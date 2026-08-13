# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## URL-token capability allowlist

Short-lived URL tokens (`oc_url_`, minted via `POST /auth/url-token`) are
capability-scoped: GET-only (plus allowlisted WebSocket upgrades) on a fixed
path allowlist. The project catalog read paths are token-readable
(`/api/projects`, `/api/projects/capabilities`,
`/api/projects/diagnostics`, `/api/projects/:id/children`,
`/api/connections`, `/api/project-sessions/snapshot`,
`/api/project-sessions/events`) so mini-chat/tray surfaces that may only
hold a token can render the unified tree. Read-only project runtime
SDK/Files/Git/permission/question/event paths are also token-readable for
cookie-less mobile/tray HTTP and SSE clients; runtime mutations and
control-plane namespaces remain excluded.
Catalog and session-index MUTATIONS are never token-usable; the security tests
in `ui-auth.test.js` pin both sides of that contract.
WebSocket upgrades are token-readable only on the socket allowlist
(`isUrlAuthWebSocketPath`): the non-prefixed sockets plus their
project-prefixed runtime variants
(`/api/projects/:id/runtime/api/{event,global/event,terminal}/ws`), which
the central project upgrade dispatcher authenticates exactly like the
non-prefixed paths.

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
