# Projects module (server)

Ownership: `packages/web/server/lib/projects/*` — the control plane's
unified Project Catalog, connection profiles, connection broker, project
runtime proxy, server-side session index and legacy migration.

## Contract

The product has exactly one first-class navigation entity: **project**
(`connectionId + canonicalPath`, stable random UUID id). Sessions belong to
projects. There is no `isLocal`/`isRemote`/`projectType` anywhere in the
catalog model; the only kind signal in the public DTO is the non-sensitive
`kind` tag; full private targets exist only inside broker adapters/stores.

```
local unified catalog -> project(connectionId + path) -> session(projectId + upstreamSessionId)
                       -> project-bound runtime handle -> server-side connection adapter
```

## Modules

| File | Responsibility |
|---|---|
| `project-identity.js` | UUID ids, project/session scope keys, location keys. Renderer mirror: `packages/ui/src/projects/identity.ts` (must stay byte-compatible; contract tests cover slashes/unicode/collisions). |
| `path-boundary.js` | Adapter-agnostic lexical path boundary helpers (`normalizePathForBoundary`, `isPathWithinRoot`, `isPathWithinProject`, `resolvePathWithinProject`, `readRequestDirectoryHints`, `scopeProjectDirectoryListRequest`, `readRequestProjectPathHints`). Collapses `.`/`..` without touching the filesystem; handles POSIX, Windows drive and UNC roots; treats relative filesystem/Git paths as project-relative. The filesystem list route is scoped through its `path` query because that route does not consume project headers, and the encoded route path of `/api/fs/serve/:path` is checked as well. Symlink resolution is adapter-owned (only the local adapter can realpath). |
| `catalog-schema.js` | Runtime validation of the on-disk document (unknown schema version → failure, never empty), public DTO serializers (`toConnectionSummary` is the ONLY serializer allowed to project a private record; never spread private records), create/update input validators (throw typed `CatalogInputError`). Dropped invalid/duplicate entries are reported via a non-enumerable `dropped` counter — the store must surface them as recovery, never a silent clean load. The public summary now carries the NON-SENSITIVE connection `kind` tag (`'local'|'direct'|'ssh'|'relay'` from the profile target, omitted when missing/illegal, never defaulted) plus `lastProbeOkAt` (epoch ms, non-secret) when present on the private record; baseUrl/tokens/credentialRef/sshInstanceId/relayId stay private. |
| `catalog-store.js` | Atomic load/write with revision, backup file, serialized mutation queue, If-Match conflicts (`catalog_revision_conflict` → 409). Corrupt primary recovers from backup or fails loudly; a corrupt catalog is never an empty catalog. A primary whose validation dropped entries loads the valid subset but enters an explicit recovery state (diagnostics + loud reason). Credentials never live here. |
| `connection-profile-store.js` | Private connection records (targets, credential refs, direct clientToken, redirect allowlists, server-written `lastProbeOkAt` epoch ms of the last successful live probe) in their own file. `kind` lives here and in adapters; only the non-sensitive `kind` tag reaches the public DTO. Loading failure — corrupt JSON OR invalid dropped records — is a config failure surfaced loudly (typed `connection_profiles_corrupt`, recovery state in diagnostics), never a reason to silently drop catalog projects. `recordProbeSuccess(connectionId, ts)` updates only the probe timestamp, preserving every other field. ALL mutations (`upsertConnection`/`deleteConnection`/`recordProbeSuccess`) run through one serialized promise queue: read-modify-persist sequences cannot interleave (boot-time probes record success for N connections concurrently) and the shared `.tmp` path never has two writers, so concurrent probes cannot tear the profile file. |
| `connection-broker.js` | Adapter registry by connectionId + lease lifecycle (idle grace → `dispose()`) + `unregisterAdapter`. Catalog presence ≠ open tunnel. `resolveConnection(connectionId)` returns `{ profile, adapter }` — the proxy/session index always resolve through it. |
| `local-adapter.js` | The built-in `local` connection: canonicalize/probe/browse on the control plane machine, HTTP/SSE forwarding to the local OpenCode runtime with injected upstream auth (never echoed to browsers). The local runtime serves PREFIX-FREE routes: the adapter strips the leading `/api` from rest paths before forwarding (same convention as the generic renderer proxy in `lib/opencode/proxy.js`) — HTTP, SSE AND WebSocket (`openWebSocket` applies the same `toUpstreamOpenCodePath` strip so project terminal/event sockets dial the prefix-free form instead of the `/api` variant that falls through to the embedded WebUI catch-all) — remote control-plane adapters (direct/relay/SSH) keep the `/api` convention and must not strip. `Headers`-instance requests are copied with `forEach`'s `(value, key)` argument order. Directory boundary is ENFORCED here: client-supplied directory hints (headers, `directory` query/body) are validated against the project canonical path lexically AND through symlink resolution (a project symlink pointing outside cannot widen the boundary; a candidate that does not exist on disk is anchored under the realpath'd root so a symlinked root — macOS `/var` — cannot turn an in-project path into a false 403), filesystem list requests are filled/scoped through `path`, and the `x-opencode-directory` header is always overwritten with the canonical path. `openWebSocket` resolves the upstream ws(s):// URL for the same paths with the identical auth injection and directory-boundary rules; the ws client itself is created by the project runtime proxy. |
| `direct-adapter.js` | `kind: 'direct'` connections: SSRF-safe forwarding to the saved baseUrl (loopback/private/metadata resolution blocked with cached verdicts, cross-host redirects rejected unless allowlisted, timeout, credential injection server-side only). The verdict cache is a fast path for probes; EVERY actual outbound request (HTTP, SSE and the WebSocket spec) re-resolves DNS fresh immediately before the connection so a rebinding flip between the cached verdict and the fetch cannot send server-side credentials to a private address. Remote paths are never canonicalized against the control plane filesystem; directory hints and filesystem list queries are enforced LEXICALLY against the project canonical path and both directory-header conventions are overwritten with it. Project creation probes `/health` and the requested remote directory before persisting. Exports `createSafeUpstreamValidator` (shared with routes). |
| `relay-adapter.js` | `kind: 'relay'` connections: connection-keyed E2EE Relay tunnel for HTTP/SSE/WS. Resolves the private relay descriptor and upstream credential through the server-side credential provider, enforces the remote project boundary, and exposes one shared tunnel per connection. Failure semantics: EOF/socket loss is a disconnect into bounded exponential backoff with recovery through a fresh handshake; terminal relay failures (auth rejected, duplicate client, connection limit) never retry and fail requests fast; the broker's idle grace disposes the tunnel when the last lease releases. |
| `session-binding-store.js` | Persisted `(connectionId, upstreamSessionId) -> projectId` bindings in `project-session-bindings.json` with own revision; `created-in-project` / `explicit` / `legacy-exact-path` sources; move requires `explicit` source or `allowMove`; deletion only ever removes the binding. |
| `session-index.js` | Per-connection lightweight session index: one upstream event stream per connection max, debounced structural refreshes, cursor pagination with a bounded page walk, explicit `partial` coverage when the bound is reached, exact-path fallback only when no binding exists, unassigned diagnostics bucket, per-connection freshness (`offline`, `stale`, `partial`; failure/stream loss keeps the last snapshot), incremental upsert/remove events for structural changes, safe error summaries that never retain upstream URLs or credentials, and global revision with revision-gap recovery. Every successful stream (re)connect re-baselines the snapshot (debounced) so a runtime that started after boot cannot leave the index permanently stale. `stopObservingConnection(connectionId)` stops the observer, drops the connection's indexed state and emits per-session removal events — called when a connection profile is deleted or replaced so the observer never retries a disposed adapter (holding its lease) forever; kind changes and brand-new connections (re)start their streams through the same reconciliation. Stop semantics include a per-connection stop-generation token: `stopObservingConnection` bumps it, and every in-flight async commit (snapshot apply, debounced refresh, observer start/stream continuation) re-checks the token it captured before touching state or emitting events, so a stopped connection can never be resurrected by a late refresh or a stream that resolves after the stop; re-observing starts a fresh generation that still rejects commits from the old one. Performance contract (§17.5): live activity events resolve through a per-connection `sessionsByUpstreamId` index (one event touches only the affected session, never a collection scan), background snapshot refreshes run through a worker pool capped at `refreshConcurrency` (default 4, injectable; one failure never blocks the queue), and stream reconnect backoff is exponential WITH deterministic ±20% jitter (FNV-1a seed + mulberry32 PRNG, clamped to the 1s→60s bounds). Started via `startSessionIndex()` after route registration. Diagnostics additionally expose per-connection backoff counts and snapshot reload/coverage-gap counters plus the last-event revision. |
| `migration.js` | Idempotent, resumable import of legacy `settings.projects` (local connection only). Missing paths go to `pendingConnectionIds`; failures never look like an authoritative empty list. A later run whose state is `legacyProjectsImported: true` but still lists pending paths RE-ATTEMPTS them (a temporarily unavailable project that recovers later is still imported) and clears the pending list only once every pending path succeeded. Legacy data stays readable for the compatibility period (dual read); deletion is a later, separate, audited step. |
| `routes.js` | Catalog API: `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id`, `GET /api/projects/:id`, `GET /api/projects/capabilities` (lightweight `{ projectCatalogV1 }` read that stays available in EVERY state), probes, connection-scoped browse, and connection profile CRUD (`POST/PATCH/DELETE /api/connections` with loopback rejection, in-use deletion guard 409, `onConnectionsChanged` adapter/observer sync). `POST/PATCH /api/connections` fire a BEST-EFFORT background probe after the response (never blocks it): on success the server writes `lastProbeOkAt`; on failure the connection stays registered without a timestamp and the failure is logged, never thrown. `POST /api/connections/:id/probe` records `lastProbeOkAt` on success while the catalog is enabled (the write is skipped in the disabled read-gate state). `PATCH /api/connections/:id` accepts label-only bodies — the private baseUrl/token fall back to the saved profile, since clients never see them — and a changed target URL DROPS the previous `lastProbeOkAt` (a stale "connected before" timestamp must never vouch for a URL the server has not contacted). `DELETE /api/projects/:id` also removes the deleted project's session bindings via `sessionBindingStore.removeBindingsForProject` and reports the count as `bindingsRemoved`. All behind the base UI auth gate. Honors the `projectCatalogV1` flag: when `false`, every catalog/connection MUTATION returns 501 `capability_unavailable` before touching any store; reads stay available and the catalog files are never rewritten (see "Feature flag" below). Project-scoped browse enforces the lexical boundary first, then delegates to the adapter (which enforces under its own path semantics via the `canonicalPath` context). |
| `runtime-proxy.js` | `/api/projects/:projectId/runtime/*`: resolves the project server-side, forwards only the documented project-capable SDK/RuntimeAPI path families (not control-plane namespaces or machine-wide `/api/fs/home`, matched as a PREFIX so `/api/fs/home/`-style variants fail closed too) with QUERY STRING PRESERVED (pagination/filter/cursor params must reach the upstream), strips the control-plane `oc_url_token` before forwarding/logging, enforces bounded request/response sizes, streams with sanitized response headers, and holds one lease per request. A browser disconnect ABORTS the upstream request/stream (and thus releases the lease promptly); the write path honors backpressure (`drain`). OpenCode `/api/config/*` has no project contract and returns an explicit 501 `capability_unavailable` instead of being forwarded. Typed adapter boundary errors retain safe 4xx/5xx codes; generic upstream failures remain sanitized 502s. Resolves the connection via the broker (profile and credential provider included in the adapter context). Also owns the desensitized proxy counters (requests/failures/cancels/active streams — no URLs, headers or bodies) and the canonical `projectCatalogV1` env resolver. `parseProjectRuntimePath` fails closed on malformed percent-encoding (null, never a throw — it runs synchronously on the `upgrade` event before any auth check, where a decode throw would escape the listener and crash the control plane). WebSocket upgrades are wired: `handleProjectUpgrade` is the central dispatcher registered first on the server `upgrade` event (server entrypoint, with a defensive try/catch that destroys the socket instead of letting a synchronous throw reach the process handler) — it owns every `/api/projects/:id/runtime...` upgrade (allowlisted paths `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`), authenticates like the terminal/event sockets (cookie/bearer/URL token + origin), gates on the connection capability AND on `projectCatalogV1` (a disabled flag rejects the upgrade 501), holds a broker lease for the socket pair lifetime and pipes either a URL-backed or adapter-owned socket back to the browser. Non-project paths are left untouched for the existing module listeners; requests it owns are marked (`PROJECT_RUNTIME_UPGRADE_MARKER`) so module listeners that also match project-prefixed paths (the terminal runtime) skip them — a project upgrade has exactly one handler. Failures reject the upgrade with an explicit HTTP error (501 `capability_unavailable` / 401 / 403 / 404 / 502), never a silent swallow. |
| `session-index-routes.js` | `GET /api/project-sessions/snapshot`, `GET /api/project-sessions/events` (SSE, revision-carrying), `POST /api/projects/:id/sessions` (create + `created-in-project` binding), `POST /api/projects/:id/sessions/:sid/bind` (explicit move). The two POST mutations are gated to 501 `capability_unavailable` by index.js when `projectCatalogV1` is false (a gate registered before these routes, so the real handlers never see them). |
| `diagnostics.js` | `GET /api/projects/diagnostics` — desensitized control-plane snapshot (plan §19) behind the same UI auth gate: catalog schema/revision/last persist time/recovery state, per-connection broker lifecycle + leases, per-connection session-index freshness (last success, backoff count, event-stream presence, reload/coverage-gap counters), session-index snapshot + last-event revision, runtime proxy request/failure/cancel/active-stream counts, migration status and the `projectCatalogV1` flag. Desensitization contract: NO tokens, credentials, headers, upstream URLs or paths; migration pending paths are reduced to a count and a recursive redaction drops known sensitive keys before the payload leaves the route. |
| `index.js` | Runtime factory: wires stores, broker, adapters (local + per-profile direct/relay + `injectedAdapters`), migration, binding store and session index; `registerRoutes`, `migrate`, `startSessionIndex`, `registerInjectedAdapter`, `unregisterInjectedAdapter`, `getDiagnostics`, `dispose`. Reads the operator env switch (`OPENCHAMBER_PROJECT_CATALOG_DISABLED=1`) into the `projectCatalogV1` capability flag, passes it to every route registrar, and — when disabled — registers the explicit 501 gates for the runtime proxy prefix and the session-index mutation routes in place of the real handlers. Injected adapters (Electron SSH) are registered and seeded with private ssh profiles automatically. `registerInjectedAdapter(adapter)` attaches a privileged adapter at runtime (broker registration + idempotent profile seed + stop-then-ensure observer start, awaited so an unregister cannot race a still-in-flight observer start) and is served to native hosts as `handle.registerProjectConnectionAdapter`; `unregisterInjectedAdapter(connectionId)` detaches it and stops observation while deliberately PRESERVING the saved profile (catalog projects stay resolvable; the connection stays visible as offline; profile deletion stays the user-facing 409-guarded connection delete path). Relay adapters are registered only when a server-side credential provider is supplied. `startSessionIndex()` also fires a best-effort boot-time probe for every saved direct/relay connection (never blocking startup, never throwing): a successful probe records `lastProbeOkAt`, so a server that ever connected stays visibly "connected before" — the write is skipped entirely in the disabled read-gate state. |
| `DOCUMENTATION.md` | This file. Tests live adjacent (`*.test.js`) and cover every module. |

## Feature flag: `projectCatalogV1` (plan §20)

- Operator switch: set `OPENCHAMBER_PROJECT_CATALOG_DISABLED=1` in the server
  environment (any other value or absence = enabled). The flag is resolved in
  `index.js` (`resolveProjectCatalogV1`, canonical env resolver in
  `runtime-proxy.js` so the WebSocket upgrade handler, which the server
  entrypoint wires directly, reads the same variable). Tests inject the
  boolean as `projectCatalogV1` in dependencies.
- While disabled, the following return 501 `capability_unavailable` (the
  existing sendError code style):
  - every catalog mutation: `POST /api/projects`, `PATCH/DELETE
    /api/projects/:id`, `POST/PATCH/DELETE /api/connections`;
  - every session-index mutation: `POST /api/projects/:id/sessions`,
    `POST /api/projects/:id/sessions/:sid/bind` (gate registered before
    the real routes);
  - every project-prefixed runtime request `app.use/all
    /api/projects/:projectId/runtime` (the real proxy is not registered)
    and every project-prefixed WebSocket upgrade (`handleProjectUpgrade`
    rejects 501).
- Reads stay available: `GET /api/projects` (snapshot), single project,
  browse, probes, `GET /api/projects/capabilities` (always returns
  `{ projectCatalogV1: boolean }`), session-index snapshot/SSE, and
  `GET /api/projects/diagnostics`.
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

The projects runtime is created and its routes registered AFTER the base UI
auth gate (`requireApiAuth` in core-routes.js) and BEFORE the generic OpenCode
`/api/*` proxy (inside `startupPipelineRuntime.run`). The generic proxy must
never capture project paths. `/api/projects` and `/api/connections` are on
the JSON body-parser allowlist (core-routes.js; `/api/project-sessions/*`
carries only GET snapshot/SSE reads and needs no body parsing) and the catalog
read paths (`/api/projects`, `/api/projects/capabilities`,
`/api/projects/diagnostics`, `/api/projects/:id/children`, `/api/connections`,
`/api/project-sessions/snapshot`, `/api/project-sessions/events`) are on the
URL-token GET allowlist (ui-auth.js). Read-only
project runtime SDK/Files/Git/permission/question/event paths are also
URL-token readable for cookie-less mobile/tray clients; runtime mutations
still require the normal session/bearer authentication. The events endpoint
is SSE (token-readable GET). When `projectCatalogV1` is disabled, the
runtime proxy and session-index mutation gates are registered BEFORE the
session-index routes so the real handlers (and the generic proxy) never see
disabled-state mutations; `GET /api/projects/capabilities` and
`GET /api/projects/diagnostics` are registered with the other project
routes and sit behind the same auth gate. `startSessionIndex()` runs after
route registration so clients cannot race the initial snapshot.

## Failure semantics

- Authoritative fetch failure never replaces old data and never renders as
  "no projects" (catalog AND session index).
- One connection failing never blocks or clears other connections; each
  connection carries its own `complete`/`stale`/`lastSuccessAt`/`error`.
- Project delete removes the catalog reference and the local
  `(connectionId, upstreamSessionId)` session bindings pointing at it (the
  DELETE route calls `removeBindingsForProject`; a binding-cleanup failure
  after a successful catalog delete returns 500 `binding_cleanup_failed` so
  the caller can retry); it never touches
  upstream sessions/files/terminals. Connection delete is refused (409) while
  projects reference it.
- Removing a privileged SSH instance (Electron main) unregisters its adapter
  and stops its session-index observer, but never deletes the connection
  profile or catalog projects: user data is removed only through the
  explicit, 409-guarded connection delete path, never as an instance-removal
  side effect.
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
- The `projectCatalogV1` disabled state is a read gate with explicit 501
  `capability_unavailable` responses for every catalog/session-index mutation
  and project runtime request/upgrade; it never rewrites catalog data
  files and never forwards project requests to any upstream.

## Security

- Private records (credentialRef, sshInstanceId, clientToken, baseUrl of
  direct targets) never appear in API responses, logs, URL tokens or the
  catalog file; `toConnectionSummary` is the only public projection.
- The runtime proxy and session index resolve upstream URLs from saved
  connection profiles only; clients can never pass an upstream URL.
- `projectId` is a TRUSTED authorization boundary server-side: project
  browse and the runtime proxy validate every directory hint (headers,
  `directory` query/body), every filesystem/Git/terminal path field, and the
  encoded route path in `/api/fs/serve/:path` against the project canonical
  path — lexically (`..` traversal rejected) and, for
  the local adapter, through symlink resolution. Relative file/Git paths are
  resolved under the project root; the filesystem list `path` query is
  independently scoped because that route does not consume directory headers.
  Local read/stat/raw requests may use the existing server-validated
  `outsideFileGrant` exception; Direct/Relay adapters cannot validate a local
  grant and reject outside paths. The project directory header is always
  overwritten with the canonical path, so a client can never widen the
  directory to e.g. `/etc`.
- Direct targets pass an SSRF gate (loopback/private/link-local/metadata
  resolution blocked, redirect hops re-validated with a cross-host allowlist).
  Known limit: the port check accepts the full 1–65535 range rather than a
  web-common subset — the host-level private/loopback blocking remains the
  primary defense, and the range check only rejects malformed ports.
- Upstream auth headers and internal URLs are stripped from proxied responses.
- Electron SSH adapters forward only to ssh-manager-produced tunnel URLs;
  renderers never see tunnel URLs or SSH material.
- Project-prefixed WebSocket upgrades (`/api/projects/:id/runtime/api/.../ws`)
  are owned by the central upgrade dispatcher: they pass the same auth gate as
  the non-prefixed sockets (session cookie / bearer / short-lived URL token via
  `isUrlAuthWebSocketPath`, then origin), the browser query string (which may
  carry the control-plane URL token) is never forwarded upstream, and the
  adapters inject upstream credentials server-side — the same
  `BLOCKED_UPSTREAM_HEADERS` filter and directory-boundary enforcement as
  `fetch` apply to upstream ws headers. The relay tunnel host allowlists the
  same project-prefixed WS paths so mobile clients can open them through the
  tunnel.

## Current phase status

Phases 0–2 are delivered on this branch: catalog + local vertical slice,
project-bound runtime handles, and terminal/WS proxying through the central
upgrade dispatcher. Phase 3's implementation slice now includes Direct
connection CRUD, SSRF/redirect/credential handling, remote path probing,
project-scoped HTTP/SSE/WS forwarding, filesystem/Git/terminal directory
boundaries, and the project-bound SDK/RuntimeAPI wiring. Relay has the
connection-keyed adapter and real wire coverage, but its broad cross-platform
acceptance remains Phase 5 work.

The remaining Phase 3 gate is environmental: add one real reachable remote
server and verify session list/messages, files/search, Git, terminal,
permission/question, SSE/WS reconnect, and browser/Storage secret absence.
Focused tests prove the control-plane contracts but do not substitute for that
remote acceptance. Non-project selections still use the ambient runtime for
compatibility; the runtime-switch facades were retired with Phase 6 — the
control plane is now the only runtime selection mechanism
(`packages/ui/src/lib/control-plane.ts`).
