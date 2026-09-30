'use client';
/**
 * useLakehouseBinding — the container + root the lakehouse ACTUALLY lives in.
 *
 * Extracted from lakehouse-editor-shell.tsx with the #3904 fix (the shell is
 * frozen at 1,200 LOC by the monolith-creep ratchet, and this is a genuinely
 * separate bounded context: "which storage does this item own", answered once
 * per open and consumed by every pane).
 *
 * WHAT IT FIXES. The editor used to open on `containers[0]` — `bronze`, because
 * `listContainers()` walks KNOWN_CONTAINERS in order — and list the CONTAINER
 * root (`''`). The installer materialises a lakehouse at
 * `landing/lakehouses/<Name>/…`, so the very first request the Files browser
 * issued named the wrong container AND a directory the lakehouse has never
 * occupied. It 404'd on first open, live.
 *
 * ONE RESOLUTION AUTHORITY: `resolveLakehouseAbfss` (lib/azure/lakehouse-abfss).
 *   1. the record it prefers, read straight off the item the editor already has
 *      (lakehouse-binding.ts — no guessing, no env),
 *   2. else the BFF running that same resolver (its env-derived step 3
 *      included) via `/api/lakehouse/paths?lakehouseId=&workspaceId=`, which
 *      returns the binding AND its root listing in one round trip,
 *   3. else nothing — an unsaved or never-provisioned lakehouse opens on the
 *      first probed container, and its item-scoped listing answers with the
 *      route's storage gate rather than another item's files.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { parseJsonOrError } from '../shared';
import type { ContainerInfo, ListingError, PathEntry } from '../shared';
import type { WorkspaceItem } from '@/lib/api/workspaces';
import type { UseQueryResult } from '@tanstack/react-query';
import { bindingFromItemState, joinPrefix, type LakehouseBinding } from '../lakehouse-binding';

type PrefixCache = Record<string, PathEntry[] | 'loading' | ListingError>;

interface Params {
  id: string;
  isNewItem: boolean;
  itemQ: UseQueryResult<WorkspaceItem>;
  activeContainer: string | null;
  setActiveContainer: (c: string | null) => void;
  setOpenPrefixes: (fn: (p: PrefixCache) => PrefixCache) => void;
  cacheKey: (container: string, prefix: string) => string;
}

export interface LakehouseBindingState {
  containers: ContainerInfo[] | null;
  containerError: string | null;
  /** Container + root the provisioner actually wrote to; null when unbound. */
  binding: LakehouseBinding | null;
  /** "The top" of THIS lakehouse in the active container. `''` when unbound. */
  rootPrefix: string;
  /** `<rootPrefix>/Tables` — where this lakehouse's Delta tables live. */
  tablesPrefix: string;
  /** Where a given container's explorer tree starts. */
  treeRootFor: (container: string) => string;
  /** Containers to render: only the bound one when bound; the probed list otherwise. */
  displayContainers: ContainerInfo[];
}

export function useLakehouseBinding({
  id, isNewItem, itemQ, activeContainer, setActiveContainer, setOpenPrefixes, cacheKey,
}: Params): LakehouseBindingState {
  const [containers, setContainers] = useState<ContainerInfo[] | null>(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [serverBinding, setServerBinding] = useState<LakehouseBinding | null>(null);
  const [bindingResolved, setBindingResolved] = useState(false);
  const resolveStartedRef = useRef(false);

  const stateBinding = useMemo(() => bindingFromItemState(itemQ.data), [itemQ.data]);
  const binding = stateBinding ?? serverBinding;
  const rootPrefix = binding && activeContainer === binding.container ? binding.root : '';
  const tablesPrefix = joinPrefix(rootPrefix, 'Tables');

  // Container list. NOTE (#3904): this no longer picks the active container —
  // `containers[0]` is `bronze`, which is not where a lakehouse is materialised.
  useEffect(() => {
    let cancelled = false;
    clientFetch('/api/lakehouse/containers')
      .then((r) => parseJsonOrError<{ ok: boolean; error?: string; containers?: ContainerInfo[] }>(r, 'List containers'))
      .then((j) => {
        if (cancelled) return;
        if (!j.ok) { setContainerError(j.error || 'Failed to list containers'); setContainers([]); return; }
        setContainers(j.containers || []);
      })
      .catch((e) => { if (!cancelled) { setContainerError(String(e)); setContainers([]); } });
    return () => { cancelled = true; };
  }, []);

  // Bind to the lakehouse's OWN container. Runs once, as soon as the container
  // list and the item record have both settled; a user's later container pick
  // is never overridden.
  useEffect(() => {
    if (activeContainer || bindingResolved) return;
    if (containers === null) return;                       // container list still in flight
    if (!isNewItem && itemQ.isPending) return;             // item record still in flight

    // 1. Stamped on the item — no round trip.
    if (stateBinding) {
      setBindingResolved(true);
      setActiveContainer(stateBinding.container);
      return;
    }

    // 2. Ask the BFF to run resolveLakehouseAbfss (it can see LOOM_*_URL; we
    //    cannot). One call returns the binding AND its root listing.
    const workspaceId = itemQ.data?.workspaceId;
    if (!isNewItem && workspaceId) {
      // `bindingResolved` is only set when the promise settles, so a re-render
      // in flight would otherwise fire a second resolve. The ref closes that.
      if (resolveStartedRef.current) return;
      resolveStartedRef.current = true;
      let cancelled = false;
      const qs = new URLSearchParams({ lakehouseId: id, workspaceId });
      const fallback = () => {
        setBindingResolved(true);
        // 3. No binding to be had (honest gate / not provisioned). The listing
        //    stays item-scoped, so the route answers with its storage gate.
        if (containers.length) setActiveContainer(containers[0].name);
      };
      clientFetch(`/api/lakehouse/paths?${qs.toString()}`)
        .then((r) => parseJsonOrError<{
          ok: boolean; error?: string; container?: string | null; root?: string | null;
          prefix?: string; paths?: PathEntry[];
        }>(r, 'Resolve lakehouse storage'))
        .then((j) => {
          if (cancelled) return;
          if (!j.ok || !j.container) { fallback(); return; }
          const resolvedRoot = typeof j.root === 'string' ? j.root : '';
          setBindingResolved(true);
          setServerBinding({ container: j.container, root: resolvedRoot, source: 'server' });
          setActiveContainer(j.container);
          // Prime the cache so the root listing isn't fetched twice.
          if (Array.isArray(j.paths)) {
            const key = cacheKey(j.container, typeof j.prefix === 'string' ? j.prefix : resolvedRoot);
            setOpenPrefixes((p) => (p[key] === undefined ? { ...p, [key]: j.paths as PathEntry[] } : p));
          }
        })
        .catch(() => { if (!cancelled) fallback(); });
      return () => { cancelled = true; };
    }

    // 3. Unsaved / new item — nothing to bind to.
    setBindingResolved(true);
    if (containers.length) setActiveContainer(containers[0].name);
  }, [
    activeContainer, bindingResolved, containers, isNewItem, itemQ.isPending,
    itemQ.data?.workspaceId, stateBinding, id, cacheKey, setActiveContainer, setOpenPrefixes,
  ]);

  /**
   * Where a container's tree starts: the lakehouse's own root in its bound
   * container. An unbound item lists through the same item-scoped route, which
   * answers with the storage gate rather than a container listing.
   */
  const treeRootFor = useCallback(
    (container: string) => (binding && container === binding.container ? binding.root : ''),
    [binding],
  );

  /**
   * A BOUND lakehouse renders only its own container: every listing is
   * item-scoped (`/api/lakehouse/paths?lakehouseId=`), and the route answers a
   * listing outside the item's container + root with 403, so offering the other
   * containers would only offer refusals. It is rendered even when the live
   * `listContainers()` probe did not return it (that probe drops entries on a 6s
   * timeout) — a transient probe miss must not hide where this item lives.
   * An unbound item keeps the probed list.
   */
  const displayContainers = useMemo<ContainerInfo[]>(() => {
    const list = containers || [];
    if (!binding?.container) return list;
    return [list.find((c) => c.name === binding.container) ?? { name: binding.container, url: '' }];
  }, [containers, binding]);

  return {
    containers, containerError, binding, rootPrefix, tablesPrefix, treeRootFor, displayContainers,
  };
}
