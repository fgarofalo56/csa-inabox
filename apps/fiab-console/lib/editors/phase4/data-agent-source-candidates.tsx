'use client';

/**
 * Data-agent source picker — CANDIDATE LOADING.
 *
 * Extracted from `data-agent-editor.tsx` as part of fixing #4092. Two reasons,
 * and the second is the one that matters:
 *
 *  1. The monolith-creep ratchet (`scripts/ci/check-file-size.mjs`) freezes that
 *     editor at 2100 LOC. The #4092 repair grew it past the ceiling, and the
 *     ratchet's contract is DECOMPOSE, not `--update-baseline`.
 *  2. This is the code the bug lived in, and in the editor it was untestable —
 *     reachable only by mounting a 2000-line component with Monaco, Azure Maps
 *     and a Fluent tree in the graph. As its own hook it is exercised directly.
 *
 * WHAT #4092 WAS. `GET /api/items/data-agent/[id]` never projected
 * `workspaceId`, so `useItemState().workspaceId` was `''`, so the guard below
 * never fired and `/api/items/by-type` WAS NEVER CALLED. The Dropdown then
 * showed its empty-list placeholder ("None found") with **Add** disabled — a
 * dead end over an API that was serving the item correctly. The route projects
 * the field now; this module carries the client half of the repair.
 *
 * THE TWO CLIENT DEFECTS FIXED HERE:
 *
 *   A. `catch {}` left the cache entry UNDEFINED and recorded no reason, so the
 *      failure was invisible in both the state and the UI. The entry is now
 *      seeded with `[]` and the reason kept per type, which makes "we tried and
 *      it failed" distinguishable from "we never tried" — and stops the guarded
 *      effect re-issuing the request the next time any OTHER dependency changes
 *      (a picker-type round trip, a workspace change). The user-visible half is
 *      (B); this half is what makes the state readable.
 *
 *      NOT a fix for an infinite retry loop, and an earlier revision of this
 *      comment claimed it was. That claim was FALSE and a mutation test caught
 *      it: the effect's deps are `[workspaceId, pickerType, itemType, cache,
 *      load]`, and a failure without the seed leaves `cache` untouched, so React
 *      never re-runs the effect and nothing spins. Stated here because a comment
 *      that overstates what a line does is worse than none — the next reader
 *      stops looking (deploy-integrity.md R7).
 *
 *   B. A non-2xx fell through as `j.items || []`, so a 404/500 rendered
 *      identically to an empty workspace. That states as fact ("there are none")
 *      something the code never established — `deploy-integrity.md` R7. The
 *      reason is now kept per type and rendered as a retryable gate.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { ArrowSync16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

/** One selectable item in the picker's Item dropdown. */
export interface SourceCandidate { id: string; name: string }

export interface SourceCandidatesState {
  /** Candidates for the CURRENT picker type. Never undefined. */
  options: SourceCandidate[];
  loading: boolean;
  /** The real failure reason for the current type, or null. Never a fake "none". */
  error: string | null;
  /** Re-run the lookup for the current type (the Retry affordance). */
  reload: () => void;
}

/**
 * List the Loom items of `itemType` in `workspaceId` that the picker can offer.
 *
 * `itemType` empty ⇒ this source kind has no backing Loom item (Microsoft 365
 * Graph, metric view), so there is nothing to fetch and the result is an
 * intentional empty list rather than a gate.
 *
 * `workspaceId` empty ⇒ the item has not loaded yet (or is unsaved `/new`), so
 * the lookup is DEFERRED, not failed: scoping is mandatory, and an unscoped
 * query would list a sibling workspace's items — the cross-workspace leak
 * `/api/items/by-type` exists to prevent.
 */
export function useSourceCandidates(
  workspaceId: string,
  pickerType: string,
  itemType: string,
): SourceCandidatesState {
  const [cache, setCache] = useState<Record<string, SourceCandidate[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (type: string, forType: string) => {
    if (!forType) { setCache((p) => ({ ...p, [type]: [] })); return; }
    setLoading(true);
    setErrors((p) => { if (!p[type]) return p; const n = { ...p }; delete n[type]; return n; });
    try {
      const ws = workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : '';
      const r = await clientFetch(`/api/items/by-type?types=${encodeURIComponent(forType)}${ws}`);
      const j = await r.json().catch(() => ({}));
      // (B) A non-2xx is a FAILURE, not an empty workspace.
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`);
      const items: SourceCandidate[] = (Array.isArray(j.items) ? j.items : [])
        .map((it: any) => ({ id: it.id, name: it.displayName || it.id }));
      setCache((p) => ({ ...p, [type]: items }));
    } catch (e: any) {
      // (A) Seed the key even on failure so the guarded effect cannot re-arm.
      setCache((p) => ({ ...p, [type]: [] }));
      setErrors((p) => ({ ...p, [type]: e?.message || String(e) }));
    } finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => {
    // THE GUARD #4092 LEFT PERMANENTLY FALSE. It is correct as written — the
    // bug was that `workspaceId` never arrived, not that it is consulted.
    if (workspaceId && !cache[pickerType]) load(pickerType, itemType);
  }, [workspaceId, pickerType, itemType, cache, load]);

  return {
    options: cache[pickerType] || [],
    loading,
    error: errors[pickerType] || null,
    reload: useCallback(() => load(pickerType, itemType), [load, pickerType, itemType]),
  };
}

/**
 * The placeholder for the Item dropdown — three DISTINCT states, because
 * collapsing them is what made #4092 unreadable from the screen: "None found"
 * was shown for a healthy-but-unqueried endpoint, a failed query, AND a
 * genuinely empty workspace.
 */
export function sourceCandidatePlaceholder(s: Pick<SourceCandidatesState, 'options' | 'loading' | 'error'>): string {
  if (s.loading) return 'Loading…';
  if (s.options.length) return 'Select…';
  if (s.error) return "Couldn't load — retry";
  return 'None in this workspace';
}

/** Retryable, honest failure gate for the candidate lookup. Renders nothing on success. */
export function SourceCandidateError({ error, loading, label, onRetry }: {
  error: string | null; loading: boolean; label: string; onRetry: () => void;
}) {
  if (!error || loading) return null;
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Couldn&apos;t list {label} items</MessageBarTitle>
        {' '}{error}{' '}
        <Button size="small" appearance="transparent" icon={<ArrowSync16Regular />} onClick={onRetry}>Retry</Button>
      </MessageBarBody>
    </MessageBar>
  );
}
