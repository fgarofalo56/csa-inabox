/**
 * Per-engine string-literal escaping (lib/sql/quoting.ts).
 *
 * `escapeSqlLiteral` doubles the quote: the T-SQL / ANSI / OData / DAX rule.
 * Databricks / Spark SQL and KQL read a regular single-quoted literal with
 * BACKSLASH escapes instead, so they get their own helpers:
 * `escapeSparkSqlLiteral` and `escapeKqlLiteral`.
 *
 * The oracle below is a small reader for the backslash grammar, written from
 * the two Learn pages cited in quoting.ts, NOT from the helper under test:
 *   - `\<c>` yields the mapped control for n/t/r/0, else `<c>` itself;
 *   - an unescaped `'` ends the literal.
 * Each round-trip test asserts two things. The literal ends at its LAST
 * character, so the whole value stayed inside one literal. And the reader gives
 * back exactly the input. Every test names the input that would turn it red.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeSqlLiteral,
  escapeSparkSqlLiteral,
  escapeKqlLiteral,
  escapeLiteralFor,
  quoteLiteral,
  LiteralEscapeError,
} from '../quoting';

/** Read one backslash-grammar literal starting at `lit[0] === "'"`. */
function readBackslashLiteral(lit: string): { value: string; end: number } {
  expect(lit[0]).toBe("'");
  let out = '';
  for (let i = 1; i < lit.length; i++) {
    const c = lit[i];
    if (c === '\\') {
      const n = lit[++i];
      if (n === undefined) break; // dangling escape: unterminated
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n;
      continue;
    }
    if (c === "'") return { value: out, end: i };
    out += c;
  }
  return { value: out, end: -1 }; // no closing quote
}

const HELPERS = [
  ['escapeSparkSqlLiteral', escapeSparkSqlLiteral],
  ['escapeKqlLiteral', escapeKqlLiteral],
] as const;

describe.each(HELPERS)('%s', (_name, escape) => {
  const roundTrip = (v: string) => {
    const lit = `'${escape(v)}'`;
    const r = readBackslashLiteral(lit);
    return { lit, ...r };
  };

  it('backslash-quote pair: the two characters \\\' stay inside the literal', () => {
    // Breaks if the backslash is NOT escaped: `'\\''` reads as `\` and then
    // closes at offset 3, so end !== lit.length - 1.
    const v = "\\'";
    expect(escape(v)).toBe("\\\\\\'");
    const r = roundTrip(v);
    expect(r.end).toBe(r.lit.length - 1);
    expect(r.value).toBe(v);
  });

  it('trailing backslash does not consume the closing quote', () => {
    // Breaks if the backslash is NOT escaped: `'abc\'` never closes (end === -1).
    const v = 'abc\\';
    expect(escape(v)).toBe('abc\\\\');
    const r = roundTrip(v);
    expect(r.end).toBe(r.lit.length - 1);
    expect(r.value).toBe(v);
  });

  it('lone quote is backslash-escaped, not doubled', () => {
    // Breaks under quote DOUBLING: `''''` closes at offset 1, so the value is
    // '' and end !== 3. Also breaks if the quote is escaped BEFORE the backslash
    // (`\'` becomes `\\'`, which closes early).
    const v = "'";
    expect(escape(v)).toBe("\\'");
    const r = roundTrip(v);
    expect(r.end).toBe(r.lit.length - 1);
    expect(r.value).toBe(v);
  });

  it('backslash-n (two characters) stays two characters, not a newline', () => {
    // Breaks if the backslash is NOT escaped: the engine reads `\n` as U+000A.
    const v = '\\n';
    expect(v).toHaveLength(2);
    expect(escape(v)).toBe('\\\\n');
    expect(roundTrip(v).value).toBe(v);
  });

  it('an ordinary value round-trips byte-for-byte unchanged', () => {
    // Breaks if the helper touches characters outside \ ' TAB LF CR.
    const v = 'sales_2024-Q1 "net" (EUR) @ 5% / region=West';
    expect(escape(v)).toBe(v);
    expect(roundTrip(v).value).toBe(v);
  });

  it('TAB / LF / CR are carried as escape sequences', () => {
    // Breaks if any of the three is emitted raw or dropped.
    const v = 'a\tb\nc\rd';
    expect(escape(v)).toBe('a\\tb\\nc\\rd');
    expect(roundTrip(v).value).toBe(v);
  });

  it.each([
    [0x00, 'a\u0000b', 1],
    [0x1b, '\u001b[0m', 0],
    [0x7f, 'xy\u007f', 2],
    [0x0b, 'v\u000btab', 1],
  ])('refuses control character U+%s with a typed error', (cp, v, index) => {
    // Breaks if the value is escaped instead of refused, or if the error
    // loses its type or its code point / offset.
    let caught: unknown;
    try { escape(v); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LiteralEscapeError);
    const e = caught as LiteralEscapeError;
    expect(e.codePoint).toBe(cp);
    expect(e.index).toBe(index);
    // The message names the code point, never the value itself.
    expect(e.message).toContain(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    expect(e.message).not.toContain(v);
  });
});

describe('engine tag on LiteralEscapeError', () => {
  it('names the engine that refused the value', () => {
    // Breaks if the two helpers share one hard-coded engine label.
    expect(() => escapeSparkSqlLiteral('\u0000')).toThrow(/spark-sql string literal/);
    expect(() => escapeKqlLiteral('\u0000')).toThrow(/kql string literal/);
  });
});

describe('escapeSqlLiteral is unchanged (T-SQL / ANSI doubling)', () => {
  it('doubles the quote and leaves the backslash and control characters alone', () => {
    // Breaks if the T-SQL helper were switched to the backslash rule. T-SQL
    // has no backslash escape, so `\\` inside the literal would be two
    // characters of data.
    expect(escapeSqlLiteral("a'b\\c\u0000")).toBe("a''b\\c\u0000");
  });
});

describe('dialect-aware quoteLiteral / escapeLiteralFor', () => {
  const v = "it's C:\\tmp";

  it('databricks-sql uses the Spark rule', () => {
    // Breaks if the databricks-sql branch falls back to doubling: the result
    // would be 'it''s C:\\tmp', which Spark reads as `its C:<TAB>mp`.
    expect(quoteLiteral(v, 'databricks-sql')).toBe("'it\\'s C:\\\\tmp'");
    expect(escapeLiteralFor(v, 'databricks-sql')).toBe("it\\'s C:\\\\tmp");
    expect(readBackslashLiteral(quoteLiteral(v, 'databricks-sql')).value).toBe(v);
  });

  it.each([
    ['tsql', "N'it''s C:\\tmp'"],
    ['synapse', "N'it''s C:\\tmp'"],
    ['postgres', "'it''s C:\\tmp'"],
    ['trino', "'it''s C:\\tmp'"],
    [undefined, "'it''s C:\\tmp'"],
  ] as const)('%s keeps quote doubling', (dialect, expected) => {
    // Breaks if the Spark rule leaks into a doubling dialect.
    expect(quoteLiteral(v, dialect)).toBe(expected);
  });

  it('databricks-sql refuses NUL; tsql still carries it (unchanged)', () => {
    // Breaks if quoteLiteral('databricks-sql') does not go through escapeSparkSqlLiteral.
    expect(() => quoteLiteral('a\u0000', 'databricks-sql')).toThrow(LiteralEscapeError);
    expect(quoteLiteral('a\u0000', 'tsql')).toBe("N'a\u0000'");
  });

  it('non-string scalars are unchanged by dialect', () => {
    expect(quoteLiteral(null, 'databricks-sql')).toBe('NULL');
    expect(quoteLiteral(42, 'databricks-sql')).toBe('42');
    expect(quoteLiteral(true, 'databricks-sql')).toBe('1');
  });
});
