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
  `getControlPlaneBaseUrl()` or a global runtime key. The catalog is the only
  source of workspace membership.
- External session targets (deep links, tray actions, notifications,
  permission/question toasts, and embedded Context Panel chat frames) carry
  `workspaceId` alongside the upstream session ID when the Session Index can
  resolve it. Legacy bare-session payloads remain readable only as a
  compatibility path.

## Modules

| File | `setControlPlane()` | `subscribeControlPlane*` | Classification |
|---|---|
| `types.ts` | Shared public types + `CatalogClientError`. No local/remote branches. |
| `identity.ts` | Scope/session key helpers (renderer mirror of the server identity module). |
| `control-plane-fetch.ts` | Pinned fetch for EVERY workspace-owned request (catalog, session index, workspace SDK clients). Resolves the LOCAL control plane in priority order: an explicit `setControlPlaneOrigin(...)` injection (Capacitor mobile pins the connected OpenChamber server after a capability probe), `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop loopback), then the window origin (deployment path prefix preserved when the active runtime IS the control plane) — and NEVER follows the Active Runtime, so switching to a remote server must not move the unified catalog. Runtimes with NO control plane (non-http webview origins like `vscode-webview://`/`capacitor://localhost` with no injection) get an explicit `control_plane_unavailable` 501 response — never a request to the wrong target and never a silent empty success. In relay mode the request rides `runtimeFetch` on the window (virtual) origin so the E2EE tunnel carries it. Attaches the bearer only when it belongs to the control plane; other requests rely on the UI session cookie. |
| `catalog-client.ts` | Control-plane HTTP client (via the pinned control-plane fetch); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`; connection CRUD (create/update/delete); `fetchWorkspaceCapabilities()` reads `GET /api/workspaces/capabilities` (plan §20 flag read that stays available when the catalog is disabled). Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success; stale refresh responses are generation-guarded), optimistic update/delete with ENTITY-SCOPED rollback (a failed mutation never wipes concurrent successes elsewhere), create via server canonicalization (never optimistic), and 409 conflict replay after re-fetch for create/update/delete. |
| `AddWorkspaceDialog.tsx` | Unified server + path + name + color flow with an inline "Add server…" form (label + URL + optional token) that registers a direct connection; probe/browse go through connection-scoped catalog endpoints; browse responses are generation-guarded so a slow old server response cannot overwrite a newer selection; parent-path navigation handles POSIX, Windows drive and UNC roots; input is preserved on failure; a lost create response is deduped server-side. |
| `session-index-client.ts` | Snapshot/create/bind API calls plus the SSE events stream (revision-carrying incremental events, exponential backoff with healthy-stream reset, deterministic ±20% jitter seeded per stream and clamped to the 1s→30s bounds — §17.5, non-numeric revisions dropped) — all through the control-plane pinned fetch. |
| `session-index-store.ts` | Renderer Session Index: revision-gap detection (gap → re-fetch snapshot), clone-on-write event reducers, per-connection freshness including `offline`/`stale`/partial coverage; failure never empties a prior snapshot. Reducer work is proportional to the affected entity (§17.5): a `sessionIndex` Map (key→array position) makes upsert membership/position O(1) and removal O(1)-checked — `applyEvent` never scans the sessions array. Also hosts the `workspaceCatalogV1` capability state (`capabilities` + `refreshCapabilities()`, plan §20) on a separate channel — a failed read marks `capabilitiesError` and keeps the prior value, and unknown is treated as enabled; only an authoritative `false` flips the unified sidebar to its read-only degradation state. Also hosts `resolveActiveWorkspaceId` (pure workspace-derivation helper). |
| `useActiveWorkspace.ts` | Derives the ACTIVE workspace from the current session selection (session index is authoritative; null for non-workspace sessions keeps the legacy ambient path) plus `useActiveWorkspaceCapabilities`/`resolveActiveWorkspaceCapabilities` — the connection capabilities of the active workspace, used by capability gates (terminal etc.); null while the catalog has no authoritative snapshot means "do not gate". |
| `workspace-runtime-fetch.ts` | Pure workspace-prefix path rewriting; mirrors the server proxy contract (loopback-origin rewriting when `window` is absent). |
| `workspace-runtime-registry.ts` | Per-workspace handles (SDK client and `OpencodeService` facade on the control-plane workspace base URL via the pinned control-plane fetch + scope key + URL resolver) with lease/retain and bounded LRU; never-retained handles are evictable; no global endpoint mutation. |
| `workspace-runtime-context.ts` | Context value + `useWorkspaceRuntime` hook (split from the provider for fast-refresh lint rules). |
| `WorkspaceRuntimeProvider.tsx` | Provides the current workspace's handle to the full-sync surface; retains while mounted. Mounted in `App.tsx` around the main `SyncProvider`. |

`useWindowTitle` resolves the active workspace label and connection label from
the Catalog when a composite workspace/session target is selected. It does not
use the ambient Desktop Host URL as that workspace's identity; the old host
matching path remains only for legacy non-workspace windows during migration.

`RuntimeAPIProvider` consumes the current handle when one is present and
overlays its workspace-owned `files`, `git`, `terminal`, `settings`, and
`permissions` implementations on the ambient API object. Git root/toplevel resolution is part
of that bound Git contract, so worktree discovery and creation do not fall back
to the active runtime endpoint. Capabilities without a workspace route yet (for
example GitHub integration and auth) remain on the ambient compatibility path
until their explicit workspace contracts are implemented. The OpenChamber-owned
permission auto-accept policy is explicitly unavailable for workspace sessions,
so it cannot persist a session policy against the wrong runtime. Workspace
settings/config CRUD is likewise unavailable: its handle implementation returns
a typed `capability_unavailable` result, so it cannot send a request to the
control plane's ambient settings endpoint. The latter must not be confused with
`RuntimeAPIs.permissions`, which is the native directory-access bridge.
File tree/editor/plan/Markdown readers likewise prefer the bound FilesAPI;
binary previews are materialized through the workspace adapter and Markdown
file-existence probes are cached by sync scope, so equal paths on two
workspaces cannot share a result.

The unified sidebar (`WorkspaceSessionsSection`) lives in
`packages/ui/src/components/session/sidebar/` and consumes the catalog +
session index stores; see that module's `DOCUMENTATION.md`.

## Feature flag: `unifiedWorkspaceSidebarV1` (plan §20)

The client has no independent flag switch — it mirrors the server capability
`workspaceCatalogV1` (operator env switch
`OPENCHAMBER_WORKSPACE_CATALOG_DISABLED=1` on the control plane; server-side
doc has the enforcement contract). The shared UI never hardcodes env vars:
`catalog-client.fetchWorkspaceCapabilities()` reads
`GET /api/workspaces/capabilities` through the control-plane pinned fetch,
and `session-index-store.refreshCapabilities()` holds the result
(`capabilities`, `capabilitiesStatus`, `capabilitiesError`).

- `SessionSidebar` (the narrowest honest wiring point — it is the only
  consumer of `WorkspaceSectionsSection`) fetches capabilities once on mount
  and derives `unifiedWorkspaceSidebarV1 = capabilities?.workspaceCatalogV1
  !== false`. Unknown (no response yet, old server, transient failure,
  control-plane unavailable) is treated as ENABLED: only an authoritative
  `false` flips the UI, and a transient blip can never hide the catalog.
- When the flag is off, the sidebar renders `WorkspaceCatalogDegradedSection`
  instead of `WorkspaceSessionsSection`: a warning banner plus the last
  catalog snapshot as a READ-ONLY list (workspace label + server label only).
  It contains no mutation affordance — no session create, no add-workspace,
  no rename/delete, no open attempts. The server additionally rejects every
  catalog/session-index mutation and workspace runtime request/upgrade with
  501 `capability_unavailable`, and the catalog data files stay untouched.
- §20.3 deviation: the plan's rollback step "close the unified sidebar, keep
  Catalog data, restore old navigation" cannot restore the old navigation —
  the fleet-era navigation was deleted in Phase 6 and there is no legacy
  navigation left to restore. The honest scope is: visible degradation state,
  no client-side mutation attempts, server-enforced 501s, and catalog data
  preserved for a later re-enable. This deviation is mirrored in the
  server-side workspaces DOCUMENTATION.md.

## Navigation invariants

- Opening a session must only change the composite current
  `workspaceId`/`sessionId` target and the bound runtime handle. The selection
  store accepts the explicit workspace ID so equal upstream IDs and directory
  names across connections cannot be guessed by tuple matching. It must NOT
  call `setControlPlane()` and must NOT clear other workspaces'
  directories or summaries.
- Native deep links, Electron tray actions, and Mini Chat window open/focus
  actions carry the optional `workspaceId` alongside the upstream session ID
  and directory. Legacy payloads without it still use the Session Index tuple
  resolver; a resolved composite target is passed directly to
  `setCurrentSession`. Workspace-targeted draft events retain the same
  `workspaceId` in `NewSessionDraftState`, so opening a new chat cannot infer a
  project or directory from the ambient runtime. A workspace-targeted Mini Chat
  binds its own
  `WorkspaceRuntimeHandle` after Catalog hydration; if that handle cannot be
  resolved it shows an explicit unavailable state instead of borrowing the
  ambient runtime.
- Embedded Context Panel chat uses the same workspace provider and bound
  `SyncProvider` as the main surface. Its directory gate reads the bound sync
  directory, and the legacy ambient directory setter is disabled for a
  workspace-targeted frame.
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
  consumes `handle.scopeKey` (the workspace scope key), the event stream runs
  on the bound SDK's SSE endpoint through
  the workspace runtime proxy, while terminal streaming uses a separate
  workspace-scoped WebSocket transport, and
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
WebSocket upgrade is wired for terminal/event streams), session actions and
sends use the handle's `OpencodeService` over that same SDK/fetch pair, while
the ambient singleton remains only for legacy non-workspace mounting,
`WorkspaceRuntimeHandle.apis`
carries workspace-bound `RuntimeAPIs` (files/git/terminal route through the
workspace prefix + control-plane fetch; terminal streaming uses a dedicated
`TerminalTransport` with a workspace-prefixed URL and control-plane-scoped
URL token), and per-workspace sync caches key by
`workspaceScopeKey(workspaceId)`. Git generation, file previews, Markdown
reference probes, and Mini Chat targets also stay on the bound workspace
adapter. New sessions are created per workspace from
the sidebar group header through `session-index-client.createWorkspaceSession`.
Capacitor mobile pins the connected server as the control plane and re-fetches
catalog/session-index revisions on resume, restores the composite target before
the legacy session fallback, and binds mobile SyncProvider/API calls through
the same workspace handle when available; VS Code surfaces an explicit
"workspace unavailable" state (no OpenChamber control plane is embedded in
the extension host yet — bridge payloads already carry optional
`workspaceId`/`controlPlane` passthrough for a future control-plane proxy).

Remaining (Phase 6, requires a compatibility release cycle per the
architecture doc): `setControlPlane` (still used by the Host Switcher /
remote-instances / mobile disconnect paths). The local control-plane project
projection has moved to Catalog: successful Catalog snapshots own the
projected local list, Catalog owns local workspace create/delete and
label/color/order writes. `projectId.ts`, the path-derived identity module,
the `useProjectsStore` VS Code folder bridge and its legacy metadata
dual-reads, `useGlobalSessionsStore`, the ambient sync scope fallback, the
`resetForRuntimeSwitch` actions, and the legacy localStorage dual-reads were
deleted in the final phase: cold session lists read the Session Index
summaries, live full-session data for the ACTIVE workspace comes from the
workspace runtime handle's SDK or the live child stores, and every
`SyncProvider` mount is workspace-scoped (no ambient fallback). The Session
Index is the cross-workspace authority and the forward path for
sidebar/catalog consumers.
While a composite workspace/session target is mounted, the legacy project
metadata store may still update its compatibility projection but does not
call the ambient directory setter; the workspace-bound SyncProvider owns that
directory.
Project-shaped worktree actions follow the same boundary: when a workspace
scope is mounted they resolve the bound Git/worktree API and bound directory,
carry the workspace target into any draft, and never update the ambient
directory or `contextStore` selection mirror. Worktree setup/config CRUD still
has no workspace-owned settings contract, so a missing settings capability is
treated as unavailable rather than routed to the old runtime.
New code must not call the old facades; the call-site list may only shrink.

#### `SyncProvider` scope-key decision (§12.2)

`sync-context.tsx` computes `scopeKey = workspaceHandle.scopeKey` — the
workspace scope key of the bound handle. There is **no ambient fallback**:
every `SyncProvider` mount is workspace-scoped.

- Workspace-targeted entry points pass the handle: `App.tsx`
  (`WorkspaceSyncMount`, `EmbeddedSessionChatRuntime`), `ElectronMiniChatApp`,
  `MobileApp` (`MobileWorkspaceSyncMount`), and `VSCodeApp` (descriptor-driven)
  all gate on the handle before mounting.
- Callers that cannot resolve a handle render an explicit state instead of
  mounting sync: the app shows the workspace selection gate (unified session
  section) while the catalog is unavailable or no session is selected, the
  VS Code webview shows the descriptor-driven loading/unavailable states, and
  Mini Chat gates on the handle.

### Store-key migration status

Session-scoped stores key exclusively on explicit workspace scope keys
(`workspaceScopeKey(workspaceId)` when the session index resolves the
`(sessionId, directory)` tuple; the unscoped bucket for unmapped sessions).
The shared resolver is `resolveSessionScopeKey` in
`packages/ui/src/sync/selection-store.ts`.

Scope-ized (workspace scope only; legacy ambient dual-reads and
`resetForRuntimeSwitch` were removed):

- `sync/selection-store.ts` (per-session model/agent/variant selections)
- `sync/viewport-store.ts` (scroll/memory state)
- `sync/session-ui-store.ts` (`setCurrentSession` memory buckets,
  last-active-session cache, worktree topology persistence, draft-target
  storage, queued-send scope guard)
- `sync/last-session-cache.ts`, `sync/worktree-topology-cache.ts`,
  `sync/runtime-live-memory.ts` (buckets keyed by the scope key passed by
  their callers)
- `stores/messageQueueStore.ts`, `stores/useSessionPinnedStore.ts`,
  `stores/useTodosPersistStore.ts`, `stores/useInlineCommentDraftStore.ts`,
  `stores/useSessionFoldersStore.ts` (outer bucket),
  `lib/chatDraftPersistence.ts`

The `useGlobalSessionsStore` compatibility facade was deleted; its consumers
read the Session Index (`session-summary.ts`) or the active workspace
handle's SDK. `useProjectsStore` is a Catalog-first projection with the
legacy VS Code folder bridge and legacy metadata dual-reads removed.

### Sync-layer scope migration

The sync layer passes the workspace scope key explicitly from `SyncProvider`
(`scopeKey = workspaceHandle.scopeKey`); there is no ambient fallback:

- `sync/child-store.ts` — children are keyed by `scopeKey\ndirectory`
  composite keys (every method accepts an explicit `scopeKey`).
- `sync/session-message-loader.ts` — request identity, invalidation and
  prefetch keys use the configured `scopeKey`.
- `sync/persist-cache.ts` — storage prefix is `storagePrefixForScope(scopeKey,
  directory)`; every pending write is workspace-scoped and always commits.
- `sync/session-prefetch-cache.ts` — composite keys use the scope.
- `sync/session-deletion-cleanup.ts` — identities carry the workspace scope
  key; cleanup commits only for a matching workspace identity.
- `sync/event-pipeline.ts` — `forceSse` makes workspace-bound sync ride the
  bound SDK's SSE stream only (never a WebSocket against the global runtime
  URL).
- `sync/use-sync.ts` — session-keyed LRU/inflight caches key by the sync
  scope.
