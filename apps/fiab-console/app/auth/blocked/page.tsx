/**
 * /auth/blocked — the terminal page of the sign-in circuit breaker (#3334).
 *
 * A SERVER component on purpose. Every value it shows is resolved here, from
 * the request itself:
 *
 *   - the `loom_authtry` cookie (authoritative: written by /auth/sign-in at the
 *     moment it tripped), and
 *   - the `?cause=` / `?n=` query fallback, which is what makes this page still
 *     diagnose correctly when the browser is returning NO cookies — one of the
 *     very loop causes it exists to explain.
 *
 * It fires no fetch. It cannot 401, so it cannot bounce back into the loop it
 * just terminated. (`triggerTopLevelReauth` in lib/client-fetch also treats
 * this path as a pre-auth surface, so nothing the app shell mounts around it
 * can navigate away either.)
 *
 * Both untrusted inputs are narrowed before use: `cause` through parseCause()
 * against the closed AUTH_CAUSES union, `n` through a digits-only bound. Neither
 * raw value is ever rendered, so there is nothing to reflect.
 */

import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import {
  AUTH_BREAKER_COOKIE,
  authBreakerMaxAttempts,
  authBreakerWindowSecs,
  decodeAttemptCookie,
  describeCause,
  parseCause,
  type AuthFailureCause,
} from '@/lib/auth/auth-breaker';
import { SignInBlocked } from '@/lib/components/auth/sign-in-blocked';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign-in stopped · CSA Loom',
  robots: { index: false, follow: false },
};

/** Digits-only, bounded. Anything else is "not supplied". */
function parseCount(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export default async function AuthBlockedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const jar = await cookies();
  const state = decodeAttemptCookie(jar.get(AUTH_BREAKER_COOKIE)?.value);

  const queryCause = parseCause(typeof sp.cause === 'string' ? sp.cause : null);
  // Cookie first — it is what /auth/sign-in wrote when it tripped. The query is
  // the cookie-less fallback, not a competing source of truth.
  const cause: AuthFailureCause = state?.cause ?? queryCause ?? 'unknown';
  const max = authBreakerMaxAttempts();
  const attempts = state?.n ?? parseCount(sp.n) ?? max;

  return (
    <SignInBlocked
      cause={cause}
      narrative={describeCause(cause, state?.cookieHeaderBytes)}
      attempts={attempts}
      maxAttempts={max}
      windowSecs={authBreakerWindowSecs()}
      cookieHeaderBytes={state?.cookieHeaderBytes}
    />
  );
}
