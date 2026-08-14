/**
 * MSAL sign-in initiator. When a real Entra app-registration credential is
 * configured (LOOM_MSAL_CLIENT_ID + LOOM_MSAL_CLIENT_SECRET + AZURE_TENANT_ID)
 * the confidential client builds an OAuth code URL and 302s the browser to AAD.
 * Until then we return 503 with a clear message so the unblock action is obvious
 * in the network tab.
 *
 * IMPORTANT — the honest gate keys on the MSAL app-registration vars, NOT on
 * AZURE_CLIENT_ID. AZURE_CLIENT_ID is always set to the Console UAMI client id
 * in a deploy (used by DefaultAzureCredential for data-plane calls); that
 * identity is a managed identity and CANNOT perform an interactive user login.
 * If the gate keyed on AZURE_CLIENT_ID it would pass even with no real app
 * registration, and getMsalClient() would fall back to the UAMI with no secret
 * → an opaque login 500 (PRP deploy-readiness gap #2). Keying on
 * LOOM_MSAL_CLIENT_ID + a non-empty LOOM_MSAL_CLIENT_SECRET surfaces the honest
 * 503 with the wire-up remediation instead.
 *
 * Wire-up steps live in docs/fiab/MSAL-handoff.md. The push-button deploy now
 * provisions the app registration + secret automatically — see
 * platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep and
 * scripts/csa-loom/bootstrap-msal-app-reg.sh.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import { enforceRateLimitForKey, clientIp } from '@/lib/azure/rate-limiter';
import { armBase, getSqlSuffix } from '@/lib/azure/cloud-endpoints';
import {
  authCsrfEnabled,
  newAuthFlow,
  encodeAuthFlowCookie,
  setAuthFlowCookieHeader,
} from '@/lib/auth/authflow';
import { getSession } from '@/lib/auth/session';
import {
  AUTH_BREAKER_COOKIE,
  AUTH_BLOCKED_PATH,
  HOP_PARAM,
  authBreakerEnabled,
  authBreakerMaxAttempts,
  clearAttemptCookieHeader,
  decodeAttemptCookie,
  externalOrigin,
  hopFromParam,
  recordAttempt,
  requestIsHttps,
  setAttemptCookieHeader,
  stateWithHop,
} from '@/lib/auth/auth-breaker';
import { logSafe } from '@/lib/util/log-safe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Base login scopes (Graph audience for the session) + the delegated Azure
// Service Management scope. Requesting ARM user_impersonation at consent time
// means that after callback we can silently obtain an ARM-audience token for
// the user and cache it (lib/azure/user-token-store) — enabling per-user RBAC
// in the cross-subscription resource picker. If this scope isn't admin-
// consented, AAD simply omits it and login still succeeds (MSAL won't fail the
// code exchange for the base scopes). The ARM host is sovereign-cloud aware via
// armBase() so the delegated scope matches the deployment's cloud (Commercial
// management.azure.com vs Gov management.usgovcloudapi.net).
const ARM_SCOPE = `${armBase()}/user_impersonation`;
// Delegated Azure SQL Database scope — used to obtain a SQL-audience token for
// the user so a SQL analytics endpoint set to "user's identity" data-access
// mode (F10) can run queries under the caller's own identity. The audience host
// is cloud-portable: LOOM_SYNAPSE_SQL_TOKEN_SCOPE overrides, else the default
// follows getSqlSuffix() so a single image serves every sovereign cloud without
// the operator having to set the env var:
//   Commercial/GCC:  https://database.windows.net/user_impersonation
//   GCC-High/IL5/DoD: https://database.usgovcloudapi.net/user_impersonation
// If this scope isn't admin-consented, AAD simply omits it and login still
// succeeds (MSAL won't fail the code exchange for the base scopes); the query
// route then surfaces an honest "sign in again / grant consent" gate.
const SQL_USER_SCOPE = `https://${process.env.LOOM_SYNAPSE_SQL_TOKEN_SCOPE || getSqlSuffix()}/user_impersonation`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read', ARM_SCOPE, SQL_USER_SCOPE];

function redirectUri(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/auth/callback`;
}

/**
 * `getSession()` for the breaker's "is this actually a loop?" question.
 *
 * A live session at /auth/sign-in means the browser HOLDS a working session, so
 * this is an account switch and not a loop. Wrapped because a failure to READ
 * the session must never be reported as "no session" — that would silently turn
 * an account switch into a counted loop attempt. On a throw we return undefined
 * (unknown), and the caller treats unknown the same as absent for counting but
 * the distinction is recorded here rather than being lost in a bare `catch`.
 */
function getSessionSafely(): ReturnType<typeof getSession> | undefined {
  try {
    return getSession();
  } catch {
    return undefined;
  }
}

export async function GET(req: NextRequest) {
  // Per-IP anonymous rate limit (rel-T16) — a sign-in initiator is cheap to spam
  // (302 to AAD). Default ON; two-tier (in-memory burst + durable window).
  const limited = await enforceRateLimitForKey(clientIp(req.headers), 'auth');
  if (limited) return limited;

  // Honest gate (PRP deploy-readiness gap #2): require the MSAL app-registration
  // credential the confidential client actually uses for user login. Do NOT key
  // on AZURE_CLIENT_ID — that is the Console UAMI (a managed identity) which
  // cannot perform an interactive sign-in and has no usable client secret.
  const msalClientId = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  const msalSecret = (process.env.LOOM_MSAL_CLIENT_SECRET || '').trim();
  const tenantId = (process.env.AZURE_TENANT_ID || process.env.LOOM_MSAL_TENANT_ID || '').trim();
  if (!msalClientId || !msalSecret || !tenantId) {
    return NextResponse.json(
      {
        status: 'msal-not-configured',
        missing: [
          msalClientId ? null : 'LOOM_MSAL_CLIENT_ID',
          msalSecret ? null : 'LOOM_MSAL_CLIENT_SECRET',
          tenantId ? null : 'AZURE_TENANT_ID',
        ].filter(Boolean),
        unblock:
          'The push-button deploy provisions the Entra app registration + client ' +
          'secret automatically (loomMsalAppRegEnabled, default on). Re-run the ' +
          'post-deploy bootstrap (csa-loom-post-deploy-bootstrap.yml → "Provision ' +
          'MSAL app registration"), or follow docs/fiab/MSAL-handoff.md for the ' +
          'az ad app create / credential reset + Key Vault steps.',
      },
      { status: 503 },
    );
  }
  // ── CIRCUIT BREAKER (#3334) ───────────────────────────────────────────────
  // Everything above this point is untouched. Below, before we hand the browser
  // back to Entra, decide whether this browser is in a sign-in LOOP.
  //
  // The count is of COMPLETED Entra round trips that left the browser
  // unauthenticated — never of sign-in initiations. A user who abandons the
  // Entra page, or fumbles a password, never reaches /auth/callback, so nothing
  // stamped an outcome, nothing increments, and the breaker cannot fire on
  // them. See lib/auth/auth-breaker for the two counting channels (cookie +
  // the stateless hop carried in the OAuth `state`) and why one is not enough.
  const breakerOn = authBreakerEnabled();
  const secure = requestIsHttps(req.headers);
  let attemptCookie: string | null = null;
  let hop = 0;
  if (breakerOn) {
    // A live session here means this browser demonstrably HOLDS a working
    // session — an account switch, not a loop. Reset and proceed untouched.
    const live = getSessionSafely();
    if (live) {
      attemptCookie = clearAttemptCookieHeader(secure);
    } else {
      const prev = decodeAttemptCookie(req.cookies.get(AUTH_BREAKER_COOKIE)?.value);
      const carried = hopFromParam(new URL(req.url).searchParams.get(HOP_PARAM));
      const decision = recordAttempt(prev, Math.floor(Date.now() / 1000), carried);
      if (decision.tripped) {
        // Both interpolated values are already bounded by construction —
        // `effective` is a clamped integer and `cause` was narrowed to the
        // closed AUTH_CAUSES union — so neither can carry CR/LF. logSafe stays
        // anyway: the log-injection guard is a NAME scan that cannot see that
        // reasoning, and a wrapper that is merely redundant is cheaper than a
        // guard everyone learns to argue with. Do not strip it.
        console.warn(
          '[auth/sign-in] CIRCUIT BREAKER tripped —',
          logSafe(decision.effective),
          'completed sign-in round trips left this browser unauthenticated within',
          'the window; cause:',
          logSafe(decision.cause),
          '— serving the terminal diagnosis page instead of redirecting to Entra.',
        );
        // Terminal. This response NEVER redirects to Entra, so the loop stops
        // here. The cause + count also ride the query string so the page still
        // diagnoses correctly when the browser is dropping cookies entirely
        // (which is one of the loop causes it has to survive).
        //
        // The origin comes from `externalOrigin(req.headers)`, NOT from
        // `req.url`. Under `output: 'standalone'` with HOSTNAME/PORT set — this
        // console's shape — Next builds the handler's request URL from its own
        // listen address, so `new URL(to, req.url)` emits
        // `Location: https://0.0.0.0:3000/auth/blocked` and the terminal page
        // never renders. See the evidence chain on externalOrigin().
        const to = `${AUTH_BLOCKED_PATH}?cause=${encodeURIComponent(decision.cause)}&n=${decision.effective}`;
        const res = NextResponse.redirect(new URL(to, externalOrigin(req.headers)), 303);
        // A per-browser diagnosis must never be served to a different browser
        // from a shared cache. Front Door has cached HTML on this estate before.
        res.headers.set('cache-control', 'no-store');
        res.headers.append('set-cookie', setAttemptCookieHeader(decision.state, secure));
        return res;
      }
      if (decision.effective > 0) {
        // EVERY counted attempt is logged, not only the one that trips. Without
        // this a loop is invisible in the logs until hop 5, and entirely
        // invisible in the cases the breaker cannot count (see the coverage
        // note in lib/auth/auth-breaker) — a silent loop that became a silent
        // block is only half a fix. Both values are bounded by construction;
        // logSafe stays for the same reason it does on the trip line above.
        console.warn(
          '[auth/sign-in] sign-in attempt',
          logSafe(`${decision.effective}/${authBreakerMaxAttempts()}`),
          '— a completed Entra round trip left this browser unauthenticated; cause:',
          logSafe(decision.cause),
        );
      }
      attemptCookie = setAttemptCookieHeader(decision.state, secure);
      hop = decision.nextHop;
    }
  }

  // Login-CSRF hardening (rel-T12): mint {state, PKCE verifier + S256 challenge,
  // nonce} and persist {state, verifier, nonce} in the short-lived, single-use
  // `loom_authflow` cookie BEFORE bolting the matching params onto the authorize
  // URL. This is purely ADDITIVE — the client-id, scopes, redirect-URI, authority
  // and prompt are untouched; the params below only extend the existing builder.
  //
  // Atomic + degradation-safe: only when the cookie value can actually be
  // encrypted (SESSION_SECRET present) AND the kill switch is on do we add the
  // params AND set the cookie together. If either is absent the flow falls back
  // byte-for-byte to the prior behavior (no params, no cookie), and the callback's
  // own no_session_secret gate still fires downstream unchanged.
  const minted = authCsrfEnabled() ? newAuthFlow() : null;
  // Carry the breaker's STATELESS hop counter in the OAuth `state` (#3334).
  // Entra echoes `state` verbatim, so this survives a browser that returns no
  // cookies at all — the exact condition under which the cookie counter above
  // is blind, and the condition `state_mismatch` describes. The random half is
  // untouched (32 CSPRNG bytes) and the authflow cookie stores the WHOLE
  // suffixed string, so the callback's byte-for-byte safeEqual is unchanged.
  // With LOOM_AUTH_CSRF_ENABLED=false there is no state at all, so this channel
  // is simply absent and the cookie counter carries the breaker alone.
  const flow = minted && breakerOn ? { ...minted, state: stateWithHop(minted.state, hop) } : minted;
  const authFlowCookie = flow ? encodeAuthFlowCookie(flow) : null;
  const client = getMsalClient();
  const url = await client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(req),
    prompt: 'select_account',
    ...(flow && authFlowCookie
      ? { state: flow.state, codeChallenge: flow.challenge, codeChallengeMethod: 'S256' as const, nonce: flow.nonce }
      : {}),
  });
  const res = NextResponse.redirect(url);
  // append, never set — the authflow and breaker cookies are TWO Set-Cookie
  // headers and `set` would collapse them into one, silently dropping the first.
  if (flow && authFlowCookie) {
    res.headers.append('set-cookie', setAuthFlowCookieHeader(authFlowCookie));
  }
  if (attemptCookie) res.headers.append('set-cookie', attemptCookie);
  return res;
}
