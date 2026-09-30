/**
 * `tagLoadState` — which tag-breakdown notice the Monitor cost tab may show.
 * The defect this pins: an empty breakdown rendered "No cost-allocation tags
 * found" even when the tag query had FAILED, or when no summary had been read
 * at all, a cause the code never established. What breaks each test is stated
 * at its site.
 */
import { describe, it, expect } from 'vitest';
import { tagLoadState } from '../cost-tag-state';

const ERR = [{ subscription: 'sub-1', error: 'Too many requests' }];
const SUB_ERR = [{ subscription: 'sub-2', error: 'AuthorizationFailed for test' }];
const ROWS = [{ key: 'commercial', cost: 7 }];

describe('tagLoadState', () => {
  it('failed: no rows and a tag query failed → never "none"', () => {
    // Breaks if errors are ignored when rows are empty (the original defect): kind would be 'none'.
    expect(tagLoadState({ byTag: [], tagQueryErrors: ERR })).toEqual({ kind: 'failed', errors: ERR });
  });

  it('partial: rows present but a tag query failed → the omission is disclosed', () => {
    // Breaks if partial failures are hidden behind the rows (review finding 3): kind would be 'ok'.
    expect(tagLoadState({ byTag: ROWS, tagQueryErrors: ERR })).toEqual({ kind: 'partial', errors: ERR });
  });

  it('none: no rows and every tag query answered → the only state that may say "no tags"', () => {
    // Breaks if "none" is keyed on rows alone and reached with errors, or if it is renamed away.
    expect(tagLoadState({ byTag: [], tagQueryErrors: [], subscriptionErrors: [] })).toEqual({ kind: 'none' });
    // A cached report written before tagQueryErrors existed is treated as answered.
    expect(tagLoadState({ byTag: [] })).toEqual({ kind: 'none' });
  });

  it('ok: rows and no errors', () => {
    // Positive pair for the non-ok states; breaks if ok is never reachable.
    expect(tagLoadState({ byTag: ROWS, tagQueryErrors: [] })).toEqual({ kind: 'ok' });
  });

  it('unknown: no summary was read → never "none" (#4771 R7, B-1)', () => {
    // Breaks if a missing summary falls through to the row/error test: with
    // zero rows and zero errors it would read 'none', and the Cost tab would
    // say "No cost-allocation tags found" while loading, after a 504, after a
    // non-JSON body, after ok:false, under a gate, and after a 401.
    expect(tagLoadState(null)).toEqual({ kind: 'unknown' });
    expect(tagLoadState(undefined)).toEqual({ kind: 'unknown' });
  });

  it('a subscription whose whole cost read failed is a tag error too (B-4)', () => {
    // Breaks if subscriptionErrors are ignored: a sub that contributed no rows
    // at all would leave kind 'none' (no rows) or 'ok' (other subs' rows).
    expect(tagLoadState({ byTag: [], tagQueryErrors: [], subscriptionErrors: SUB_ERR })).toEqual({ kind: 'failed', errors: SUB_ERR });
    expect(tagLoadState({ byTag: ROWS, subscriptionErrors: SUB_ERR })).toEqual({ kind: 'partial', errors: SUB_ERR });
  });

  it('a subscription named in both lists is counted once, tag error first', () => {
    const both = [{ subscription: 'sub-1', error: 'whole cost read failed' }];
    // Breaks if the merge does not de-duplicate by subscription: errors would
    // be length 2 and the partial notice would count 2 subscriptions for 1.
    // Also breaks if the ORDER flips: the tag-specific text must win.
    expect(tagLoadState({ byTag: ROWS, tagQueryErrors: ERR, subscriptionErrors: both })).toEqual({ kind: 'partial', errors: ERR });
    // Distinct subscriptions are both kept: breaks if the de-dup drops by position.
    expect(tagLoadState({ byTag: ROWS, tagQueryErrors: ERR, subscriptionErrors: SUB_ERR })).toEqual({ kind: 'partial', errors: [...ERR, ...SUB_ERR] });
  });
});
