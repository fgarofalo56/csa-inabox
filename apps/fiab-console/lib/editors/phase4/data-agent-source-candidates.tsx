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
 * THE THREE CLIENT DEFECTS FIXED HERE:
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
 *
 *   C. The FIRST repair of (B) reintroduced R7 one state over. It gave the
 *      placeholder function `options | loading | error` and no way to express
 *      DEFERRED, so "we have no workspace yet, and therefore asked nothing"
 *      rendered as "None in this workspace" — a positive claim about the
 *      workspace's contents, made having queried nothing, and reachable on
 *      every single open (the picker renders alongside the load Spinner) plus
 *      permanently on `/new`. `deferred` is now part of the state and part of
 *      the placeholder's input, so the state can be supplied by a test and is
 *      kept distinct on screen.
 *
 *   D. #4102 — the SAME false claim by a third route, and the one that also
 *      broke the button. A source kind whose `itemType` is `''` binds no Loom
 *      item, so `load()` short-circuits to an intentional empty list: nothing
 *      is queried, ever. That state was ALSO unrepresentable — with a workspace
 *      present, `deferred` is false — so it collapsed into EMPTY and the picker
 *      again asserted "None in this workspace" having asked nothing.
 *
 *      Worse, the consumer keyed its "this kind has no item picker" branch on
 *      the literal `pickerType === 'microsoft-graph'`, so `metric-view` (the
 *      OTHER `itemType: ''` kind) rendered an Item dropdown that could never
 *      populate — and the Add button's `!pickSel` guard therefore held it
 *      DISABLED FOREVER. A first-class source type could not be added at all.
 *
 *      `unbound` is now part of the state, and `sourceTypeBindsLoomItem()` is
 *      exported so the consumer keys off the SHAPE (`itemType === ''`) rather
 *      than a list of names that the next such type would not be on.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { ArrowSync16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { DaSourceType } from '../_family-utils';

/** One selectable item in the picker's Item dropdown. */
export interface SourceCandidate { id: string; name: string }

export interface SourceCandidatesState {
  /** Candidates for the CURRENT picker type. Never undefined. */
  options: SourceCandidate[];
  loading: boolean;
  /** The real failure reason for the current type, or null. Never a fake "none". */
  error: string | null;
  /**
   * DEFERRED — no `workspaceId` yet, so NOTHING was queried and nothing is
   * known about the workspace's contents.
   *
   * This flag exists because without it the state is unrepresentable, and an
   * unrepresentable state gets rendered as whichever neighbour it collapses
   * into. It collapsed into EMPTY, so the picker asserted "None in this
   * workspace" — a positive claim about a workspace it had never asked about,
   * which is the same `deploy-integrity.md` R7 defect as (B) in the module
   * docblock above, and a STRONGER false claim than the `'None found'` it
   * replaced.
   *
   * Reachable on every open, not in theory: the editor renders the picker
   * alongside its load Spinner with no early return, so this is the state for
   * the whole of a saved item's load — and permanently on `/items/data-agent/new`,
   * where the item has no workspace until it is saved.
   */
  deferred: boolean;
  /**
   * UNBOUND — this source kind has no backing Loom item type (`itemType === ''`),
   * so there is no item picker to populate and no query to make. #4102.
   *
   * Distinct from `deferred` (a workspace-scoped query we have not made YET) and
   * from an empty result (a query that came back with nothing). All three render
   * an empty option list, and before this flag the third message — "None in this
   * workspace" — was shown for all three. For an unbound kind that claim is not
   * merely unproven, it is about a lookup the code is designed never to perform.
   */
  unbound: boolean;
  /** Re-run the lookup for the current type (the Retry affordance). */
  reload: () => void;
}

/**
 * `itemType: ''` means the kind binds no Loom item, so it gets NO item picker
 * and is added directly. That was true of two entries below while the UI keyed
 * the branch on the literal name `microsoft-graph` — which left `metric-view`
 * rendering a dropdown that could never populate and an Add button that could
 * never enable (#4102). Every consumer now asks
 * `sourceTypeBindsLoomItem(cfg.itemType)` instead, so the rule follows the
 * declaration rather than a list of names.
 *
 * `scopeHint` is the copy shown in the picker where the Item dropdown would be:
 * it must say what the user configures INSTEAD, never anything about a
 * workspace's contents (deploy-integrity.md R7).
 */
export const DA_SOURCE_TYPES: { value: DaSourceType; label: string; itemType: string; scopeHint?: string }[] = [
  { value: 'warehouse', label: 'Warehouse', itemType: 'warehouse' },
  { value: 'lakehouse', label: 'Lakehouse', itemType: 'lakehouse' },
  { value: 'kql', label: 'KQL database', itemType: 'kql-database' },
  { value: 'semantic-model', label: 'Semantic model', itemType: 'semantic-model' },
  // Governed metric view (DBX-6). Not a standalone Loom item — grounds the agent
  // on the governed measure definitions (typed into the card) and executes SQL
  // over the Azure-native warehouse. itemType '' skips the item picker.
  {
    value: 'metric-view', label: 'Metric view', itemType: '',
    scopeHint: 'Governed view name + its dimensions and measures — configured on the source card after adding.',
  },
  { value: 'ai-search', label: 'AI Search', itemType: 'ai-search-index' },
  { value: 'ontology', label: 'Ontology', itemType: 'ontology' },
  { value: 'graph', label: 'Graph model', itemType: 'graph-model' },
  // Not a Loom item — grounds on Microsoft Graph directly (site/drive/mail
  // scope picked on the source card). itemType '' skips the item picker.
  {
    value: 'microsoft-graph', label: 'Microsoft 365 (Graph)', itemType: '',
    scopeHint: 'SharePoint site / OneDrive drive / mailbox — configured on the source card after adding.',
  },
  // Hosted agent compose-back (DBX-2): a deployed Loom App (Agent/FastAPI
  // template). The picker lists loom-app-runtime items; the executor POSTs the
  // routed sub-question to the app's /invoke endpoint.
  { value: 'agent', label: 'Hosted agent', itemType: 'loom-app-runtime' },
];
/**
 * Does this source kind bind a Loom item the picker can list?
 *
 * THE SHAPE, not a name list (#4102). The consumer used to branch on
 * `pickerType === 'microsoft-graph'`, which was true of the only unbound kind
 * that existed when it was written and silently wrong the moment `metric-view`
 * was added with the same `itemType: ''`. Keyed here, the next such kind is
 * handled on the day it is declared.
 */
export function sourceTypeBindsLoomItem(itemType: string): boolean {
  return typeof itemType === 'string' && itemType.trim().length > 0;
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
    // The guard above, restated as OUTPUT. Without this the caller cannot tell
    // "the query returned nothing" from "there was no query", and the second
    // one silently renders as the first.
    //
    // ORDER MATTERS on screen, and it is decided in the placeholder, not here:
    // an unbound kind is reported as unbound even before a workspace exists,
    // because "there is no item type to look up" is the older and more specific
    // truth about it.
    deferred: !workspaceId,
    unbound: !sourceTypeBindsLoomItem(itemType),
    reload: useCallback(() => load(pickerType, itemType), [load, pickerType, itemType]),
  };
}

/**
 * The placeholder for the Item dropdown — FIVE distinct states, because
 * collapsing them is what made #4092 unreadable from the screen: "None found"
 * was shown for a healthy-but-unqueried endpoint, a failed query, AND a
 * genuinely empty workspace.
 *
 * DEFERRED and UNBOUND are REQUIRED inputs, not optional refinements. The first
 * revision of this function took only `options | loading | error`, which left
 * DEFERRED unrepresentable — so it fell through to the final `return` and
 * claimed "None in this workspace" having queried nothing. #4102 is the same
 * error one door down: UNBOUND was unrepresentable too, and a source kind that
 * binds no Loom item reached the same sentence. A spec named "never collapsed"
 * could not catch either, because it could not SUPPLY the state.
 *
 * UNBOUND is tested FIRST among the empty states. It is a property of the
 * source KIND, decided before any workspace is involved, so reporting it as
 * "waiting for the workspace" would be a second false claim — the wait would
 * never end.
 */
export function sourceCandidatePlaceholder(
  s: Pick<SourceCandidatesState, 'options' | 'loading' | 'error' | 'deferred' | 'unbound'>,
): string {
  if (s.loading) return 'Loading…';
  if (s.options.length) return 'Select…';
  if (s.error) return "Couldn't load — retry";
  // #4102 — no item type to look up. Nothing was asked and nothing ever will be,
  // so nothing may be said about any workspace's contents.
  if (s.unbound) return 'No item to pick — configured below';
  // Nothing was asked, so nothing may be asserted about the answer.
  if (s.deferred) return 'Waiting for the workspace…';
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
