'use client';

/**
 * use-session-keepalive — keeps a long-lived, idle tab from bouncing to the
 * login screen on the hour.
 *
 * It pings POST /api/auth/refresh on a sliding interval (default 30m) and on
 * window focus. While the user's MSAL refresh token is alive (≈24h), each ping
 * re-slides the encrypted loom_session cookie's `exp` to now + MAX_AGE_SECS, so
 * an open dashboard left untouched all afternoon stays signed in.
 *
 * Deliberately FIRE-AND-FORGET: on a {reauth:true} (refresh token expired) the
 * hook does NOTHING — an idle background tab must NOT be yanked into a redirect.
 * The next real /api call (via lib/client-fetch) drives the interactive
 * TOP-LEVEL reauth when the user actually acts. This hook never imports MSAL,
 * never touches a token, and never redirects on its own.
 *
 * KILL SWITCH: when sliding sessions are disabled server-side
 * (LOOM_SESSION_SLIDING_ENABLED=false) the /api/auth/refresh route answers with
 * `{ sliding:false }`. On seeing that, this hook STOPS its proactive timer so an
 * idle tab is NOT continuously re-slid every 30m — the session then expires on
 * its fixed cookie window exactly as it did before the sliding-session fix. The
 * flag is the env-level revert of the proactive sliding (the one-shot clientFetch
 * 401 recovery is separate and intentionally left intact).
 *
 * Mounted once by the app shell (app/providers.tsx). Self-contained: takes no
 * props and renders nothing.
 */

import { useEffect } from 'react';

/** Default keepalive interval — well under the 8h cookie Max-Age. */
export const KEEPALIVE_INTERVAL_MS = 30 * 60 * 1000; // 30 min

export function useSessionKeepalive(intervalMs: number = KEEPALIVE_INTERVAL_MS): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      cancelled = true;
      if (id !== undefined) clearInterval(id);
    };

    const ping = () => {
      if (cancelled) return;
      // credentials:'include' so the loom_session cookie reaches the BFF behind
      // the deployment edge (Front Door). A failed ping is a no-op; recovery is
      // the next user action's clientFetch 401 handler.
      fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then(async (res) => {
          if (!res.ok) return; // 401 {reauth:true} ignored — idle tab not yanked.
          // Honor the server kill switch: with sliding DISABLED the route returns
          // { sliding:false } — stop pinging so we stop re-sliding an idle tab.
          const body = (await res.json().catch(() => null)) as { sliding?: unknown } | null;
          if (body && body.sliding === false) stop();
        })
        .catch(() => {});
    };

    id = setInterval(ping, Math.max(60_000, intervalMs));
    const onFocus = () => ping();
    window.addEventListener('focus', onFocus);
    // A short post-mount ping re-slides a tab restored from bfcache / a fresh
    // load near the end of its window.
    const t = setTimeout(ping, 1000);

    return () => {
      stop();
      clearTimeout(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [intervalMs]);
}
