# Workspaces module (server)

Ownership: `packages/web/server/lib/workspaces/*` — the control plane's
unified Workspace Catalog, connection profiles, connection broker, workspace
runtime proxy and legacy migration.

## Contract

The product has exactly one first-class navigation entity: **workspace**
(`connectionId + canonicalPath`, stable random UUID id). Sessions belong to
workspaces. There is no `isLocal`/`isRemote`/`projectType` anywhere in the
catalog model; connection kind exists only inside broker adapters.

```
local unified catalog -> workspace(connectionId + path) -> session(workspaceId + upstreamSessionId)
                       -> workspace-bound runtime handle -> server-side connection adapter
```

## Modules

| File | Responsibility |
|---|---|
| `workspace-identity.js` | UUID ids, workspace/session scope keys, location keys. Renderer mirror: `packages/ui/src/workspaces/identity.ts` (must stay byte-compatible; contract tests cover slashes/unicode/collisions). |
| `catalog-schema.js` | Runtime validation of the on-disk document (unknown schema version → failure, never empty), public DTO serializers (`toConnectionSummary` is the ONLY serializer allowed to project a private record; never spread private records). |
| `catalog-store.js` | Atomic load/write with revision, backup file, serialized mutation queue, If-Match conflicts (`catalog_revision_conflict` → 409). Corrupt primary recovers from backup or fails loudly; a corrupt catalog is never an empty catalog. Credentials never live here. |
| `connection-profile-store.js` | Private connection records (targets, credential refs) in their own file. `kind` only appears here and in adapters. Loading failure is a config failure, never a reason to drop catalog workspaces. |
| `connection-broker.js` | Adapter registry by connectionId + lease lifecycle (idle grace → `dispose()`). Catalog presence ≠ open tunnel. |
| `local-adapter.js` | The built-in `local` connection: canonicalize/probe/browse on the control plane machine, HTTP/SSE forwarding to the local OpenCode runtime with injected upstream auth (never echoed to browsers). WS forwarding is `capability_unavailable` until wired. |
| `migration.js` | Idempotent, resumable import of legacy `settings.projects` (local connection only). Missing paths go to `pendingConnectionIds`; failures never look like an authoritative empty list. Legacy data stays readable for the compatibility period (dual read); deletion is a later, separate, audited step. |
| `routes.js` | Catalog API: `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`, `GET /api/workspaces/:id`, probes, connection-scoped browse. All behind the base UI auth gate. |
| `runtime-proxy.js` | `/api/workspaces/:workspaceId/runtime/*`: resolves the workspace server-side, forwards only `/api/...` paths to the connection adapter with streaming body, sanitized response headers, lease per request. WS upgrades not yet wired. |

## Registration order (server/index.js)

The workspaces runtime is created and its routes registered AFTER the base UI
auth gate (`requireApiAuth` in core-routes.js) and BEFORE the generic OpenCode
`/api/*` proxy (inside `startupPipelineRuntime.run`). The generic proxy must
never capture workspace paths. `/api/workspaces` and `/api/connections` are on
the JSON body-parser allowlist (core-routes.js) and the URL-token GET
allowlist (ui-auth.js).

## Failure semantics

- Authoritative fetch failure never replaces old data and never renders as
  "no workspaces".
- One connection failing never blocks or clears other connections.
- Workspace delete removes only the catalog reference; it never touches
  upstream sessions/files/terminals.
- A catalog write that succeeds but whose response is lost: client retry hits
  the `(connectionId, canonicalPath)` uniqueness constraint and receives the
  existing descriptor (`created: false`), so no duplicates are created.
- Missing vs corrupt vs empty are always distinguishable (diagnostics).

## Security

- Private records (credentialRef, sshInstanceId, baseUrl of direct targets)
  never appear in API responses, logs, URL tokens or the catalog file.
- The runtime proxy resolves upstream URLs from saved connection profiles
  only; clients can never pass an upstream URL.
- Upstream auth headers and internal URLs are stripped from proxied responses.

## Current phase status

Phase 1 (catalog + local workspace vertical slice) and the Phase 2 core
(workspace runtime proxy + registry contract) are implemented. Remaining:
session index + unified sidebar (Phase 4), Direct/Relay/SSH adapters
(Phases 3/5), full sync-scope migration, and removal of the fleet/global
runtime-switch architecture (Phase 6). SyncProvider is still ambient-runtime
bound; `getOpencodeClient()`/`switchRuntimeEndpoint()` remain as migration
facades that new code must not call.
