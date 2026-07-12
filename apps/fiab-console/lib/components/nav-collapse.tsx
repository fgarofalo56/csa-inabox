'use client';

/**
 * nav-collapse — shared, persisted expand/collapse state for left-nav sections.
 *
 * The rail groups (Home / Data / Build / …) and the Pinned section are each
 * collapsible; their open/closed state persists per user in localStorage so the
 * rail reopens the way the user left it. Keyboard-accessible: the header is a
 * real <button aria-expanded> and the children live in an aria-controls region.
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown16Regular, ChevronRight16Regular } from '@fluentui/react-icons';

/** Where all section-collapse state lives (one JSON map, keyed by section id). */
export const NAV_COLLAPSE_LS_KEY = 'loom.nav.sections.collapsed.v1';

function readMap(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(NAV_COLLAPSE_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, boolean>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NAV_COLLAPSE_LS_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * useNavCollapse — collapse state for a set of section keys.
 *
 * SSR-safe: starts fully expanded (matching the server render) and hydrates the
 * persisted map after mount, so there's no hydration mismatch. `collapsed(key)`
 * reports whether a section is collapsed; `toggle(key)` flips + persists it.
 */
export function useNavCollapse() {
  const [map, setMap] = useState<Record<string, boolean>>({});

  // Hydrate persisted state after mount (avoids SSR/client divergence).
  useEffect(() => {
    setMap(readMap());
  }, []);

  const collapsed = useCallback((key: string) => map[key] === true, [map]);

  const toggle = useCallback((key: string) => {
    setMap((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeMap(next);
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

/** The rotating chevron shown at the head of a collapsible section header. */
export function CollapseChevron({ open }: { open: boolean }) {
  return open ? <ChevronDown16Regular /> : <ChevronRight16Regular />;
}
