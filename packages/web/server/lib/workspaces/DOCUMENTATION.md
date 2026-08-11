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
| `path-boundary.js` | Adapter-agnostic lexical path boundary helpers (`normalizePathForBoundary`, `isPathWithinRoot`, `isPathWithinWorkspace`, `resolvePathWithinWorkspace`, `readRequestDirectoryHints`, `scopeWorkspaceDirectoryListRequest`, `readRequestWorkspacePathHints`). Collapses `.`/`..` without touching the filesystem; handles POSIX, Windows drive and UNC roots; treats relative filesystem/Git paths as workspace-relative. The filesystem list route is scoped through its `path` query because that route does not consume workspace headers, and the encoded route path of `/api/fs/serve/:path` is checked as well. Symlink resolution is adapter-owned (only the local adapter can realpath). |
| `catalog-schema.js` | Runtime validation of the on-disk document (unknown schema version → failure, never empty), public DTO serializers (`toConnectionSummary` is the ONLY serializer allowed to project a private record; never spread private records), create/update input validators (throw typed `CatalogInputError`). Dropped invalid/duplicate entries are reported via a non-enumerable `dropped` counter — the store must surface them as recovery, never a silent clean load. |
| `catalog-store.js` | Atomic load/write with revision, backup file, serialized mutation queue, If-Match conflicts (`catalog_revision_conflict` → 409). Corrupt primary recovers from backup or fails loudly; a corrupt catalog is never an empty catalog. A primary whose validation dropped entries loads the valid subset but enters an explicit recovery state (diagnostics + loud reason). Credentials never live here. |
| `connection-profile-store.js` | Private connection records (targets, credential refs, direct clientToken, redirect allowlists) in their own file. `kind` only appears here and in adapters. Loading failure — corrupt JSON OR invalid dropped records — is a config failure surfaced loudly (typed `connection_profiles_corrupt`, recovery state in diagnostics), never a reason to silently drop catalog workspaces. |
| `connection-broker.js` | Adapter registry by connectionId + lease lifecycle (idle grace → `dispose()`) + `unregisterAdapter`. Catalog presence ≠ open tunnel. `resolveConnection(connectionId)` returns `{ profile, adapter }` — the proxy/session index always resolve through it. |
| `local-adapter.js` | The built-in `local` connection: canonicalize/probe/browse on the control plane machine, HTTP/SSE forwarding to the local OpenCode runtime with injected upstream auth (never echoed to browsers). Directory boundary is ENFORCED here: client-supplied directory hints (headers, `directory` query/body) are validated against the workspace canonical path lexically AND through symlink resolution (a workspace symlink pointing outside cannot widen the boundary), filesystem list requests are filled/scoped through `path`, and the `x-opencode-directory` header is always overwritten with the canonical path. `openWebSocket` resolves the upstream ws(s):// URL for the same paths with the identical auth injection and directory-boundary rules; the ws client itself is created by the workspace runtime proxy. |
| `direct-adapter.js` | `kind: 'direct'` connections: SSRF-safe forwarding to the saved baseUrl (loopback/private/metadata resolution blocked with cached verdicts, cross-host redirects rejected unless allowlisted, timeout, credential injection server-side only). Remote paths are never canonicalized against the control plane filesystem; directory hints and filesystem list queries are enforced LEXICALLY against the workspace canonical path and both directory-header conventions are overwritten with it. Workspace creation probes `/health` and the requested remote directory before persisting. Exports `createSafeUpstreamValidator` (shared with routes). |
| `relay-adapter.js` | `kind: 'relay'` connections: connection-keyed E2EE Relay tunnel for HTTP/SSE/WS. Resolves the private relay descriptor and upstream credential through the server-side credential provider, enforces the remote workspace boundary, and exposes one shared tunnel per connection. Failure semantics: EOF/socket loss is a disconnect into bounded exponential backoff with recovery through a fresh handshake; terminal relay failures (auth rejected, duplicate client, connection limit) never retry and fail requests fast; the broker's idle grace disposes the tunnel when the last lease releases. |
| `session-binding-store.js` | Persisted `(connectionId, upstreamSessionId) -> workspaceId` bindings in `workspace-session-bindings.json` with own revision; `created-in-workspace` / `explicit` / `legacy-exact-path` sources; move requires `explicit` source or `allowMove`; deletion only ever removes the binding. |
| `session-index.js` | Per-connection lightweight session index: one upstream event stream per connection max, debounced structural refreshes, cursor pagination with a bounded page walk, explicit `partial` coverage when the bound is reached, exact-path fallback only when no binding exists, unassigned diagnostics bucket, per-connection freshness (`offline`, `stale`, `partial`; failure/stream loss keeps the last snapshot), incremental upsert/remove events for structural changes, safe error summaries that never retain upstream URLs or credentials, and global revision with revision-gap recovery. Performance contract (§17.5): live activity events resolve through a per-connection `sessionsByUpstreamId` index (one event touches only the affected session, never a collection scan), background snapshot refreshes run through a worker pool capped at `refreshConcurrency` (default 4, injectable; one failure never blocks the queue), and stream reconnect backoff is exponential WITH deterministic ±20% jitter (FNV-1a seed + mulberry32 PRNG, clamped to the 1s→60s bounds). Started via `startSessionIndex()` after route registration. Diagnostics additionally expose per-connection backoff counts and snapshot reload/coverage-gap counters plus the last-event revision. |
| `migration.js` | Idempotent, resumable import of legacy `settings.projects` (local connection only). Missing paths go to `pendingConnectionIds`; failures never look like an authoritative empty list. A later run whose state is `legacyProjectsImported: true` but still lists pending paths RE-ATTEMPTS them (a temporarily unavailable project that recovers later is still imported) and clears the pending list only once every pending path succeeded. Legacy data stays readable for the compatibility period (dual read); deletion is a later, separate, audited step. |
| `routes.js` | Catalog API: `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:id`, `GET /api/workspaces/:id`, `GET /api/workspaces/capabilities` (lightweight `{ workspaceCatalogV1 }` read that stays available in EVERY state), probes, connection-scoped browse, and connection profile CRUD (`POST/PATCH/DELETE /api/connections` with loopback rejection, in-use deletion guard 409, `onConnectionsChanged` adapter sync). All behind the base UI auth gate. Honors the `workspaceCatalogV1` flag: when `false`, every catalog/connection MUTATION returns 501 `capability_unavailable` before touching any store; reads stay available and the catalog files are never rewritten (see "Feature flag" below). Workspace-scoped browse enforces the lexical boundary first, then delegates to the adapter (which enforces under its own path semantics via the `canonicalPath` context). |
| `runtime-proxy.js` | `/api/workspaces/:workspaceId/runtime/*`: resolves the workspace server-side, forwards only the documented workspace-capable SDK/RuntimeAPI path families (not control-plane namespaces or machine-wide `/api/fs/home`) with QUERY STRING PRESERVED (pagination/filter/cursor params must reach the upstream), strips the control-plane `oc_url_token` before forwarding/logging, enforces bounded request/response sizes, streams with sanitized response headers, and holds one lease per request. A browser disconnect ABORTS the upstream request/stream (and thus releases the lease promptly); the write path honors backpressure (`drain`). OpenCode `/api/config/*` has no workspace contract and returns an explicit 501 `capability_unavailable` instead of being forwarded. Typed adapter boundary errors retain safe 4xx/5xx codes; generic upstream failures remain sanitized 502s. Resolves the connection via the broker (profile and credential provider included in the adapter context). Also owns the desensitized proxy counters (requests/failures/cancels/active streams — no URLs, headers or bodies) and the canonical `workspaceCatalogV1` env resolver. WebSocket upgrades are wired: `handleWorkspaceUpgrade` is the central dispatcher registered first on the server `upgrade` event (server entrypoint) — it owns every `/api/workspaces/:id/runtime...` upgrade (allowlisted paths `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`), authenticates like the terminal/event sockets (cookie/bearer/URL token + origin), gates on the connection capability AND on `workspaceCatalogV1` (a disabled flag rejects the upgrade 501), holds a broker lease for the socket pair lifetime and pipes either a URL-backed or adapter-owned socket back to the browser. Non-workspace paths are left untouched for the existing module listeners; requests it owns are marked (`WORKSPACE_RUNTIME_UPGRADE_MARKER`) so module listeners that also match workspace-prefixed paths (the terminal runtime) skip them — a workspace upgrade has exactly one handler. Failures reject the upgrade with an explicit HTTP error (501 `capability_unavailable` / 401 / 403 / 404 / 502), never a silent swallow. |
| `session-index-routes.js` | `GET /api/workspace-sessions/snapshot`, `GET /api/workspace-sessions/events` (SSE, revision-carrying), `POST /api/workspaces/:id/sessions` (create + `created-in-workspace` binding), `POST /api/workspaces/:id/sessions/:sid/bind` (explicit move). The two POST mutations are gated to 501 `capability_unavailable` by index.js when `workspaceCatalogV1` is false (a gate registered before these routes, so the real handlers never see them). |
| `diagnostics.js` | `GET /api/workspaces/diagnostics` — desensitized control-plane snapshot (plan §19) behind the same UI auth gate: catalog schema/revision/last persist time/recovery state, per-connection broker lifecycle + leases, per-connection session-index freshness (last success, backoff count, event-stream presence, reload/coverage-gap counters), session-index snapshot + last-event revision, runtime proxy request/failure/cancel/active-stream counts, migration status and the `workspaceCatalogV1` flag. Desensitization contract: NO tokens, credentials, headers, upstream URLs or paths; migration pending paths are reduced to a count and a recursive redaction drops known sensitive keys before the payload leaves the route. |
| `index.js` | Runtime factory: wires stores, broker, adapters (local + per-profile direct/relay + `injectedAdapters`), migration, binding store and session index; `registerRoutes`, `migrate`, `startSessionIndex`, `getDiagnostics`, `dispose`. Reads the operator env switch (`OPENCHAMBER_WORKSPACE_CATALOG_DISABLED=1`) into the `workspaceCatalogV1` capability flag, passes it to every route registrar, and — when disabled — registers the explicit 501 gates for the runtime proxy prefix and the session-index mutation routes in place of the real handlers. Injected adapters (Electron SSH) are registered and seeded with private ssh profiles automatically. Relay adapters are registered only when a server-side credential provider is supplied. |
| `DOCUMENTATION.md` | This file. Tests live adjacent (`*.test.js`) and cover every module. |

## Feature flag: `workspaceCatalogV1` (plan §20)

- Operator switch: set `OPENCHAMBER_WORKSPACE_CATALOG_DISABLED=1` in the server
  environment (any other value or absence = enabled). The flag is resolved in
  `index.js` (`resolveWorkspaceCatalogV1`, canonical env resolver in
  `runtime-proxy.js` so the WebSocket upgrade handler, which the server
  entrypoint wires directly, reads the same variable). Tests inject the
  boolean as `workspaceCatalogV1` in dependencies.
- While disabled, the following return 501 `capability_unavailable` (the
  existing sendError code style):
  - every catalog mutation: `POST /api/workspaces`, `PATCH/DELETE
    /api/workspaces/:id`, `POST/PATCH/DELETE /api/connections`;
  - every session-index mutation: `POST /api/workspaces/:id/sessions`,
    `POST /api/workspaces/:id/sessions/:sid/bind` (gate registered before
    the real routes);
  - every workspace-prefixed runtime request `app.use/all
    /api/workspaces/:workspaceId/runtime` (the real proxy is not registered)
    and every workspace-prefixed WebSocket upgrade (`handleWorkspaceUpgrade`
    rejects 501).
- Reads stay available: `GET /api/workspaces` (snapshot), single workspace,
  browse, probes, `GET /api/workspaces/capabilities` (always returns
  `{ workspaceCatalogV1: boolean }`), session-index snapshot/SSE, and
  `GET /api/workspaces/diagnostics`.
- **Data safety (mandatory):** the disabled state is a READ GATE. It never
  deletes, downgrades, rewrites or touches the catalog/backup/profile/binding
  files; mutations are rejected before any store call. Tests assert file
  bytes are unchanged after rejected mutations and that store reads never
  rewrite the file.
- §20.3 deviation: the plan's rollback step "close the unified sidebar,
  keep Catalog data, restore old navigation" cannot restore the old
  navigation because the fleet-era navigation was deleted in Phase 6 (see
  the shared-UI doc). The honest scope is: visible read-only degradation in
  the unified sidebar, no client-side mutation attempts, server-enforced
  501s, and catalog data preserved for a later re-enable.

## Registration order (server/index.js)

The workspaces runtime is created and its routes registered AFTER the base UI
auth gate (`requireApiAuth` in core-routes.js) and BEFORE the generic OpenCode
`/api/*` proxy (inside `startupPipelineRuntime.run`). The generic proxy must
never capture workspace paths. `/api/workspaces`, `/api/connections` and
`/api/workspace-sessions/*` are on the JSON body-parser allowlist
(core-routes.js) and the URL-token GET allowlist (ui-auth.js). Read-only
workspace runtime SDK/Files/Git/permission/question/event paths are also
URL-token readable for cookie-less mobile/tray clients; runtime mutations
still require the normal session/bearer authentication. The events endpoint
is SSE (token-readable GET). When `workspaceCatalogV1` is disabled, the
runtime proxy and session-index mutation gates are registered BEFORE the
session-index routes so the real handlers (and the generic proxy) never see
disabled-state mutations; `GET /api/workspaces/capabilities` and
`GET /api/workspaces/diagnostics` are registered with the other workspace
routes and sit behind the same auth gate. `startSessionIndex()` runs after
route registration so clients cannot race the initial snapshot.

Note: the capabilities GET is NOT on the URL-token allowlist (ui-auth.js
matches `/api/workspaces` exactly); cookie-less tray/mobile surfaces fall
back to "enabled" until a follow-up adds the path if needed.

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
- Relay connection EOF is a disconnect, not a terminal failure: the tunnel
  backs off exponentially (never zero-delay) and recovers with a fresh E2EE
  handshake. Relay auth rejection, duplicate-client eviction and connection
  limits are terminal: no retry loop, and requests fail fast rather than hang.
- The `workspaceCatalogV1` disabled state is a read gate with explicit 501
  `capability_unavailable` responses for every catalog/session-index mutation
  and workspace runtime request/upgrade; it never rewrites catalog data
  files and never forwards workspace requests to any upstream.

## Security

- Private records (credentialRef, sshInstanceId, clientToken, baseUrl of
  direct targets) never appear in API responses, logs, URL tokens or the
  catalog file; `toConnectionSummary` is the only public projection.
- The runtime proxy and session index resolve upstream URLs from saved
  connection profiles only; clients can never pass an upstream URL.
- `workspaceId` is a TRUSTED authorization boundary server-side: workspace
  browse and the runtime proxy validate every directory hint (headers,
  `directory` query/body), every filesystem/Git/terminal path field, and the
  encoded route path in `/api/fs/serve/:path` against the workspace canonical
  path — lexically (`..` traversal rejected) and, for
  the local adapter, through symlink resolution. Relative file/Git paths are
  resolved under the workspace root; the filesystem list `path` query is
  independently scoped because that route does not consume directory headers.
  Local read/stat/raw requests may use the existing server-validated
  `outsideFileGrant` exception; Direct/Relay adapters cannot validate a local
  grant and reject outside paths. The workspace directory header is always
  overwritten with the canonical path, so a client can never widen the
  directory to e.g. `/etc`.
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

Phases 0–2 are delivered on this branch: catalog + local vertical slice,
workspace-bound runtime handles, and terminal/WS proxying through the central
upgrade dispatcher. Phase 3's implementation slice now includes Direct
connection CRUD, SSRF/redirect/credential handling, remote path probing,
workspace-scoped HTTP/SSE/WS forwarding, filesystem/Git/terminal directory
boundaries, and the workspace-bound SDK/RuntimeAPI wiring. Relay has the
connection-keyed adapter and real wire coverage, but its broad cross-platform
acceptance remains Phase 5 work.

The remaining Phase 3 gate is environmental: add one real reachable remote
server and verify session list/messages, files/search, Git, terminal,
permission/question, SSE/WS reconnect, and browser/Storage secret absence.
Focused tests prove the control-plane contracts but do not substitute for that
remote acceptance. Non-workspace selections still use the ambient runtime for
compatibility; `getOpencodeClient()`/`switchRuntimeEndpoint()` remain migration
facades that new code must not call.
