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
- External session targets (deep links, tray actions, notifications,
  permission/question toasts, and embedded Context Panel chat frames) carry
  `workspaceId` alongside the upstream session ID when the Session Index can
  resolve it. Legacy bare-session payloads remain readable only as a
  compatibility path.

## Modules

| File | Responsibility |
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
  call `switchRuntimeEndpoint()` and must NOT clear other workspaces'
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
  consumes `handle.scopeKey` (workspace scope key, ambient runtime key
  otherwise), the event stream runs on the bound SDK's SSE endpoint through
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
architecture doc): the VS Code folder fallback portion of
`useProjectsStore` (path-derived ids remain only at that explicit bridge),
`switchRuntimeEndpoint` (still used by the Host Switcher /
remote-instances / mobile disconnect paths), the residual
`runtimeEndpointReset` cleanup facade, and `projectId` as authoritative
identity. The local control-plane project projection has moved to Catalog:
successful Catalog snapshots own the projected local list, Catalog owns local
workspace create/delete and label/color/order writes, and legacy project
settings remain only as a dual-read metadata bridge for icons/default models.
Remote workspaces intentionally stay out of the old project tree; the unified
sidebar and Session Index are their forward path. `useGlobalSessionsStore` has
entered the migration: it remains a full-Session compatibility facade, but its
visible state is partitioned by the bound `workspace:<workspaceId>` or legacy
runtime scope, its loads use the current bound SDK, and ordinary endpoint
changes no longer reset it. The Session Index remains the cross-workspace
authority and is the forward path for new sidebar/catalog consumers.
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

### Facade call-point inventory (live)

Verified call-point inventory of the compat facades (`getRuntimeKey`,
`getRuntimeApiBaseUrl`, `switchRuntimeEndpoint`,
`subscribeRuntimeEndpointChanged/WillChange`, and the `opencodeClient`
singleton) in `packages/ui/src`, excluding tests. This table is the live
inventory required by plan §12.4: it may only decrease. Re-run
`grep -rn "getRuntimeKey()\|getRuntimeApiBaseUrl()\|switchRuntimeEndpoint(\|subscribeRuntimeEndpoint\|opencodeClient" packages/ui/src` after any change and update the table. Counts are per file and count only exact `getRuntimeKey()`/`getRuntimeApiBaseUrl()` call sites (substring matches like `targetRuntimeKey` do not count; the other facades are listed where present).

Classification:

- **workspace-bound-ok** — the call keys caches by the workspace scope key
  when one is resolvable and falls back to the ambient runtime key only for
  legacy non-workspace mounts (byte-identical keys in non-workspace mode).
- **control-plane-legit** — genuine control-plane switching/auth flows
  (bootstrap, desktop host switcher, mobile connect/disconnect, relay
  restore, SessionAuthGate token re-apply) that the audit classified as out
  of scope; also desktop host config/label resolution that is inherently
  ambient.
- **ambient-guard** — stale-runtime guards/epoch resubscriptions that run
  against the ambient key because the surface is a legacy runtime scope; the
  workspace-bound sync partitions run on explicit workspace scope keys and
  never touch these.
- **blocked-on-VSCode-descriptor** — VS Code extension host has no embedded
  OpenChamber control plane yet; must keep the ambient singleton/folder
  bridge until a control-plane proxy exists (bridge payloads already carry
  the optional `workspaceId`/`controlPlane` passthrough).
- **blocked-on-release-window** — documented Phase-6 deletion list (§15.7):
  removal requires a compatibility release cycle.

| File | `getRuntimeKey()` | `getRuntimeApiBaseUrl()` | `switchRuntimeEndpoint()` | `subscribeRuntimeEndpoint*` | Classification |
|---|---|---|---|---|---|
| `sync/sync-context.tsx` | 13 (9 scope defaults + 4 ambient guards; +2 doc mentions) | — | — | — | workspace-bound-ok (ambient defaults/guards serve legacy non-workspace sync; see scope-key decision below) |
| `sync/child-store.ts` | 1 | — | — | — | workspace-bound-ok (manager scope defaults to ambient) |
| `sync/session-prefetch-cache.ts` | 4 | — | — | — | workspace-bound-ok (explicit scope from SyncProvider) |
| `sync/persist-cache.ts` | 3 | — | — | 1 (`WillChange`) | workspace-bound-ok + ambient stale-runtime write guard |
| `sync/session-event-router.ts` | 1 | — | — | 1 (`WillChange`) | workspace-bound-ok (scope defaults to ambient; endpoint-switch clear) |
| `sync/last-session-cache.ts` | 3 | — | — | — | workspace-bound-ok (dual read legacy runtime bucket) |
| `sync/worktree-topology-cache.ts` | 1 | — | — | — | workspace-bound-ok (dual read legacy runtime bucket) |
| `sync/session-ordering.ts` | 2 | — | — | — | workspace-bound-ok (scope-partitioned; ambient normalization fallback) |
| `sync/global-session-status.ts` | 2 | — | — | — | workspace-bound-ok (scope-partitioned; ambient normalization fallback) |
| `sync/session-activity-timing.ts` | 2 | — | — | — | workspace-bound-ok (legacy bare-session records readable) |
| `sync/session-deletion-cleanup.ts` | 1 | — | — | — | workspace-bound-ok (ambient guard when identity has no workspace) |
| `sync/session-ui-store.ts` | 1 | — | — | — | workspace-bound-ok (scope-key normalization fallback) |
| `sync/selection-store.ts` | 2 | — | — | — | workspace-bound-ok (`resolveSessionScopeKey` ambient fallback) |
| `sync/session-actions.ts` | 2 | — | — | — | workspace-bound-ok (bound service/scope when provider mounted; ambient singleton fallback otherwise) |
| `sync/sync-refs.ts` | 2 | — | — | — | workspace-bound-ok (bound refs; ambient fallback before mount) |
| `sync/use-sync.ts` | 1 | — | — | — | workspace-bound-ok (`useSyncScopeKey` preferred) |
| `stores/useUIStore.ts` | 4 | — | — | 1 (`Changed`) | workspace-bound-ok (context-panel tabs scoped by workspace; ambient fallback) |
| `stores/useGitStore.ts` | 1 | — | — | 1 (`Changed`) | workspace-bound-ok |
| `stores/useFilesViewTabsStore.ts` | 2 | — | — | 1 (`Changed`) | workspace-bound-ok |
| `stores/useTerminalStore.ts` | 1 | — | — | 1 (`Changed`) | workspace-bound-ok |
| `stores/useDirectoryStore.ts` | — | — | — | 1 (`Changed`) | workspace-bound-ok (endpoint-change clear is a genuine runtime switch) |
| `stores/useGitHubPrStatusStore.ts` | 1 | — | — | — | workspace-bound-ok |
| `stores/useFileSearchStore.ts` | 1 | — | — | — | workspace-bound-ok |
| `stores/usePrContextStore.ts` | 1 | — | — | — | workspace-bound-ok |
| `stores/useMcpStore.ts` | 1 | — | — | — | workspace-bound-ok |
| `stores/useSessionPinnedStore.ts` | 3 | — | — | — | workspace-bound-ok (legacy runtime-key read path) |
| `stores/useTodosPersistStore.ts` | 2 | — | — | — | workspace-bound-ok (legacy runtime-key read path) |
| `stores/useSessionFoldersStore.ts` | 3 | — | — | — | workspace-bound-ok (outer bucket scoped; inner key stays directory) |
| `stores/useInlineCommentDraftStore.ts` | 2 | — | — | — | workspace-bound-ok (legacy runtime-key read path) |
| `stores/messageQueueStore.ts` | 1 | — | — | — | workspace-bound-ok (queued-send scope guard) |
| `stores/useGlobalSessionsStore.ts` | 2 | — | — | — | workspace-bound-ok (scope-partitioned facade; ambient before bind) |
| `stores/useConfigStore.ts` | 2 | — | — | — | workspace-bound-ok (worktree-project lookup follows SyncProvider scope) |
| `lib/opencode/client.ts` | 2 | — | — | — | workspace-bound-ok (ambient singleton itself; scopeKey-aware cache keys) |
| `lib/opencode/provider-tracker.ts` | 1 | — | — | — | ambient-guard (provider prefs are ambient until a workspace settings contract exists) |
| `lib/gitApiHttp.ts` | 3 | — | — | — | ambient-guard (legacy HTTP git cache keys; workspace paths use bound FilesAPI) |
| `lib/chatDraftPersistence.ts` | 2 | — | — | — | workspace-bound-ok (scope-keyed drafts; legacy runtime identity guard) |
| `lib/modelPrefsAutoSave.ts` | 2 | — | — | 1 (`WillChange`) | ambient-guard |
| `lib/persistence.ts` | 3 | — | — | 2 (`Changed`+`WillChange`) | ambient-guard (runtime settings mirror; workspace settings CRUD is `capability_unavailable`) |
| `lib/reviewFlow.ts` | 4 | — | — | — | ambient-guard (auto-review runtime-current guard) |
| `lib/desktop.ts` | 2 | 2 | — | — | control-plane-legit (desktop origin/API URL resolution for IPC safety) |
| `lib/desktopCurrentHost.ts` | 1 | 1 | — | — | control-plane-legit |
| `lib/desktopRelayRestore.ts` | 5 | 2 | 5 | 1 (`Changed`) | control-plane-legit (relay restore) |
| `lib/projectMeta.ts` | — | 1 | — | — | blocked-on-release-window (legacy project metadata bridge) |
| `lib/openchamberEvents.ts` | — | — | — | 1 (`Changed`) | control-plane-legit (endpoint-change epoch) |
| `lib/gitApi.ts` | — | — | — | — | blocked-on-VSCode-descriptor (prompt via ambient SDK; VS Code bridge) |
| `contexts/ThemeSystemContext.tsx` | 3 | — | — | 1 (`Changed`) | ambient-guard (custom theme request generation) |
| `contexts/content-cache-owner.ts` | — | — | — | 1 (`WillChange`) | control-plane-legit (cache invalidation on endpoint change) |
| `App.tsx` | 2 | — | — | 1 (`Changed`) | workspace-bound-ok (ambient selection guard for legacy mounts) |
| `apps/MobileApp.tsx` | 1 | 6 | 4 | 1 (`Changed`) | control-plane-legit (connect/disconnect) + workspace-bound-ok mounts |
| `apps/mobileConnections.ts` | 2 (+1 doc mention) | 2 | 2 | — | control-plane-legit (mobile connect/disconnect) |
| `apps/mobileWorkspaceResume.ts` | 1 | — | — | — | workspace-bound-ok (legacy runtime resume fallback) |
| `apps/mobileWidgetSnapshot.ts` | 1 | — | — | — | ambient-guard (widget snapshot runtime key) |
| `apps/AppEffects.tsx` | 1 | 1 | — | 1 (`Changed`) | control-plane-legit (runtime push to desktop) |
| `apps/runtimeEndpointReset.ts` | — | — | — | — | control-plane-legit (fires only on genuine endpoint changes; verified) |
| `apps/VSCodeApp.tsx` | — | — | — | — | blocked-on-VSCode-descriptor (SyncProvider without workspaceHandle) |
| `apps/ElectronMiniChatApp.tsx` | — | — | — | — | workspace-bound-ok (workspace target via control plane; ambient only for non-workspace windows) |
| `apps/deepLinks.ts` / `apps/deepLinkNavigation.ts` | — | — | — | — | workspace-bound-ok (intent carries `workspaceId`) |
| `components/auth/SessionAuthGate.tsx` | 1 | 2 | 1 | 1 (`Changed`) | control-plane-legit (token re-apply after runtime switch) |
| `components/desktop/DesktopHostSwitcher.tsx` | — | — | 4 | 1 (`Changed`) | control-plane-legit (Host Switcher) |
| `components/sections/remote-instances/RemoteInstancesPage.tsx` | — | 3 | 1 | — | control-plane-legit (remote instances page) |
| `components/sections/openchamber/DesktopNetworkSettings.tsx` | — | 1 | — | — | control-plane-legit |
| `components/sections/openchamber/TunnelSettings.tsx` | — | 1 | — | — | control-plane-legit |
| `components/sections/openchamber/OpenChamberPage.tsx` | — | — | — | 1 (`Changed`) | control-plane-legit (settings epoch) |
| `components/sections/openchamber/OpenChamberVisualSettings.tsx` | — | — | — | 1 (`Changed`) | control-plane-legit (settings epoch) |
| `components/sections/mcp/startMcpAuthorization.ts` | — | 1 | — | — | control-plane-legit (OAuth callback origin) |
| `components/views/FilesView.tsx` | — | 1 | — | — | control-plane-legit (download/preview origin) |
| `components/layout/ContextPanel.tsx` | 1 | 4 | — | — | ambient-guard (proxy cache key + URL auth token refresh on ambient origin) |
| `components/layout/SidebarFilesTree.tsx` | 1 | — | — | — | workspace-bound-ok (`handle?.scopeKey ?? getRuntimeKey()`) |
| `components/layout/Header.tsx` | — | — | — | 1 (`Changed`) | control-plane-legit (header epoch) |
| `components/update/OpenCodeUpdateToast.tsx` | 3 | — | — | 1 (`Changed`) | ambient-guard (update check is per-runtime) |
| `components/chat/AutoReviewBanner.tsx` | 1 | — | — | — | ambient-guard (auto-review run matching) |
| `components/chat/ChatInput.tsx` | 1 | — | — | — | ambient-guard (auto-review run matching) |
| `components/comments/useInlineCommentController.ts` | 1 | — | — | — | workspace-bound-ok (legacy runtime-key read path) |
| `components/session/sidebar/hooks/useAuthoritativeSessionCleanup.ts` | 1 | — | — | — | workspace-bound-ok (retention cleanup on ambient scope) |
| `components/session/DirectoryExplorerDialog.tsx` | — | — | — | — | blocked-on-release-window (ambient filesystem home/browse via singleton) |
| `hooks/useTraySync.ts` | 1 | 1 | — | — | workspace-bound-ok (workspace-first identity; ambient instance label/routing key only when no workspace) |
| `hooks/useWindowTitle.ts` | — | 1 | — | — | workspace-bound-ok (Catalog label first; ambient host matching only for legacy non-workspace windows) |
| `hooks/useQueuedMessageAutoSend.ts` | 1 | — | — | — | workspace-bound-ok (queued-send scope guard) |
| `hooks/useWebNotificationStream.ts` | — | — | — | — | workspace-bound-ok (payload carries `workspaceId`) |
| `sync/notification-store.ts` | — | — | — | — | workspace-bound-ok (composite `workspaceSessionKey` when workspace known) |
| `workspaces/control-plane-fetch.ts` | — | 2 | — | — | control-plane-legit (local control-plane origin resolution — pinned, never follows Active Runtime) |
| `workspaces/workspace-runtime-registry.ts` | — | — | — | — | workspace-bound-ok (per-workspace handles; no ambient singleton calls) |

The `opencodeClient` singleton remains the ambient compatibility client for:
legacy non-workspace SyncProvider mounts (`App.tsx`, `ElectronMiniChatApp`,
`MobileApp` fallback SDK), the VS Code folder bridge (`VSCodeApp.tsx`,
`useProjectsStore`, `gitApi.ts` — blocked-on-VSCode-descriptor), the
filesystem-home/browse/clone surface (`DirectoryExplorerDialog.tsx` —
blocked-on-release-window), and diagnostics (`lib/debug.ts`,
`lib/startupTrace.ts`). Every workspace-bound sync consumer holds the bound
`OpencodeService`/SDK from the runtime registry instead and does not consult
the singleton while a workspace provider is mounted.

#### `SyncProvider` scope-key decision (§12.2)

`sync-context.tsx` computes `scopeKey = workspaceHandle?.scopeKey ??
getRuntimeKey()`. The ambient fallback is **retained and documented, not
removed**: not every real `SyncProvider` caller carries a workspace.

- Workspace-targeted entry points pass the handle's explicit scope key:
  `App.tsx` (`WorkspaceSyncMount`, `EmbeddedSessionChatRuntime`),
  `ElectronMiniChatApp.tsx`, `MobileApp.tsx` (`MobileWorkspaceSyncMount`) all
  pass `workspaceHandle={handle}` with `handle.scopeKey` set.
- Callers that legitimately have no workspace keep the fallback:
  `VSCodeApp.tsx` mounts `SyncProvider` with no `workspaceHandle` at all
  (blocked-on-VSCode-descriptor), and the legacy non-workspace mounts of
  `App.tsx`/`ElectronMiniChatApp`/`MobileApp` deliberately pass
  `workspaceHandle={null}` to preserve the ambient runtime scope
  (byte-identical keys, so persisted data stays readable).

The fallback is therefore never exercised by a migrated entry point; when the
VS Code control-plane proxy lands and the legacy ambient mounts are deleted
(§15.7), the `?? getRuntimeKey()` may be dropped from `SyncProvider`.

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

Still ambient (intentionally global or Phase-6 legacy): the VS Code folder
fallback bridge in `useProjectsStore`, the legacy project-worktree selection
mirror in `contextStore`, and the fleet-era caches. The local control-plane
projection is Catalog-backed
but retains the old hook shape for compatibility. The
`useGlobalSessionsStore` compatibility facade is now scope-partitioned, but
its public hook shape is still ambient/current-scope and its replacement by
Session Index summaries plus workspace-bound full-session consumers remains a
later cleanup. Folders' inner scope key stays the caller-provided
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
