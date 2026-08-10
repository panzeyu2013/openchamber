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
| `catalog-client.ts` | Control-plane HTTP client (via `runtimeFetch`); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`; connection CRUD (create/update/delete). Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success), optimistic update/delete with rollback, create via server canonicalization (never optimistic), conflict replay after re-fetch. |
| `AddWorkspaceDialog.tsx` | Unified server + path + name + color flow with an inline "Add server…" form (label + URL + optional token) that registers a direct connection; probe/browse go through connection-scoped catalog endpoints; input is preserved on failure; a lost create response is deduped server-side. |
| `session-index-client.ts` | Snapshot/create/bind API calls plus the SSE events stream (revision-carrying incremental events, exponential backoff with healthy-stream reset, non-numeric revisions dropped). |
| `session-index-store.ts` | Renderer Session Index: revision-gap detection (gap → re-fetch snapshot), clone-on-write event reducers, per-connection freshness; failure never empties a prior snapshot. |
| `workspace-runtime-fetch.ts` | Pure workspace-prefix path rewriting; mirrors the server proxy contract (loopback-origin rewriting when `window` is absent). |
| `workspace-runtime-registry.ts` | Per-workspace handles (SDK client on the control-plane workspace base URL + scope key + URL resolver) with lease/retain and bounded LRU; never-retained handles are evictable; no global endpoint mutation. |
| `workspace-runtime-context.ts` | Context value + `useWorkspaceRuntime` hook (split from the provider for fast-refresh lint rules). |
| `WorkspaceRuntimeProvider.tsx` | Provides the current workspace's handle to the full-sync surface; retains while mounted. **Not yet mounted anywhere** — it is the integration point for the workspace-bound SyncProvider migration (knip reports it as unused by design). |

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
- Current behavior: local workspace sessions open through the normal
  selection path; remote workspace sessions render full offline/stale
  semantics and their click shows a "coming with the sync migration" notice —
  they never switch the global runtime endpoint.

## Migration status

Phases 1–4 are live: catalog + session index hydration at boot
(`WorkspaceCatalogBridge` / `SessionIndexBridge` in AppEffects), the unified
Add Workspace dialog (with inline server registration), and the unified
sidebar that replaced the fleet section. The renderer fleet observation layer
(`packages/ui/src/fleet/`) was removed in Phase 6; its coordination
algorithms live in the session index. Remaining: `useProjectsStore`
(path-derived ids, API-base-URL-sliced storage), `useGlobalSessionsStore`,
`switchRuntimeEndpoint` (still used by the Host Switcher / remote-instances /
mobile disconnect paths), `runtimeEndpointReset`, and the workspace-bound
SyncProvider migration (mounts `WorkspaceRuntimeProvider` and makes remote
session opening real). New code must not call the old facades; the call-site
list may only shrink.
