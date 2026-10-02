/**
 * Per-engine string-literal escaping (lib/sql/quoting.ts).
 *
 * `escapeSqlLiteral` doubles the quote: the T-SQL / ANSI / OData / DAX rule.
 * Databricks / Spark SQL and KQL read a regular single-quoted literal with
 * BACKSLASH escapes instead, so they get their own helpers:
 * `escapeSparkSqlLiteral` and `escapeKqlLiteral`. Neither throws: every
 * character, control characters included, is carried.
 *
 * THE ORACLES are ports of each engine's own decoder, NOT of the helper under
 * test. They are TRANSCRIBED (TypeScript cannot import Scala or C#), so each
 * one carries positive controls below that pin its non-obvious branches — a
 * port that silently dropped the octal or `\%` branch would make the round-trip
 * tests blind to exactly the cases they exist for.
 *
 *   sparkUnescape  ← SparkParserUtils.unescapeSQLString, apache/spark
 *     sql/api/src/main/scala/org/apache/spark/sql/catalyst/util/SparkParserUtils.scala
 *     (blob ee296a6fb664e80f9fde5e0d0042f1a6fceee89b, read 2026-09-30).
 *   kqlDecode      ← KustoFacts.GetStringLiteralValue + DecodeEscapes,
 *     microsoft/Kusto-Query-Language src/Kusto.Language/KustoFacts.cs
 *     (blob of the copy read on 2026-09-30: ec8e0b97094ca16bba08f99d16b9b0906c94ef2e).
 *
 * The decoders take the whole token. Where the token ENDS is the lexer's job:
 * `lexEnd` below applies the shared rule of both lexers for a regular
 * single-quoted literal — a backslash takes the next character, an unescaped
 * quote ends the literal. (Spark's decoder also folds `''`; the helpers never
 * emit an unescaped quote, so that branch is not reached here.)
 *
 * Each round-trip asserts two things: the literal ends at its LAST character
 * (the whole value stayed inside one literal), and the engine's decoder gives
 * back exactly the input. Every test names the input that would turn it red.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeSqlLiteral,
  escapeSparkSqlLiteral,
  escapeKqlLiteral,
  escapeLiteralFor,
  quoteLiteral,
} from '../quoting';

/** Offset of the quote that closes the literal opened at lit[0], or -1. */
function lexEnd(lit: string): number {
  expect(lit[0]).toBe("'");
  for (let i = 1; i < lit.length; i++) {
    if (lit[i] === '\\') { i++; continue; }
    if (lit[i] === "'") return i;
  }
  return -1;
}

/** Port of SparkParserUtils.unescapeSQLString for a single-quoted token. */
function sparkUnescape(b: string): string {
  const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
  const allHex = (s: string, start: number, n: number) => {
    for (let k = start; k < start + n; k++) if (!isHex(s[k])) return false;
    return true;
  };
  const octal3 = (s: string, start: number) =>
    (s[start] === '0' || s[start] === '1') && /[0-7]/.test(s[start + 1]) && /[0-7]/.test(s[start + 2]);
  const appendEscaped = (n: string): string => {
    switch (n) {
      case '0': return '\u0000';
      case 'b': return '\b';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'Z': return '\u001A';
      case '%': return '\\%';
      case '_': return '\\_';
      default: return n;
    }
  };
  if (b.indexOf('\\') === -1 && b.indexOf("''") === -1) return b.substring(1, b.length - 1);
  let out = '';
  let i = 1;
  const length = b.length - 1;
  while (i < length) {
    const c = b[i];
    if (c === "'" && i + 1 < length && b[i + 1] === "'") {
      out += "'";
      i += 2;
    } else if (c !== '\\' || i + 1 === length) {
      out += c;
      i += 1;
    } else {
      i += 1;
      const n = b[i];
      if (n === 'u' && i + 1 + 4 <= length && allHex(b, i + 1, 4)) {
        out += String.fromCharCode(parseInt(b.substring(i + 1, i + 5), 16));
        i += 5;
      } else if (n === 'U' && i + 1 + 8 <= length && allHex(b, i + 1, 8)) {
        out += String.fromCodePoint(parseInt(b.substring(i + 1, i + 9), 16));
        i += 9;
      } else if (i + 3 <= length && octal3(b, i)) {
        out += String.fromCharCode(parseInt(b.substring(i, i + 3), 8));
        i += 3;
      } else {
        out += appendEscaped(n);
        i += 1;
      }
    }
  }
  return out;
}

/** Port of KustoFacts.GetStringLiteralValue (regular `'…'` path) + DecodeEscapes. */
function kqlDecode(literal: string): string {
  const start = 1;
  let end = literal.length;
  if (literal[end - 1] === "'") end--;
  if (end <= start) return '';
  if (literal.indexOf('\\', start) < start) return literal.substring(start, end);
  const hex = (n: number, at: { i: number }) => {
    let v = 0;
    for (let k = 0; k < n && at.i < literal.length; k++, at.i++) {
      const ch = literal[at.i];
      if (/[0-9a-fA-F]/.test(ch)) v = (v << 4) + parseInt(ch, 16);
      else break;
    }
    return v;
  };
  const oct = (at: { i: number }) => {
    let v = 0;
    for (let k = 0; k < 3 && at.i < literal.length && /[0-9]/.test(literal[at.i]); k++, at.i++) {
      v = (v << 3) + (literal.charCodeAt(at.i) - 48);
    }
    return v;
  };
  let out = '';
  const at = { i: start };
  while (at.i < end) {
    const ch = literal[at.i];
    if (ch === '\\' && at.i + 1 < end) {
      const ch2 = literal[at.i + 1];
      const simple: Record<string, string> = {
        "'": "'", '"': '"', '\\': '\\', a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
      };
      if (ch2 in simple) { out += simple[ch2]; at.i += 2; }
      else if (ch2 === 'u') { at.i += 2; out += String.fromCharCode(hex(4, at)); }
      else if (ch2 === 'U') { at.i += 2; out += String.fromCodePoint(hex(8, at)); }
      else if (ch2 === 'x') { at.i += 2; out += String.fromCharCode(hex(2, at)); }
      else if (/[0-9]/.test(ch2)) { at.i += 1; out += String.fromCharCode(oct(at)); }
      else { out += ch2; at.i += 2; }
    } else {
      out += ch;
      at.i += 1;
    }
  }
  return out;
}

describe('the decoder ports read their engines\' non-obvious escapes (positive controls)', () => {
  it('Spark: three-digit octal, \\u / \\U, \\Z, \\% and \\_ (backslash kept), \\<other> → other', () => {
    // Breaks if the port loses the octal branch (`\012` would read as NUL + "12"),
    // the \u branch, or the MySQL-style `\%` / `\_` rule.
    expect(sparkUnescape("'\\012'")).toBe('\n');
    expect(sparkUnescape("'\\0'")).toBe('\u0000');
    expect(sparkUnescape("'\\u0041\\U0001F600'")).toBe('A\u{1F600}');
    expect(sparkUnescape("'\\Z'")).toBe('\u001A');
    expect(sparkUnescape("'50\\%'")).toBe('50\\%');
    expect(sparkUnescape("'a\\_b'")).toBe('a\\_b');
    expect(sparkUnescape("'\\q'")).toBe('q');
    expect(sparkUnescape("'a''b'")).toBe("a'b");
  });

  it('KQL: \\uXXXX, \\x, octal, \\f / \\v, \\<other> → other', () => {
    // Breaks if the port loses the \u branch (every control-character round trip
    // below depends on it) or the octal / \x branches.
    expect(kqlDecode("'\\u001B\\u007F'")).toBe('\u001b\u007f');
    expect(kqlDecode("'\\x41\\101'")).toBe('AA');
    expect(kqlDecode("'\\f\\v\\a'")).toBe('\f\v\u0007');
    expect(kqlDecode("'\\q'")).toBe('q');
  });
});

const ENGINES = [
  ['escapeSparkSqlLiteral', escapeSparkSqlLiteral, sparkUnescape],
  ['escapeKqlLiteral', escapeKqlLiteral, kqlDecode],
] as const;

describe.each(ENGINES)('%s', (_name, escape, decode) => {
  const roundTrip = (v: string) => {
    const lit = `'${escape(v)}'`;
    return { lit, end: lexEnd(lit), value: decode(lit) };
  };
  const expectRoundTrip = (v: string) => {
    const r = roundTrip(v);
    expect(r.end, `literal for ${JSON.stringify(v)} closes early or never`).toBe(r.lit.length - 1);
    expect(r.value).toBe(v);
  };

  it('backslash-quote pair: the two characters \\\' stay inside the literal', () => {
    // Breaks if the backslash is NOT escaped: `'\\''` reads as `\` and then
    // closes at offset 3, so end !== lit.length - 1.
    const v = "\\'";
    expect(escape(v)).toBe("\\\\\\'");
    expectRoundTrip(v);
  });

  it('trailing backslash does not consume the closing quote', () => {
    // Breaks if the backslash is NOT escaped: `'abc\'` never closes (end === -1).
    const v = 'abc\\';
    expect(escape(v)).toBe('abc\\\\');
    expectRoundTrip(v);
  });

  it('lone quote is backslash-escaped, not doubled', () => {
    // Breaks under quote DOUBLING: `''''` closes at offset 1. Also breaks if the
    // quote is escaped BEFORE the backslash (`\'` becomes `\\'`, which closes early).
    const v = "'";
    expect(escape(v)).toBe("\\'");
    expectRoundTrip(v);
  });

  it('backslash-n (two characters) stays two characters, not a newline', () => {
    // Breaks if the backslash is NOT escaped: the engine reads `\n` as U+000A.
    const v = '\\n';
    expect(v).toHaveLength(2);
    expect(escape(v)).toBe('\\\\n');
    expectRoundTrip(v);
  });

  it('backslash-percent and backslash-underscore survive (Spark keeps the backslash on \\% / \\_)', () => {
    // Input is the three characters `5`, `\`, `%`. Breaks if the backslash is not
    // escaped: Spark would read `\%` as `\%` (by luck the same) but KQL would read
    // it as `%`; and for `\_x`, an unescaped backslash drops in KQL. Escaping the
    // backslash makes both engines give back the input exactly.
    for (const v of ['5\\%', 'a\\_b', '%_']) {
      expectRoundTrip(v);
    }
    expect(escape('%_')).toBe('%_');
  });

  it('an ordinary value round-trips byte-for-byte unchanged', () => {
    // Breaks if the helper touches characters outside \ ' and control characters.
    const v = 'sales_2024-Q1 "net" (EUR) @ 5% / region=West';
    expect(escape(v)).toBe(v);
    expectRoundTrip(v);
  });

  it('non-ASCII, including a non-BMP character, is passed raw and round-trips', () => {
    // Breaks if the helper encodes or drops characters above U+007F, or splits a
    // surrogate pair.
    for (const v of ['서울시', 'café — naïve', 'x\u{1F600}y']) {
      expect(escape(v)).toBe(v);
      expectRoundTrip(v);
    }
  });

  it('TAB / LF are carried as escape sequences; CR per engine', () => {
    // Breaks if TAB or LF is emitted raw or dropped. CR: Spark writes the
    // documented `\r`; KQL writes the `\u` form, because the KQL string page
    // lists `\t`, `\n`, `\\` and the quote as the regular-literal escapes and
    // mentions `\r` only in its notes. Breaks if either engine's CR changes.
    const v = 'a\tb\nc\rd';
    const cr = _name === 'escapeKqlLiteral' ? '\\u000D' : '\\r';
    expect(escape(v)).toBe(`a\\tb\\nc${cr}d`);
    expectRoundTrip(v);
  });

  it('every C0 control character and DEL is carried, never refused', () => {
    // 33 code points, each alone, embedded, and followed by two octal digits
    // ("12") and by "u0041" (so an encoder that wrote a bare `\0` or a short hex
    // run would merge with what follows). Breaks if any helper throws, drops the
    // character, or emits a form its engine reads differently.
    const cps = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];
    expect(cps).toHaveLength(33);
    for (const cp of cps) {
      const c = String.fromCharCode(cp);
      for (const v of [c, `a${c}b`, `${c}12`, `${c}u0041`, `${c}${c}`]) {
        expect(() => escape(v)).not.toThrow();
        expectRoundTrip(v);
      }
    }
  });

  it('NUL followed by two octal digits does not merge into one octal escape', () => {
    // The Spark-specific case: `\0` + "12" is the octal escape `\012` (LF). Breaks
    // if escapeSparkSqlLiteral writes `\0` unconditionally — sparkUnescape then
    // returns "\n" (asserted as the decoder's control above), not NUL + "12".
    const v = '\u000012';
    expectRoundTrip(v);
    expect(decode(`'${escape(v)}'`)).not.toBe('\n');
  });
});

describe('encoded shape per engine', () => {
  it('Spark: NUL → \\0 (or \\u0000 before two octal digits); other controls raw', () => {
    // Breaks if NUL is passed raw, if the octal look-ahead is dropped, or if the
    // Spark helper starts \u-encoding the other controls (pins the documented
    // "any Unicode character" reading).
    expect(escapeSparkSqlLiteral('a\u0000b')).toBe('a\\0b');
    expect(escapeSparkSqlLiteral('\u000012')).toBe('\\u000012');
    expect(escapeSparkSqlLiteral('\u00001x')).toBe('\\01x');
    expect(escapeSparkSqlLiteral('\u000c\u001b\u007f')).toBe('\u000c\u001b\u007f');
  });

  it('KQL: other C0 controls and DEL → \\uXXXX (upper-case hex)', () => {
    // Breaks if a control character is passed raw or with a short escape the
    // KQL decoder would read differently.
    expect(escapeKqlLiteral('\u0000\u000c\u001b\u007f')).toBe('\\u0000\\u000C\\u001B\\u007F');
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
    // would be 'it''s C:\\tmp', which Spark reads as `it's C:<TAB>mp`.
    expect(quoteLiteral(v, 'databricks-sql')).toBe("'it\\'s C:\\\\tmp'");
    expect(escapeLiteralFor(v, 'databricks-sql')).toBe("it\\'s C:\\\\tmp");
    expect(sparkUnescape(quoteLiteral(v, 'databricks-sql'))).toBe(v);
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

  it('databricks-sql encodes NUL as \\0; tsql still carries it raw (unchanged)', () => {
    // Breaks if quoteLiteral('databricks-sql') does not go through escapeSparkSqlLiteral.
    expect(quoteLiteral('a\u0000', 'databricks-sql')).toBe("'a\\0'");
    expect(quoteLiteral('a\u0000', 'tsql')).toBe("N'a\u0000'");
  });

  it('non-string scalars are unchanged by dialect', () => {
    expect(quoteLiteral(null, 'databricks-sql')).toBe('NULL');
    expect(quoteLiteral(42, 'databricks-sql')).toBe('42');
    expect(quoteLiteral(true, 'databricks-sql')).toBe('1');
  });
});
