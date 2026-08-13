/**
 * SIGN-IN CIRCUIT BREAKER (#3334).
 *
 * ── The failure class this exists for ───────────────────────────────────────
 *
 * `/auth/callback` bounces a state/nonce failure to `/auth/sign-in`, which
 * immediately 302s back to Entra, which comes back to `/auth/callback`. The
 * comment in authflow.ts asserts this "cannot loop", and that assertion is
 * TRUE — but only while the `loom_authflow` cookie round-trips. On 2026-08-13
 * a cookie stopped round-tripping (a 99-group admin's 5383-byte `loom_session`
 * exceeded the 4096-byte cap and was discarded silently, #3331) and the
 * operator hit an infinite, silent sign-in loop with no diagnosis anywhere.
 *
 * #3331 removed that TRIGGER. It did not remove the CLASS: any future cookie or
 * state failure loops identically. This module bounds the class.
 *
 * There are two distinct loops, and the breaker has to see both:
 *
 *   LOOP A — the callback never authenticates.
 *     callback → state/nonce/exchange failure → /auth/sign-in → Entra → callback …
 *
 *   LOOP B — the callback authenticates every time and the browser keeps nothing.
 *     callback → SUCCESS, Set-Cookie emitted → / → 401 → reauth → /auth/sign-in
 *     → Entra → callback → SUCCESS … (this is the 2026-08-13 outage exactly:
 *     the server logged a perfectly successful `session encoded` line on every
 *     hop.)
 *
 * ── What is counted, and why it is NOT "sign-in initiations" ────────────────
 *
 * The counter increments on a COMPLETED Entra round trip that left the browser
 * unauthenticated — never on a bare sign-in initiation. That distinction is the
 * whole reason a user who fumbles their password five times never sees the
 * breaker: they never reach `/auth/callback`, so nothing stamps an outcome and
 * nothing increments. Mechanically:
 *
 *   1. Every terminal branch of `/auth/callback` stamps the outcome IT
 *      ESTABLISHED into the `loom_authtry` cookie (`pending`). Success stamps
 *      `session_issued` plus the exact byte length of the Set-Cookie header it
 *      emitted.
 *   2. `/auth/sign-in` consumes a `pending` stamp: that is the proof a round
 *      trip completed and yet we are being asked to sign in again. It
 *      increments, attributes the cause, and clears the stamp.
 *   3. A live `loom_session` at `/auth/sign-in` (an account switch) resets the
 *      counter — the browser demonstrably holds a working session.
 *
 * ── Two independent counters, because one cookie is not enough ──────────────
 *
 * A cookie-based counter cannot see a loop in which NO cookie round-trips —
 * which is precisely the `state_mismatch` case the issue names. So the breaker
 * carries a SECOND, stateless counter in the OAuth `state` value itself:
 * `<random>~h<hop>`. Entra echoes `state` back verbatim, so the hop count
 * survives total cookie failure. The random half is untouched (still 32 bytes
 * of CSPRNG entropy) and the authflow cookie stores the whole suffixed string,
 * so `safeEqual(stateParam, flow.state)` still validates byte-for-byte.
 *
 * The hop count is attacker-controllable (it rides a URL). That is harmless:
 * raising it only trips the attacker's own breaker sooner, and it is parsed as
 * a bounded small integer and never rendered raw. The effective attempt count
 * is `max(cookie counter, carried hop + 1)`, so neither channel can mask the
 * other.
 *
 * Coverage, stated honestly:
 *   - Loop A, cookies working        → both counters fire.
 *   - Loop A, no cookie round-trips  → hop counter fires.
 *   - Loop B, cookies working        → cookie counter fires (hop chain breaks
 *                                      because a successful callback redirects
 *                                      to `/`, not to sign-in).
 *   - Loop B, no cookie round-trips  → does not reach here and does not loop:
 *                                      `loom_seen` is also absent, so
 *                                      `reauthDestination()` sends the browser
 *                                      to `/welcome`, which never auto-forwards
 *                                      to Entra.
 *
 * ── R7 (deploy-integrity): an error must not assert what it did not establish ──
 *
 * Every cause below is a fact one specific branch of the callback OBSERVED, and
 * `describeCause()` states only that. Where the code genuinely cannot tell two
 * causes apart (`no_state_returned` — neither the cookie nor the state param
 * came back), the copy says it cannot tell, rather than picking the likelier
 * one. `session_not_returned` reports the measured Set-Cookie byte length and
 * only blames size when the measurement actually exceeds the 4096-byte cap.
 *
 * Kill switch: LOOM_AUTH_BREAKER_ENABLED (default ON). `false` reverts the
 * sign-in/callback flow byte-for-byte to the pre-#3334 behaviour, matching the
 * LOOM_AUTH_CSRF_ENABLED / LOOM_SESSION_SLIDING_ENABLED convention.
 */

/** Counter cookie. Distinct from `loom_session` and `loom_authflow`. */
export const AUTH_BREAKER_COOKIE = 'loom_authtry';

/** Cookie Path — covers `/auth/sign-in`, `/auth/callback`, `/auth/blocked`. */
const AUTH_BREAKER_PATH = '/auth';

/** The terminal surface the breaker sends the browser to. Never redirects on. */
export const AUTH_BLOCKED_PATH = '/auth/blocked';

/** Query param carrying the stateless hop count from callback → sign-in. */
export const HOP_PARAM = 'h';

/** Highest hop/attempt value we will parse or store. Keeps the cookie tiny and
 *  a crafted `~h999999` from ever becoming a number worth reasoning about. */
const MAX_COUNT = 99;

/** Separator for the hop suffix on the OAuth `state`. `~` is RFC 3986
 *  unreserved and is NOT in the base64url alphabet, so it can never collide
 *  with the random half of the state. */
const HOP_SEP = '~h';

/**
 * Consecutive failed round trips that trip the breaker. Five is deliberate:
 * a real loop completes five Entra round trips in a few seconds, while a human
 * has to complete five FULL sign-ins that each end unauthenticated to reach it.
 */
export function authBreakerMaxAttempts(): number {
  const raw = Number(process.env.LOOM_AUTH_BREAKER_MAX_ATTEMPTS);
  if (!Number.isFinite(raw) || raw < 1) return 5;
  return Math.min(Math.floor(raw), MAX_COUNT);
}

/**
 * The window the attempts must fall inside. 600s mirrors AUTHFLOW_MAX_AGE_SECS
 * — a login round trip is seconds, so anything slower than this window is not
 * the tight loop being defended against and is left uncounted on purpose.
 */
export function authBreakerWindowSecs(): number {
  const raw = Number(process.env.LOOM_AUTH_BREAKER_WINDOW_SECS);
  if (!Number.isFinite(raw) || raw < 1) return 600;
  return Math.floor(raw);
}

/** Default ON. `false` reverts the login flow byte-for-byte to pre-#3334. */
export function authBreakerEnabled(): boolean {
  return (process.env.LOOM_AUTH_BREAKER_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/**
 * Every outcome a `/auth/callback` branch can ESTABLISH. Each maps 1:1 to a
 * return in that handler — nothing here is inferred.
 */
export const AUTH_CAUSES = [
  /** Per-IP anonymous rate limit tripped before the exchange was attempted. */
  'rate_limited',
  /** Entra returned `?error=` instead of a code. */
  'aad_error',
  /** Entra's response carried no `code`. */
  'missing_code',
  /** LOOM_MSAL_CLIENT_ID / AZURE_TENANT_ID missing on the Console. */
  'not_configured',
  /** LOOM_MSAL_CLIENT_SECRET missing on the Console. */
  'no_client_secret',
  /** SESSION_SECRET missing on the Console. */
  'no_session_secret',
  /** A `state` came back but the `loom_authflow` cookie did not. */
  'authflow_cookie_missing',
  /** The cookie came back but Entra's response carried no `state`. */
  'state_param_missing',
  /** Neither came back — the code cannot tell which side failed. */
  'no_state_returned',
  /** Both present, values differ. */
  'state_mismatch',
  /** The id_token's `nonce` did not echo the one we sent. */
  'nonce_mismatch',
  /** The code exchange returned no account / access token. */
  'no_token',
  /** The code exchange threw. Detail stays in the server log. */
  'exchange_failed',
  /** The callback authenticated and emitted a session cookie (pending only). */
  'session_issued',
  /**
   * Attributed at sign-in: the callback emitted a session cookie AND the
   * browser came back unauthenticated. The `session_issued` stamp becomes this
   * once sign-in observes the second half of that fact.
   */
  'session_not_returned',
  /** Round trips completed and failed, but no branch stamped a cause. */
  'unknown',
] as const;

export type AuthFailureCause = (typeof AUTH_CAUSES)[number];

const CAUSE_SET = new Set<string>(AUTH_CAUSES);

/** Narrow an untrusted string (cookie field, query param) to a known cause. */
export function parseCause(raw: string | null | undefined): AuthFailureCause | null {
  if (!raw) return null;
  return CAUSE_SET.has(raw) ? (raw as AuthFailureCause) : null;
}

/** The breaker's persisted state. Small enough that it can never itself be the
 *  oversized cookie that starts a loop. */
export interface AuthAttemptState {
  /** Consecutive completed round trips that left the browser unauthenticated. */
  n: number;
  /** Unix seconds the current window opened. */
  first: number;
  /** Outcome stamped by the callback, awaiting attribution at the next sign-in. */
  pending?: AuthFailureCause;
  /** Cause attributed to the most recent counted attempt. */
  cause?: AuthFailureCause;
  /** Byte length of the `Set-Cookie: loom_session=…` header last emitted. */
  cookieHeaderBytes?: number;
}

function clampCount(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), MAX_COUNT);
}

/**
 * Encode the state for the cookie value: base64url of JSON.
 *
 * Deliberately NOT encrypted. `loom_authflow` can be encrypted because it is
 * only ever read on a path that already requires SESSION_SECRET; this cookie
 * must survive `no_session_secret`, which is itself one of the loop causes it
 * has to count. It carries no secret and no identity — a counter, a timestamp,
 * an enum, and a byte length — and every field is re-validated on decode, so
 * forging it can only trip the forger's own breaker (clearable in one click
 * from the terminal page) or suppress it back to today's behaviour.
 */
export function encodeAttemptCookie(state: AuthAttemptState): string {
  const compact: AuthAttemptState = {
    n: clampCount(state.n),
    first: Math.floor(state.first),
    ...(state.pending ? { pending: state.pending } : {}),
    ...(state.cause ? { cause: state.cause } : {}),
    ...(typeof state.cookieHeaderBytes === 'number'
      ? { cookieHeaderBytes: Math.max(0, Math.floor(state.cookieHeaderBytes)) }
      : {}),
  };
  return Buffer.from(JSON.stringify(compact), 'utf-8').toString('base64url');
}

/** Decode + STRICTLY validate. Any malformed field yields null, never a throw. */
export function decodeAttemptCookie(value: string | undefined | null): AuthAttemptState | null {
  if (!value) return null;
  try {
    const json = Buffer.from(value, 'base64url').toString('utf-8');
    const o = JSON.parse(json) as Record<string, unknown>;
    if (typeof o.n !== 'number' || typeof o.first !== 'number') return null;
    if (!Number.isFinite(o.first) || o.first < 0) return null;
    const bytes = typeof o.cookieHeaderBytes === 'number' && Number.isFinite(o.cookieHeaderBytes)
      ? Math.max(0, Math.floor(o.cookieHeaderBytes))
      : undefined;
    return {
      n: clampCount(o.n),
      first: Math.floor(o.first),
      ...(parseCause(o.pending as string) ? { pending: parseCause(o.pending as string)! } : {}),
      ...(parseCause(o.cause as string) ? { cause: parseCause(o.cause as string)! } : {}),
      ...(bytes !== undefined ? { cookieHeaderBytes: bytes } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Whether this request reached us over HTTPS.
 *
 * The `Secure` attribute is set from this rather than hard-coded, and that is a
 * deliberate difference from `loom_authflow`. A deployment served over http —
 * the measured `frontDoorEnabled`-unset case that produced synthetic J3 — drops
 * every `Secure` cookie, which is one of the ways a sign-in loop STARTS. A
 * breaker cookie that is itself dropped in that state could never fire. It
 * carries no secret, so on http there is nothing for the flag to protect; on
 * https it is byte-identical to the sibling cookies.
 */
export function requestIsHttps(headers: Headers): boolean {
  const proto = headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim().toLowerCase() === 'https';
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  return !host.startsWith('localhost') && !host.startsWith('127.0.0.1');
}

function cookieFlags(secure: boolean): string {
  return `Path=${AUTH_BREAKER_PATH}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax`;
}

/** Set-Cookie that persists the counter. Max-Age matches the counting window. */
export function setAttemptCookieHeader(state: AuthAttemptState, secure: boolean): string {
  return `${AUTH_BREAKER_COOKIE}=${encodeAttemptCookie(state)}; ${cookieFlags(secure)}; Max-Age=${authBreakerWindowSecs()}`;
}

/** Set-Cookie that clears the counter (successful sign-in, sign-out, reset). */
export function clearAttemptCookieHeader(secure: boolean): string {
  return `${AUTH_BREAKER_COOKIE}=; ${cookieFlags(secure)}; Max-Age=0`;
}

/**
 * Record what a `/auth/callback` branch ESTABLISHED, without counting it. The
 * count happens at sign-in, because only sign-in can observe the second half of
 * the fact — that we are being asked to authenticate again.
 */
export function stampOutcome(
  prev: AuthAttemptState | null,
  cause: AuthFailureCause,
  nowSecs: number,
  cookieHeaderBytes?: number,
): AuthAttemptState {
  const base: AuthAttemptState = prev ?? { n: 0, first: nowSecs };
  return {
    ...base,
    pending: cause,
    ...(typeof cookieHeaderBytes === 'number' ? { cookieHeaderBytes } : {}),
  };
}

export interface AttemptDecision {
  /** State to persist on the response. */
  state: AuthAttemptState;
  /** Attempts attributed to this browser in the current window (both channels). */
  effective: number;
  /** True when `effective` has reached the configured maximum. */
  tripped: boolean;
  /** Cause to report if tripped. Always a value the code established. */
  cause: AuthFailureCause;
  /** Hop value to mint into the next OAuth `state` (stateless channel). */
  nextHop: number;
}

/**
 * The sign-in decision.
 *
 * `carriedHop` is the hop count parsed off the callback's redirect (null when
 * absent). `prev` is the decoded counter cookie (null when absent — including
 * the case where the browser is dropping it, which is why the hop channel
 * exists).
 *
 * Increments ONLY when a completed round trip is evidenced: a `pending` stamp
 * from the callback, or a carried hop. A bare initiation (user clicked Sign in,
 * abandoned Entra, clicked again) evidences neither and is not counted.
 */
export function recordAttempt(
  prev: AuthAttemptState | null,
  nowSecs: number,
  carriedHop: number | null,
): AttemptDecision {
  const windowSecs = authBreakerWindowSecs();
  const fresh = !prev || nowSecs - prev.first > windowSecs || nowSecs < prev.first;
  const base: AuthAttemptState = fresh ? { n: 0, first: nowSecs } : { ...prev! };

  const evidenced = !!base.pending || carriedHop !== null;
  if (!evidenced) {
    // No completed round trip since the last initiation — nothing new to count.
    //
    // But an ALREADY-EXHAUSTED counter still trips. Without this the breaker is
    // not terminal: after it fires, the very next /auth/sign-in carries no
    // pending stamp (the trip consumed it) and no hop, so it would hand the
    // browser straight back to Entra and the loop would resume at every other
    // hop. Measured — the loop-termination spec caught exactly that. The window
    // check above still expires the state on its own, and POST /auth/reset is
    // the deliberate way out; what is removed here is the ACCIDENTAL way back
    // in.
    const effective = base.n;
    const cause = base.cause ?? 'unknown';
    return {
      state: base,
      effective,
      tripped: effective >= authBreakerMaxAttempts(),
      cause,
      nextHop: Math.min(effective, MAX_COUNT),
    };
  }

  // `session_issued` is the callback's half of the fact; reaching sign-in
  // unauthenticated is the other half. Together they are `session_not_returned`.
  const attributed: AuthFailureCause =
    base.pending === 'session_issued' ? 'session_not_returned' : (base.pending ?? base.cause ?? 'unknown');

  const counted = clampCount(base.n + 1);
  // A carried hop of H means H+1 round trips have now completed and failed.
  const fromHop = carriedHop === null ? 0 : clampCount(carriedHop + 1);
  const effective = Math.max(counted, fromHop);

  const state: AuthAttemptState = {
    n: effective,
    first: base.first,
    cause: attributed,
    ...(typeof base.cookieHeaderBytes === 'number' ? { cookieHeaderBytes: base.cookieHeaderBytes } : {}),
  };

  return {
    state,
    effective,
    tripped: effective >= authBreakerMaxAttempts(),
    cause: attributed,
    nextHop: Math.min(effective, MAX_COUNT),
  };
}

/** Append the stateless hop counter to a freshly minted OAuth `state`. */
export function stateWithHop(state: string, hop: number): string {
  return `${state}${HOP_SEP}${clampCount(hop)}`;
}

/**
 * Read the hop counter off a RAW, untrusted `state` param. Strict: only a
 * 1–2 digit suffix immediately at the end. Null when absent or malformed —
 * never a throw, never an unbounded number.
 */
export function hopFromState(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /~h(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.min(n, MAX_COUNT) : null;
}

/** Parse the `?h=` hop the callback forwards to sign-in. Bounded; null if absent. */
export function hopFromParam(raw: string | null | undefined): number | null {
  if (!raw) return null;
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(n, MAX_COUNT) : null;
}

/**
 * The RFC 6265 §6.1 floor every user agent must support, per cookie, INCLUDING
 * the name and attributes. Front Door applies the same ceiling to the header.
 * Both discard an over-length `Set-Cookie` silently.
 */
export const BROWSER_COOKIE_LIMIT_BYTES = 4096;

/** Human-facing copy for one cause. Every string is a fact, or says it is not. */
export interface CauseNarrative {
  /** One-line summary of what failed. */
  headline: string;
  /** What the code OBSERVED. Never a guess. */
  established: string;
  /** Ordered, concrete things to try. May be empty. */
  whatToTry: string[];
  /** True when the remedy is an operator/deployment action, not a user one. */
  operatorAction: boolean;
}

/**
 * Turn an established cause into copy that asserts only what was established.
 *
 * `cookieHeaderBytes` is the MEASURED length of the `Set-Cookie: loom_session=…`
 * header the callback emitted. It is used to decide whether size is a supported
 * explanation or an excluded one — never to imply either without the number.
 */
export function describeCause(
  cause: AuthFailureCause,
  cookieHeaderBytes?: number,
): CauseNarrative {
  const cookieAdvice = [
    'Allow cookies for this site (including any "block third-party cookies" or tracking-protection setting that also blocks first-party cookies on redirects).',
    'Try a private/incognito window with extensions disabled — a cookie-blocking extension produces exactly this.',
    'Clear this site\'s cookies and use "Clear sign-in cookies and try again" below.',
  ];

  switch (cause) {
    case 'authflow_cookie_missing':
      return {
        headline: 'Your browser did not send back the sign-in cookie.',
        established:
          'Before redirecting you to Microsoft Entra ID, Loom set a short-lived cookie (loom_authflow) holding the login-CSRF state, the PKCE verifier and the OIDC nonce. Entra returned a state value, so the round trip itself completed — but the cookie did not come back with it, so Loom could not verify the response.',
        whatToTry: cookieAdvice,
        operatorAction: false,
      };
    case 'state_mismatch':
      return {
        headline: 'The state value returned by Entra did not match the one Loom sent.',
        established:
          'Your browser returned the loom_authflow cookie and Entra returned a state value, and the two did not match. That is what Loom checked and what failed — it is also what the check is for: it rejects an authorization response that was not started by this browser.',
        whatToTry: [
          'Use "Clear sign-in cookies and try again" below to start one clean flow.',
          'If you have more than one Loom tab mid-sign-in, close all but one — a second sign-in overwrites the first tab\'s state.',
          'If you followed a sign-in link from an email or another site, start from the Loom URL directly instead.',
        ],
        operatorAction: false,
      };
    case 'state_param_missing':
      return {
        headline: 'Entra\'s response carried no state value.',
        established:
          'Your browser returned the loom_authflow cookie, so the cookie round-trip is working. The response from Microsoft Entra ID carried no state parameter, so there was nothing to match it against.',
        whatToTry: [
          'Use "Clear sign-in cookies and try again" below.',
          'If this persists, the app registration\'s reply URL may be reached through a redirect that strips the query string — an operator should confirm the redirect URI Loom sends is registered exactly.',
        ],
        operatorAction: false,
      };
    case 'no_state_returned':
      return {
        headline: 'Loom cannot tell which half of the sign-in handshake failed.',
        established:
          'Neither the loom_authflow cookie nor a state parameter came back from the sign-in round trip. Either could explain the other\'s absence, and Loom did not establish which one failed first. It is not reporting a cause it did not measure.',
        whatToTry: [
          ...cookieAdvice,
          'If cookies are definitely allowed, an operator should check the Console log for the [auth/callback] state validation line, which records which of the two was present.',
        ],
        operatorAction: false,
      };
    case 'nonce_mismatch':
      return {
        headline: 'The ID token did not carry the nonce Loom sent.',
        established:
          'The code exchange with Microsoft Entra ID succeeded and returned an ID token, and that token\'s nonce claim did not match the nonce Loom put in the authorization request. Loom rejected the token rather than trusting it.',
        whatToTry: [
          'Use "Clear sign-in cookies and try again" below.',
          'If it repeats, an operator should check for a stale or replayed authorization response — the Console log records the mismatch at [auth/callback].',
        ],
        operatorAction: false,
      };
    case 'session_not_returned': {
      const known = typeof cookieHeaderBytes === 'number' && cookieHeaderBytes > 0;
      const oversize = known && cookieHeaderBytes! > BROWSER_COOKIE_LIMIT_BYTES;
      const measured = known
        ? ` The Set-Cookie header Loom emitted measured ${cookieHeaderBytes} bytes.`
        : ' Loom did not record the size of that header for this attempt.';
      const verdict = !known
        ? ''
        : oversize
          ? ` That is over the ${BROWSER_COOKIE_LIMIT_BYTES}-byte per-cookie limit RFC 6265 obliges every browser to enforce, and which Azure Front Door applies to the header as well. Both discard an over-length Set-Cookie silently, which explains why nothing errored.`
          : ` That is within the ${BROWSER_COOKIE_LIMIT_BYTES}-byte per-cookie limit, so the size of the cookie does NOT explain this. A browser cookie policy, an extension, or something between Loom and your browser stripping the header remain possible — Loom has not established which.`;
      return {
        headline: 'Sign-in succeeded, but your browser kept no session.',
        established:
          'Microsoft Entra ID authenticated you and Loom completed the code exchange and emitted a session cookie — every time.' +
          measured +
          verdict +
          ' The next request arrived with no session cookie, which is why you were sent back to sign in.',
        whatToTry: oversize
          ? [
              'This is a deployment-side defect, not something you can fix in the browser. Give an operator this page.',
              'Operator: the session payload exceeds the browser cookie limit. lib/auth/session.ts bounds it (MAX_COOKIE_VALUE_BYTES) and drops the groups claim to the Graph fallback — a value over the limit means a NEW unbounded field was added to UserClaims. See #3331.',
            ]
          : cookieAdvice,
        operatorAction: oversize,
      };
    }
    case 'exchange_failed':
      return {
        headline: 'The authorization code exchange with Entra failed.',
        established:
          'Loom sent the authorization code to Microsoft Entra ID and the exchange threw. The reason is recorded in the Console server log at [auth/callback] and is deliberately not shown here, because the raw error can contain values that should not be reflected into a browser URL.',
        whatToTry: [
          'Use "Clear sign-in cookies and try again" below — an expired or already-redeemed code fails this way and a clean flow fixes it.',
          'Operator: read the [auth/callback] exception line in the Console logs. AADSTS7000215 means the client secret on the Console does not match the app registration; AADSTS9002313 means the code itself was rejected.',
        ],
        operatorAction: false,
      };
    case 'aad_error':
      return {
        headline: 'Microsoft Entra ID returned an error instead of signing you in.',
        established:
          'Entra answered the authorization request with an error rather than an authorization code. Loom recorded the error code and description in the Console server log at [auth/callback]; it does not reflect the raw values here.',
        whatToTry: [
          'If you cancelled or declined a consent prompt, use "Clear sign-in cookies and try again" below and complete it.',
          'Operator: the [auth/callback] AAD error line names the exact AADSTS code — consent, assignment, or conditional-access policy are the common ones.',
        ],
        operatorAction: false,
      };
    case 'missing_code':
      return {
        headline: 'Entra\'s response carried no authorization code.',
        established:
          'The browser returned to /auth/callback with neither an authorization code nor an error parameter. There was nothing to exchange.',
        whatToTry: ['Use "Clear sign-in cookies and try again" below to start a fresh flow.'],
        operatorAction: false,
      };
    case 'no_token':
      return {
        headline: 'The code exchange returned no account or access token.',
        established:
          'Microsoft Entra ID accepted the authorization code and the exchange completed without throwing, but the result carried no account or no access token, so Loom had no identity to build a session from.',
        whatToTry: [
          'Use "Clear sign-in cookies and try again" below.',
          'Operator: check the Console log at [auth/callback] and confirm the app registration grants the requested scopes.',
        ],
        operatorAction: false,
      };
    case 'not_configured':
      return {
        headline: 'This Console has no Entra app registration configured.',
        established:
          'The callback found LOOM_MSAL_CLIENT_ID or AZURE_TENANT_ID unset on the Console. No sign-in can complete until they are set — this is a deployment state, not anything you did.',
        whatToTry: [
          'Operator: re-run csa-loom-post-deploy-bootstrap.yml → "Provision MSAL app registration", which sets LOOM_MSAL_CLIENT_ID, LOOM_MSAL_CLIENT_SECRET and AZURE_TENANT_ID on the Console app.',
        ],
        operatorAction: true,
      };
    case 'no_client_secret':
      return {
        headline: 'This Console has no Entra client secret configured.',
        established:
          'The callback found LOOM_MSAL_CLIENT_SECRET unset (or empty) on the Console. The confidential client cannot redeem an authorization code without it.',
        whatToTry: [
          'Operator: re-run csa-loom-post-deploy-bootstrap.yml → "Provision MSAL app registration" to mint and wire the secret, then roll the Console.',
        ],
        operatorAction: true,
      };
    case 'no_session_secret':
      return {
        headline: 'This Console has no SESSION_SECRET configured.',
        established:
          'The callback found SESSION_SECRET unset on the Console. Loom encrypts the session cookie with a key derived from it, so no session can be issued and every sign-in returns here.',
        whatToTry: [
          'Operator: SESSION_SECRET is set by the platform deploy. An unset value means the Console app was rolled without it — re-run the deploy rather than patching the container app, because a bicep re-render drops an out-of-band value.',
        ],
        operatorAction: true,
      };
    case 'rate_limited':
      return {
        headline: 'Too many sign-in attempts from this network.',
        established:
          'The anonymous per-IP rate limit on the sign-in endpoints rejected the request before any exchange was attempted.',
        whatToTry: ['Wait a minute, then use "Clear sign-in cookies and try again" below.'],
        operatorAction: false,
      };
    case 'session_issued':
      // Only ever a PENDING value; sign-in converts it to session_not_returned
      // before anything renders. Handled so the union stays exhaustive.
      return {
        headline: 'Sign-in completed but the outcome was not attributed.',
        established:
          'Loom issued a session cookie and did not observe whether the browser kept it. It is not claiming that it did or did not.',
        whatToTry: ['Use "Clear sign-in cookies and try again" below.'],
        operatorAction: false,
      };
    case 'unknown':
    default:
      return {
        headline: 'Sign-in kept restarting, and Loom did not establish why.',
        established:
          'Loom counted repeated completed sign-in round trips that each left this browser unauthenticated. No branch of the callback recorded a specific cause for them, so Loom is not naming one.',
        whatToTry: [
          ...cookieAdvice,
          'Operator: the Console log lines beginning [auth/callback] cover every terminal branch of the sign-in callback and will name the step that failed.',
        ],
        operatorAction: false,
      };
  }
}
