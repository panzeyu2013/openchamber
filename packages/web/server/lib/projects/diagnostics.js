/**
 * Project diagnostics route.
 *
 * `GET /api/projects/diagnostics` — desensitized control-plane snapshot
 * (plan §19 of docs/unified-project-architecture.md), served
 * behind the same base UI auth gate as every other project route:
 *
 * - catalog schema/revision/last successful persist time/recovery state,
 * - per-connection broker lifecycle state, active leases and last release,
 * - per-connection session-index freshness (incl. last success), backoff
 *   count, event-stream (observer) presence and snapshot reload/gap counts,
 * - session-index snapshot revision + last event revision (one global
 *   counter: every event emission bumps it) and totals for reload/gap,
 * - runtime proxy request/failure/cancel counts and the active upstream
 *   stream gauge (no URLs, paths, headers, bodies or credentials recorded),
 * - migration completion/pending/failure state and the `projectCatalogV1`
 *   capability flag.
 *
 * Desensitization contract: NO tokens, credentials, headers, upstream URLs
 * or filesystem paths are ever projected. Migration pending paths are
 * reduced to a count; connection errors are the safe session-index
 * summaries; a recursive redaction drops any known sensitive key that a
 * future diagnostics contributor might add by mistake.
 */

const sendError = (res, status, message, code) => {
  res.status(status).json({ error: message, ...(code ? { code } : {}) });
};

/** Known-sensitive key names that must never cross the diagnostics boundary. */
const SENSITIVE_KEYS = new Set([
  'baseUrl',
  'clientToken',
  'credentialRef',
  'sshInstanceId',
  'allowRedirectHosts',
  'token',
  'authorization',
  'headers',
  'url',
  'path',
  'directory',
]);

const redactSensitiveKeys = (value) => {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEYS.has(key))
        .map(([key, entry]) => [key, redactSensitiveKeys(entry)]),
    );
  }
  return value;
};

/** Projects the runtime's raw diagnostics into the desensitized payload. */
export const desensitizeDiagnostics = (raw) => {
  const migration = raw?.migration && typeof raw.migration === 'object' ? raw.migration : {};
  return redactSensitiveKeys({
    ...(raw ?? {}),
    migration: {
      legacyProjectsImported: migration.legacyProjectsImported === true,
      // Migration pending entries are filesystem paths; only the count may
      // cross the boundary.
      pendingCount: Array.isArray(migration.pendingConnectionIds) ? migration.pendingConnectionIds.length : 0,
      revision: typeof migration.revision === 'number' ? migration.revision : null,
    },
  });
};

export const registerProjectDiagnosticsRoutes = (app, dependencies) => {
  const { getDiagnostics } = dependencies;

  app.get('/api/projects/diagnostics', async (_req, res) => {
    try {
      res.json(desensitizeDiagnostics(await getDiagnostics()));
    } catch (error) {
      sendError(res, 500, error instanceof Error ? error.message : 'Failed to read project diagnostics');
    }
  });
};
