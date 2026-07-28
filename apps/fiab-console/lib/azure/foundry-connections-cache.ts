/**
 * foundry-connections-cache — the budget + memo + truncation POLICY for the
 * Foundry hub's `/connections` list, kept out of foundry-client so the policy
 * is readable (and testable) on its own rather than buried in a 2.6k-line
 * client.
 *
 * `/connections` is the one ARM list that sits on the AOAI target-resolution
 * hot path: `resolveAoaiTarget` falls through to it on EVERY turn when the
 * tenant config carries no endpoint and `LOOM_AOAI_ENDPOINT` is unset. A cold
 * walk measured 22.9 s inside a `maxDuration = 60` route (issue #2557), hence
 * a tighter-than-default paging budget plus a short TTL memo.
 *
 * THE POLICY, in one place:
 *   • bounded — 10 pages / 8 s (`LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS`);
 *   • memoized — 5 min (`LOOM_FOUNDRY_CONNECTIONS_TTL_MS`), invalidated by
 *     Loom's own writes and by `?refresh=1`;
 *   • ONLY A COMPLETE WALK IS EVER MEMOIZED. The memo is shared across
 *     consumers that ask for different things — the Copilot's AOAI discovery,
 *     `GET /api/foundry/connections`, `resolveContentSafetyEndpoint` — and a
 *     partial list cached by one of them is served to all the others for the
 *     full TTL. That is memo poisoning: a caller that would have wanted the
 *     whole list silently gets someone else's truncated one, with no way to
 *     tell. Splitting the rule by truncation KIND ("time is transient, pages is
 *     deterministic, so keep the page-capped one") only made it harder to
 *     reason about without removing the poisoning, so the rule is now flat:
 *     truncated ⇒ not memoized, and the next caller re-walks ARM. The cost is
 *     re-paying a bounded walk on a hub that genuinely overflows 10 pages; the
 *     benefit is that a memo hit is, by construction, a WHOLE list.
 *   • `requireComplete` turns a truncation into a `PagingDeadlineError`, so a
 *     caller that would otherwise conclude "that connection does not exist"
 *     from an incomplete list reports a DEADLINE instead of a missing resource.
 *     Note this is the LAST resort, not the first: a caller searching for one
 *     connection should search first and only care about completeness if the
 *     search MISSES (see `copilot-orchestrator.resolveAoaiTargetRaw`) — a
 *     truncated walk that already contains the target is a fine answer.
 *
 * No mocks — this only decides what to do with the result of a real ARM walk.
 */
import { createTtlMemo } from './ttl-memo';
import type { PagedWalkResult, PagingBudgetOptions, PagingTruncation } from './paging-budget';

/** Positive-number env override with a code default. */
function envPositive(k: string, def: number): number {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Tighter than the shared 15 s default — this list is on the Copilot hot path. */
export const CONNECTIONS_PAGING: PagingBudgetOptions = {
  maxPages: 10,
  get budgetMs() {
    return envPositive('LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS', 8_000);
  },
};

/** A walk's rows plus the budget that governed it (for the truncation policy). */
export interface ConnectionsWalk<T> {
  rows: T[];
  walk: PagedWalkResult<any>;
}

const connectionsMemo = createTtlMemo<ConnectionsWalk<any>>(
  envPositive('LOOM_FOUNDRY_CONNECTIONS_TTL_MS', 300_000),
);

/** Drop the memo so a create/update/delete through foundry-connections-client
 *  is visible on the very NEXT read rather than after the TTL. */
export function invalidateFoundryConnections(): void {
  connectionsMemo.invalidate();
}

/** Apply the policy above to `compute` (the real ARM walk). */
export async function cachedConnections<T>(
  compute: () => Promise<ConnectionsWalk<T>>,
  opts?: {
    force?: boolean;
    requireComplete?: boolean;
    /** Told which ceiling tripped when the list is short, so a surface can say
     *  "ARM was slow" instead of implying the hub has fewer connections. */
    onTruncated?: (t: PagingTruncation) => void;
  },
): Promise<T[]> {
  const memo = (await connectionsMemo.get(compute, opts?.force)) as ConnectionsWalk<T>;
  const truncatedBy = memo.walk.truncatedBy;
  if (truncatedBy) opts?.onTruncated?.(truncatedBy);
  // Never let a partial list become the 5-minute answer for EVERY consumer of
  // this memo — whatever cut it short. The caller that triggered the walk still
  // gets these rows (they are the freshest thing we have); the next one re-walks.
  if (truncatedBy) connectionsMemo.invalidate();
  if (truncatedBy && opts?.requireComplete) memo.walk.budget.assertComplete(memo.rows.length);
  return memo.rows;
}
