/**
 * trim — linear char-run trimming (CodeQL js/polynomial-redos class fix).
 *
 * The timing tests are the regression guard: with the old `/\/+$/`-style
 * regexes these inputs took seconds (quadratic backtracking); the linear
 * helpers finish in microseconds. Bound generous (<1s) to survive CI noise,
 * same shape as the FOCUS fingerprinter regression in focus-mart.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  slugify,
  trimChar,
  trimCharEnd,
  trimCharStart,
  trimEdges,
  trimLeadingSlashes,
  trimSlashes,
  trimTrailingSlashes,
} from '../trim';

describe('trim helpers — behavior parity with the regexes they replaced', () => {
  it('trimTrailingSlashes matches replace(/\\/+$/, "")', () => {
    for (const s of ['', '/', '///', 'a', 'a/', 'a///', '/a/b//', 'a/b', '//a//b//']) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''));
    }
  });

  it('trimLeadingSlashes matches replace(/^\\/+/, "")', () => {
    for (const s of ['', '/', '///', 'a', '/a', '///a/b/', 'a/b']) {
      expect(trimLeadingSlashes(s)).toBe(s.replace(/^\/+/, ''));
    }
  });

  it('trimSlashes matches replace(/^\\/+|\\/+$/g, "")', () => {
    for (const s of ['', '/', '///', 'a', '/a/', '///a/b///', 'a/b', '/a//b/']) {
      expect(trimSlashes(s)).toBe(s.replace(/^\/+|\/+$/g, ''));
    }
  });

  it('trimChar / trimCharEnd / trimCharStart handle arbitrary characters', () => {
    expect(trimChar('--a-b--', '-')).toBe('a-b');
    expect(trimChar('___x___', '_')).toBe('x');
    expect(trimChar('----', '-')).toBe('');
    expect(trimCharEnd('a;;;', ';')).toBe('a');
    expect(trimCharEnd(';;;a', ';')).toBe(';;;a');
    expect(trimCharStart(';;;a', ';')).toBe('a');
    expect(trimChar('', '-')).toBe('');
  });
});

describe('slugify — behavior parity with the ~75 copy-pasted slugifiers', () => {
  const legacy = (s: string, max: number) =>
    s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);

  it('matches the legacy chain on ordinary input', () => {
    for (const s of ['My API', 'Sales & Finance', '--Leading', 'Trailing--', 'a', '', 'ünïcodé Ítem', 'A-B_C.D']) {
      expect(slugify(s, { max: 80 })).toBe(legacy(s, 80));
    }
  });

  it('respects allow / sep / max / lower / fallback', () => {
    expect(slugify('Raw Events!', { allow: /[^a-z0-9]+/g, max: 60 })).toBe('raw-events');
    expect(slugify('My Table', { allow: /[^A-Z0-9]+/g, sep: '_', lower: false })).toBe('M_T');
    expect(slugify('!!!', { fallback: 'x' })).toBe('x');
    expect(slugify(null, { fallback: 'x' })).toBe('x');
  });

  it('re-trims after the slice so a truncation cannot leave a trailing separator', () => {
    // legacy sliced AFTER trimming, so `ab-cd` @max=3 → 'ab-' (trailing sep).
    expect(slugify('ab cd', { max: 3 })).toBe('ab');
  });

  it('trimEdges strips runs of any listed char', () => {
    expect(trimEdges('.-.a-b.-.', '-.')).toBe('a-b');
    expect(trimEdges('---', '-')).toBe('');
    expect(trimEdges('abc', '-')).toBe('abc');
  });

  it('REGRESSION: a 300k separator run returns instantly (legacy chain was quadratic)', () => {
    // The allow-class [^a-z0-9-] PERMITS '-', so the run is NOT collapsed and
    // the legacy `-+$` retried it from every offset. Measured 1.35s at n=50k.
    const hostile = 'a' + '-'.repeat(300_000) + 'b';
    const started = Date.now();
    expect(slugify(hostile, { max: 80 })).toBe('a');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('trim helpers — linear on adversarial runs (ReDoS regression)', () => {
  it('handles 500k-char runs instantly where /X+$/ was quadratic', () => {
    // "/////…x" — the exact pump CodeQL reports: the old regex retried the
    // run at every offset, O(n²). Linear scan must finish immediately.
    const hostile = '/'.repeat(500_000) + 'x';
    const started = Date.now();
    expect(trimTrailingSlashes(hostile)).toBe(hostile); // ends in x — nothing to trim
    expect(trimSlashes(hostile)).toBe(hostile.slice(500_000)); // leading run stripped
    expect(trimCharEnd(';'.repeat(500_000) + 'x', ';')).toMatch(/x$/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
