---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security audit (AQ-0012), portal engineering
informed: portal maintainers, governance, ops
---

# ADR 0014 — MSAL Backend-for-Frontend (BFF) auth pattern

## Context and Problem Statement

CSA-0020 (HIGH) — the React portal persists MSAL access and refresh
tokens in `sessionStorage` via `@azure/msal-browser`. Any XSS primitive
on the portal origin can read those tokens and exfiltrate them via an
image beacon, an attacker-controlled `fetch()`, or a `postMessage`
leak. Once lifted, the tokens are valid against Microsoft Graph and
the portal's own downstream APIs until they expire — with a stolen
refresh token, indefinitely.

`sessionStorage` is narrower than `localStorage` (scoped to the tab
lifetime) but it is still **readable from any JavaScript running on
the origin**. Strict CSP can make exploitation harder but cannot
eliminate the class: a bypass in a third-party dependency (React,
Next.js runtime, a transitive UI package) reintroduces the XSS path.

The audit board approved item AQ-0012:

> **Short-term**: add `storeAuthStateInCookie: true` and strict CSP
> with nonces.
> **Long-term**: migrate to an MSAL Backend-for-Frontend (BFF) pattern
> where tokens never reach the browser.

This ADR records the two-phase rollout.

## Decision Drivers

- **Eliminate token-exfiltration class** — XSS on the portal origin
  must not yield access tokens or refresh tokens. The browser should
  hold only an opaque session id.
- **Keep the SPA DX intact during migration** — flipping straight to
  BFF across every environment simultaneously is risky; operators
  need a feature flag.
- **Preserve Gov portability** — the solution must work against
  `login.microsoftonline.us` with the same codepaths as the commercial
  cloud.
- **Server-side refresh rotation** — refresh tokens must be usable
  without the browser ever seeing them, so Entra ID can rotate
  aggressively without user-visible re-authentication.
- **Auditor-friendly** — an auditor tracing AQ-0012 must land on
  concrete code, concrete tests, and a concrete migration plan.

## Considered Options

1. **SPA + strict CSP + Trusted Types only** — keep tokens in
   `sessionStorage` but make exfiltration materially harder.
2. **SPA + localStorage + strict CSP** — move cache to `localStorage`
   for the "persist across tabs" story; no security benefit over
   option 1 and a strictly worse blast radius.
3. **MSAL Backend-for-Frontend (BFF) pattern** — the FastAPI backend
   runs the MSAL Auth Code + PKCE flow, stores tokens server-side,
   and issues the browser an opaque httpOnly signed session cookie.
4. **Third-party IdP proxy (Auth0, Clerk, Workos)** — out of scope:
   reopens ADR-0007-style discussions around data-plane custody and
   FedRAMP posture.

## Decision Outcome

Chosen: **Option 3 — BFF, delivered in two phases**.

**Phase 1 — SPA hardening (landed, this commit).**

Applies immediately to every environment. SPA remains the default
(`AUTH_MODE=spa`).

- `portal/react-webapp/src/middleware.ts` — Next.js Edge middleware
  generates a per-request 16-byte base64 CSP nonce and emits a strict
  Content-Security-Policy with:
  - `default-src 'self'`
  - `script-src 'self' 'nonce-<n>' 'strict-dynamic'`
  - `style-src 'self' 'nonce-<n>'`
  - `frame-ancestors 'none'`
  - `require-trusted-types-for 'script'` + `trusted-types default`
  - Allow-list for `login.microsoftonline.com`, `login.microsoftonline.us`,
    `graph.microsoft.com`, `graph.microsoft.us`, and an optional
    `NEXT_PUBLIC_BFF_API_ORIGIN` in `connect-src`.
- `portal/react-webapp/src/pages/_document.tsx` — reads the middleware
  nonce via `getInitialProps` and stamps it onto `<Head>` and
  `<NextScript>` so every Next.js runtime chunk loads under the policy.
- `portal/react-webapp/next.config.js` — static security headers
  (`Strict-Transport-Security`, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`) set on
  every route via `headers()`.
- `portal/react-webapp/src/services/authConfig.ts` — documents why
  `storeAuthStateInCookie` is **not** set (msal-browser v4 removed the
  flag; the cookie-backed state it gated is now the library default)
  and adds the `resolveAuthMode()` feature-flag selector.

**Phase 2 — BFF scaffolding (landed, flag-gated off by default).**

- `portal/shared/api/routers/auth_bff.py` — FastAPI router at `/auth/*`
  implementing:
  - `GET /auth/login` — PKCE S256 challenge + state + nonce issued,
    bundled into a signed short-lived cookie, 302 to Entra ID.
  - `GET /auth/callback` — verifies signed pending-auth cookie,
    checks `state`, runs
    `msal.ConfidentialClientApplication.acquire_token_by_authorization_code`
    with the bound PKCE verifier, persists a `SessionState` in the
    configured `SessionStore`, sets an httpOnly signed `csa_sid`
    cookie, 302 to `redirect_to`.
  - `GET /auth/me` — returns the caller's profile from the session
    (401 when the cookie is missing / tampered / expired). Touches
    the session TTL for idle-extension.
  - `POST /auth/logout` — revokes the server-side session and
    deletes the cookie (204).
  - `POST /auth/token` — server-side `acquire_token_silent` for a
    named resource, returning a `Bearer` access token. Falls back
    to `acquire_token_by_refresh_token` on cache miss. Used during
    the migration window before the SPA routes every API call
    through the BFF as a reverse proxy.
- `portal/shared/api/services/session_store.py` — `SessionStore`
  Protocol with `InMemorySessionStore` (dev/test) and
  `RedisSessionStore` (production, async redis). Factory picks one
  based on `BFF_SESSION_STORE={memory|redis}`.
- `portal/shared/api/models/auth_bff.py` — Pydantic models
  (`SessionState`, `AuthMeResponse`, `TokenResponse`,
  `PendingAuthState`).
- `portal/shared/api/config.py` — adds `AUTH_MODE`, `BFF_TENANT_ID`,
  `BFF_CLIENT_ID`, `BFF_CLIENT_SECRET`, `BFF_REDIRECT_URI`,
  `BFF_SCOPES`, `BFF_COOKIE_*`, `BFF_SESSION_SIGNING_KEY`,
  `BFF_SESSION_TTL_SECONDS`, `BFF_PENDING_AUTH_TTL_SECONDS`,
  `BFF_SESSION_STORE`, `BFF_REDIS_URL`.
- `portal/shared/api/main.py` — router is **conditionally mounted**
  only when `settings.AUTH_MODE == "bff"`, so accidental exposure on
  an SPA-configured deployment is impossible. Staging / production
  deployments additionally fail startup if the signing key or the
  confidential-client credentials are missing.
- `portal/react-webapp/src/services/authBff.ts` — frontend helper
  (`bffFetchMe`, `bffLoginRedirect`, `bffLogout`) that the React app
  uses when `NEXT_PUBLIC_AUTH_MODE=bff`.

Both phases ship in the same commit. Phase 2 is feature-flagged off
(`AUTH_MODE=spa` default) so merging this work does not require
simultaneous Azure app-registration changes. Flip `AUTH_MODE=bff` per
environment once the BFF app registration is provisioned and the
redirect URI is registered.

### Why nonces + `strict-dynamic` + Trusted Types (instead of hashes)

- **Nonces rotate per response** — a leaked nonce is stale on the
  next load. A hash allow-list is essentially permanent and leaks as
  soon as one script is cacheable on an adversarial CDN.
- **`strict-dynamic`** lets scripts we already trust (Next.js runtime
  chunks) load their own dependencies without us enumerating every
  CDN up-front — including future upgrades.
- **Trusted Types** blocks common XSS primitives (`element.innerHTML
  = userInput`, `eval(x)`, `setTimeout(string)`) at the browser level.
  A `default` policy is declared by name; per-site policies can be
  added later without a spec churn.

### Cookie settings

| Setting          | Value                                  | Rationale                                              |
| ---------------- | -------------------------------------- | ------------------------------------------------------ |
| `HttpOnly`       | `true`                                 | JavaScript cannot read the cookie                       |
| `Secure`         | `true` in staging/prod; off in local   | Required for `SameSite=None` and for HSTS coherence     |
| `SameSite`       | `lax` default, `none` for split origin | Lax covers same-origin SPA; ops may relax for split origin |
| `Path`           | `/`                                    | Session applies to every BFF route                      |
| `Max-Age`        | 8h (configurable)                      | Matches typical SSO session; idle-extended on `/me`     |

## Consequences

**Positive:**

- Tokens never reach the browser — XSS on the portal origin yields
  only an opaque session id, which the BFF can revoke server-side.
- Refresh tokens rotate server-side; leaked access tokens expire in
  minutes without user-visible re-auth.
- Central logout: a single `POST /auth/logout` revokes the session
  across every tab and replica (Redis store).
- Clear migration path — SPA and BFF modes can coexist per
  environment during cutover.

**Negative:**

- New backend dependency on a confidential-client secret
  (`BFF_CLIENT_SECRET`) that must live in Key Vault, not environment
  vars, in production.
- Session-store infrastructure becomes a required dependency in
  multi-replica deploys (Redis). Single-replica deploys can use the
  in-memory store but lose the "central logout" guarantee.
- Every API call now round-trips through the BFF (or re-acquires an
  access token via `/auth/token`). In the steady state, latency is
  one extra intra-VNet hop; on cache misses it's a silent refresh
  against Entra ID.
- Mobile / native SPA embeddings lose straight MSAL access — they
  must either adopt the BFF pattern or fall back to SPA mode behind
  a feature flag.

**Neutral:**

- The `storeAuthStateInCookie` flag that AQ-0012 called out was
  removed from `@azure/msal-browser` in v4 because the library now
  cookies auth-request state by default on every redirect flow. The
  mitigation AQ-0012 asked for is now the MSAL v5 default — no
  explicit configuration change is required to achieve it. This is
  documented in `authConfig.ts` and asserted by
  `__tests__/pages/_app.test.tsx` so future MSAL upgrades can't
  silently regress the control.

## Migration plan

Per environment:

1. **Provision a confidential-client Entra ID app registration**
   separate from the SPA public client. Request the scopes in
   `BFF_SCOPES` (default `openid profile email offline_access
   User.Read`). Add a web redirect URI pointing at the BFF's
   `/auth/callback`.
2. **Store the client secret in Key Vault**; inject via managed
   identity into the App Service / Container Apps configuration.
3. **Generate a 64-byte random `BFF_SESSION_SIGNING_KEY`** and store
   it in Key Vault.
4. **Deploy Redis** (Azure Cache for Redis, premium tier for Gov
   regions) and configure `BFF_REDIS_URL`. Single-replica dev/test
   deployments may keep `BFF_SESSION_STORE=memory`.
5. **Flip `AUTH_MODE=bff`** in the backend environment and
   **`NEXT_PUBLIC_AUTH_MODE=bff`** in the frontend build env. Both
   flags are required — mismatched modes cause the SPA to hit
   non-existent endpoints or the BFF to refuse requests.
6. **Validate** with the `curl -I` check below, then run the portal
   smoke tests end-to-end (login → `/auth/me` → API call → logout).
7. **Roll forward env-by-env**: local → dev → staging → Gov staging
   → commercial prod → Gov prod.

## Validation

We will know this decision is right if:

- A portal XSS sandbox (deliberate injection of
  `document.body.innerHTML = '<img src=x onerror=...>'`) under
  `AUTH_MODE=bff` yields **zero tokens** to the attacker — only the
  opaque `csa_sid` cookie, which is `HttpOnly` and therefore
  unreadable from JS.
- `curl -I https://portal.example.com/` returns a CSP header that
  refuses inline scripts, with a fresh nonce per response:

  ```
  HTTP/2 200
  content-security-policy: default-src 'self'; script-src 'self' 'nonce-abc123==' 'strict-dynamic'; style-src 'self' 'nonce-abc123=='; img-src 'self' data: https:; connect-src 'self' https://login.microsoftonline.com https://login.microsoftonline.us https://graph.microsoft.com https://graph.microsoft.us https://bff.example.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default
  strict-transport-security: max-age=31536000; includeSubDomains; preload
  x-content-type-options: nosniff
  x-frame-options: DENY
  referrer-policy: strict-origin-when-cross-origin
  permissions-policy: camera=(), microphone=(), geolocation=(), payment=()
  ```

- The BFF test suite (`pytest portal/shared/api -k auth_bff`) passes
  in CI, exercising state-tampering, happy-path token exchange,
  session resolution, logout, and silent acquisition fallback paths.

- The jest suite asserts the CSP header shape, the MSAL v5 cache
  contract, and the `resolveAuthMode()` precedence rules.

If we need to revert at any layer:

- **CSP breaks a legitimate script** → add a nonce to that script,
  or narrow the directive in `src/services/csp.ts`. Never weaken the
  policy below `'strict-dynamic'`.
- **BFF flow breaks in one environment** → flip `AUTH_MODE=spa` +
  `NEXT_PUBLIC_AUTH_MODE=spa` to roll back to Phase-1 hardening. The
  SPA mode never depends on the BFF, so the rollback is one deploy.

## Alternatives considered

### Option 1 — SPA + strict CSP + Trusted Types only

- Pros: zero backend churn; unchanged MSAL configuration; no new
  infrastructure.
- Cons: does **not** eliminate the XSS token exfiltration class. A
  CSP bypass in a transitive dependency reintroduces the whole
  threat. Inadequate as a long-term control for HIGH-severity
  findings.

### Option 2 — SPA + localStorage

- Pros: none beyond "tokens survive tab close."
- Cons: strictly worse than sessionStorage — every opened tab on
  the origin can read the cache, so the blast radius of one XSS
  bug widens. Rejected.

### Option 3 — BFF (chosen)

- Pros: authoritative mitigation; server-side refresh rotation;
  central logout; auditor-friendly narrative.
- Cons: new confidential-client secret + session-store infra.

### Option 4 — Third-party IdP proxy

- Pros: off-the-shelf implementation.
- Cons: reopens data-custody / FedRAMP posture; SaaS surface to
  clear in Gov; breaks the "no third-party control planes" posture
  that ADR-0008 and ADR-0007 established.

## References

- ADR-0007 Azure OpenAI over self-hosted LLM — informs the "no new
  SaaS control-plane in Gov" posture that pushes this ADR toward an
  in-tenant BFF.
- ADR-0008 dbt Core over dbt Cloud — same "keep the control plane
  in the tenant" principle.
- Related code (landed with this ADR):
  - `portal/react-webapp/src/middleware.ts`
  - `portal/react-webapp/src/services/csp.ts`
  - `portal/react-webapp/src/services/authConfig.ts`
  - `portal/react-webapp/src/services/authBff.ts`
  - `portal/react-webapp/src/pages/_document.tsx`
  - `portal/react-webapp/next.config.js`
  - `portal/shared/api/routers/auth_bff.py`
  - `portal/shared/api/services/session_store.py`
  - `portal/shared/api/models/auth_bff.py`
  - `portal/shared/api/config.py`
  - `portal/shared/api/main.py`
- Test suites:
  - `portal/react-webapp/__tests__/middleware.test.ts`
  - `portal/react-webapp/__tests__/pages/_app.test.tsx`
  - `portal/shared/tests/test_auth_bff.py`
- Framework controls: NIST 800-53 **IA-2** (identification and
  authentication), **SC-8** (transmission confidentiality — Trusted
  Types + CSP are input-sink controls that complement transport
  protection), **SC-23** (session authenticity — httpOnly signed
  cookies plus server-side revocation), **SI-10** (input
  validation — Trusted Types + strict CSP). See
  `csa_platform/governance/compliance/nist-800-53-rev5.yaml`.
- MSAL for Python reference: [Confidential client API](https://learn.microsoft.com/python/api/msal/msal.application.confidentialclientapplication)
- Auth Code + PKCE spec: [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)
- Trusted Types spec: [W3C Trusted Types](https://www.w3.org/TR/trusted-types/)
- Discussion / finding: CSA-0020 (HIGH); approved ballot item
  AQ-0012.

## Deferred work

- **Reverse-proxy API traffic through the BFF** — today
  `/auth/token` returns raw access tokens for SPA migration
  convenience. The terminal state is that the SPA calls the BFF on
  `/api/*` and the BFF attaches the access token server-side. Track
  as a follow-up (CSA-0020 Phase 3).
- **MSAL token cache persistence** — `msal.SerializableTokenCache`
  can rehydrate the MSAL internal cache from the session store,
  making `acquire_token_silent` first-call-fast. The current
  implementation lets MSAL rebuild the cache from the refresh token
  on every process restart; acceptable but not optimal.
- **Per-route CSP relaxation** — some third-party libraries
  (documentation embeds, Monaco editor) need looser CSP. Today those
  are not on the portal; if they land, add per-route CSP overrides
  in `src/middleware.ts` rather than weakening the global policy.
