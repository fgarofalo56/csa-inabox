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
  it('a pathological input completes fast', () => {
    const t0 = performance.now();
    stripTrailingSlashes(hostile(200_000));
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('scales LINEARLY, not quadratically', () => {
    const once = (n: number) => {
      const s = hostile(n);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) stripTrailingSlashes(s);
      return performance.now() - t0;
    };
    // BEST-of-N, not a single sample. This assertion is about an ALGORITHMIC
    // property, but it measures wall clock, so scheduler noise reads as
    // algorithmic cost. A single sample made it fail inside the full 1302-file
    // suite (ratio 11.85 vs a limit of 8) while passing 3/3 in isolation: under
    // load `small` can be timed on an uncontended slice while `large` gets
    // descheduled mid-measurement, and the ratio inflates for reasons that have
    // nothing to do with the regex.
    //
    // The MINIMUM of several runs is the least-contended observation of each
    // size — the closest thing to the true cost. Taking it on both sides keeps
    // the bound exactly as strict (a genuinely quadratic implementation is ~16x
    // in EVERY sample, so its minimum ratio is still ~16x) while dropping the
    // noise that made this flaky.
    const best = (n: number) => Math.min(once(n), once(n), once(n));
    once(10_000); // warm the JIT before any measurement counts
    const small = Math.max(best(50_000), 0.01);
    const large = best(200_000);
    // 4x the input must not cost ~16x (the quadratic signature).
    expect(large / small).toBeLessThan(8);
  });

  // DELIBERATELY NOT TESTED HERE: a head-to-head against the old
  // `s.replace(/\/+$/, '')`. Written first, it cost **165 seconds** — because
  // proving the regex is quadratic means actually running the quadratic regex,
  // and that is a wildly disproportionate price for every CI run forever.
  //
  // The bound is already established by the two tests above, and the mutation
  // proof is stronger evidence anyway: swapping `stripTrailingSlashes` back to
  // the regex made this suite HANG past 600s on the 200k input, which is exactly
  // the ReDoS the fix removes. Recorded in the PR rather than paid for on every
  // run.
});
