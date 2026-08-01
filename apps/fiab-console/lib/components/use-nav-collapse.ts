'use client';

/**
 * Nav-rail collapse state (#2673).
 *
 * THE BUG: `AppShell` drove the rail from a manual toggle + localStorage and
 * NOTHING else — there was no viewport logic anywhere in the shell. At 900px the
 * rail stayed expanded, its labels wrapped mid-word ("Lakehouse catalog" →
 * "Lak / cat"), and the content pane overlapped it. The rail *could* collapse;
 * it just never did so on its own.
 *
 * THE MODEL, and why it is three states rather than a boolean:
 *
 *   pref = null   → follow the viewport (the default, and what a fresh session
 *                   gets). This is the state a plain `useState(false)` cannot
 *                   express, which is exactly why the bug existed.
 *   pref = true   → operator pinned it collapsed.
 *   pref = false  → operator pinned it expanded.
 *
 * The pin is deliberately CLEARED when the viewport crosses the breakpoint.
 * Without that, one click at any width would pin the rail forever and the
 * responsive behaviour would silently stop applying — the same "control exists,
 * reads fine, never executes" shape as the original bug. Crossing the boundary
 * is a new layout situation, so the viewport gets the say again.
 *
 * Toggling is computed against what the operator currently SEES (`collapsed`),
 * not against `pref`. If the viewport forced a collapse and the button were
 * wired to `!pref`, the first click would set pref=true — collapse a rail that
 * was already collapsed — and appear to do nothing.
 */
import { useEffect, useState } from 'react';

export const NAV_COLLAPSE_KEY = 'loom.navCollapsed';

/**
 * Below this width the expanded rail cannot fit its labels beside the content.
 * 1024px is the standard tablet-landscape boundary and sits above the repo's own
 * `visual-narrow` Playwright viewport (900px), so that project now exercises the
 * collapsed rail it was always meant to.
 */
export const NAV_AUTO_COLLAPSE_PX = 1024;

export interface NavCollapseState {
  /** What the rail should render as right now. */
  collapsed: boolean;
  /** Flip relative to what is on screen, and pin that choice. */
  toggle: () => void;
}

export function useNavCollapse(): NavCollapseState {
  /** null = follow the viewport; true/false = an explicit operator choice. */
  const [pref, setPref] = useState<boolean | null>(null);
  const [narrow, setNarrow] = useState(false);

  // Restore a previously pinned choice. Absent = follow the viewport.
  useEffect(() => {
    try {
      const v = localStorage.getItem(NAV_COLLAPSE_KEY);
      if (v === '1' || v === '0') setPref(v === '1');
    } catch { /* SSR / storage disabled */ }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(`(max-width: ${NAV_AUTO_COLLAPSE_PX - 1}px)`);

    // Initial read only — mount must NOT clear a restored preference.
    setNarrow(mq.matches);

    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setNarrow(e.matches);
      setPref(null);
      try { localStorage.removeItem(NAV_COLLAPSE_KEY); } catch { /* ignore */ }
    };

    if (mq.addEventListener) {
      mq.addEventListener('change', onChange as (e: MediaQueryListEvent) => void);
      return () => mq.removeEventListener('change', onChange as (e: MediaQueryListEvent) => void);
    }
    // Safari < 14 / older jsdom.
    mq.addListener(onChange as (e: MediaQueryListEvent) => void);
    return () => mq.removeListener(onChange as (e: MediaQueryListEvent) => void);
  }, []);

  const collapsed = pref ?? narrow;

  const toggle = () => {
    const next = !collapsed;
    setPref(next);
    try { localStorage.setItem(NAV_COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };

  return { collapsed, toggle };
}
