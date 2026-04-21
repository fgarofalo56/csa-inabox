---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: security audit (AQ-0012), portal engineering
informed: portal maintainers, governance, ops
---

# ADR 0019 — BFF reverse-proxy + HMAC-sealed MSAL token cache

## Context and Problem Statement

CSA-0020 (HIGH) / AQ-0012 ran in two phases:

- **Phase 1 (ADR-0014)** — SPA hardening with strict CSP + Trusted
  Types.
- **Phase 2 (ADR-0014)** — server-side MSAL Auth Code + PKCE flow
  issuing an opaque httpOnly `csa_sid` session cookie. Access and
  refresh tokens stopped leaving the backend.

Phase 2 left two concrete items on the deferred-work list:

> **Reverse-proxy API traffic through the BFF** — today
> `/auth/token` returns raw access tokens for SPA migration
> convenience. The terminal state is that the SPA calls the BFF on
> `/api/*` and the BFF attaches the access token server-side. Track
> as a follow-up (CSA-0020 Phase 3).
>
> **MSAL token cache persistence** — `msal.SerializableTokenCache`
> can rehydrate the MSAL internal cache from the session store,
> making `acquire_token_silent` first-call-fast. The current
> implementation lets MSAL rebuild the cache from the refresh token
> on every process restart; acceptable but not optimal.

This ADR closes both. Shipping the reverse proxy eliminates the last
path where an access token reaches the browser (`POST /auth/token`).
Shipping a persistent, HMAC-sealed MSAL cache makes every proxied
request cache-fast across pod restarts and multi-replica deployments
— and it makes the cache tamper-evident if Redis is compromised.

## Decision Drivers

- **Never hand a token to the browser.** The residual `/auth/token`
  call site exists only for the SPA migration window. Phase 3
  terminates the handoff so an XSS primitive on the portal origin
  yields exactly zero token material, end of story.
- **Cache persistence must not introduce a new replay vector.** A
  Redis compromise should not translate into a "poison the cache /
  replay tokens" primitive. Sealing each cache blob with HMAC-SHA256
  makes tampering detectable and drops the blob on the floor when
  detected.
- **Feature-flagged rollout.** Phase 2 is already deployed in some
  environments using the direct-handoff path; flipping the proxy on
  globally must be operator-controlled, so `BFF_PROXY_ENABLED`
  defaults to `false` and is switched per environment.
- **Fail-closed configuration.** The upstream API scope has no safe
  default (operators must know their app registration); a missing
  HMAC key with the Redis cache backend is a security hole. Both are
  enforced at settings-load time, not at first request.
- **No real infra in tests.** The test suite must never reach out to
  Entra ID, Redis, or an upstream API — every dependency is injected
  or monkey-patched.

## Considered Options

1. **Keep the direct `/auth/token` handoff** indefinitely — SPA pulls
   a fresh bearer, then calls the API directly.
2. **Persist the MSAL cache without sealing** — trust Redis integrity
   to the platform's network controls.
3. **Full API gateway** (Azure API Management, Kong) in front of the
   portal API — offload auth + routing.
4. **BFF reverse-proxy + HMAC-sealed persistent cache** (chosen).

## Decision Outcome

Chosen: **Option 4 — BFF reverse-proxy mounted behind
`BFF_PROXY_ENABLED=true`, backed by a HMAC-sealed
`msal.SerializableTokenCache` persisted to Redis.**

### What ships

- `portal/shared/api/routers/api_proxy.py` — FastAPI router mounted
  at `/api/{path:path}` when `AUTH_MODE=bff` AND
  `BFF_PROXY_ENABLED=true`. Resolves `csa_sid` → `SessionState` →
  `TokenBroker.acquire_token()` → forwards the request to
  `BFF_UPSTREAM_API_ORIGIN` with `Authorization: Bearer …` injected,
  streams the response back byte-for-byte, strips hop-by-hop headers
  and any upstream `Set-Cookie`.
- `portal/shared/api/services/token_broker.py` — `TokenBroker` class
  wrapping MSAL. Attempts `acquire_token_silent` first, falls back to
  `acquire_token_by_refresh_token`, raises
  `TokenRefreshRequiredError` (inherits `HTTPException(401, …)`) when
  both paths fail. Emits structured logs with `session_id_hash`,
  `scope`, `cache_hit`, `acquisition_ms`.
- `portal/shared/api/services/token_cache.py` — `SealedTokenCache`
  subclass of `msal.SerializableTokenCache` with async `async_load` /
  `async_save` hooks. Sealing: `nonce ‖ HMAC-SHA256(key, nonce ‖
  body) ‖ body`. Tamper → log `bff.token_cache.tamper_detected` at
  ERROR, purge the blob, return empty so MSAL re-acquires.
  `InMemoryTokenCacheBackend` for dev; `RedisTokenCacheBackend` for
  production, with key namespace `csa:bff:tcache:<sha256(session_id)>`.
- `portal/shared/api/config.py` — new settings:
  `BFF_PROXY_ENABLED`, `BFF_UPSTREAM_API_ORIGIN`,
  `BFF_UPSTREAM_API_SCOPE`, `BFF_UPSTREAM_API_TIMEOUT_SECONDS`,
  `BFF_TOKEN_CACHE_BACKEND`, `BFF_TOKEN_CACHE_TTL_SECONDS`,
  `BFF_TOKEN_CACHE_HMAC_KEY` (`SecretStr`). A `model_validator`
  enforces: (a) proxy enabled ⇒ upstream scope required, (b) Redis
  cache ⇒ HMAC key ≥ 32 chars.
- `portal/shared/api/main.py` — lifespan hook instantiates the shared
  `httpx.AsyncClient` + `TokenBroker` on startup and closes them on
  shutdown. Router mounted under the same `AUTH_MODE=bff` guard that
  already protects `auth_bff`.
- Tests: 36 new (`test_api_proxy.py`, `test_token_broker.py`,
  `test_token_cache.py`) — zero network, zero Redis, zero MSAL
  outbound traffic.

### Why HMAC sealing (instead of raw storage)

A Redis compromise with raw storage lets the attacker:

1. **Inject a cached refresh token for an attacker-controlled
   session** — replay that entry on a legitimate session's cache key
   and MSAL will happily trade it for a bearer.
2. **Swap the token into a short-lived session** — rotate cache
   contents faster than MSAL re-acquires from the refresh token.

HMAC over `nonce ‖ body` makes these primitives observable: a bad MAC
on load logs `bff.token_cache.tamper_detected` + drops the blob, and
MSAL falls back to the refresh-token path (which lives in the signed
`csa_sid` session record — a separate trust boundary). This is not
confidentiality; the body of the MSAL cache is not secret beyond the
session it belongs to. It is *integrity* + *freshness* (via the
nonce) so cache replay and substitution are detectable.

### Why `SerializableTokenCache` (instead of custom in-session state)

MSAL's cache format is versioned and includes schema fields
(`Account`, `AccessToken`, `RefreshToken`, `IdToken`) that we do not
want to reimplement. Subclassing `SerializableTokenCache` reuses
MSAL's own (de)serialisation and lets future MSAL upgrades evolve the
schema without our touching the persistence code. Sealing happens
around the `serialize()` / `deserialize()` boundary so the MSAL
internal format is never coupled to our wire encoding.

### Feature-flag behaviour

| `AUTH_MODE` | `BFF_PROXY_ENABLED` | Result |
| --- | --- | --- |
| `spa` | any | Neither BFF nor proxy mounted — existing SPA deployment. |
| `bff` | `false` (default) | BFF auth router mounted, direct `/auth/token` handoff still works — no behaviour change from Phase 2. |
| `bff` | `true` | BFF auth + reverse proxy both mounted. SPA should `fetch('/api/...')` and rely on the cookie; `/auth/token` remains mounted for migration rollback. |

Mis-combinations (`spa` + `BFF_PROXY_ENABLED=true`) are tolerated —
the proxy isn't mounted because the `AUTH_MODE=bff` guard wraps both
routers — but the startup logs make the state obvious.

## Consequences

**Positive:**

- **Zero-token browser** — the `/auth/token` migration-convenience
  path becomes optional; the SPA's steady state never touches an
  access token. AQ-0012's "long-term" column is fully delivered.
- **Persistent silent acquisition** — process restarts, pod recycles,
  and multi-replica deployments all benefit from cache continuity.
  The first proxied request after a restart is silent-cache-fast,
  not a round-trip to Entra ID.
- **Tamper-evident cache** — a Redis compromise produces log events
  (not silent token reuse). The HMAC key is a `SecretStr` injected
  from Key Vault in production.
- **Structured observability** — `bff.proxy.request`,
  `bff.token_cache.hit/miss/refreshed/tamper_detected`,
  `bff.token_broker.acquired` fields land in Log Analytics with
  `session_id_hash`, `cache_hit`, `upstream_ms`, `acquisition_ms` so
  cache-hit ratios + tail latency are queryable.
- **Retry-aware upstream** — tenacity retries 502/503/504 and
  transport-level errors up to 3 times with jittered exponential
  backoff before surfacing a 504 to the SPA. Matches the "upstream
  transient vs. upstream dead" distinction operators need.

**Negative:**

- **Operator burden: one more secret** — `BFF_TOKEN_CACHE_HMAC_KEY`
  must live in Key Vault alongside `BFF_SESSION_SIGNING_KEY` and
  `BFF_CLIENT_SECRET`. Documented in the settings validators and in
  `portal/shared/README.md`.
- **Additional hop for API traffic** — one BFF → upstream intra-VNet
  trip per request. In the happy path this is ~1ms; on cache miss
  + refresh-token fallback it is dominated by the Entra ID round
  trip. Acceptable; observable via `upstream_ms`.
- **Redis becomes load-bearing for cache** — without Redis, cache
  persistence falls back to in-memory (dev behaviour). Production
  deployments must provision Azure Cache for Redis (the same
  instance already used by `BFF_SESSION_STORE=redis`).

**Neutral:**

- The existing `/auth/token` endpoint is **not removed**. It remains
  available for migration rollback — flip `BFF_PROXY_ENABLED=false`
  + revert the SPA to `authBff.bffFetchToken()` and the platform is
  back on Phase 2 without a redeploy of the BFF image. Removal is
  planned for the next major version, tracked separately.

## Migration plan

Per environment, in order:

1. **Generate a 64-byte random `BFF_TOKEN_CACHE_HMAC_KEY`** via
   `openssl rand -base64 48`. Store in Key Vault; inject via managed
   identity into App Service / Container Apps.
2. **Provision Redis** (if not already for Phase 2) and set
   `BFF_TOKEN_CACHE_BACKEND=redis` + `BFF_REDIS_URL=…`. Single-
   replica dev deployments can keep `memory`.
3. **Configure `BFF_UPSTREAM_API_ORIGIN`** to the private-endpoint
   URL of the portal backend (or `http://localhost:8001` in dev).
4. **Configure `BFF_UPSTREAM_API_SCOPE`** — must be the custom API
   scope the BFF app registration is allowed to request on behalf of
   the user. `api://<portal-api-client-id>/.default` is the standard
   pattern.
5. **Flip `BFF_PROXY_ENABLED=true`** in the BFF environment. Startup
   validators refuse to boot if the settings above are missing.
6. **Update the SPA** — replace `authBff.bffFetchToken()` + direct
   API calls with plain `fetch('/api/...', { credentials: 'include' })`.
   Because cookies are httpOnly + SameSite=Lax + Secure, no token
   plumbing is needed; the browser attaches `csa_sid` automatically.
7. **Validate** with the `curl` flow below, monitor
   `bff.proxy.request` events for non-zero `upstream_ms` and
   `cache_hit=true` after the first request.

## Validation

We will know this decision is right if:

- A portal XSS sandbox (`document.body.innerHTML = "<img src=x
  onerror=navigator.sendBeacon('/x', ...)>"`) under `AUTH_MODE=bff`
  with `BFF_PROXY_ENABLED=true` **cannot** exfiltrate a token — there
  is no token in JS runtime, `fetch('/auth/token')` is not called by
  the SPA, and the `csa_sid` cookie is httpOnly so no beacon can
  carry it.
- `curl -b csa_sid=<signed-cookie> https://portal.example.com/api/v1/sources`
  round-trips through the BFF → upstream → back to the caller with
  a 200 and a JSON payload; log analytics shows a
  `bff.proxy.request` event with `cache_hit=true` on the second
  call.
- A tampered Redis entry produces `bff.token_cache.tamper_detected`
  in Log Analytics and the next `/api/...` call succeeds (MSAL
  re-acquires from the refresh token — no user-visible failure).
- The test suite `pytest portal/shared/tests/test_api_proxy.py
  portal/shared/tests/test_token_broker.py
  portal/shared/tests/test_token_cache.py` passes in CI.

## Alternatives considered

### Option 1 — keep `/auth/token` forever

- Pros: zero new code; no infrastructure change.
- Cons: still passes a bearer through the browser. An XSS primitive
  that can call `fetch('/auth/token?resource=api')` still extracts a
  live token. AQ-0012's "long-term" box stays unchecked.

### Option 2 — persist the cache without HMAC sealing

- Pros: simpler; one fewer secret.
- Cons: Redis compromise becomes a token replay primitive. A
  defense-in-depth posture in a FedRAMP deployment cannot accept
  that. Rejected.

### Option 3 — full API gateway (APIM / Kong)

- Pros: offloads routing + auth + telemetry to a managed control
  plane.
- Cons: reopens the "what's in the tenant vs. a SaaS control plane"
  question ADR-0008 settled for dbt. Gov rollout adds an APIM tier
  to the FedRAMP boundary. The BFF is already in-tenant and owns the
  session; bolting APIM on top is duplication. Deferred, not
  rejected — if we need cross-service routing later, APIM is the
  natural next step and it can sit in front of the BFF.

### Option 4 — BFF reverse-proxy + sealed cache (chosen)

- Pros: completes AQ-0012; tamper-evident cache; operator-controlled
  rollout; zero new SaaS surface.
- Cons: one new secret; Redis becomes load-bearing for cache (it
  already was for sessions when
  `BFF_SESSION_STORE=redis`).

## References

- ADR-0014 MSAL BFF auth pattern — predecessor; Phase 3 deferred
  work lands here.
- Related code (landed with this ADR):
  - `portal/shared/api/routers/api_proxy.py`
  - `portal/shared/api/services/token_broker.py`
  - `portal/shared/api/services/token_cache.py`
  - `portal/shared/api/models/auth_bff.py` (`AcquiredToken`)
  - `portal/shared/api/config.py` (new `BFF_PROXY_*`,
    `BFF_UPSTREAM_API_*`, `BFF_TOKEN_CACHE_*` settings + validators)
  - `portal/shared/api/main.py` (lifespan + conditional mount)
- Test suites:
  - `portal/shared/tests/test_api_proxy.py`
  - `portal/shared/tests/test_token_broker.py`
  - `portal/shared/tests/test_token_cache.py`
- Framework controls: NIST 800-53 **AC-17(2)** (transport
  confidentiality — bearer tokens stay server-side), **SC-23**
  (session authenticity — BFF cookie + sealed cache), **SC-28(1)**
  (protection at rest — HMAC-sealed cache blobs), **SI-10** (input
  validation — tamper detection on deserialise). See
  `csa_platform/governance/compliance/nist-800-53-rev5.yaml`.
- MSAL token cache reference:
  [SerializableTokenCache](https://learn.microsoft.com/python/api/msal/msal.serializabletokencache)
- HMAC construction: [RFC 2104](https://datatracker.ietf.org/doc/html/rfc2104)
- Hop-by-hop headers: [RFC 7230 §6.1](https://datatracker.ietf.org/doc/html/rfc7230#section-6.1)
- Discussion / finding: CSA-0020 (HIGH); approved ballot item
  AQ-0012 — "long-term" column.

## Deferred work

- **Remove `/auth/token`** — once the proxy has been in production
  for one release and all SPA call sites have been migrated, the
  direct-handoff endpoint can be removed. Track as a breaking
  change for the next major version; the current default
  (`BFF_PROXY_ENABLED=false`) keeps migration pressure low.
- **WebSocket proxying** — the current proxy is HTTP-only. If the
  portal needs WebSocket transport (e.g. live dashboard updates), a
  separate path handler with upgrade support is needed. Not blocking
  for CSA-0020.
- **Per-route cache keying** — today one MSAL cache is kept per
  session; a future optimisation could key per `(session, scope)` so
  swapping scopes doesn't serialise through the same cache. Profile
  first before shipping.
