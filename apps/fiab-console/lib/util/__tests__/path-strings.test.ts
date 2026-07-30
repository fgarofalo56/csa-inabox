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
    const time = (n: number) => {
      const s = hostile(n);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) stripTrailingSlashes(s);
      return performance.now() - t0;
    };
    time(10_000); // warm
    const small = Math.max(time(50_000), 0.01);
    const large = time(200_000);
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
