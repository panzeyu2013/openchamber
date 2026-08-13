import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  TERMINAL_WS_MAX_PAYLOAD_BYTES,
  TERMINAL_WS_PATH,
  createTerminalWsControlFrame,
  parseRequestPathname,
  readTerminalWsControlFrame,
} from './terminal-ws-protocol.js';
import { sanitizeTerminalHistoryChunk } from './history.js';
import { consumeTerminalThemeQueries, terminalThemeModeReport } from './theme-response.js';
import { createTerminalShellResolver, getTerminalShellLoginArgs, normalizeTerminalShell } from './shells.js';
import { stripAppImageArgv0Leak, resolveLinuxPtyLaunch } from '../inherited-env.js';
import { PROJECT_RUNTIME_UPGRADE_MARKER, parseProjectRuntimePath } from '../projects/runtime-proxy.js';

const MAX_SESSIONS = 20;
const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_INPUT_CHARS = 65_536;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 1000;
const validateSize = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
const trimHistory = (history) => {
  const bytes = Buffer.from(history);
  if (bytes.byteLength <= MAX_HISTORY_BYTES) return history;
  let start = bytes.byteLength - MAX_HISTORY_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
};

export function createTerminalRuntime({
  app, server, fs, path, uiAuthController, buildAugmentedPath, searchPathFor, isExecutable,
  isRequestOriginAllowed, rejectWebSocketUpgrade, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS,
  loadPtyProvider, terminalTerminationGraceMs = TERMINATION_GRACE_MS,
}) {
  const sessions = new Map();
  const pendingSessionCreates = new Map();
  const pendingSessionRestarts = new Map();
  const connections = new Set();
  const pendingTerminations = new Set();
  const runtime = typeof globalThis.Bun === 'undefined' ? 'node' : 'bun';
  let ptyProviderPromise = null;
  let wsServer = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const shellResolver = createTerminalShellResolver({ fs, path, searchPathFor, isExecutable, buildAugmentedPath });

  const getPtyProvider = async () => {
    if (!ptyProviderPromise) {
      ptyProviderPromise = loadPtyProvider ? loadPtyProvider() : (async () => {
        if (typeof globalThis.Bun !== 'undefined') {
          try { const pty = await import('bun-pty'); return { spawn: pty.spawn, backend: 'bun-pty' }; } catch { /* fall through */ }
        }
        const pty = await import('node-pty');
        return { spawn: pty.spawn, backend: 'node-pty' };
      })();
    }
    return ptyProviderPromise;
  };

  const spawnPty = async ({ cwd, cols, rows, themeMode, shell, loginShell }) => {
    const provider = await getPtyProvider();
    const resolvedShell = await shellResolver.resolve(shell);
    let lastError = null;
    for (const executable of resolvedShell.executables) {
      const args = loginShell ? getTerminalShellLoginArgs(executable) : [];
      if (!args) throw new Error(`Terminal shell "${resolvedShell.id}" does not support login mode`);
      try {
        const env = { ...process.env, PATH: buildAugmentedPath(), TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: themeMode === 'light' ? '0;15' : '15;0' };
        // The daemon's IPC fd is closed inside the PTY. An explicit override is
        // required because bun-pty also inherits Bun's native process environment.
        env.NODE_CHANNEL_FD = '';
        delete env.BASH_XTRACEFD; delete env.BASH_ENV; delete env.ENV; delete env.ELECTRON_RUN_AS_NODE;
        // AppImage exports ARGV0; zsh would otherwise rewrite argv[0] for every command (#2588).
        // bun-pty also merges the native OS environ, so wrap with `env -u ARGV0` on Linux.
        stripAppImageArgv0Leak(env);
        const launch = resolveLinuxPtyLaunch(executable, args);
        const options = { name: 'xterm-256color', cwd, cols, rows, env, ...(process.platform === 'win32' ? { useConpty: true } : {}) };
        return { process: provider.spawn(launch.executable, launch.args, options), backend: provider.backend, shell: resolvedShell.id, loginShell };
      } catch (error) { lastError = error; }
    }
    throw lastError ?? new Error('No executable shell found');
  };

  const killProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return;
    if (process.platform !== 'win32' && Number.isInteger(ptyProcess.pid) && ptyProcess.pid > 0) {
      try { process.kill(-ptyProcess.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
    }
    try { ptyProcess.kill(force ? 'SIGKILL' : undefined); } catch { /* already gone */ }
  };

  const terminateProcess = (ptyProcess, force = false) => {
    if (!ptyProcess) return Promise.resolve();
    if (force) { killProcess(ptyProcess, true); return Promise.resolve(); }
    let termination;
    termination = new Promise((resolve) => {
      let settled = false;
      let disposable = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        disposable?.dispose?.();
        resolve();
      };
      const timeout = setTimeout(() => { killProcess(ptyProcess, true); finish(); }, terminalTerminationGraceMs);
      try { disposable = ptyProcess.onExit(() => finish()); } catch { /* backend is already gone */ }
      killProcess(ptyProcess, false);
    }).finally(() => pendingTerminations.delete(termination));
    pendingTerminations.add(termination);
    return termination;
  };

  const send = (socket, message) => {
    if (socket?.readyState !== 1) return false;
    try { socket.send(createTerminalWsControlFrame(message), { binary: true }); return true; } catch { return false; }
  };

  const closeAttachments = (sessionId, code, message) => {
    for (const connection of connections) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: 'error', v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const snapshot = (session) => ({
    t: 'snapshot', v: 3, s: session.id, q: session.sequence, history: session.history,
    status: session.status, exitCode: session.exitCode, signal: session.signal,
    runtime, ptyBackend: session.backend,
  });

  const publish = (session, event) => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const drainEvents = (session) => {
    if (session.draining) return;
    session.draining = true;
    try {
      while (session.eventQueue.length > 0) {
        const event = session.eventQueue.shift();
        if (event.process !== session.process) continue;
        if (event.type === 'output') {
          const theme = consumeTerminalThemeQueries(session.pendingThemeControlSequence, event.data, {
            themeMode: session.themeMode,
            background: session.terminalBackground,
            foreground: session.terminalForeground,
            modeEnabled: session.themeModeEnabled,
          }, { respondToPrimaryDeviceAttributes: true });
          session.pendingThemeControlSequence = theme.pending;
          session.themeModeEnabled = theme.modeEnabled;
          for (const response of theme.responses) session.process?.write(response);
          const sanitized = sanitizeTerminalHistoryChunk(session.pendingHistoryControlSequence, event.data);
          session.pendingHistoryControlSequence = sanitized.pending;
          session.history = trimHistory(session.history + sanitized.visible);
          session.lastActivity = Date.now();
          publish(session, { t: 'output', d: event.data, ...(sanitized.visible !== event.data ? { r: sanitized.visible } : {}) });
        } else {
          session.status = 'exited';
          session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
          session.signal = Number.isInteger(event.signal) ? event.signal : null;
          session.process = null;
          publish(session, { t: 'exit', exitCode: session.exitCode, signal: session.signal });
        }
      }
    } finally { session.draining = false; }
  };

  const wire = (session, ptyProcess) => {
    ptyProcess.onData((data) => { session.eventQueue.push({ type: 'output', process: ptyProcess, data }); drainEvents(session); });
    ptyProcess.onExit(({ exitCode, signal }) => { session.eventQueue.push({ type: 'exit', process: ptyProcess, exitCode, signal }); drainEvents(session); });
  };

  const validateCwd = async (cwd) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('cwd is required');
    const stats = await fs.promises.stat(cwd).catch(() => null);
    if (!stats?.isDirectory()) throw new Error('Invalid working directory');
  };

  const assertProjectCwd = async (cwd, canonicalPath) => {
    if (!canonicalPath) return;
    if (typeof cwd !== 'string' || !cwd.trim()) return;
    const root = path.resolve(canonicalPath);
    const candidate = path.resolve(cwd);
    const lexicalRelative = path.relative(root, candidate);
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
      const error = new Error('Working directory is outside the project');
      error.code = 'catalog_path_outside_project';
      error.status = 403;
      throw error;
    }
    const realpath = typeof fs.promises.realpath === 'function'
      ? (value) => fs.promises.realpath(value).catch(() => value)
      : async (value) => value;
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      const error = new Error('Working directory is outside the project');
      error.code = 'catalog_path_outside_project';
      error.status = 403;
      throw error;
    }
  };

  const applyAppearance = (session, { themeMode, terminalBackground, terminalForeground }) => {
    const previous = [session.themeMode, session.terminalBackground, session.terminalForeground];
    if (themeMode === 'light' || themeMode === 'dark') session.themeMode = themeMode;
    if (typeof terminalBackground === 'string') session.terminalBackground = terminalBackground;
    if (typeof terminalForeground === 'string') session.terminalForeground = terminalForeground;
    const changed = previous[0] !== session.themeMode || previous[1] !== session.terminalBackground || previous[2] !== session.terminalForeground;
    if (changed && session.themeModeEnabled) {
      try { session.process?.write(terminalThemeModeReport(session.themeMode)); } catch { /* process exited */ }
    }
  };

  const startSession = async (session, { cwd, cols, rows, themeMode = 'dark', terminalBackground, terminalForeground, shell, loginShell }, clear = true) => {
    await validateCwd(cwd);
    const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell });
    if (clear) { session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; }
    session.cwd = cwd; session.cols = cols; session.rows = rows; session.process = spawned.process;
    session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.status = 'running'; session.exitCode = null; session.signal = null;
    session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
    session.lastActivity = Date.now(); session.eventQueue.length = 0;
    wire(session, spawned.process);
  };

  const createSession = async ({ sessionId, cwd, cols = 80, rows = 24, themeMode, terminalBackground, terminalForeground, shell = 'auto', loginShell = false, projectId = null, canonicalPath = null }) => {
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
    if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
    const normalizedShell = normalizeTerminalShell(shell);
    if (!normalizedShell) throw new Error('Invalid terminal shell');
    if (projectId && !canonicalPath) {
      const error = new Error('Project directory is unavailable');
      error.code = 'catalog_project_directory_unavailable';
      error.status = 403;
      throw error;
    }
    await assertProjectCwd(cwd, canonicalPath);
    const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : randomUUID();
    if (id.length > 128) throw new Error('Invalid terminal session id');
    // Project binding: sessions created through a project-prefixed path
    // (projectId) belong to that project and are never reachable from any
    // other scope; `null` keeps the legacy non-project behavior.
    const boundProjectId = projectId ?? null;
    const existing = sessions.get(id);
    const resolvedCwd = path.resolve(cwd);
    if (existing?.status === 'running') {
      if (existing.projectId !== boundProjectId) throw new Error('Terminal session belongs to a different project');
      if (path.resolve(existing.cwd) !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      applyAppearance(existing, { themeMode, terminalBackground, terminalForeground });
      return existing;
    }
    const pending = pendingSessionCreates.get(id);
    if (pending) {
      if (pending.projectId !== boundProjectId) throw new Error('Terminal session belongs to a different project');
      if (pending.cwd !== resolvedCwd) throw new Error('Terminal session belongs to a different working directory');
      if (pending.shell !== normalizedShell) throw new Error('Terminal session is already being created with a different shell');
      if (pending.loginShell !== loginShell) throw new Error('Terminal session is already being created with a different login mode');
      const session = await pending.promise;
      applyAppearance(session, { themeMode, terminalBackground, terminalForeground });
      return session;
    }
    if (!existing && sessions.size + pendingSessionCreates.size >= MAX_SESSIONS) throw new Error('Maximum terminal sessions reached');
    const creation = (async () => {
      const session = existing ?? { id, sequence: 0, history: '', pendingHistoryControlSequence: '', pendingThemeControlSequence: '', eventQueue: [], draining: false };
      session.projectId = boundProjectId;
      session.canonicalPath = canonicalPath ?? null;
      await startSession(session, { cwd, cols, rows, themeMode, terminalBackground, terminalForeground, shell: normalizedShell, loginShell });
      sessions.set(id, session);
      return session;
    })();
    const pendingEntry = { cwd: resolvedCwd, shell: normalizedShell, loginShell, projectId: boundProjectId, promise: creation };
    pendingSessionCreates.set(id, pendingEntry);
    try { return await creation; }
    finally { if (pendingSessionCreates.get(id) === pendingEntry) pendingSessionCreates.delete(id); }
  };

  wsServer.on('connection', (socket, _req, projectId) => {
    const connection = { socket, attachments: new Map(), projectId: projectId ?? null };
    connections.add(connection);
    send(socket, { t: 'hello', v: 3 });
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS);
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Binary control frame required', fatal: false }); return; }
      const message = readTerminalWsControlFrame(raw);
      if (!message || message.v !== 3 || typeof message.t !== 'string') { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Invalid terminal frame', fatal: false }); return; }
      if (message.t === 'ping') { send(socket, { t: 'pong', v: 3 }); return; }
      if (message.t === 'hello') return;
      const id = typeof message.s === 'string' ? message.s : '';
      if (!id) { send(socket, { t: 'error', v: 3, code: 'BAD_FRAME', message: 'Session id required', fatal: false }); return; }
      if (message.t === 'detach') { connection.attachments.delete(id); return; }
      const session = sessions.get(id);
      if (!session) { send(socket, { t: 'error', v: 3, s: id, code: 'SESSION_NOT_FOUND', message: 'Terminal session not found', fatal: true }); return; }
      // A session bound to a project is only reachable from an upgrade that
      // arrived through the SAME project prefix; cross-project and legacy
      // connections cannot touch it (and vice versa).
      if (session.projectId !== connection.projectId) {
        send(socket, { t: 'error', v: 3, s: id, code: 'PROJECT_SCOPE_MISMATCH', message: 'Terminal session belongs to a different project', fatal: false });
        return;
      }
      if (message.t === 'attach') {
        const attachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        const initial = snapshot(session);
        send(socket, initial);
        for (const event of attachment.pending) if (event.q > initial.q) send(socket, event);
        attachment.pending.length = 0; attachment.initializing = false;
        return;
      }
      if (message.t === 'write') {
        if (typeof message.d !== 'string' || !message.d || message.d.length > MAX_INPUT_CHARS) { send(socket, { t: 'error', v: 3, s: id, code: 'BAD_INPUT', message: 'Invalid terminal input', fatal: false }); return; }
        if (session.status !== 'running' || !session.process) { send(socket, { t: 'error', v: 3, s: id, code: 'NOT_RUNNING', message: 'Terminal is not running', fatal: false }); return; }
        try { session.process.write(message.d); session.lastActivity = Date.now(); } catch { send(socket, { t: 'error', v: 3, s: id, code: 'WRITE_FAILED', message: 'Failed to write to terminal', fatal: false }); }
      }
    });
    const cleanup = () => { clearInterval(heartbeat); connection.attachments.clear(); connections.delete(connection); };
    socket.on('close', cleanup); socket.on('error', () => {});
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    const parsedProject = parseProjectRuntimePath(pathname);
    const terminalPath = parsedProject ? parsedProject.restPath : pathname;
    if (terminalPath !== TERMINAL_WS_PATH) return;
    // Project-prefixed upgrades are owned by the central project upgrade
    // dispatcher when it is installed (it registers first and marks the
    // request); this listener never double-handles the same upgrade.
    if (parsedProject && req?.[PROJECT_RUNTIME_UPGRADE_MARKER]) return;
    const projectId = parsedProject?.projectId ?? null;
    void (async () => {
      try {
        if (uiAuthController?.enabled) {
          if (!await uiAuthController.ensureSessionToken(req, null)) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 500, 'Terminal WebSocket unavailable'); return; }
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req, projectId));
      } catch { rejectWebSocketUpgrade(socket, 500, 'Upgrade failed'); }
    })();
  };
  server.on('upgrade', upgradeHandler);

  /** Extracts the project binding from a project-prefixed request path
   * (`/api/projects/:projectId/runtime/api/terminal/...`). Non-prefixed
   * requests (legacy control-plane terminals) resolve to a null binding. The
   * canonical path is read from the `x-opencode-directory` header, which the
   * project runtime proxy overwrites with the project canonical path. */
  const resolveProjectScope = (req) => {
    const rawUrl = req?.originalUrl || req?.url;
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      return { projectId: null, canonicalPath: null };
    }
    let pathname;
    try {
      pathname = new URL(rawUrl, 'http://localhost').pathname;
    } catch {
      return { projectId: null, canonicalPath: null };
    }
    const parsed = parseProjectRuntimePath(pathname);
    if (!parsed) return { projectId: null, canonicalPath: null };
    const directoryHeader = req?.headers?.['x-opencode-directory'];
    return {
      projectId: parsed.projectId,
      canonicalPath: typeof directoryHeader === 'string' && directoryHeader.length > 0 ? directoryHeader : null,
    };
  };

  /** Session lookup that also enforces the project scope of the request:
   * a session bound to a project is only reachable through that project's
   * prefix, and legacy requests only reach legacy sessions. */
  const findSessionForRequest = (req, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const { projectId } = resolveProjectScope(req);
    if (session.projectId !== projectId) return null;
    return session;
  };

  app.get('/api/terminal/shells', async (_req, res) => {
    try {
      const shells = await shellResolver.list();
      res.json(shells.map(({ id, name, supportsLogin }) => ({ id, name, supportsLogin })));
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list terminal shells' });
    }
  });
  app.post('/api/terminal/create', async (req, res) => {
    try {
      const scope = resolveProjectScope(req);
      if (scope.projectId && !scope.canonicalPath) {
        return res.status(403).json({ error: 'Project directory is unavailable', code: 'catalog_project_directory_unavailable' });
      }
      const session = await createSession({ ...(req.body ?? {}), projectId: scope.projectId, canonicalPath: scope.canonicalPath });
      res.json({ sessionId: session.id, cols: session.cols, rows: session.rows, status: session.status });
    }
    catch (error) {
      const status = error?.status ?? (error?.message === 'Maximum terminal sessions reached' ? 429 : 400);
      res.status(status).json({ error: error?.message || 'Failed to create terminal session', ...(error?.code ? { code: error.code } : {}) });
    }
  });
  app.post('/api/terminal/:sessionId/resize', (req, res) => {
    const session = findSessionForRequest(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const { cols, rows } = req.body ?? {};
    if (!validateSize(cols, 1000) || !validateSize(rows, 500)) return res.status(400).json({ error: 'Invalid terminal dimensions' });
    try { if (session.status === 'running') session.process?.resize(cols, rows); session.cols = cols; session.rows = rows; res.json({ success: true, cols, rows }); }
    catch (error) { res.status(500).json({ error: error?.message || 'Failed to resize terminal' }); }
  });
  app.post('/api/terminal/:sessionId/appearance', (req, res) => {
    const session = findSessionForRequest(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    applyAppearance(session, req.body ?? {});
    res.json({ success: true });
  });
  app.post('/api/terminal/:sessionId/restart', async (req, res) => {
    const session = findSessionForRequest(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    const scope = resolveProjectScope(req);
    if (scope.projectId && !scope.canonicalPath) {
      return res.status(403).json({ error: 'Project directory is unavailable', code: 'catalog_project_directory_unavailable' });
    }
    const cwd = req.body?.cwd ?? session.cwd;
    const cols = req.body?.cols ?? session.cols;
    const rows = req.body?.rows ?? session.rows;
    const themeMode = req.body?.themeMode ?? session.themeMode;
    const terminalBackground = req.body?.terminalBackground ?? session.terminalBackground;
    const terminalForeground = req.body?.terminalForeground ?? session.terminalForeground;
    const shell = req.body?.shell ?? 'auto';
    const loginShell = req.body?.loginShell ?? false;
    const previousRestart = pendingSessionRestarts.get(session.id) ?? Promise.resolve();
    const restart = previousRestart.catch(() => {}).then(async () => {
      await assertProjectCwd(cwd, scope.canonicalPath);
      await validateCwd(cwd);
      if (!validateSize(cols, 1000) || !validateSize(rows, 500)) throw new Error('Invalid terminal dimensions');
      if (typeof loginShell !== 'boolean') throw new Error('Invalid terminal login mode');
      const oldProcess = session.process;
      const spawned = await spawnPty({ cwd, cols, rows, themeMode, shell, loginShell });
      session.process = spawned.process; session.backend = spawned.backend; session.shell = spawned.shell; session.loginShell = spawned.loginShell; session.cwd = cwd; session.cols = cols; session.rows = rows;
      session.history = ''; session.pendingHistoryControlSequence = ''; session.pendingThemeControlSequence = ''; session.themeModeEnabled = false; session.status = 'running'; session.exitCode = null; session.signal = null; session.eventQueue.length = 0;
      session.themeMode = themeMode === 'light' ? 'light' : 'dark'; session.terminalBackground = terminalBackground; session.terminalForeground = terminalForeground;
       wire(session, spawned.process); void terminateProcess(oldProcess); publish(session, { t: 'restarted', history: '' });
    });
    pendingSessionRestarts.set(session.id, restart);
    try {
      await restart;
      res.json({ sessionId: session.id, cols, rows, status: session.status });
    } catch (error) {
      res.status(error?.status ?? 400).json({ error: error?.message || 'Failed to restart terminal', ...(error?.code ? { code: error.code } : {}) });
    }
    finally { if (pendingSessionRestarts.get(session.id) === restart) pendingSessionRestarts.delete(session.id); }
  });
  app.delete('/api/terminal/:sessionId', async (req, res) => {
    const session = findSessionForRequest(req, req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Terminal session not found' });
    sessions.delete(session.id);
    closeAttachments(session.id, 'CLOSED', 'Terminal closed');
    await terminateProcess(session.process);
    res.json({ success: true });
  });
  app.post('/api/terminal/force-kill', (req, res) => {
    const scope = resolveProjectScope(req);
    if (scope.projectId && !scope.canonicalPath) {
      return res.status(403).json({ error: 'Project directory is unavailable', code: 'catalog_project_directory_unavailable' });
    }
    const { sessionId, cwd } = req.body ?? {}; let killedCount = 0;
    const killedSessionIds = [];
    for (const [id, session] of sessions) {
      if (session.projectId !== scope.projectId) continue;
      if ((sessionId && id !== sessionId) || (!sessionId && cwd && session.cwd !== cwd)) continue;
      sessions.delete(id); closeAttachments(id, 'KILLED', 'Terminal was killed'); void terminateProcess(session.process, true); killedSessionIds.push(id); killedCount += 1;
    }
    res.json({ success: true, killedCount, killedSessionIds });
  });

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      const attached = [...connections].some((connection) => connection.attachments.has(id));
      if (!attached && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        sessions.delete(id); closeAttachments(id, 'IDLE_TIMEOUT', 'Terminal expired after being idle'); void terminateProcess(session.process, true);
      }
    }
  }, 5 * 60 * 1000);

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler); clearInterval(idleSweep);
    await Promise.allSettled([...pendingSessionRestarts.values()]);
    for (const session of sessions.values()) void terminateProcess(session.process, true);
    sessions.clear();
    await Promise.allSettled([...pendingTerminations]);
    if (!wsServer) return;
    for (const client of wsServer.clients) client.terminate();
    await Promise.race([
      new Promise((resolve) => wsServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    wsServer = null;
  };
  return { shutdown };
}
