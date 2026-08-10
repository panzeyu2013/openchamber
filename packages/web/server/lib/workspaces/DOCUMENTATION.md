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
| `session-binding-store.js` | (connectionId, upstreamSessionId) → workspaceId binding map in its own file (`workspace-session-bindings.json`). Serialized atomic writes + own revision counter, backup recovery (corrupt ≠ empty), legacy exact-path import. Bindings reference workspace/connection ids only and never touch upstream data. No If-Match: callers must re-read after an awaited mutation. |
| `connection-profile-store.js` | Private connection records (targets, credential refs) in their own file. `kind` only appears here and in adapters. Loading failure is a config failure, never a reason to drop catalog workspaces. |
| `connection-broker.js` | Adapter registry by connectionId + lease lifecycle (idle grace → `dispose()`). Catalog presence ≠ open tunnel. |
| `local-adapter.js` | The built-in `local` connection: canonicalize/probe/browse on the control plane machine, HTTP/SSE forwarding to the local OpenCode runtime with injected upstream auth (never echoed to browsers). WS forwarding is `capability_unavailable` until wired. |
| `migration.js` | Idempotent, resumable import of legacy `settings.projects` (local connection only). Missing paths go to `pendingConnectionIds`; failures never look like an authoritative empty list. Legacy data stays readable for the compatibility period (dual read); deletion is a later, separate, audited step. |
| `routes.js` | Catalog API: `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`, `GET /api/workspaces/:id`, probes, connection-scoped browse. All behind the base UI auth gate. |
| `runtime-proxy.js` | `/api/workspaces/:workspaceId/runtime/*`: resolves the workspace server-side, forwards only `/api/...` paths to the connection adapter with streaming body, sanitized response headers, lease per request. WS upgrades not yet wired. |
| `direct-adapter.js` | `kind: 'direct'` connections: SSRF-safe forwarding to the saved baseUrl (loopback/private/metadata resolution blocked, cross-host redirects rejected unless allowlisted, timeout, credential injection server-side only). Remote paths are never canonicalized against the control plane filesystem. |
| `session-binding-store.js` | Persisted `(connectionId, upstreamSessionId) -> workspaceId` bindings with own revision; `created-in-workspace` / `explicit` / `legacy-exact-path` sources; deletion only ever removes the binding. |
| `session-index.js` | Per-connection lightweight session index: one upstream event stream per connection max, debounced structural refreshes, exact-path fallback only when no binding exists, unassigned diagnostics bucket, per-connection freshness (failure keeps last snapshot), global revision with revision-gap recovery. |
| `session-index-routes.js` | `GET /api/workspace-sessions/snapshot`, `GET /api/workspace-sessions/events` (SSE), `POST /api/workspaces/:id/sessions` (create + binding), `POST /api/workspaces/:id/sessions/:sid/bind`. |

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

Phases 1–2 (catalog + local vertical slice + runtime proxy/registry) and the
Phase 3 direct-connection vertical slice and the Phase 4 server-side session
index + renderer session-index store are implemented. Remaining: unified
sidebar (replacing fleet sections), Relay/SSH adapters (Phase 5), full
sync-scope migration, and removal of the fleet/global runtime-switch
architecture (Phase 6). SyncProvider is
still ambient-runtime bound; `getOpencodeClient()`/`switchRuntimeEndpoint()`
remain as migration facades that new code must not call.
