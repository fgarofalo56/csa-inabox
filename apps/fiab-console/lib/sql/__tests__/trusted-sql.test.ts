/**
 * Adversarial + invariant tests for `lib/sql/trusted-sql.ts` — the type that
 * makes `azure-sql-client.executeParameterized` safe by construction
 * (CodeQL js/sql-injection #789).
 *
 * WHY THESE TESTS AND NOT A TYPE TEST.
 *
 *   The load-bearing guarantee of that module is a COMPILE-TIME one: a raw
 *   `string` cannot reach `request.query()`. `tsc -p tsconfig.build.json` is
 *   what enforces it, and it is already a merge gate — a vitest suite cannot
 *   observe it and should not pretend to. (The brand not collapsing to `string`
 *   IS pinned, as a type-level assertion inside the module itself, so the same
 *   tsc gate catches it.)
 *
 *   What vitest CAN prove is the other half: that each constructor's RUNTIME
 *   invariant actually holds. A branded type is only as good as the function
 *   that mints the brand — `quotedIdentifier` that failed to double a `]`, or
 *   `integerLiteral` that emitted `1e21`, would hand out a token the compiler
 *   trusts and the parser does not. That is the failure mode these tests cover,
 *   and each asserts a BREAKOUT ATTEMPT stays inside its syntactic position.
 */
import { describe, it, expect } from 'vitest';
import {
  tsql,
  sqlFragment,
  quotedIdentifier,
  quotedName,
  integerLiteral,
  containedCheckExpression,
  joinFragments,
  commaSeparated,
  sqlWithNoContainmentGuarantee,
  UntrustedSqlError,
} from '../trusted-sql';

// ---------------------------------------------------------------------------
// The template constructors — literal spans are source text, fragments weave in
// order. An off-by-one here would silently drop or duplicate a span.
// ---------------------------------------------------------------------------

describe('tsql / sqlFragment — weaving', () => {
  it('a zero-interpolation template is the literal, byte for byte', () => {
    expect(tsql`SELECT 1;`).toBe('SELECT 1;');
    expect(sqlFragment`NONCLUSTERED`).toBe('NONCLUSTERED');
  });

  it('interleaves every literal span with every fragment, in order', () => {
    const a = sqlFragment`A`;
    const b = sqlFragment`B`;
    expect(tsql`<${a}|${b}>`).toBe('<A|B>');
  });

  it('preserves a leading and a trailing fragment position', () => {
    expect(tsql`${sqlFragment`X`} mid ${sqlFragment`Y`}`).toBe('X mid Y');
  });

  it('composes fragments into fragments without losing text', () => {
    const inner = sqlFragment`${quotedIdentifier('Total')} > 0`;
    expect(tsql`CHECK (${inner});`).toBe('CHECK ([Total] > 0);');
  });
});

// ---------------------------------------------------------------------------
// Identifiers — the containment claim is TOTAL: any input becomes exactly one
// delimited token. These are the payloads that motivated #789.
// ---------------------------------------------------------------------------

describe('quotedIdentifier — breakout attempts stay one token', () => {
  it('wraps and doubles every "]" (delegating to lib/sql/quoting)', () => {
    expect(quotedIdentifier('Orders')).toBe('[Orders]');
    expect(quotedIdentifier('we]ird')).toBe('[we]]ird]');
  });

  it('a statement-chaining payload cannot end the identifier', () => {
    const out = quotedIdentifier('x] ; DROP TABLE Orders --');
    expect(out).toBe('[x]] ; DROP TABLE Orders --]');
    // Exactly one closing bracket — the one this function added.
    expect(out.slice(1, -1).replace(/]]/g, '')).not.toContain(']');
  });

  it('quotes and contains characters that are syntax outside a bracket', () => {
    for (const hostile of ["';--", ') OR 1=1 --', '*/', 'a\nb']) {
      expect(quotedIdentifier(hostile)).toBe(`[${hostile}]`);
    }
  });
});

describe('quotedName — dotted paths', () => {
  it('brackets every part and joins with source-text dots', () => {
    expect(quotedName('dbo', 'Orders')).toBe('[dbo].[Orders]');
    expect(quotedName('db', 'dbo', 'Orders')).toBe('[db].[dbo].[Orders]');
  });

  it('a dot inside a part cannot split the path', () => {
    expect(quotedName('dbo', 'a.b')).toBe('[dbo].[a.b]');
  });

  it('refuses an empty path rather than emitting nothing', () => {
    expect(() => quotedName()).toThrow(UntrustedSqlError);
  });
});

// ---------------------------------------------------------------------------
// Integer literals — the whole claim is "the rendering contains only `-` and
// digits". Anything that stringifies otherwise must throw, not be emitted.
// ---------------------------------------------------------------------------

describe('integerLiteral', () => {
  it('renders exact integers, including negatives and zero', () => {
    expect(integerLiteral(0)).toBe('0');
    expect(integerLiteral(5000)).toBe('5000');
    expect(integerLiteral(-7)).toBe('-7');
  });

  it('renders a bigint (the change-tracking version case)', () => {
    expect(integerLiteral(9007199254740993n)).toBe('9007199254740993');
  });

  it('emits only "-" and digits, for every accepted value', () => {
    for (const v of [0, 1, 42, -42, Number.MAX_SAFE_INTEGER]) {
      expect(integerLiteral(v)).toMatch(/^-?\d+$/);
    }
  });

  it('throws rather than emit a value that is not a numeric literal', () => {
    // 1e21 stringifies to "1e+21" and NaN/Infinity to words — each would be
    // spliced into the statement as text the parser rejects (or worse, reads).
    for (const bad of [1.5, NaN, Infinity, -Infinity, 1e21, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => integerLiteral(bad)).toThrow(UntrustedSqlError);
    }
  });
});

// ---------------------------------------------------------------------------
// The CHECK expression — the one free-text fragment. Containment is proven by
// lib/sql/check-expression; this asserts the CONSTRUCTOR refuses rather than
// mints a brand for a rejected expression.
// ---------------------------------------------------------------------------

describe('containedCheckExpression', () => {
  it('passes a legitimate expression through unchanged', () => {
    expect(containedCheckExpression('[Total] > 0')).toBe('[Total] > 0');
    expect(containedCheckExpression("[Owner's Name] <> ''")).toBe("[Owner's Name] <> ''");
  });

  it('refuses the exact #789 payload', () => {
    expect(() => containedCheckExpression('1=1); DROP TABLE Orders; --')).toThrow(UntrustedSqlError);
  });

  it('refuses the delimited-identifier desync payloads', () => {
    expect(() => containedCheckExpression("[c'] OR 1=1) DROP TABLE Orders --'")).toThrow(UntrustedSqlError);
    expect(() => containedCheckExpression("[a'] ) DROP TABLE Orders [b']")).toThrow(UntrustedSqlError);
  });

  it('refuses statement terminators, comments, and unbalanced parens', () => {
    for (const bad of ['1=1;', '1=1 --x', '1=1 /*x', '1=1)', '([Total] > 0']) {
      expect(() => containedCheckExpression(bad)).toThrow(UntrustedSqlError);
    }
  });

  it('carries the validator\'s own message so the caller can surface it', () => {
    expect(() => containedCheckExpression('1=1;')).toThrow(/statement terminator/);
  });
});

// ---------------------------------------------------------------------------
// Joins — the separator is itself a fragment, so no caller text can become one.
// ---------------------------------------------------------------------------

describe('joinFragments / commaSeparated', () => {
  it('joins with the given fragment separator', () => {
    const cols = [quotedIdentifier('A'), quotedIdentifier('B')];
    expect(joinFragments(cols, sqlFragment` AND `)).toBe('[A] AND [B]');
  });

  it('commaSeparated matches the ", " every column list used before', () => {
    expect(commaSeparated([quotedIdentifier('A'), quotedIdentifier('B')])).toBe('[A], [B]');
  });

  it('a single-element and an empty list are stable', () => {
    expect(commaSeparated([quotedIdentifier('A')])).toBe('[A]');
    expect(commaSeparated([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The escape hatch — it must be honest. If it ever started sanitising, callers
// would come to rely on a guarantee its own name disclaims.
// ---------------------------------------------------------------------------

describe('sqlWithNoContainmentGuarantee', () => {
  it('returns the statement verbatim — it filters NOTHING, by design', () => {
    const hostile = "SELECT 1; DROP TABLE Orders; --";
    expect(sqlWithNoContainmentGuarantee(hostile, 'report-visual-compiler')).toBe(hostile);
  });

  it('requires a named surface', () => {
    expect(() => sqlWithNoContainmentGuarantee('SELECT 1', '' as 'report-visual-compiler'))
      .toThrow(UntrustedSqlError);
  });
});
