# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`pr-description`, `conflict-details`) and generation helpers.

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `gitService.ts`
  - Owns VS Code Git and worktree operations.
  - Fast worktree creation reports bootstrap phases explicitly: `directory-created`, then `git-ready` after Git population/upstream work, and `setup-ready` after setup commands. Existing worktrees without tracked bootstrap state fall back to `ready`/`setup-ready`; shared webview consumers also accept legacy responses without `phase`.
  - Worktree removal waits for an active create/bootstrap task for the same directory so background Git and setup work cannot race deletion or restore stale bootstrap state.
  - Worktree population enables Git `core.longpaths` (local repo config plus `-c core.longpaths=true` on `git reset --hard`) so deeply nested checkouts under the managed data-dir worktree root do not fail on Windows MAX_PATH with "Filename too long".

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

The webview CSP permits `blob:` only for `worker-src` so shared UI parsers can run bounded local decompression off the main thread. Blob scripts remain disallowed by `script-src`.

- `bridge-localfs-proxy-runtime.ts`
  - Local `/api/fs/read` and `/api/fs/raw` proxy helpers and shared proxy utility helpers.

- `bridge-proxy-runtime.ts`
  - Proxy route handlers (`api:proxy`, `api:session:message`) with injected helper dependencies.
  - SSE routes are intentionally excluded from the generic proxy and use `sseProxy.ts`, whose upstream-only stall watchdog closes a quiet OpenCode stream so the webview can reconnect instead of trusting an open but silent response.
  - The webview allocates each SSE stream ID and installs its listener before requesting the upstream stream, so immediate OpenCode replay events cannot race the bridge start response.
  - `api:proxy` accepts forward-compat `controlPlane` / `projectId` payload fields (backward compatible; existing callers omit them). A `controlPlane: true` request is NEVER forwarded to the opencode binary. With an explicitly configured control plane (`openchamber.apiUrl`, resolved through the injected `resolveControlPlaneOrigin` seam wired from `bridge.ts`'s `readConfiguredControlPlaneOrigin`) the request is forwarded to `{origin}{path}{query}` using the host's auth headers (`OpenCodeManager.getOpenCodeAuthHeaders()`, the same credentials the descriptor fetch uses) with an 8s abort timeout (matching the catalog read) and per-request abort via `api:proxy:abort`; upstream status/body/headers are returned to the webview, and `authorization`/`set-cookie`/`www-authenticate` response headers are stripped so upstream credentials never reach the webview. Without a configured origin the request keeps the explicit `capability_unavailable` (501, `control_plane_unavailable`) answer — the managed opencode binary is NOT a control plane, so no localhost fallback is ever guessed. Control-plane WebSocket/terminal upgrades stay `capability_unavailable` (501, VS Code V1: terminal unsupported), and control-plane SSE-accept requests are rejected with the same `api:sse:start` guidance as binary SSE paths so no open stream is buffered by the single-response proxy — the webview routes control-plane SSE through the streamed SSE bridge instead (see `sseProxy.ts`).

- `bridge-project-runtime.ts`
  - Project-identity message handlers (`api:workspace:descriptor:get` — the IPC name is preserved as a VS Code bridge contract) with injected dependencies.
  - The current VS Code folder set (the same `resolveWorkspaceFolders` candidates the webview bootstrap uses) resolves to a stable project descriptor: an `available` result carries the full `ProjectDescriptor` with its stable UUID `projectId` (the webview types the payload with the shared catalog type `@openchamber/ui/projects/types`; the host's structural mirror is documented in the module). Matching is a pure function (`matchFolderToCatalogProject`) against the descriptor `canonicalPath` with the active folder preferred and the first folder as fallback — same precedence as the legacy folder bridge.
  - `fetchControlPlaneCatalogProjects` is the real implementation of the injected `fetchCatalogProjects` seam, wired in `bridge.ts`. It reads the catalog from the configured control plane via `GET {origin}/api/projects`, where the origin is the explicitly configured `openchamber.apiUrl` (the managed opencode binary the extension spawns when the setting is empty is NOT a control plane). The fetch mirrors the host's existing authenticated-request shape — `Accept: application/json` plus `OpenCodeManager.getOpenCodeAuthHeaders()` — with an 8s abort timeout, and maps the server's catalog snapshot (`ProjectCatalogSnapshot.projects`) to the shared `ProjectDescriptor` shape, dropping entries that fail the same required-field validation the server applies. It returns `null` ONLY for a genuine unreachable-control-plane condition (origin not configured, network/parse failure, non-2xx, or a response that is not a catalog snapshot) and never throws; an empty catalog is returned as `[]` so the bridge can distinguish `not_found` from `capability_unavailable`. On `null` the bridge answers the explicit deterministic state `{ status: 'capability_unavailable', code: 'capability_unavailable', reason: 'control_plane_unavailable', workspaceFolders, activePath }` — it NEVER synthesizes a path-derived ID as authoritative identity. `no_folder` (untitled window) and `not_found` (catalog reachable, folder not cataloged) are separate explicit states. The result carries no `projectId` in any non-`available` state.
  - Project-scoped bridge requests follow the existing shape: the descriptor result carries the resolved `projectId` when `available`, and `api:proxy` (`controlPlane: true`) accepts the same `projectId` passthrough (echoed only in the `capability_unavailable` answer; the forward itself targets the configured control-plane origin).

- `sseProxy.ts`
  - Streams the OpenCode binary's `/event` and `/global/event` streams to the webview (`api:sse:start` / `api:sse:chunk` / `api:sse:end`), with exponential-backoff reconnect and an upstream-only stall watchdog.
  - Supports control-plane streams (`controlPlane: true` + a caller-resolved `controlPlaneOrigin`): the target is `{origin}{path}{query}` verbatim — no `/event` normalization, no default-directory injection — with the same auth headers as the binary's event stream. The upstream stream is relayed as-is and the host does NOT reconnect (fail-fast on connect errors): the session-index client owns reconnect with its own backoff, so retry layers do not stack. The panel providers (`ChatViewProvider`, `SessionEditorPanelProvider`, `AgentManagerPanelProvider`) resolve the origin via `bridge.ts`'s `readConfiguredControlPlaneOrigin()` and answer an explicit `capability_unavailable` (501) when no control plane is configured.

- `bridge-config-runtime.ts`
  - Config and skills message handlers (`api:config/*`).
  - Includes OpenCode resolution diagnostics parity handler used by shared UI (`/api/config/opencode-resolution`).

- `bridge-settings-runtime.ts`
  - Settings read/write and OpenCode skills discovery via API for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/provider/quota/notification/update-check message handlers.
  - Includes session activity snapshot bridge handler used by webview parity routes (`/api/session-activity`).
  - Includes Zen utility model parity handler used by shared notification settings (`/api/zen/models`).
  - Owns managed OpenCode upgrade status and mutation handlers, including capability reporting, upgrade serialization, and process restart after a successful upgrade.
  - Provider handlers cover source lookup, disconnect (`DELETE /api/provider/:id/auth`), and custom provider upsert (`PUT /api/provider`; create/update OpenAI-compatible config with explicit `scope` for user/project/custom layers; requires `env` or stored auth; secrets via OpenCode auth API).

- `opencode-upgrade-runtime.ts`
  - Owns managed-versus-external capability decisions, latest-version checks, serialized OpenCode self-upgrades, and restart-after-upgrade behavior.

- `bridge-permission-auto-accept-runtime.ts`
  - Owns the persisted VS Code permission auto-accept policy and its GET/PUT bridge contract.
  - Serializes reads and read-modify-write updates, persists a monotonic policy revision, and broadcasts the exact committed snapshot to every active OpenChamber webview. Permission replies remain foreground UI-owned because VS Code does not run the OpenChamber server runtime.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.
