/**
 * `tagLoadState` — which tag-breakdown notice the Monitor cost tab may show.
 * The defect this pins: an empty breakdown rendered "No cost-allocation tags
 * found" even when the tag query had FAILED, a cause the code never
 * established. What breaks each test is stated at its site.
 */
import { describe, it, expect } from 'vitest';
import { tagLoadState } from '../cost-tag-state';

const ERR = [{ subscription: 'sub-1', error: 'Too many requests' }];
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
    expect(tagLoadState({ byTag: [], tagQueryErrors: [] })).toEqual({ kind: 'none' });
    // A cached report written before tagQueryErrors existed is treated as answered.
    expect(tagLoadState({ byTag: [] })).toEqual({ kind: 'none' });
  });

  it('ok: rows and no errors', () => {
    // Positive pair for the three non-ok states; breaks if ok is never reachable.
    expect(tagLoadState({ byTag: ROWS, tagQueryErrors: [] })).toEqual({ kind: 'ok' });
    expect(tagLoadState(null)).toEqual({ kind: 'none' });
  });
});
