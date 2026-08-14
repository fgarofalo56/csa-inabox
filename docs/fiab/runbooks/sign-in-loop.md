# Sign-in loop — the circuit breaker and its cause codes

**Applies to:** every boundary (Commercial, GCC, GCC-High, IL5, DoD). The breaker
ships in the Console **image** and is on by default in all of them.

**Symptom that brings you here:** a user reports that clicking **Sign in** does
nothing except bounce them back to sign in, or they land on
**`/auth/blocked` — "Sign-in stopped after N attempts"**.

---

## 1. What the breaker is, and what it is not

Before #3334 a failing sign-in restarted itself forever. `/auth/callback` bounced
a state or nonce failure to `/auth/sign-in`, which handed the browser straight
back to Microsoft Entra ID. The code comments asserted this "cannot loop" — true
only while the `loom_authflow` cookie round-trips. On 2026-08-13 a cookie stopped
round-tripping ([#3331](https://github.com/fgarofalo56/csa-inabox/pull/3331): a
99-group admin's 5383-byte session cookie exceeded the 4096-byte browser cap and
was discarded silently) and the loop was infinite, silent, and undiagnosed.

The breaker counts **completed Entra round trips that left the browser
unauthenticated**. After five of those inside a ten-minute window,
`/auth/sign-in` stops redirecting to Entra and serves `/auth/blocked` — a
terminal page naming the specific cause.

It deliberately does **not** count sign-in *initiations*. A user who clicks
**Sign in**, fumbles a password, abandons the Entra page and tries again never
reaches `/auth/callback`, so nothing is recorded and the breaker cannot fire on
them. A user whose sign-in simply works never sees it at all.

It is **not** the per-IP rate limiter (`enforceRateLimitForKey(..., 'auth')`).
That limiter is keyed by IP — shared by everyone behind one egress address —
carries no diagnosis, and answers with a raw 429. It cannot substitute for a
per-browser breaker and never could.

---

## 2. Reading the terminal page

`/auth/blocked` shows a headline, what Loom **established** (never what it
guessed), what to try, and a diagnostics row: `cause`, `attempts`, `window`, and
— when a successful callback recorded one — the measured `Set-Cookie` byte
length. Ask the user for those four values first; they map 1:1 onto the server
log lines below.

| Cause | What it means Loom OBSERVED | First move |
|---|---|---|
| `authflow_cookie_missing` | Entra returned a `state`; the browser did not return the `loom_authflow` cookie. | Browser-side: cookie policy, tracking protection, or an extension. Try a private window. |
| `state_mismatch` | Both came back and did not match. | A genuinely stale/parallel flow, or a sign-in started from a foreign link. One clean retry. |
| `state_param_missing` | The cookie came back; Entra's response carried no `state`. | Check the redirect URI is registered exactly (a redirect that drops the query string does this). |
| `no_state_returned` | Neither came back. **Loom cannot tell which failed** and says so. | Read the `[auth/callback] state validation failed` log line — it records `haveCookie` and `haveStateParam`. |
| `nonce_mismatch` | The ID token's `nonce` did not echo the one Loom sent. | Stale or replayed authorization response. One clean retry; if it repeats, investigate. |
| `session_not_returned` | The exchange **succeeded** and a session cookie was emitted every time; the browser kept none. **This is the 2026-08-13 class.** | Read the byte count. Over 4096 → deployment defect, see §4. Under → browser/edge. |
| `exchange_failed` | The code exchange threw. Detail is server-side only. | `[auth/callback] exception:` in the Console log. `AADSTS7000215` = client secret drift; `AADSTS9002313` = the code was rejected. |
| `aad_error` | Entra answered with an error, not a code. | `[auth/callback] AAD error` names the AADSTS code — usually consent, assignment, or conditional access. |
| `not_configured` / `no_client_secret` / `no_session_secret` | The Console is missing `LOOM_MSAL_CLIENT_ID`/`AZURE_TENANT_ID`, `LOOM_MSAL_CLIENT_SECRET`, or `SESSION_SECRET`. | Deployment state — see §4. |
| `missing_code` / `no_token` | The callback had nothing to exchange, or the exchange produced no account/token. | One clean retry; then the Console log. |
| `rate_limited` | The anonymous per-IP limiter rejected the request. | Wait, retry. If many users share an egress IP, expect this under load. |
| `unknown` | Round trips failed and no branch recorded a cause. | Read every `[auth/callback]` line for that time window. |

---

## 3. Getting a user moving again

The page's **"Clear sign-in cookies and try again"** button POSTs to
`/auth/reset`, which clears `loom_authtry`, `loom_authflow` and `loom_session`
and starts exactly one clean attempt. If the underlying cause is still there the
loop restarts and terminates again after the same bounded number of hops. That
is the contract: **bounded, not cured.**

The counter also expires on its own after the window (default 600s), and is
cleared by a deliberate sign-out and by any `/auth/sign-in` that arrives holding
a valid session (an account switch).

---

## 4. When it is the deployment, not the browser

Two causes are yours, not the user's.

**`session_not_returned` with a byte count over 4096.** The session payload has
outgrown the cookie. `lib/auth/session.ts` bounds it (`MAX_COOKIE_VALUE_BYTES`)
and drops the `groups` claim to the Graph membership fallback, so a value over
the limit means a **new unbounded field was added to `UserClaims`**. Find it and
bound it. Do not raise the cap: 4096 is RFC 6265 §6.1, which every browser
enforces and Azure Front Door applies to the header as well — both discard an
over-length `Set-Cookie` silently.

**`not_configured` / `no_client_secret` / `no_session_secret`.** Re-run
`csa-loom-post-deploy-bootstrap.yml` → *Provision MSAL app registration*, or the
platform deploy for `SESSION_SECRET`. **Do not patch the Container App by hand** —
a bicep re-render drops out-of-band state, so a patched value is a countdown
rather than a fix.

---

## 5. Server-side signals

```
[auth/sign-in] sign-in attempt N/MAX — a completed Entra round trip left this
               browser unauthenticated; cause: <code>
[auth/sign-in] CIRCUIT BREAKER tripped — N completed sign-in round trips left
               this browser unauthenticated within the window; cause: <code>
[auth/callback] state validation failed — restarting login { haveCookie, haveStateParam }
[auth/callback] id_token nonce mismatch — restarting login
[auth/callback] exception: <message>
[auth/callback] session encoded for upn# <fingerprint> — cookie length <n>
```

The **first** line is emitted on every counted attempt, not only on the one that
trips — so a loop is visible from hop 1, and a loop that never reaches the
ceiling still leaves a trail. It is emitted only when a completed round trip was
evidenced, so an ordinary sign-in produces none of them.

The last line is the one that made 2026-08-13 confusing: it is emitted on a
**successful** encode, so a clean run of it on every hop of a loop is the
signature of `session_not_returned`, not evidence that sign-in worked.

---

## 6. Turning it off

`LOOM_AUTH_BREAKER_ENABLED=false` reverts the sign-in/callback flow byte-for-byte
to the pre-#3334 behaviour — i.e. back to looping forever with no diagnosis.
There is no supported reason to set it; it exists as a single-flip rollback,
matching the `LOOM_AUTH_CSRF_ENABLED` / `LOOM_SESSION_SLIDING_ENABLED`
convention. `LOOM_AUTH_BREAKER_MAX_ATTEMPTS` (default 5) and
`LOOM_AUTH_BREAKER_WINDOW_SECS` (default 600) tune it; all three are optional and
the breaker is fully functional with none of them set.

---

## 7. Verification

- Unit: `apps/fiab-console/lib/auth/__tests__/auth-breaker.test.ts`
- Loop termination (drives the real handlers, carries its own
  breaker-off control): `apps/fiab-console/app/auth/__tests__/sign-in-loop-termination.test.ts`
- Terminal-redirect reachability (drives the real handlers with the
  production request shape, carries its own embedded control):
  `apps/fiab-console/app/auth/__tests__/sign-in-redirect-origin.test.ts`
- Browser (G1): `pnpm exec playwright test --project=auth-loop-breaker`
  against a console running an image that carries #3334. Unattended — Entra is
  never reached, so no credentials and no MFA.

---

## 8. Known limits (measured, not assumed)

**A browser that keeps NO cookies at all is bounded per entry, not blocked
permanently.** The counter cookie is discarded and the stateless hop counter
lives in the OAuth `state`, which a fresh sign-in re-mints — so there is nothing
left to persist the verdict in. Each user-initiated attempt still runs at most
`LOOM_AUTH_BREAKER_MAX_ATTEMPTS` round trips and still ends on `/auth/blocked`
with a cause. It is never unbounded and never silent.

**Loop B with `loom_authtry` specifically dropped is not counted.** If the code
exchange SUCCEEDS every time and the browser keeps neither `loom_session` nor
`loom_authtry`, but does still send an older `loom_seen`, there is no counting
channel at all: a successful callback redirects to `/` and mints no `?h=` hop.
The reauth then goes to `/auth/sign-in` rather than `/welcome` and the loop runs
unbounded. Closing this needs a channel that survives a browser keeping nothing
on a path that does not pass back through `/auth/sign-in`.
