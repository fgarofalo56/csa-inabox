/**
 * #2655 (js/polynomial-redos) — the slash strippers must be LINEAR and must
 * behave byte-for-byte like the regexes they replace.
 */
import { describe, it, expect } from 'vitest';
import {
  stripTrailingSlashes,
  stripLeadingSlashes,
  trimSlashes,
  lastSegment,
} from '../path-strings';

/** The killer input: a long slash run that does NOT end the string, so the
 *  old `/\/+$/` retries from every slash position and scans to the end. */
const hostile = (n: number) => `a${'/'.repeat(n)}b`;

describe('semantics match the regexes they replace', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['///', ''],
    ['a', 'a'],
    ['a/', 'a'],
    ['a///', 'a'],
    ['/a/b/', '/a/b'],
    ['https://v.vault.azure.net//', 'https://v.vault.azure.net'],
    ['a/b//c', 'a/b//c'],   // interior slashes untouched
  ])('stripTrailingSlashes(%j) === %j', (input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected);
    // ...and agrees with the regex it replaces.
    expect(stripTrailingSlashes(input)).toBe(input.replace(/\/+$/, ''));
  });

  it.each([
    ['', ''],
    ['///', ''],
    ['/a', 'a'],
    ['///a/b', 'a/b'],
    ['a/b', 'a/b'],
  ])('stripLeadingSlashes(%j) === %j', (input, expected) => {
    expect(stripLeadingSlashes(input)).toBe(expected);
    expect(stripLeadingSlashes(input)).toBe(input.replace(/^\/+/, ''));
  });

  it.each([
    ['///a/b///', 'a/b'],
    ['////', ''],
    ['a', 'a'],
  ])('trimSlashes(%j) === %j', (input, expected) => {
    expect(trimSlashes(input)).toBe(expected);
  });

  it('returns the SAME reference when nothing is stripped', () => {
    const s = 'a/b';
    expect(stripTrailingSlashes(s)).toBe(s);
    expect(stripLeadingSlashes(s)).toBe(s);
    expect(trimSlashes(s)).toBe(s);
  });
});

describe('lastSegment', () => {
  it.each([
    ['a/b/c', 'c'],
    ['a/b/c/', 'c'],
    ['a/b/c///', 'c'],
    ['c', 'c'],
    ['/c', 'c'],
    ['', ''],
    ['///', ''],
  ])('lastSegment(%j) === %j', (input, expected) => {
    expect(lastSegment(input)).toBe(expected);
  });

  it('a trailing slash does NOT yield an empty name', () => {
    // The behaviour every current caller depends on — a download named '' would
    // be a user-visible bug, not just a style difference.
    expect(lastSegment('bronze/sales/')).toBe('sales');
  });
});

describe('linear time (the ReDoS bound)', () => {
  // WHY AN ABSOLUTE BUDGET AND NOT A RATIO (#2834).
  //
  // This used to carry a second test asserting `large/small < 8` — that 4x the
  // input must not cost ~16x, the quadratic signature. It measured wall clock,
  // so scheduler noise read as algorithmic cost, and it flaked under full-suite
  // load. It had already been "fixed" once by taking best-of-3 on both sides;
  // that did not hold, because the problem is not sample noise, it is SCALE:
  //
  //     linear, n=200_000, 1 call ........... 0.0013 ms
  //     linear, n=200_000, x20 loop ......... 0.125  ms
  //     linear, n=50_000,  x20 loop ......... 0.03   ms   <- the divisor
  //
  // The ratio divided two sub-millisecond numbers, so a single deschedule of a
  // fraction of a millisecond on the `small` side inflated it without limit. A
  // minimum-of-N cannot fix that: it is the small side being small, not noisy.
  // Raising the threshold to 16 would only have bought time and weakened the
  // bound, so the ratio test is gone rather than loosened.
  //
  // NOTHING IS LOST. The absolute budget below is a strictly STRONGER assertion
  // and is what actually catches the quadratic regex, with ~5 orders of
  // magnitude of separation rather than 2x of headroom (measured, node 20):
  //
  //     linear    n=200_000 ......... 0.0013 ms   (budget 100 ms → ~77,000x under)
  //     /\/+$/    n= 50_000 ......... 1_422  ms
  //     /\/+$/    n=200_000 ......... ~22_800 ms  (O(n^2) → 16x of the above)
  //
  // A bound where PASS is 0.0013 ms and FAIL is ~23_000 ms cannot be flipped by
  // the scheduler; the ratio form, where pass and fail were 0.03 ms apart, could
  // be flipped by almost anything. Mutation-proved both directions in the PR:
  // substituting `s.replace(/\/+$/, '')` for the linear scan turns these RED.
  const budgetMs = 100;

  it('a pathological input completes fast', () => {
    const t0 = performance.now();
    stripTrailingSlashes(hostile(200_000));
    expect(performance.now() - t0).toBeLessThan(budgetMs);
  });

  // Growing the input 16x must stay inside the SAME fixed budget. A linear scan
  // shrugs this off (microseconds); anything quadratic blows the budget by
  // orders of magnitude long before the largest size — so this keeps the
  // scaling signal the deleted ratio test was reaching for, without ever
  // dividing one measurement by another.
  it.each([12_500, 25_000, 50_000, 100_000, 200_000])(
    'stays inside the fixed budget at n=%i (quadratic would not)',
    (n) => {
      const s = hostile(n);
      const t0 = performance.now();
      stripTrailingSlashes(s);
      expect(performance.now() - t0).toBeLessThan(budgetMs);
    },
  );

  // DELIBERATELY NOT TESTED HERE: a head-to-head against the old
  // `s.replace(/\/+$/, '')`. Written first, it cost **165 seconds** — because
  // proving the regex is quadratic means actually running the quadratic regex,
  // and that is a wildly disproportionate price for every CI run forever.
  //
  // The bound is already established by the tests above, and the mutation
  // proof is stronger evidence anyway: swapping `stripTrailingSlashes` back to
  // the regex made this suite HANG past 600s on the 200k input, which is exactly
  // the ReDoS the fix removes. Recorded in the PR rather than paid for on every
  // run.
});
