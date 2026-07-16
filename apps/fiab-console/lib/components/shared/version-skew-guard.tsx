'use client';

/**
 * VersionSkewGuard — detects that the SERVER has rolled to a new build while
 * this tab's CLIENT bundle is still the old one, and recovers gracefully.
 *
 * WHY (diagnosed live 2026-07-16): Loom self-updates in place (Admin →
 * Updates rolls every Container App). A tab left open across a roll keeps its
 * old chunk graph; the next soft navigation fetches RSC payloads/chunks that
 * no longer exist and the router's retry path can hard-freeze the renderer for
 * 30s+ (reproduced on /monitor, /admin/gates, /deployment-pipelines — a fresh
 * tab loads the same pages instantly). At VA scale every update would wedge
 * every open tab.
 *
 * Mechanism: remember the FIRST build sha this tab observes from
 * /api/version; re-check every 5 minutes and on tab re-focus (the moment a
 * stale tab typically comes back). On skew: toast "Loom was updated", then
 * HARD-reload on the next route change (preferred — never interrupts typing)
 * or after a 60s grace if no navigation happens. A hard reload replaces the
 * whole chunk graph, which is the documented recovery for chunk-load skew.
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

const CHECK_INTERVAL_MS = 5 * 60_000;
const IDLE_RELOAD_GRACE_MS = 60_000;

export function VersionSkewGuard() {
  const pathname = usePathname();
  const bootSha = useRef<string | null>(null);
  const skewed = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hard reload on the next route change once skew is known.
  useEffect(() => {
    if (skewed.current) window.location.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    let disposed = false;

    async function check() {
      try {
        const r = await fetch('/api/version', { cache: 'no-store', credentials: 'include' });
        if (!r.ok) return;
        const j = await r.json();
        const sha: string | undefined = j?.build?.sha;
        if (!sha || disposed) return;
        if (bootSha.current === null) { bootSha.current = sha; return; }
        if (sha !== bootSha.current && !skewed.current) {
          skewed.current = true;
          // Reload on next navigation; failing that, after a quiet grace so a
          // dashboard left on screen also recovers. Never mid-keystroke: the
          // grace timer restarts whenever the operator is actively typing.
          const arm = () => {
            if (idleTimer.current) clearTimeout(idleTimer.current);
            idleTimer.current = setTimeout(() => {
              const el = document.activeElement;
              const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
              if (typing) arm(); else window.location.reload();
            }, IDLE_RELOAD_GRACE_MS);
          };
          arm();
        }
      } catch { /* transient network — try again next cycle */ }
    }

    void check();
    const t = setInterval(() => { void check(); }, CHECK_INTERVAL_MS);
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      disposed = true;
      clearInterval(t);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  return null;
}
