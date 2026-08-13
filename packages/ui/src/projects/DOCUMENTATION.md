# Projects module (shared UI)

Ownership: `packages/ui/src/projects/*` — the renderer side of the unified
Project Catalog, the Session Index, the project runtime registry and the
unified Add Project flow. Server mirror:
`packages/web/server/lib/projects/`.

## Identity invariants

- `projectId` is a stable random UUID from the server; it is never computed
  from paths, URLs or server names, and the client never generates one.
- Scope keys (`projectScopeKey`, `projectSessionKey`) in `identity.ts`
  must stay byte-compatible with the server's `project-identity.js`
  (NUL-separated composite keys; contract tests cover unicode/slashes/
  collisions).
- No component may guess project membership from `window.location`,
  `getControlPlaneBaseUrl()` or a global runtime key. The catalog is the only
  source of project membership.
- External session targets (deep links, tray actions, notifications,
  permission/question toasts, and embedded Context Panel chat frames) carry
  `projectId` alongside the upstream session ID when the Session Index can
  resolve it. Legacy bare-session payloads remain readable only as a
  compatibility path.

## Modules

| File | `setControlPlane()` | `subscribeControlPlane*` | Classification |
|---|---|
| `types.ts` | Shared public types + `CatalogClientError`. No local/remote branches. |
| `identity.ts` | Scope/session key helpers (renderer mirror of the server identity module). |
| `control-plane-fetch.ts` | Pinned fetch for EVERY project-owned request (catalog, session index, project SDK clients). Resolves the LOCAL control plane in priority order: an explicit `setControlPlaneOrigin(...)` injection (Capacitor mobile pins the connected OpenChamber server after a capability probe), `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop loopback), then the window origin (deployment path prefix preserved when the active runtime IS the control plane) — and NEVER follows the Active Runtime, so switching to a remote server must not move the unified catalog. Runtimes with NO control plane (non-http webview origins like `vscode-webview://`/`capacitor://localhost` with no injection) get an explicit `control_plane_unavailable` 501 response — never a request to the wrong target and never a silent empty success. In relay mode the request rides `runtimeFetch` on the window (virtual) origin so the E2EE tunnel carries it. Attaches the bearer only when it belongs to the control plane; other requests rely on the UI session cookie. |
| `catalog-client.ts` | Control-plane HTTP client (via the pinned control-plane fetch); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`; connection CRUD (create/update/delete); `probeConnection` returns `{ ok, latencyMs?, error?, authRequired? }` (round-trip latency measured client-side); `fetchProjectCapabilities()` reads `GET /api/projects/capabilities` (plan §20 flag read that stays available when the catalog is disabled). Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success; stale refresh responses are generation-guarded), optimistic update/delete with ENTITY-SCOPED rollback (a failed mutation never wipes concurrent successes elsewhere), create via server canonicalization (never optimistic), and 409 conflict replay after re-fetch for create/update/delete. |
| `AddProjectDialog.tsx` | Unified server + path + name + color flow with an inline "Add server…" form (label + URL + optional token) that registers a direct connection; after registration the dialog probes the new connection: on success it advances straight to the path step (the user can immediately browse and add a project), on failure it stays on the form with retry/continue (the server is registered either way); probe/browse go through connection-scoped catalog endpoints; browse responses are generation-guarded so a slow old server response cannot overwrite a newer selection; parent-path navigation handles POSIX, Windows drive and UNC roots; input is preserved on failure; a lost create response is deduped server-side. |
| `session-index-client.ts` | Snapshot/create/bind API calls plus the SSE events stream (revision-carrying incremental events, exponential backoff with healthy-stream reset, deterministic ±20% jitter seeded per stream and clamped to the 1s→30s bounds — §17.5, non-numeric revisions dropped) — all through the control-plane pinned fetch. |
| `session-index-store.ts` | Renderer Session Index: revision-gap detection (gap → re-fetch snapshot), clone-on-write event reducers, per-connection freshness including `offline`/`stale`/partial coverage; failure never empties a prior snapshot. Reducer work is proportional to the affected entity (§17.5): a `sessionIndex` Map (key→array position) makes upsert membership/position O(1) and removal O(1)-checked — `applyEvent` never scans the sessions array. Also hosts the `projectCatalogV1` capability state (`capabilities` + `refreshCapabilities()`, plan §20) on a separate channel — a failed read marks `capabilitiesError` and keeps the prior value, and unknown is treated as enabled; only an authoritative `false` flips the unified sidebar to its read-only degradation state. Also hosts `resolveActiveProjectId` (pure project-derivation helper). |
| `useActiveProject.ts` | Derives the ACTIVE project from the current session selection (session index is authoritative; null for non-project sessions keeps the legacy ambient path) plus `useActiveProjectCapabilities`/`resolveActiveProjectCapabilities` — the connection capabilities of the active project, used by capability gates (terminal etc.); null while the catalog has no authoritative snapshot means "do not gate". |
| `project-runtime-fetch.ts` | Pure project-prefix path rewriting; mirrors the server proxy contract (loopback-origin rewriting when `window` is absent). |
| `project-runtime-registry.ts` | Per-project handles (SDK client and `OpencodeService` facade on the control-plane project base URL via the pinned control-plane fetch + scope key + URL resolver) with lease/retain and bounded LRU; never-retained handles are evictable; no global endpoint mutation. |
| `project-runtime-context.ts` | Context value + `useProjectRuntime` hook (split from the provider for fast-refresh lint rules). |
| `ProjectRuntimeProvider.tsx` | Provides the current project's handle to the full-sync surface; retains while mounted. Mounted in `App.tsx` around the main `SyncProvider`. |

`useWindowTitle` resolves the active project label and connection label from
the Catalog when a composite project/session target is selected. It does not
use the ambient Desktop Host URL as that project's identity; the old host
matching path remains only for legacy non-project windows during migration.

`ConnectionProfileSummary.lastProbeOkAt` (epoch ms of the last successful live
probe, recorded server-side) is the shared connection-status signal consumed by
the unified sidebar and the Settings Servers page
(`components/sections/servers/` — page + sidebar + page-local UI store).
`ConnectionProfileSummary.kind` (`local`/`direct`/`ssh`/`relay`, non-secret
server projection) lets the Servers page type connections: `ssh` connections
(desktop only) show the ssh-manager tunnel phase and connect/disconnect/retry
actions through `useDesktopSshStore`, and removing an `ssh` connection also
disposes its ssh-manager instance (best-effort). SSH instance creation from
the Add Project dialog's server form reuses the same store, so the tunnel
lifecycle stays ssh-manager-owned and renderers never touch tunnel URLs or
credentials. Device pairing/remote clients are a separate concept and live on
the Settings Devices page (`components/sections/devices/DevicesPage.tsx`,
slug `devices`), extracted from the legacy Remote Instances page. The legacy
page now keeps only the desktop direct-hosts surface (the host switcher has
no hosts CRUD) behind its `hiddenInNav` entry; its SSH instance management
was deleted once the Servers page owned the SSH connection lifecycle.

`RuntimeAPIProvider` consumes the current handle when one is present and
overlays its project-owned `files`, `git`, `terminal`, `settings`, and
`permissions` implementations on the ambient API object. Git root/toplevel resolution is part
of that bound Git contract, so worktree discovery and creation do not fall back
to the active runtime endpoint. Capabilities without a project route yet (for
example GitHub integration and auth) remain on the ambient compatibility path
until their explicit project contracts are implemented. The OpenChamber-owned
permission auto-accept policy is explicitly unavailable for project sessions,
so it cannot persist a session policy against the wrong runtime. Project
settings/config CRUD is likewise unavailable: its handle implementation returns
a typed `capability_unavailable` result, so it cannot send a request to the
control plane's ambient settings endpoint. The latter must not be confused with
`RuntimeAPIs.permissions`, which is the native directory-access bridge.
File tree/editor/plan/Markdown readers likewise prefer the bound FilesAPI;
binary previews are materialized through the project adapter and Markdown
file-existence probes are cached by sync scope, so equal paths on two
projects cannot share a result.

The unified sidebar (`ProjectSessionsSection`) lives in
`packages/ui/src/components/session/sidebar/` and consumes the catalog +
session index stores; see that module's `DOCUMENTATION.md`.

## Feature flag: `unifiedProjectSidebarV1` (plan §20)

The client has no independent flag switch — it mirrors the server capability
`projectCatalogV1` (operator env switch
`OPENCHAMBER_WORKSPACE_CATALOG_DISABLED=1` on the control plane; server-side
doc has the enforcement contract). The shared UI never hardcodes env vars:
`catalog-client.fetchProjectCapabilities()` reads
`GET /api/projects/capabilities` through the control-plane pinned fetch,
and `session-index-store.refreshCapabilities()` holds the result
(`capabilities`, `capabilitiesStatus`, `capabilitiesError`).

- `SessionSidebar` (the narrowest honest wiring point — it is the only
  consumer of `ProjectSessionsSection`) fetches capabilities once on mount
  and derives `unifiedProjectSidebarV1 = capabilities?.projectCatalogV1
  !== false`. Unknown (no response yet, old server, transient failure,
  control-plane unavailable) is treated as ENABLED: only an authoritative
  `false` flips the UI, and a transient blip can never hide the catalog.
- When the flag is off, the sidebar renders `ProjectCatalogDegradedSection`
  instead of `ProjectSessionsSection`: a warning banner plus the last
  catalog snapshot as a READ-ONLY list (project label + server label only).
  It contains no mutation affordance — no session create, no add-project,
  no rename/delete, no open attempts. The server additionally rejects every
  catalog/session-index mutation and project runtime request/upgrade with
  501 `capability_unavailable`, and the catalog data files stay untouched.
- §20.3 deviation: the plan's rollback step "close the unified sidebar, keep
  Catalog data, restore old navigation" cannot restore the old navigation —
  the fleet-era navigation was deleted in Phase 6 and there is no legacy
  navigation left to restore. The honest scope is: visible degradation state,
  no client-side mutation attempts, server-enforced 501s, and catalog data
  preserved for a later re-enable. This deviation is mirrored in the
  server-side projects DOCUMENTATION.md.

## Navigation invariants

- Opening a session must only change the composite current
  `projectId`/`sessionId` target and the bound runtime handle. The selection
  store accepts the explicit project ID so equal upstream IDs and directory
  names across connections cannot be guessed by tuple matching. It must NOT
  call `setControlPlane()` and must NOT clear other projects'
  directories or summaries.
- Native deep links, Electron tray actions, and Mini Chat window open/focus
  actions carry the optional `projectId` alongside the upstream session ID
  and directory. Legacy payloads without it still use the Session Index tuple
  resolver; a resolved composite target is passed directly to
  `setCurrentSession`. Project-targeted draft events retain the same
  `projectId` in `NewSessionDraftState`, so opening a new chat cannot infer a
  project or directory from the ambient runtime. A project-targeted Mini Chat
  binds its own
  `ProjectRuntimeHandle` after Catalog hydration; if that handle cannot be
  resolved it shows an explicit unavailable state instead of borrowing the
  ambient runtime.
- Embedded Context Panel chat uses the same project provider and bound
  `SyncProvider` as the main surface. Its directory gate reads the bound sync
  directory, and the legacy ambient directory setter is disabled for a
  project-targeted frame.
- The registry's handle requests always go to the CURRENT control plane
  through the project prefix; the server resolves the connection and
  injects upstream auth.
- Current behavior: when a project session is selected, the main app's
  `SyncProvider` runs against the project-bound handle (SDK on the
  project prefix + project directory) and is keyed by projectId, so
  switching between projects remounts the sync WITHOUT a global runtime
  switch — the same server, the right project, no state bleed. LOCAL AND
  REMOTE project sessions now open through the same unified selection path
  (the old "coming with the sync migration" notice was removed): the sync
  consumes `handle.scopeKey` (the project scope key), the event stream runs
  on the bound SDK's SSE endpoint through
  the project runtime proxy, while terminal streaming uses a separate
  project-scoped WebSocket transport, and
  project-scoped caches (child stores, message loader, persist cache,
  prefetch cache, deletion cleanup) key by `projectScopeKey(projectId)`
  so equal paths/session IDs on different servers never collide. Clicking a
  session never switches the global runtime endpoint.

## Migration status

Phases 1–4 are live: catalog + session index hydration at boot
(`ProjectCatalogBridge` / `ProjectSessionIndexBridge` in AppEffects — both pinned
to the local control plane, so runtime endpoint changes never swap the
catalog), the unified Add Project dialog (with inline server registration),
and the unified sidebar that replaced the fleet section. The renderer fleet
observation layer (`packages/ui/src/fleet/`) was removed in Phase 6; its
coordination algorithms live in the session index. The project runtime
registry/provider is now MOUNTED (App.tsx) and the full sync consumes the
project handle for BOTH local and remote projects: session open goes
through the unified selection path, the event stream rides the bound SDK's
SSE endpoint via the project runtime proxy (and the server-side project
WebSocket upgrade is wired for terminal/event streams), session actions and
sends use the handle's `OpencodeService` over that same SDK/fetch pair, while
the ambient singleton remains only for legacy non-project mounting,
`ProjectRuntimeHandle.apis`
carries project-bound `RuntimeAPIs` (files/git/terminal route through the
project prefix + control-plane fetch; terminal streaming uses a dedicated
`TerminalTransport` with a project-prefixed URL and control-plane-scoped
URL token), and per-project sync caches key by
`projectScopeKey(projectId)`. Git generation, file previews, Markdown
reference probes, and Mini Chat targets also stay on the bound project
adapter. New sessions are created per project from
the sidebar group header through `session-index-client.createProjectSession`.
Capacitor mobile pins the connected server as the control plane and re-fetches
catalog/session-index revisions on resume, restores the composite target before
the legacy session fallback, and binds mobile SyncProvider/API calls through
the same project handle when available; VS Code surfaces an explicit
"project unavailable" state (no OpenChamber control plane is embedded in
the extension host yet — bridge payloads already carry optional
`projectId`/`controlPlane` passthrough for a future control-plane proxy).

Remaining (Phase 6, requires a compatibility release cycle per the
architecture doc): `setControlPlane` (still used by the Host Switcher /
remote-instances / mobile disconnect paths). The local control-plane project
projection has moved to Catalog: successful Catalog snapshots own the
projected local list, Catalog owns local project create/delete and
label/color/order writes. `projectId.ts`, the path-derived identity module,
the `useProjectsStore` VS Code folder bridge and its legacy metadata
dual-reads, `useGlobalSessionsStore`, the ambient sync scope fallback, the
`resetForRuntimeSwitch` actions, and the legacy localStorage dual-reads were
deleted in the final phase: cold session lists read the Session Index
summaries, live full-session data for the ACTIVE project comes from the
project runtime handle's SDK or the live child stores, and every
`SyncProvider` mount is project-scoped (no ambient fallback). The Session
Index is the cross-project authority and the forward path for
sidebar/catalog consumers.
While a composite project/session target is mounted, the legacy project
metadata store may still update its compatibility projection but does not
call the ambient directory setter; the project-bound SyncProvider owns that
directory.
Project-shaped worktree actions follow the same boundary: when a project
scope is mounted they resolve the bound Git/worktree API and bound directory,
carry the project target into any draft, and never update the ambient
directory or `contextStore` selection mirror. Worktree setup/config CRUD still
has no project-owned settings contract, so a missing settings capability is
treated as unavailable rather than routed to the old runtime.
New code must not call the old facades; the call-site list may only shrink.

#### `SyncProvider` scope-key decision (§12.2)

`sync-context.tsx` computes `scopeKey = projectHandle.scopeKey` — the
project scope key of the bound handle. There is **no ambient fallback**:
every `SyncProvider` mount is project-scoped.

- Project-targeted entry points pass the handle: `App.tsx`
  (`ProjectSyncMount`, `EmbeddedSessionChatRuntime`), `ElectronMiniChatApp`,
  `MobileApp` (`MobileProjectSyncMount`), and `VSCodeApp` (descriptor-driven)
  all gate on the handle before mounting.
- Callers that cannot resolve a handle render an explicit state instead of
  mounting sync: the app shows the project selection gate (unified session
  section) while the catalog is unavailable or no session is selected, the
  VS Code webview shows the descriptor-driven loading/unavailable states, and
  Mini Chat gates on the handle. On the desktop shell cold start the app
  auto-selects the local project matching the restored directory (falling
  back to the first local project) so the main layout mounts immediately;
  an explicit session/draft selection always wins.

### Store-key migration status

Session-scoped stores key exclusively on explicit project scope keys
(`projectScopeKey(projectId)` when the session index resolves the
`(sessionId, directory)` tuple; the unscoped bucket for unmapped sessions).
The shared resolver is `resolveSessionScopeKey` in
`packages/ui/src/sync/selection-store.ts`.

Scope-ized (writes are project-scope only; legacy ambient dual-reads and
`resetForRuntimeSwitch` were removed, with two intentional compatibility
reads kept: selection-store's in-memory legacy maps for bare session-ID
version-1 data, and session-ui-store's one-time promotion of the unscoped
draft-target key):

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
read the Session Index (`session-summary.ts`) or the active project
handle's SDK. `useProjectsStore` is a Catalog-first projection with the
legacy VS Code folder bridge and legacy metadata dual-reads removed.

### Sync-layer scope migration

The sync layer passes the project scope key explicitly from `SyncProvider`
(`scopeKey = projectHandle.scopeKey`); there is no ambient fallback:

- `sync/child-store.ts` — children are keyed by `scopeKey\ndirectory`
  composite keys (every method accepts an explicit `scopeKey`).
- `sync/session-message-loader.ts` — request identity, invalidation and
  prefetch keys use the configured `scopeKey`.
- `sync/persist-cache.ts` — storage prefix is `storagePrefixForScope(scopeKey,
  directory)`; every pending write is project-scoped and always commits.
- `sync/session-prefetch-cache.ts` — composite keys use the scope.
- `sync/session-deletion-cleanup.ts` — identities carry the project scope
  key; cleanup commits only for a matching project identity.
- `sync/event-pipeline.ts` — `forceSse` makes project-bound sync ride the
  bound SDK's SSE stream only (never a WebSocket against the global runtime
  URL).
- `sync/use-sync.ts` — session-keyed LRU/inflight caches key by the sync
  scope.
