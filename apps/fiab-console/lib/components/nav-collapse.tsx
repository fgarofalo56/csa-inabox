'use client';

/**
 * nav-collapse — shared, persisted expand/collapse state for grouped sidebars.
 *
 * The rail groups (Home / Data / Build / …) and the Pinned section are each
 * collapsible; their open/closed state persists per user in localStorage so the
 * rail reopens the way the user left it. Keyboard-accessible: the header is a
 * real <button aria-expanded> and the children live in an aria-controls region.
 *
 * The same hook backs the Admin portal and Governance sidebars (#5467). Each
 * surface passes its OWN storage key so collapsing a group in one sidebar can
 * never collapse a same-named group in another.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';

/** Where the main left-nav's section-collapse state lives (one JSON map, keyed by section id). */
export const NAV_COLLAPSE_LS_KEY = 'loom.nav.sections.collapsed.v1';

function readMap(storageKey: string): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeMap(storageKey: string, map: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * useNavCollapse — collapse state for a set of section keys.
 *
 * SSR-safe: starts fully expanded (matching the server render) and hydrates the
 * persisted map after mount, so there's no hydration mismatch. `collapsed(key)`
 * reports whether a section is collapsed; `toggle(key)` flips + persists it;
 * `setCollapsed(keys, value)` sets many at once (Expand all / Collapse all);
 * `expand(key)` opens one section (used to force the active route's group open).
 *
 * @param storageKey localStorage key for this surface's map. Defaults to the
 *   main left nav's key; every other sidebar must pass its own.
 */
export function useNavCollapse(storageKey: string = NAV_COLLAPSE_LS_KEY) {
  const [map, setMap] = useState<Record<string, boolean>>({});

  // Hydrate persisted state after mount (avoids SSR/client divergence).
  useEffect(() => {
    setMap(readMap(storageKey));
  }, [storageKey]);

  const collapsed = useCallback((key: string) => map[key] === true, [map]);

  const toggle = useCallback((key: string) => {
    setMap((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeMap(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const setCollapsed = useCallback((keys: readonly string[], value: boolean) => {
    setMap((prev) => {
      // No-op when nothing changes, so forcing an already-open group open on
      // every navigation neither re-renders nor rewrites storage.
      if (keys.every((k) => (prev[k] === true) === value)) return prev;
      const next = { ...prev };
      for (const k of keys) next[k] = value;
      writeMap(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const expand = useCallback((key: string) => setCollapsed([key], false), [setCollapsed]);

  return { collapsed, toggle, setCollapsed, expand };
}

/** The rotating chevron shown at the head of a collapsible section header. */
export function CollapseChevron({ open }: { open: boolean }) {
  return open ? <ChevronDown16Regular /> : <ChevronRight16Regular />;
}
