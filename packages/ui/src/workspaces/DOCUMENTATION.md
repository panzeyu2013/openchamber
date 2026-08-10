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
| `control-plane-fetch.ts` | Pinned fetch for EVERY workspace-owned request (catalog, session index, workspace SDK clients). Resolves the LOCAL control plane (`__OPENCHAMBER_LOCAL_ORIGIN__` on desktop, window origin elsewhere, deployment path prefix preserved) and NEVER follows the Active Runtime — switching to a remote server must not move the unified catalog. Attaches the bearer only when it belongs to the control plane; other requests rely on the UI session cookie. |
| `catalog-client.ts` | Control-plane HTTP client (via the pinned control-plane fetch); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`; connection CRUD (create/update/delete). Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success; stale refresh responses are generation-guarded), optimistic update/delete with ENTITY-SCOPED rollback (a failed mutation never wipes concurrent successes elsewhere), create via server canonicalization (never optimistic), and 409 conflict replay after re-fetch for create/update/delete. |
| `AddWorkspaceDialog.tsx` | Unified server + path + name + color flow with an inline "Add server…" form (label + URL + optional token) that registers a direct connection; probe/browse go through connection-scoped catalog endpoints; browse responses are generation-guarded so a slow old server response cannot overwrite a newer selection; parent-path navigation handles POSIX, Windows drive and UNC roots; input is preserved on failure; a lost create response is deduped server-side. |
| `session-index-client.ts` | Snapshot/create/bind API calls plus the SSE events stream (revision-carrying incremental events, exponential backoff with healthy-stream reset, non-numeric revisions dropped) — all through the control-plane pinned fetch. |
| `session-index-store.ts` | Renderer Session Index: revision-gap detection (gap → re-fetch snapshot), clone-on-write event reducers, per-connection freshness; failure never empties a prior snapshot. Also hosts `resolveActiveWorkspaceId` (pure workspace-derivation helper). |
| `useActiveWorkspace.ts` | Derives the ACTIVE workspace from the current session selection (session index is authoritative; null for non-workspace sessions keeps the legacy ambient path). |
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
  switching between local workspaces remounts the sync WITHOUT a global
  runtime switch — the same server, the right workspace, no state bleed.
  Remote workspace sessions still render full offline/stale semantics and
  their click shows a "coming with the sync migration" notice — they never
  switch the global runtime endpoint.

## Migration status

Phases 1–4 are live: catalog + session index hydration at boot
(`WorkspaceCatalogBridge` / `SessionIndexBridge` in AppEffects — both pinned
to the local control plane, so runtime endpoint changes never swap the
catalog), the unified Add Workspace dialog (with inline server registration),
and the unified sidebar that replaced the fleet section. The renderer fleet
observation layer (`packages/ui/src/fleet/`) was removed in Phase 6; its
coordination algorithms live in the session index. The workspace runtime
registry/provider is now MOUNTED (App.tsx) and the full sync consumes the
workspace handle for local workspaces. Remaining: remote workspace full-sync
(click currently shows the migration notice), `useProjectsStore`
(path-derived ids, API-base-URL-sliced storage), `useGlobalSessionsStore`,
`switchRuntimeEndpoint` (still used by the Host Switcher / remote-instances /
mobile disconnect paths), `runtimeEndpointReset`, and the store-key migration
for all sync caches to explicit workspace scope. New code must not call the
old facades; the call-site list may only shrink.
