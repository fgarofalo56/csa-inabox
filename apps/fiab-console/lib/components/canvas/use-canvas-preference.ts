'use client';

/**
 * useCanvasBooleanPreference — a generic, per-surface, localStorage-backed
 * boolean preference. First use: the minimap show/hide toggle (#3699 Scope B).
 *
 * Every existing boolean-toggle hook in this codebase (`use-inline-complete-
 * toggle.ts`, `use-nav-collapse.ts`) is a single FIXED global key — one value
 * for the whole app. `SplitPane`'s `storageKey` and `useCollapsibleState`'s
 * `storageKey` (collapsible-side-panel.tsx) are per-surface, but neither is a
 * general boolean preference: one persists a pane size, the other is
 * collapse-specific chrome. This hook is the per-surface-keyed boolean
 * equivalent, modeled directly on `useCollapsibleState`'s SSR-safe
 * read-after-mount + updater-form setter shape.
 *
 * Key shape: `loom.canvas.<surfaceKey>.<prefKey>` — namespaced by BOTH the
 * surface (so two different canvases never share a toggle) and the
 * preference name (so one surface can hold more than one boolean preference
 * without key collisions).
 */

import { useCallback, useEffect, useState } from 'react';

const STORE_PREFIX = 'loom.canvas.';

export function useCanvasBooleanPreference(
  surfaceKey: string,
  prefKey: string,
  defaultValue = true,
): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const storageKey = `${STORE_PREFIX}${surfaceKey}.${prefKey}`;
  const [value, setValueState] = useState(defaultValue);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem(storageKey);
      if (v === '1') setValueState(true);
      else if (v === '0') setValueState(false);
    } catch { /* private mode / disabled storage — fall back to in-session state */ }
    // Re-read if the caller changes which surface/preference this hook targets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const setValue = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setValueState((prev) => {
      const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(prev) : v;
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(storageKey, next ? '1' : '0'); } catch { /* ignore */ }
      }
      return next;
    });
  }, [storageKey]);

  return [value, setValue];
}
