/**
 * sweep(): which previously observed documents are no longer present.
 *
 * A type in `partialTypes` (list failed, only a page was read, or the gateway
 * rejected the call) is EXEMPT: absence from an incomplete snapshot proves
 * nothing, and sweeping it would delete real inventory.
 */
import type { ObservedType } from './types';

export function sweep(
  prior: ReadonlyArray<{ id: string; observedType: ObservedType }>,
  seenIds: ReadonlySet<string>,
  partialTypes: ReadonlySet<ObservedType>,
): string[] {
  return prior.filter((d) => !partialTypes.has(d.observedType) && !seenIds.has(d.id)).map((d) => d.id);
}
