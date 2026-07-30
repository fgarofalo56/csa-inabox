/**
 * kql-escape — the incomplete-sanitization class fix.
 *
 * The breakout tests parse the produced literal with a faithful little
 * scanner: if the escape is wrong (the old quote-only `.replace(/"/g,'\\"')`),
 * an input ending in a backslash re-arms the closing quote and the scanner
 * terminates EARLY — exactly how ADX would, handing the attacker raw KQL.
 */
import { describe, it, expect } from 'vitest';
import {
  kqlEscapeDouble,
  kqlEscapeSingle,
  kqlIdent,
  kqlVerbatimDouble,
  kqlVerbatimSingle,
} from '../kql-escape';

/**
 * Scan a REGULAR KQL literal `q…q` starting at 0; returns the index just past
 * the terminating quote, honoring backslash escapes. Mirrors ADX lexing.
 */
function scanRegularLiteral(lit: string, q: string): number {
  expect(lit[0]).toBe(q);
  for (let i = 1; i < lit.length; i++) {
    if (lit[i] === '\\') { i++; continue; }
    if (lit[i] === q) return i + 1;
  }
  throw new Error('unterminated literal');
}

/** Scan a VERBATIM literal `q…q` (only escape: doubled quote). */
function scanVerbatimLiteral(lit: string, q: string): number {
  expect(lit[0]).toBe(q);
  for (let i = 1; i < lit.length; i++) {
    if (lit[i] === q) {
      if (lit[i + 1] === q) { i++; continue; }
      return i + 1;
    }
  }
  throw new Error('unterminated literal');
}

const HOSTILE = [
  'plain',
  'tráiling backslash \\',
  '\\',
  '\\\\',
  'quote " inside',
  "single ' inside",
  'both \\" mixed \\\' end\\',
  'a\\', // the classic: old escape produced "a\\" → quote LIVE
  'x"; evil | take 999 //',
  "x'; evil | take 999 //",
];

describe('kqlEscapeDouble / kqlEscapeSingle — literal can never be broken out of', () => {
  it('the closing quote always terminates the literal (no early exit)', () => {
    for (const v of HOSTILE) {
      const dbl = `"${kqlEscapeDouble(v)}"`;
      expect(scanRegularLiteral(dbl, '"')).toBe(dbl.length);
      const sgl = `'${kqlEscapeSingle(v)}'`;
      expect(scanRegularLiteral(sgl, "'")).toBe(sgl.length);
    }
  });

  it('escapes backslash BEFORE the quote (the incomplete-sanitization bug)', () => {
    expect(kqlEscapeDouble('a\\')).toBe('a\\\\');
    expect(kqlEscapeDouble('a"b')).toBe('a\\"b');
    expect(kqlEscapeDouble('a\\"b')).toBe('a\\\\\\"b');
    expect(kqlEscapeSingle("a'b")).toBe("a\\'b");
    expect(kqlEscapeSingle('a\\')).toBe('a\\\\');
  });

  it('encodes CR/LF (raw line breaks terminate a KQL literal)', () => {
    expect(kqlEscapeDouble('a\nb')).toBe('a\\nb');
    expect(kqlEscapeDouble('a\r\nb')).toBe('a\\r\\nb');
  });

  it('kqlIdent bracket-quotes with the full escape', () => {
    expect(kqlIdent('Raw Events')).toBe('["Raw Events"]');
    const lit = kqlIdent('evil\\');
    expect(lit.startsWith('["')).toBe(true);
    expect(scanRegularLiteral(lit.slice(1, -1), '"')).toBe(lit.length - 2);
  });
});

describe('kqlVerbatimSingle / kqlVerbatimDouble — @-literal rules (quote DOUBLING)', () => {
  it('the closing quote always terminates the verbatim literal', () => {
    for (const v of HOSTILE) {
      const sgl = `'${kqlVerbatimSingle(v)}'`;
      expect(scanVerbatimLiteral(sgl, "'")).toBe(sgl.length);
      const dbl = `"${kqlVerbatimDouble(v)}"`;
      expect(scanVerbatimLiteral(dbl, '"')).toBe(dbl.length);
    }
  });

  it('doubles the quote and leaves backslash ALONE (backslash is plain in @"…")', () => {
    expect(kqlVerbatimSingle("it's")).toBe("it''s");
    expect(kqlVerbatimSingle('c:\\path\\')).toBe('c:\\path\\');
    expect(kqlVerbatimDouble('say "hi"')).toBe('say ""hi""');
    expect(kqlVerbatimDouble('regex \\d+ ok')).toBe('regex \\d+ ok');
  });

  it('strips CR/LF (not representable inside a verbatim literal)', () => {
    expect(kqlVerbatimSingle("a\r\nb'c")).toBe("ab''c");
  });

  /**
   * HARNESS SELF-CHECK (not a fix assertion — it passes with or without the
   * fix, on purpose). The other tests in this file prove safety by asserting
   * the scanner reaches the END of the literal; that assertion is only
   * meaningful if the scanner can actually FAIL. So feed it the exact byte
   * sequence the old code emitted and prove it exits early.
   *
   * The bad sequence is written as DATA, not produced by a live
   * `.replace(/"/g, '\\"')` call — a deliberately-broken escaper in source is
   * itself reported as js/incomplete-sanitization (alert #721 on the first
   * revision of this PR), and suppressing that with a dismissal would be
   * silencing a scanner instead of removing the pattern.
   */
  it('HARNESS: the scanner exits early on a live quote (backslash-escaped `"`)', () => {
    // data-quality-client used to render `@"${pat}"` with pat = 'x" | evil' as:
    //   "x\" | evil"        <- `\` is a PLAIN char in a verbatim literal, so
    //                          the quote at index 3 terminates the string and
    //                          ` | evil"` parsed as raw KQL.
    const broken = '"x\\" | evil"';
    expect(scanVerbatimLiteral(broken, '"')).toBe(4);
    expect(scanVerbatimLiteral(broken, '"')).toBeLessThan(broken.length);
    // …and the fixed escaper on the same input terminates at the very end.
    const fixed = `"${kqlVerbatimDouble('x" | evil')}"`;
    expect(scanVerbatimLiteral(fixed, '"')).toBe(fixed.length);
  });
});
