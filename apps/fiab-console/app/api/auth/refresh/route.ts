/**
 * POST /api/auth/refresh — silent SLIDING-session refresh.
 *
 * The fix for the hourly-logout bug has two halves: the auth-callback now sets a
 * sliding cookie `exp` (= now + MAX_AGE_SECS), and THIS route lets a long-lived
 * tab re-slide that window WITHOUT an interactive redirect — as long as the
 * user's refresh token (held server-side in the MSAL confidential-client cache,
 * keyed by oid/homeAccountId, ≈24h) is still alive.
 *
 * Contract:
 *   - No valid session cookie                         → 401 { ok:false, reauth:true }
 *   - Session present, but the MSAL cache lost the     → 401 { ok:false, reauth:true }
 *     account (cold replica / evicted) OR the refresh
 *     token is expired (silent acquire throws)
 *   - Session present + refresh token still valid      → 200 { ok:true } + a fresh
 *                                                        Set-Cookie (re-minted via
 *                                                        encodeSessionCookie with a
 *                                                        new sliding exp)
 *
 * On 401 the CLIENT (lib/client-fetch + use-session-keepalive) triggers an
 * interactive TOP-LEVEL redirect to /auth/sign-in — never an iframe (SPA silent
 * iframe refresh is blocked by 3rd-party-cookie / refresh-token-in-the-browser
 * limits per MSAL guidance).
 *
 * AUTH SAFETY: re-uses the EXISTING confidential client (authority already
 * cloud-switched in lib/auth/msal — Commercial vs Gov, no endpoint change here)
 * and the EXISTING encodeSessionCookie/setSessionCookieHeader — no new crypto.
 * The re-mint is a REAL cache-backed silent acquire (no-vaporware); tokens are
 * never logged nor returned.
 *
 * KILL SWITCH (LOOM_SESSION_SLIDING_ENABLED=false): the 200 response carries
 * `{ ok:true, sliding:false }` and the client keepalive stops its proactive
 * 30-min timer, so an idle tab is no longer continuously re-slid and the session
 * expires on its fixed ~access-token window — reverting the EXP semantics of the
 * fix. A single user-action-driven clientFetch 401 can still re-mint once (the
 * OFF-path exp tracks the ~1h access-token expiry, not MAX_AGE_SECS), so the flag
 * is a faithful revert of the *proactive* sliding, not of the one-shot 401
 * recovery. The ON response body is unchanged: exactly `{ ok:true }`.
 */

import { NextResponse } from 'next/server';
import { getMsalClient } from '@/lib/auth/msal';
import {
  getSession,
  encodeSessionCookie,
  setSessionCookieHeader,
  sessionSlidingEnabled,
  MAX_AGE_SECS,
} from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REAUTH = { ok: false as const, reauth: true as const };

export async function POST() {
  const session = getSession();
  if (!session) {
    // No (or expired) session cookie — the client must reauthenticate.
    return NextResponse.json(REAUTH, { status: 401 });
  }
  const oid = session.claims.oid;
  try {
    const client = getMsalClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    // Match the cached account by the same oid the callback derived
    // (homeAccountId.split('.')[0]) OR localAccountId — robust across MSAL
    // account shapes.
    const account = accounts.find(
      (a) => a.homeAccountId.split('.')[0] === oid || a.localAccountId === oid,
    );
    if (!account) {
      // MSAL cache no longer holds this account (cold replica / evicted) →
      // interactive reauth is required to repopulate the refresh token.
      return NextResponse.json(REAUTH, { status: 401 });
    }
    // Prove the refresh token is STILL ALIVE with a cache-backed silent acquire
    // (MSAL transparently exchanges the ~24h refresh token). A throw here means
    // interaction_required / RT expired → reauth. We don't use the token; we
    // only need the proof (and, when sliding is OFF, its expiry).
    let silentExpiresOn: Date | null = null;
    try {
      const res = await client.acquireTokenSilent({ account, scopes: ['User.Read'] });
      if (!res?.accessToken) return NextResponse.json(REAUTH, { status: 401 });
      silentExpiresOn = res.expiresOn ?? null;
    } catch {
      return NextResponse.json(REAUTH, { status: 401 });
    }
    // Sliding ON (default): new exp = now + MAX_AGE_SECS. OFF: mirror the
    // pre-sliding callback behavior (exp from the access-token expiry).
    const sliding = sessionSlidingEnabled();
    const exp = sliding
      ? Math.floor(Date.now() / 1000) + MAX_AGE_SECS
      : Math.floor((silentExpiresOn?.getTime() ?? Date.now() + 3600_000) / 1000);
    const cookieValue = encodeSessionCookie({ claims: session.claims, exp });
    // KILL-SWITCH SIGNAL (LOOM_SESSION_SLIDING_ENABLED=false): we still re-mint
    // ONCE here (so an in-flight clientFetch 401 can recover, and so the existing
    // OFF-path contract — 200 + Set-Cookie with the ~1h access-token exp — is
    // preserved), but we flag `sliding:false` so the client KEEPALIVE stops its
    // 30-minute timer. That removes the *continuous* idle-tab re-slide: with the
    // flag OFF an untouched tab is no longer pinged every 30m and so expires on
    // its fixed ~access-token window, reverting the proactive sliding behavior.
    // The ON body stays EXACTLY `{ok:true}` (unchanged contract).
    const body = sliding ? { ok: true } : { ok: true, sliding: false };
    return new NextResponse(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': setSessionCookieHeader(cookieValue),
      },
    });
  } catch {
    // Any unexpected server error → deterministic reauth path (never a 500 that
    // pins the client, never a leaked detail/token).
    return NextResponse.json(REAUTH, { status: 401 });
  }
}
