'use client';

/**
 * pin-store — the SINGLE, shared source of truth for the user's pinned items.
 *
 * Before this store, pinning was dead: `PinnedSection` listened for a
 * `loom:pin-toggle` window event and persisted to Cosmos, but NOTHING in the
 * product ever dispatched it (no pin affordance rendered anywhere), so the
 * Pinned section could only ever be empty. This module centralises pin state
 * so ANY surface (item tiles, the all-items table, the left-nav Pinned section)
 * can read "is this pinned?" and toggle it, and every subscriber stays in sync.
 *
 * Backend is REAL (per no-vaporware.md): GET/POST `/api/user-prefs?key=pinnedItems`
 * upserts the array into the Cosmos `user-prefs` container (PK /userId). There is
 * no mock data — an unauthenticated / empty response yields an empty list.
 *
 * Cloud-invariant: pins are a Loom-native preference, no Fabric dependency
 * (no-fabric-dependency.md).
 */

import { useCallback, useSyncExternalStore } from 'react';
import { clientFetch } from '@/lib/client-fetch';

export interface PinnedItem {
  /** Stable unique key (workspace id, item id, or route path). */
  id: string;
  label: string;
  href: string;
  /** Optional item-type slug ('workspace' | 'lakehouse' | 'page' | …). */
  type?: string;
}

const PREF_KEY = 'pinnedItems';

// Module-level state (client singleton). `null` = not yet loaded (no flash).
let pins: PinnedItem[] | null = null;
let loadStarted = false;
let legacyBound = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(next: PinnedItem[]): void {
  clientFetch('/api/user-prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: PREF_KEY, value: next }),
  }).catch(() => {
    /* best-effort; optimistic UI already reflects the change */
  });
}

/**
 * Pure reducer: toggle `item` in `cur`. Removes it when an entry with the same
 * id already exists, otherwise appends a normalised copy. Exported for unit
 * tests (the load-bearing logic that decides pin membership).
 */
export function nextPins(cur: PinnedItem[], item: PinnedItem): PinnedItem[] {
  const exists = cur.some((p) => p.id === item.id);
  return exists
    ? cur.filter((p) => p.id !== item.id)
    : [...cur, { id: item.id, label: item.label, href: item.href, type: item.type }];
}

export function getPins(): PinnedItem[] | null {
  return pins;
}

export function isPinnedId(id: string): boolean {
  return !!pins?.some((p) => p.id === id);
}

/** Replace the pin list, notify subscribers, and (by default) persist. */
export function setPins(next: PinnedItem[], opts: { persist?: boolean } = {}): void {
  pins = next;
  emit();
  if (opts.persist !== false) persist(next);
}

/** Toggle one item's pinned state (optimistic + persisted). */
export function togglePin(item: PinnedItem): void {
  if (!item?.id || !item?.href || !item?.label) return;
  setPins(nextPins(pins ?? [], item));
  if (typeof window !== 'undefined') {
    // Legacy fan-out for any window-event listeners still in the tree.
    window.dispatchEvent(new CustomEvent('loom:pin-changed'));
  }
}

/** Remove one pin by id. */
export function unpinId(id: string): void {
  setPins((pins ?? []).filter((p) => p.id !== id));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('loom:pin-changed'));
  }
}

function loadPins(force = false): void {
  if (loadStarted && !force) return;
  loadStarted = true;
  clientFetch(`/api/user-prefs?key=${PREF_KEY}`)
    .then((r) => r.json())
    .then((d) => {
      pins = Array.isArray(d?.value) ? d.value : [];
      emit();
    })
    .catch(() => {
      pins = pins ?? [];
      emit();
    });
}

/** Bind legacy `loom:pin-toggle` callers (the exported `pinItem` helper) once. */
function bindLegacy(): void {
  if (legacyBound || typeof window === 'undefined') return;
  legacyBound = true;
  window.addEventListener('loom:pin-toggle', (e: Event) => {
    const d = (e as CustomEvent).detail as PinnedItem | undefined;
    if (d?.id && d?.href && d?.label) togglePin(d);
  });
}

function subscribe(cb: () => void): () => void {
  bindLegacy();
  listeners.add(cb);
  loadPins();
  return () => {
    listeners.delete(cb);
  };
}

/**
 * usePins — subscribe a component to the shared pin list. Returns the current
 * pins (`null` while the first load is in flight), a membership check, and the
 * toggle/unpin actions.
 */
export function usePins() {
  const snapshot = useSyncExternalStore(
    subscribe,
    getPins,
    () => null, // server snapshot: no pins during SSR
  );
  const isPinned = useCallback(
    (id: string) => !!snapshot?.some((p) => p.id === id),
    [snapshot],
  );
  return {
    pins: snapshot,
    loading: snapshot === null,
    isPinned,
    togglePin,
    unpin: unpinId,
  };
}

/**
 * Fire-and-forget pin toggle for callers that don't render UI state. Kept as a
 * window event so any legacy listener still works; the store binds it above.
 */
export function pinItem(item: PinnedItem): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('loom:pin-toggle', { detail: item }));
  }
}
