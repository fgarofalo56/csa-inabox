/**
 * /auth/reset — the ONE escape hatch out of the tripped sign-in circuit breaker
 * (#3334).
 *
 * Clears every cookie the sign-in flow owns and hands the browser back to
 * /auth/sign-in for exactly one clean attempt:
 *
 *   - `loom_authtry`  — the breaker's attempt counter. Cleared, so the next
 *                       sign-in starts a fresh window rather than tripping
 *                       instantly. This is what makes the terminal page's
 *                       "try again" button mean something.
 *   - `loom_authflow` — a consumed / stale login-CSRF cookie is itself a cause
 *                       of the state failures the breaker counts.
 *   - `loom_session`  — a session cookie that DECODES to nothing (a rotated
 *                       SESSION_SECRET, a truncated value) reads as "no
 *                       session" on every request and is a genuine loop cause,
 *                       so clearing it is part of the remedy rather than
 *                       collateral. Anyone reaching this route is by definition
 *                       on a page telling them sign-in is not working.
 *
 * POST-only, driven by a plain <form> on /auth/blocked. A GET would make this a
 * one-click logout-CSRF (any site could force a visitor to drop their Loom
 * session by embedding an image). The form needs no JavaScript, which matters:
 * the terminal page has to work when the rest of the app might not.
 *
 * 303 (not the default 307) so the browser follows with GET rather than
 * re-POSTing to /auth/sign-in.
 *
 * The breaker does NOT re-trip on the first attempt after a reset: with the
 * counter cookie gone and no `?h=` hop carried, /auth/sign-in sees no evidence
 * of a completed round trip and does not count. If the underlying cause is
 * still there the loop restarts — and terminates again after the same bounded
 * number of hops. Bounded, not cured; that is the correct contract.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookieHeader } from '@/lib/auth/session';
import { clearAuthFlowCookieHeader } from '@/lib/auth/authflow';
import { clearAttemptCookieHeader, externalOrigin, requestIsHttps } from '@/lib/auth/auth-breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // The origin comes from the forwarded headers, NOT from `req.url`. Under
  // `output: 'standalone'` with HOSTNAME/PORT set, `req.url` carries this
  // container's own listen address, so `new URL('/auth/sign-in', req.url)`
  // emitted `Location: https://0.0.0.0:3000/auth/sign-in` — i.e. the ONE escape
  // hatch out of a tripped breaker led somewhere the browser cannot reach. See
  // the evidence chain on externalOrigin() in lib/auth/auth-breaker.
  const res = NextResponse.redirect(new URL('/auth/sign-in', externalOrigin(req.headers)), 303);
  res.headers.set('cache-control', 'no-store');
  // Three distinct Set-Cookie headers — append, never set.
  res.headers.append('set-cookie', clearAttemptCookieHeader(requestIsHttps(req.headers)));
  res.headers.append('set-cookie', clearAuthFlowCookieHeader());
  res.headers.append('set-cookie', clearSessionCookieHeader());
  return res;
}
