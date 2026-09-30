/**
 * What the cost-allocation TAG breakdown can truthfully say, derived from the
 * cost summary alone (pure; unit-tested in `__tests__/cost-tag-state.test.ts`).
 *
 * An empty `byTag` is ambiguous on its own. It means "no resource carries the
 * tag" ONLY when a summary was actually read AND every subscription's tag query
 * answered in a recognised shape. If no summary was read (still loading, a 504,
 * a non-JSON body, `ok:false`, a gate, a 401), nothing is known; if any
 * subscription's tag query — or its whole cost query — failed, the breakdown is
 * unknown or incomplete. Saying "no tags found" in either case would state a
 * cause the code never established (deploy-integrity R7).
 */
export interface TagQueryError { subscription: string; error: string }

export type TagLoadState =
  /** No summary was read at all: nothing may be claimed about tags. */
  | { kind: 'unknown' }
  /** Rows present, every tag query answered. */
  | { kind: 'ok' }
  /** Rows present, but some subscriptions' tag queries failed: the chart omits their spend. */
  | { kind: 'partial'; errors: TagQueryError[] }
  /** No rows AND at least one tag query failed: nothing is known about tags. */
  | { kind: 'failed'; errors: TagQueryError[] }
  /** No rows, every tag query answered: the estate genuinely carries no such tag value. */
  | { kind: 'none' };

export interface TagSummaryLike {
  byTag?: { key: string; cost: number }[] | null;
  tagQueryErrors?: TagQueryError[] | null;
  /**
   * Subscriptions whose WHOLE cost read failed. Their tag spend was never read
   * either, so each one is a tag error too. A subscription already named in
   * `tagQueryErrors` is not listed twice.
   */
  subscriptionErrors?: TagQueryError[] | null;
}

export function tagLoadState(summary: TagSummaryLike | null | undefined): TagLoadState {
  if (!summary) return { kind: 'unknown' };
  const errors: TagQueryError[] = [...(summary.tagQueryErrors ?? [])];
  const named = new Set(errors.map((e) => e.subscription));
  for (const e of summary.subscriptionErrors ?? []) {
    if (!named.has(e.subscription)) { errors.push(e); named.add(e.subscription); }
  }
  const hasRows = (summary.byTag?.length ?? 0) > 0;
  if (hasRows) return errors.length ? { kind: 'partial', errors } : { kind: 'ok' };
  return errors.length ? { kind: 'failed', errors } : { kind: 'none' };
}
