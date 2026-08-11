# Workspaces module (server)

Ownership: `packages/web/server/lib/workspaces/*` — the control plane's
unified Workspace Catalog, connection profiles, connection broker, workspace
runtime proxy, server-side session index and legacy migration.

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
| `path-boundary.js` | Adapter-agnostic lexical path boundary helpers (`normalizePathForBoundary`, `isPathWithinRoot`, `readRequestDirectoryHints`). Collapses `.`/`..` without touching the filesystem; handles POSIX, Windows drive and UNC roots. Symlink resolution is adapter-owned (only the local adapter can realpath). |
| `catalog-schema.js` | Runtime validation of the on-disk document (unknown schema version → failure, never empty), public DTO serializers (`toConnectionSummary` is the ONLY serializer allowed to project a private record; never spread private records), create/update input validators (throw typed `CatalogInputError`). Dropped invalid/duplicate entries are reported via a non-enumerable `dropped` counter — the store must surface them as recovery, never a silent clean load. |
| `catalog-store.js` | Atomic load/write with revision, backup file, serialized mutation queue, If-Match conflicts (`catalog_revision_conflict` → 409). Corrupt primary recovers from backup or fails loudly; a corrupt catalog is never an empty catalog. A primary whose validation dropped entries loads the valid subset but enters an explicit recovery state (diagnostics + loud reason). Credentials never live here. |
| `connection-profile-store.js` | Private connection records (targets, credential refs, direct clientToken, redirect allowlists) in their own file. `kind` only appears here and in adapters. Loading failure — corrupt JSON OR invalid dropped records — is a config failure surfaced loudly (typed `connection_profiles_corrupt`, recovery state in diagnostics), never a reason to silently drop catalog workspaces. |
| `connection-broker.js` | Adapter registry by connectionId + lease lifecycle (idle grace → `dispose()`) + `unregisterAdapter`. Catalog presence ≠ open tunnel. `resolveConnection(connectionId)` returns `{ profile, adapter }` — the proxy/session index always resolve through it. |
| `local-adapter.js` | The built-in `local` connection: canonicalize/probe/browse on the control plane machine, HTTP/SSE forwarding to the local OpenCode runtime with injected upstream auth (never echoed to browsers). Directory boundary is ENFORCED here: client-supplied directory hints (headers, `directory` query/body) are validated against the workspace canonical path lexically AND through symlink resolution (a workspace symlink pointing outside cannot widen the boundary), and the `x-opencode-directory` header is always overwritten with the canonical path. `openWebSocket` resolves the upstream ws(s):// URL for the same paths with the identical auth injection and directory-boundary rules; the ws client itself is created by the workspace runtime proxy. |
| `direct-adapter.js` | `kind: 'direct'` connections: SSRF-safe forwarding to the saved baseUrl (loopback/private/metadata resolution blocked with cached verdicts, cross-host redirects rejected unless allowlisted, timeout, credential injection server-side only). Remote paths are never canonicalized against the control plane filesystem; directory hints are enforced LEXICALLY against the workspace canonical path and both directory-header conventions are overwritten with it. Exports `createSafeUpstreamValidator` (shared with routes). |
| `session-binding-store.js` | Persisted `(connectionId, upstreamSessionId) -> workspaceId` bindings in `workspace-session-bindings.json` with own revision; `created-in-workspace` / `explicit` / `legacy-exact-path` sources; move requires `explicit` source or `allowMove`; deletion only ever removes the binding. |
| `session-index.js` | Per-connection lightweight session index: one upstream event stream per connection max, debounced structural refreshes, exact-path fallback only when no binding exists, unassigned diagnostics bucket, per-connection freshness (failure keeps last snapshot), global revision with revision-gap recovery. Started via `startSessionIndex()` after route registration. |
| `migration.js` | Idempotent, resumable import of legacy `settings.projects` (local connection only). Missing paths go to `pendingConnectionIds`; failures never look like an authoritative empty list. A later run whose state is `legacyProjectsImported: true` but still lists pending paths RE-ATTEMPTS them (a temporarily unavailable project that recovers later is still imported) and clears the pending list only once every pending path succeeded. Legacy data stays readable for the compatibility period (dual read); deletion is a later, separate, audited step. |
| `routes.js` | Catalog API: `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`, `GET /api/workspaces/:id`, probes, connection-scoped browse, and connection profile CRUD (`POST/PATCH/DELETE /api/connections` with loopback rejection, in-use deletion guard 409, `onConnectionsChanged` adapter sync). All behind the base UI auth gate. Workspace-scoped browse enforces the lexical boundary first, then delegates to the adapter (which enforces under its own path semantics via the `canonicalPath` context). |
| `runtime-proxy.js` | `/api/workspaces/:workspaceId/runtime/*`: resolves the workspace server-side, forwards only `/api/...` paths to the connection adapter with QUERY STRING PRESERVED (pagination/filter/cursor params must reach the upstream), streaming body with sanitized response headers, lease per request. A browser disconnect ABORTS the upstream request/stream (and thus releases the lease promptly); the write path honors backpressure (`drain`). Resolves the connection via the broker (profile included in the adapter context). WebSocket upgrades are wired: `handleWorkspaceUpgrade` is the central dispatcher registered first on the server `upgrade` event (server entrypoint) — it owns every `/api/workspaces/:id/runtime...` upgrade (allowlisted paths `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`), authenticates like the terminal/event sockets (cookie/bearer/URL token + origin), gates on the connection capability, holds a broker lease for the socket pair lifetime and pipes the upstream socket back to the browser. Non-workspace paths are left untouched for the existing module listeners; requests it owns are marked (`WORKSPACE_RUNTIME_UPGRADE_MARKER`) so module listeners that also match workspace-prefixed paths (the terminal runtime) skip them — a workspace upgrade has exactly one handler. Failures reject the upgrade with an explicit HTTP error (501 `capability_unavailable` / 401 / 403 / 404 / 502), never a silent swallow. |
| `session-index-routes.js` | `GET /api/workspace-sessions/snapshot`, `GET /api/workspace-sessions/events` (SSE, revision-carrying), `POST /api/workspaces/:id/sessions` (create + `created-in-workspace` binding), `POST /api/workspaces/:id/sessions/:sid/bind` (explicit move). |
| `index.js` | Runtime factory: wires stores, broker, adapters (local + per-profile direct + `injectedAdapters`), migration, binding store and session index; `registerRoutes`, `migrate`, `startSessionIndex`, `getDiagnostics`, `dispose`. Injected adapters (Electron SSH) are registered and seeded with private ssh profiles automatically. |
| `DOCUMENTATION.md` | This file. Tests live adjacent (`*.test.js`) and cover every module. |

## Registration order (server/index.js)

The workspaces runtime is created and its routes registered AFTER the base UI
auth gate (`requireApiAuth` in core-routes.js) and BEFORE the generic OpenCode
`/api/*` proxy (inside `startupPipelineRuntime.run`). The generic proxy must
never capture workspace paths. `/api/workspaces`, `/api/connections` and
`/api/workspace-sessions/*` are on the JSON body-parser allowlist
(core-routes.js) and the URL-token GET allowlist (ui-auth.js); the events
endpoint is SSE (token-readable GET). `startSessionIndex()` runs after route
registration so clients cannot race the initial snapshot.

## Failure semantics

- Authoritative fetch failure never replaces old data and never renders as
  "no workspaces" (catalog AND session index).
- One connection failing never blocks or clears other connections; each
  connection carries its own `complete`/`stale`/`lastSuccessAt`/`error`.
- Workspace delete removes only the catalog reference; it never touches
  upstream sessions/files/terminals. Connection delete is refused (409) while
  workspaces reference it.
- A catalog write that succeeds but whose response is lost: client retry hits
  the `(connectionId, canonicalPath)` uniqueness constraint and receives the
  existing descriptor (`created: false`), so no duplicates are created.
- Missing vs corrupt vs empty are always distinguishable (diagnostics).
- Session index incremental events never regress newer state; a client with a
  revision gap must re-fetch the snapshot.

## Security

- Private records (credentialRef, sshInstanceId, clientToken, baseUrl of
  direct targets) never appear in API responses, logs, URL tokens or the
  catalog file; `toConnectionSummary` is the only public projection.
- The runtime proxy and session index resolve upstream URLs from saved
  connection profiles only; clients can never pass an upstream URL.
- `workspaceId` is a TRUSTED authorization boundary server-side: workspace
  browse and the runtime proxy validate every directory hint (headers,
  `directory` query/body) against the workspace canonical path — lexically
  (`..` traversal rejected) and, for the local adapter, through symlink
  resolution. The workspace directory header is always overwritten with the
  canonical path, so a client can never widen the directory to e.g. `/etc`.
- Direct targets pass an SSRF gate (loopback/private/link-local/metadata
  resolution blocked, redirect hops re-validated with a cross-host allowlist).
- Upstream auth headers and internal URLs are stripped from proxied responses.
- Electron SSH adapters forward only to ssh-manager-produced tunnel URLs;
  renderers never see tunnel URLs or SSH material.
- Workspace-prefixed WebSocket upgrades (`/api/workspaces/:id/runtime/api/.../ws`)
  are owned by the central upgrade dispatcher: they pass the same auth gate as
  the non-prefixed sockets (session cookie / bearer / short-lived URL token via
  `isUrlAuthWebSocketPath`, then origin), the browser query string (which may
  carry the control-plane URL token) is never forwarded upstream, and the
  adapters inject upstream credentials server-side — the same
  `BLOCKED_UPSTREAM_HEADERS` filter and directory-boundary enforcement as
  `fetch` apply to upstream ws headers. The relay tunnel host allowlists the
  same workspace-prefixed WS paths so mobile clients can open them through the
  tunnel.

## Current phase status

Phases 0–6 are delivered on this branch: catalog + local vertical slice
(1–2), direct connections with SSRF-safe CRUD (3), session index + bindings +
unified sidebar (4), Electron SSH adapter injection (5), renderer fleet layer
removal (6), and workspace-scoped terminal/WS proxying via the central upgrade
dispatcher (7). Remaining: the server-side relay wire-protocol port (relay
profiles are structurally supported; the tunnel client protocol currently
lives in the UI package as TS and must be ported to server JS) and the
workspace-bound SyncProvider migration (renderer side; the runtime proxy it
needs is already in place and the renderer now mounts the workspace runtime
provider for local workspaces). SyncProvider is still ambient-runtime bound
for non-workspace selections; `getOpencodeClient()`/`switchRuntimeEndpoint()`
remain as migration facades that new code must not call.
