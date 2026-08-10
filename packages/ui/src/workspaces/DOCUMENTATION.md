# Workspaces module (shared UI)

Ownership: `packages/ui/src/workspaces/*` — the renderer side of the unified
Workspace Catalog, the workspace runtime registry and the unified Add
Workspace flow. Server mirror: `packages/web/server/lib/workspaces/`.

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
| `catalog-client.ts` | Control-plane HTTP client (via `runtimeFetch`); 409 `catalog_revision_conflict` surfaces as `CatalogClientError`. Never talks to a remote runtime URL directly. |
| `catalog-store.ts` | Zustand store: authoritative snapshot hydration (failure keeps prior snapshot and marks `error` — never empty success), optimistic update/delete with rollback, create via server canonicalization (never optimistic), conflict replay after re-fetch. |
| `AddWorkspaceDialog.tsx` | Unified server + path + name + color flow. Probe/browse go through connection-scoped catalog endpoints; input is preserved on failure; a lost create response is deduped server-side. |
| `workspace-runtime-fetch.ts` | Pure workspace-prefix path rewriting; mirrors the server proxy contract. |
| `workspace-runtime-registry.ts` | Per-workspace handles (SDK client on the control-plane workspace base URL + scope key + URL resolver) with lease/retain and bounded LRU; no global endpoint mutation. |
| `WorkspaceRuntimeProvider.tsx` | Provides the current workspace's handle to the full-sync surface; retains while mounted. |

## Navigation invariants

- Opening a session must only change the current `workspaceId`/`sessionId`
  and the bound runtime handle. It must NOT call `switchRuntimeEndpoint()`
  and must NOT clear other workspaces' directories or summaries.
- The registry's handle requests always go to the CURRENT control plane
  through the workspace prefix; the server resolves the connection and
  injects upstream auth.

## Migration status

Phase 1 is live: the catalog is hydrated at boot (AppEffects
`WorkspaceCatalogBridge`), the Add Workspace dialog writes the catalog and
mirrors local workspaces into the legacy projects store for the compatibility
period (remote workspaces never enter the legacy store). The legacy sidebar,
`useProjectsStore` (path-derived ids, API-base-URL-sliced storage),
`useGlobalSessionsStore`, fleet stores and `switchRuntimeEndpoint` remain
until the unified sidebar and session index land (Phases 4+). New code must
not call the old facades; the call-site list may only shrink.
