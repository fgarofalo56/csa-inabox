/**
 * #2660 (js/sql-injection) — adversarial tests for the ONE place SQL escaping lives.
 *
 * WHY THIS FILE MATTERS MORE THAN ANY SINGLE ALERT.
 *
 * All five reported instances are generic query executors:
 *
 *   azure-sql-client   executeQuery / executeParameterized  (request.input('p0', v))
 *   postgres-flex      client.query(st.sql, st.params)
 *   synapse-sql        bindParams(req, parameters)
 *
 * They parameterise VALUES correctly, and the one thing SQL cannot parameterise —
 * an IDENTIFIER — is routed through `lib/sql/quoting.ts`. So the whole class's
 * defence reduces to: is `quoting.ts` correct? If it is, the five alerts are
 * sanitiser-blindness. If it is not, every caller is vulnerable at once.
 *
 * `quoting.ts` exists precisely because this rule was copy-pasted ~70 times and
 * one divergent copy would be a latent hole — and `check-sql-quoting.mjs` stops
 * new copies appearing. But it shipped with NO test of its own. A single audited
 * escape function with no adversarial test is exactly the thing that breaks
 * silently under a well-meant refactor.
 *
 * These tests are the missing proof. Each asserts a BREAKOUT ATTEMPT stays inside
 * one identifier/literal rather than becoming extra SQL.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeSqlLiteral,
  quoteLiteral,
  quoteIdent,
  bracket,
  type SqlDialect,
} from '../quoting';

// ---------------------------------------------------------------------------
// T-SQL identifiers — `]` must be doubled or the bracket closes early.
// ---------------------------------------------------------------------------

describe('quoteIdent / bracket — T-SQL breakout attempts', () => {
  it('the canonical payload cannot close the bracket', () => {
    // Without the `]` → `]]` rule this yields `[x]; DROP TABLE users; --]`,
    // where the bracket closes after `x` and the rest becomes STATEMENTS.
    const out = bracket('x]; DROP TABLE users; --');
    expect(out).toBe('[x]]; DROP TABLE users; --]');
    // Exactly one opening and one *effective* closing delimiter: strip the
    // doubled pairs and only the wrapper brackets remain.
    expect(out.slice(1, -1).replace(/]]/g, '')).not.toContain(']');
  });

  it('an already-bracketed name is escaped, not passed through', () => {
    // `[foo]` must become the identifier literally named `[foo]`.
    expect(bracket('[foo]')).toBe('[[foo]]]');
  });

  it.each([
    ']',
    ']]',
    'a]b]c',
    'tbl] WITH (NOLOCK)) --',
    "]'; EXEC sp_who; --",
  ])('doubles every ] in %j', (name) => {
    const out = bracket(name);
    // Count of `]` inside the wrapper must be even — every one is escaped.
    const inner = out.slice(1, -1);
    expect((inner.match(/]/g) || []).length % 2).toBe(0);
  });

  it('leaves other SQL metacharacters alone (brackets neutralise them)', () => {
    // Inside [] a quote/semicolon/comment is just part of the name. Escaping them
    // too would CORRUPT legitimate identifiers.
    expect(bracket("o'brien")).toBe("[o'brien]");
    expect(bracket('a;b')).toBe('[a;b]');
    expect(bracket('a--b')).toBe('[a--b]');
  });

  it('bracket() and the default quoteIdent() agree', () => {
    for (const n of ['x]; DROP', '[a]', 'plain', ']']) {
      expect(bracket(n)).toBe(quoteIdent(n));
    }
  });

  it.each<SqlDialect>(['tsql', 'synapse', 'generic-sql'])('%s uses bracket quoting', (d) => {
    expect(quoteIdent('x]y', d)).toBe('[x]]y]');
  });
});

// ---------------------------------------------------------------------------
// ANSI (postgres / trino) — `"` must be doubled.
// ---------------------------------------------------------------------------

describe('quoteIdent — postgres / trino breakout attempts', () => {
  it.each<SqlDialect>(['postgres', 'trino'])('%s doubles the double-quote', (d) => {
    expect(quoteIdent('x"; DROP TABLE users; --', d)).toBe('"x""; DROP TABLE users; --"');
  });

  it.each<SqlDialect>(['postgres', 'trino'])('%s does NOT escape ] (wrong delimiter)', (d) => {
    // A ] is harmless in an ANSI-quoted identifier; escaping it would corrupt
    // legitimate names.
    expect(quoteIdent('a]b', d)).toBe('"a]b"');
  });

  it('a T-SQL payload is inert under ANSI quoting', () => {
    expect(quoteIdent('x]; DROP', 'postgres')).toBe('"x]; DROP"');
  });
});

// ---------------------------------------------------------------------------
// MySQL / Databricks — backtick must be doubled.
// ---------------------------------------------------------------------------

describe('quoteIdent — mysql / databricks-sql breakout attempts', () => {
  it.each<SqlDialect>(['mysql', 'databricks-sql'])('%s doubles the backtick', (d) => {
    expect(quoteIdent('x`; DROP TABLE users; --', d)).toBe('`x``; DROP TABLE users; --`');
  });
});

// ---------------------------------------------------------------------------
// String literals — `'` must be doubled.
// ---------------------------------------------------------------------------

describe('escapeSqlLiteral — breakout attempts', () => {
  it("the canonical payload cannot close the literal", () => {
    expect(escapeSqlLiteral("'; DROP TABLE users; --")).toBe("''; DROP TABLE users; --");
  });

  it.each([
    ["o'brien", "o''brien"],
    ["''", "''''"],
    ["a'b'c", "a''b''c"],
    ["' OR '1'='1", "'' OR ''1''=''1"],
  ])('escapes %j -> %j', (input, expected) => {
    expect(escapeSqlLiteral(input)).toBe(expected);
  });

  it('every quote in the output is part of a doubled pair', () => {
    const out = escapeSqlLiteral("a'b''c'''d");
    expect(out.replace(/''/g, '')).not.toContain("'");
  });

  it('does not mangle backslashes (T-SQL has no backslash escape)', () => {
    // Doubling backslashes here would corrupt Windows paths in literals, and
    // T-SQL does not treat \ as an escape, so \' does NOT smuggle a quote.
    expect(escapeSqlLiteral("C:\\tmp\\x")).toBe("C:\\tmp\\x");
    expect(escapeSqlLiteral("\\'")).toBe("\\''");
  });
});

describe('quoteLiteral — wrapping and scalars', () => {
  it('wraps and escapes in one step', () => {
    expect(quoteLiteral("o'brien")).toBe("'o''brien'");
    expect(quoteLiteral("o'brien", 'tsql')).toBe("N'o''brien'");
    expect(quoteLiteral("o'brien", 'synapse')).toBe("N'o''brien'");
  });

  it('a payload cannot escape the wrapper', () => {
    expect(quoteLiteral("'; DROP TABLE users; --", 'tsql')).toBe("N'''; DROP TABLE users; --'");
  });

  it('null / undefined become NULL, not the string "null"', () => {
    expect(quoteLiteral(null)).toBe('NULL');
    expect(quoteLiteral(undefined)).toBe('NULL');
  });

  it('non-finite numbers become NULL rather than an invalid token', () => {
    // 'NaN' / 'Infinity' interpolated raw would be a syntax error at best.
    expect(quoteLiteral(NaN)).toBe('NULL');
    expect(quoteLiteral(Infinity)).toBe('NULL');
    expect(quoteLiteral(-Infinity)).toBe('NULL');
  });

  it('finite numbers and booleans are emitted unquoted', () => {
    expect(quoteLiteral(42)).toBe('42');
    expect(quoteLiteral(-1.5)).toBe('-1.5');
    expect(quoteLiteral(true)).toBe('1');
    expect(quoteLiteral(false)).toBe('0');
  });

  it('a numeric-looking STRING stays quoted', () => {
    // Otherwise "1; DROP" style values could ride in as numbers.
    expect(quoteLiteral('42')).toBe("'42'");
  });
});
