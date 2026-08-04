'use client';

/**
 * usePbiWorkspaceBinding — the semantic-model editor's workspace-identity
 * cluster, extracted from semantic-model-editor.tsx (WS-E decomposition).
 *
 * PURELY STRUCTURAL: the three `useState`s and two `useEffect`s below run in the
 * same order, at the same call position, as when they were inline — the hook is
 * invoked exactly where `pbiWorkspaceId` used to be declared, so the editor's
 * expanded hook sequence (pinned by semantic-model-hook-order.test.ts) is
 * unchanged. The auto-pick effect that CONSUMES this state deliberately stays in
 * the editor at its original position; moving it would reorder effect execution,
 * which would not be a structural change.
 *
 * ── TWO WORKSPACE NAMESPACES, NEVER INTERCHANGEABLE (#2649) ──────────────────
 * `pbiWorkspaceId` — a POWER BI groupId (usePowerBiWorkspaces →
 *   /api/powerbi/workspaces). Only Power BI-backed calls may receive it: list /
 *   detail / refresh / refresh-schedule / take-over / measures / build /
 *   direct-lake / app.powerbi.com deep links + the PBI governance panels.
 * `loomWorkspaceId` — THIS item's own Loom workspace GUID (its Cosmos partition
 *   key). The assertOwner-guarded Loom item routes (`[id]/model`,
 *   `[id]/datasource`) accept nothing else and answer 404 "semantic model not
 *   found" for a Power BI groupId — which is what 404'd them on EVERY open.
 *   Resolved from the item record exactly as the sibling Power BI-family editor
 *   in this folder already does (paginated-report-editor.tsx).
 * `mappedPbiWorkspaceId` — the Power BI workspace this item's Loom workspace is
 *   MAPPED to (`pbiWorkspaceMapping.pbiWorkspaceId`, set in Workspace settings).
 *   Three-state on purpose: `''` once resolution finishes with no mapping,
 *   `null` while still resolving, so the caller's auto-pick can WAIT rather than
 *   race ahead and pin an arbitrary group.
 *
 * NO-FABRIC-DEPENDENCY: the mapping fetch is gated on `pbiOptIn` exactly like
 * `usePowerBiWorkspaces`, so the DEFAULT (Loom-native) render makes ZERO extra
 * requests for a Power BI concern.
 */

import { useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import { getItem } from '@/lib/api/workspaces';

export interface PbiWorkspaceBinding {
  /** The bound Power BI groupId ('' until the caller's auto-pick sets one). */
  pbiWorkspaceId: string;
  setPbiWorkspaceId: (v: string) => void;
  /** This item's own Loom workspace id ('' for `new` / unresolved). */
  loomWorkspaceId: string;
  /** Mapped Power BI workspace: GUID | '' (unmapped) | null (still resolving). */
  mappedPbiWorkspaceId: string | null;
}

export function usePbiWorkspaceBinding(opts: {
  itemSlug: string;
  id: string;
  /** Whether the Power BI opt-in leg is enabled (useBiBackend). */
  pbiOptIn: boolean;
}): PbiWorkspaceBinding {
  const { itemSlug, id, pbiOptIn } = opts;
  const [pbiWorkspaceId, setPbiWorkspaceId] = useState('');
  const [loomWorkspaceId, setLoomWorkspaceId] = useState('');
  const [mappedPbiWorkspaceId, setMappedPbiWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    // Best-effort: the Loom routes treat an ABSENT workspaceId as "no owner
    // check", so degrading to '' still works — unlike sending a foreign id.
    getItem(itemSlug, id)
      .then((it) => { if (!cancelled && it?.workspaceId) setLoomWorkspaceId(it.workspaceId); })
      .catch(() => { /* leave loomWorkspaceId unresolved */ });
    return () => { cancelled = true; };
  }, [itemSlug, id]);

  useEffect(() => {
    if (!pbiOptIn) return;
    if (!loomWorkspaceId) return;
    let cancelled = false;
    clientFetch(`/api/workspaces/${encodeURIComponent(loomWorkspaceId)}/powerbi-mapping`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setMappedPbiWorkspaceId(j?.ok ? (j.mapping?.pbiWorkspaceId || '') : '');
      })
      .catch(() => { if (!cancelled) setMappedPbiWorkspaceId(''); });
    return () => { cancelled = true; };
  }, [pbiOptIn, loomWorkspaceId]);

  return { pbiWorkspaceId, setPbiWorkspaceId, loomWorkspaceId, mappedPbiWorkspaceId };
}
