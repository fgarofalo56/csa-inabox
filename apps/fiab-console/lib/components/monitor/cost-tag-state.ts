/**
 * What the cost-allocation TAG breakdown can truthfully say, derived from the
 * cost summary alone (pure; unit-tested in `__tests__/cost-tag-state.test.ts`).
 *
 * An empty `byTag` is ambiguous on its own. It means "no resource carries the
 * tag" ONLY when every subscription's tag query answered in a recognised shape;
 * if any failed (throttled, timed out, refused, unrecognised columns) the
 * breakdown is unknown or incomplete, and saying "no tags found" would state a
 * cause the code never established (deploy-integrity R7).
 */
export interface TagQueryError { subscription: string; error: string }

export type TagLoadState =
  /** Rows present, every tag query answered. */
  | { kind: 'ok' }
  /** Rows present, but some subscriptions' tag queries failed: the chart omits their spend. */
  | { kind: 'partial'; errors: TagQueryError[] }
  /** No rows AND at least one tag query failed: nothing is known about tags. */
  | { kind: 'failed'; errors: TagQueryError[] }
  /** No rows, every tag query answered: the estate genuinely carries no such tag value. */
  | { kind: 'none' };

export function tagLoadState(summary: {
  byTag?: { key: string; cost: number }[] | null;
  tagQueryErrors?: TagQueryError[] | null;
} | null | undefined): TagLoadState {
  const errors = summary?.tagQueryErrors ?? [];
  const hasRows = (summary?.byTag?.length ?? 0) > 0;
  if (hasRows) return errors.length ? { kind: 'partial', errors } : { kind: 'ok' };
  return errors.length ? { kind: 'failed', errors } : { kind: 'none' };
}
