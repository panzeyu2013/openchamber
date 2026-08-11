# Workspaces module (shared UI)

Ownership: `packages/ui/src/workspaces/*` — the renderer side of the unified
Workspace Catalog, the Session Index, the workspace runtime registry and the
unified Add Workspace flow. Server mirror:
`packages/web/server/lib/workspaces/`.

## Identity invariants

- `workspaceId` is a stable random UUID from the server; it is never computed
  from paths, URLs or server names, and the client never generates one.
- Scope keys (`workspaceScopeKey`, `workspaceSessionKey`) in `identity.ts`
  must stay byte-compatible with the server's `workspace-identity.js`
  (NUL-separated composite keys; contract tests cover unicode/slashes/
  collisions).
- No component may guess workspace membership from `window.location`,
  `getRuntimeApiBaseUrl()` or a global runtime key. The catalog is the only
  source of workspace membership.

## Modules

| File | Responsibility |
|---|---|
| `types.ts` | Shared public types + `CatalogClientError`. No local/remote branches. |
| `identity.ts` | Scope/session key helpers (renderer mirror of the server identity module). |
| `control-plane-fetch.ts` | Pinned fetch for EVERY workspace-owned request (catalog, session index, workspace SDK clients). Resolves the LOCAL control plane in priority order: an explicit `setControlPlaneOrigin(...)` injection (Capacitor mobile pins the connected OpenChamber server after a capability probe), `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop loopback), then the window origin (deployment path prefix preserved when the active runtime IS the control plane) — and NEVER follows the Active Runtime, so switching to a remote server must not move the unified catalog. Runtimes with NO control plane (non-http webview origins like `vscode-webview://`/`capacitor://localhost` with no injection) get an explicit `control_plane_unavailable` 501 response — never a request to the wrong target and never a silent empty success. In relay mode the request rides `runtimeFetch` on the window (virtual) origin so the E2EE tunnel carries it. Attaches the bearer only when it belongs to the control plane; other requests rely on the UI session cookie. |
| `catalog-client.ts` | Control-plane HTTP client (via the pinned control-plane fetch); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`; connection CRUD (create/update/delete). Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success; stale refresh responses are generation-guarded), optimistic update/delete with ENTITY-SCOPED rollback (a failed mutation never wipes concurrent successes elsewhere), create via server canonicalization (never optimistic), and 409 conflict replay after re-fetch for create/update/delete. |
| `AddWorkspaceDialog.tsx` | Unified server + path + name + color flow with an inline "Add server…" form (label + URL + optional token) that registers a direct connection; probe/browse go through connection-scoped catalog endpoints; browse responses are generation-guarded so a slow old server response cannot overwrite a newer selection; parent-path navigation handles POSIX, Windows drive and UNC roots; input is preserved on failure; a lost create response is deduped server-side. |
| `session-index-client.ts` | Snapshot/create/bind API calls plus the SSE events stream (revision-carrying incremental events, exponential backoff with healthy-stream reset, non-numeric revisions dropped) — all through the control-plane pinned fetch. |
| `session-index-store.ts` | Renderer Session Index: revision-gap detection (gap → re-fetch snapshot), clone-on-write event reducers, per-connection freshness; failure never empties a prior snapshot. Also hosts `resolveActiveWorkspaceId` (pure workspace-derivation helper). |
| `useActiveWorkspace.ts` | Derives the ACTIVE workspace from the current session selection (session index is authoritative; null for non-workspace sessions keeps the legacy ambient path) plus `useActiveWorkspaceCapabilities`/`resolveActiveWorkspaceCapabilities` — the connection capabilities of the active workspace, used by capability gates (terminal etc.); null while the catalog has no authoritative snapshot means "do not gate". |
| `workspace-runtime-fetch.ts` | Pure workspace-prefix path rewriting; mirrors the server proxy contract (loopback-origin rewriting when `window` is absent). |
| `workspace-runtime-registry.ts` | Per-workspace handles (SDK client on the control-plane workspace base URL via the pinned control-plane fetch + scope key + URL resolver) with lease/retain and bounded LRU; never-retained handles are evictable; no global endpoint mutation. |
| `workspace-runtime-context.ts` | Context value + `useWorkspaceRuntime` hook (split from the provider for fast-refresh lint rules). |
| `WorkspaceRuntimeProvider.tsx` | Provides the current workspace's handle to the full-sync surface; retains while mounted. Mounted in `App.tsx` around the main `SyncProvider`. |

The unified sidebar (`WorkspaceSessionsSection`) lives in
`packages/ui/src/components/session/sidebar/` and consumes the catalog +
session index stores; see that module's `DOCUMENTATION.md`.

## Navigation invariants

- Opening a session must only change the current `workspaceId`/`sessionId`
  and the bound runtime handle. It must NOT call `switchRuntimeEndpoint()`
  and must NOT clear other workspaces' directories or summaries.
- The registry's handle requests always go to the CURRENT control plane
  through the workspace prefix; the server resolves the connection and
  injects upstream auth.
- Current behavior: when a workspace session is selected, the main app's
  `SyncProvider` runs against the workspace-bound handle (SDK on the
  workspace prefix + workspace directory) and is keyed by workspaceId, so
  switching between workspaces remounts the sync WITHOUT a global runtime
  switch — the same server, the right workspace, no state bleed. LOCAL AND
  REMOTE workspace sessions now open through the same unified selection path
  (the old "coming with the sync migration" notice was removed): the sync
  consumes `handle.scopeKey` (workspace scope key, ambient runtime key
  otherwise), the event stream runs on the bound SDK's SSE endpoint through
  the workspace runtime proxy (WebSocket upgrades are not wired yet), and
  workspace-scoped caches (child stores, message loader, persist cache,
  prefetch cache, deletion cleanup) key by `workspaceScopeKey(workspaceId)`
  so equal paths/session IDs on different servers never collide. Clicking a
  session never switches the global runtime endpoint.

## Migration status

Phases 1–4 are live: catalog + session index hydration at boot
(`WorkspaceCatalogBridge` / `SessionIndexBridge` in AppEffects — both pinned
to the local control plane, so runtime endpoint changes never swap the
catalog), the unified Add Workspace dialog (with inline server registration),
and the unified sidebar that replaced the fleet section. The renderer fleet
observation layer (`packages/ui/src/fleet/`) was removed in Phase 6; its
coordination algorithms live in the session index. The workspace runtime
registry/provider is now MOUNTED (App.tsx) and the full sync consumes the
workspace handle for BOTH local and remote workspaces: session open goes
through the unified selection path, the event stream rides the bound SDK's
SSE endpoint via the workspace runtime proxy (and the server-side workspace
WebSocket upgrade is wired for terminal/event streams), `WorkspaceRuntimeHandle.apis`
carries workspace-bound `RuntimeAPIs` (files/git/terminal route through the
workspace prefix + control-plane fetch; terminal streaming returns an
explicit `workspace_terminal_unavailable` until the workspace transport is
plumbed into `TerminalTransport`), and per-workspace sync caches key by
`workspaceScopeKey(workspaceId)`. New sessions are created per workspace from
the sidebar group header through `session-index-client.createWorkspaceSession`.
Capacitor mobile pins the connected server as the control plane and re-fetches
catalog/session-index revisions on resume; VS Code surfaces an explicit
"workspace unavailable" state (no OpenChamber control plane is embedded in
the extension host yet — bridge payloads already carry optional
`workspaceId`/`controlPlane` passthrough for a future control-plane proxy).

Remaining (Phase 6, requires a compatibility release cycle per the
architecture doc): `useProjectsStore` (path-derived ids,
API-base-URL-sliced storage), `useGlobalSessionsStore`, `switchRuntimeEndpoint`
(still used by the Host Switcher / remote-instances / mobile disconnect
paths), `runtimeEndpointReset`, and `projectId` as authoritative identity.
New code must not call the old facades; the call-site list may only shrink.

### Store-key migration status

Session-scoped stores now key on explicit workspace scope
(`workspaceScopeKey(workspaceId)` when the session index resolves the
`(sessionId, directory)` tuple, ambient `getRuntimeKey()` otherwise — keys
are byte-identical in non-workspace mode). The shared resolver is
`resolveSessionScopeKey` in `packages/ui/src/sync/selection-store.ts`.

Scope-ized (new writes only use the scope key; legacy reads kept via dual
read for at least one release cycle):

- `sync/selection-store.ts` (per-session model/agent/variant selections;
  persisted v1 bare-session-ID data stays readable in memory)
- `sync/viewport-store.ts` (scroll/memory state; bare-session-ID legacy
  entries remain readable)
- `sync/session-ui-store.ts` (`setCurrentSession` memory buckets,
  last-active-session cache, worktree topology persistence, draft-target
  storage, queued-send scope guard)
- `sync/last-session-cache.ts`, `sync/worktree-topology-cache.ts`,
  `sync/runtime-live-memory.ts` (buckets keyed by the scope key passed by
  their callers; runtime-keyed legacy entries stay readable)
- `stores/messageQueueStore.ts`, `stores/useSessionPinnedStore.ts`,
  `stores/useTodosPersistStore.ts`, `stores/useInlineCommentDraftStore.ts`,
  `stores/useSessionFoldersStore.ts` (outer bucket),
  `lib/chatDraftPersistence.ts`

Still ambient (intentionally global or Phase-6 legacy): `useProjectsStore`,
`useGlobalSessionsStore`, the `contextStore` mini-chat mirror, and the
fleet-era caches. Folders' inner scope key stays the caller-provided
directory string (see `stores/DOCUMENTATION.md`).

### Sync-layer scope migration (this wave)

The sync layer now passes the workspace scope key explicitly from
`SyncProvider` (`scopeKey = workspaceHandle?.scopeKey ?? getRuntimeKey()`),
byte-identical to the ambient runtime key in non-workspace mode:

- `sync/child-store.ts` — children are keyed by `scopeKey\nnormalizedDirectory`
  composite keys (every method accepts an explicit `scopeKey`, defaulting to
  the manager's own scope); equal paths across workspaces never collide even
  if a manager is ever shared.
- `sync/session-message-loader.ts` — request identity, invalidation and
  prefetch keys use the configured `scopeKey`.
- `sync/persist-cache.ts` — storage prefix is `storagePrefixForScope(scopeKey,
  directory)`; pending writes carry their scope and workspace-scoped writes
  always commit (runtime-scoped writes keep the stale-runtime guard).
- `sync/session-prefetch-cache.ts` — composite keys use the scope.
- `sync/session-deletion-cleanup.ts` — identities carry an optional
  `workspaceId`; the guard is `workspaceScopeKey(workspaceId)` when present,
  the ambient runtime-key guard otherwise.
- `sync/event-pipeline.ts` — `forceSse` makes workspace-bound sync ride the
  bound SDK's SSE stream only (never a WebSocket against the global runtime
  URL).
- `sync/use-sync.ts` — session-keyed LRU/inflight caches key by the sync
  scope instead of the ambient runtime key.
