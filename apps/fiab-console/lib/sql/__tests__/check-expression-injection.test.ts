/**
 * #789 (js/sql-injection, HIGH) — adversarial tests for the CHECK-expression
 * containment scan.
 *
 * Companion to `quoting-injection.test.ts`. That file proves the ESCAPING
 * primitives; this one proves the containment scan used where escaping cannot
 * apply — a CHECK-constraint expression, which is SQL by definition and so can
 * be neither bound as a parameter nor quoted.
 *
 * These tests call `validCheckExpression` directly, so every payload is asserted
 * against the grammar itself rather than through a mock. The WIRING half — that
 * `addConstraint` actually consults this BEFORE any DB round-trip, and that no
 * DROP reaches the TDS layer — lives at the call site in
 * `lib/azure/__tests__/sql-constraints-check-injection.test.ts`. Both halves are
 * needed: a correct scan nobody calls is worth nothing, and a called scan that
 * is wrong is worse.
 *
 * Each REJECT case is a BREAKOUT ATTEMPT against the statement the scan
 * protects:
 *   ALTER TABLE [s].[t] WITH CHECK ADD CONSTRAINT [c] CHECK (<expr>);
 */
import { describe, it, expect } from 'vitest';
import { validCheckExpression, consumeQuoted } from '../check-expression';

/** The scan's contract: null == contained, a string == the refusal reason. */
const accepts = (e: string) => expect(validCheckExpression(e)).toBeNull();
const rejects = (e: string) => expect(typeof validCheckExpression(e)).toBe('string');

// ---------------------------------------------------------------------------
// Breakout attempts — the expression must never reach statement position.
// ---------------------------------------------------------------------------

describe('validCheckExpression — breakout attempts', () => {
  it('the canonical payload cannot close the CHECK clause', () => {
    // Unprotected this yields:
    //   CHECK (1=1); DROP TABLE Orders; --);
    rejects('1=1); DROP TABLE Orders; --');
  });

  it.each([
    ['closes CHECK( then chains a statement', '1=1); DROP TABLE Orders; --'],
    ['closes CHECK( then comments out the tail', '1=1) --'],
    ['closes CHECK( then block-comments the tail', '1=1) /* swallow the rest'],
    ['re-balances around the stolen paren', '1=1) OR (1=1'],
    ['chains a statement without touching parens', '1=1; DROP TABLE Orders'],
    ['leaves a string literal open to swallow the tail', "[Code] = 'x"],
    ['closes the literal early then chains', "[Code] = 'x'; DROP TABLE Orders; --"],
    ['uses a bare unbalanced closing paren', '1=1)'],
    ['hides the payload behind a doubled-quote literal', "[Code] = 'it''s'); DROP TABLE Orders; --"],
    ['leaves an unbalanced opening paren', '(1=1'],
  ])('rejects an expression that %s', (_label, expression) => {
    rejects(expression);
  });
});

// ---------------------------------------------------------------------------
// Delimited identifiers — the desync bypass the first revision had.
//
// A `'` inside [ ] (or " " under QUOTED_IDENTIFIER ON) is an ordinary NAME
// character to T-SQL, not a string delimiter. A scan that tracks only '…'
// therefore desynchronises from the parser: the attacker's apostrophes make it
// believe a clause-closing `)` is "inside a string". Both payloads below were
// ACCEPTED by the first revision.
// ---------------------------------------------------------------------------

describe('validCheckExpression — a quote inside a delimited identifier cannot desync the scan', () => {
  it.each([
    ['brackets hide the ")" behind fake literal state', "[c'] OR 1=1) DROP TABLE Orders --'"],
    ['brackets bracket the payload on both sides', "[a'] ) DROP TABLE Orders [b']"],
    ['a double-quoted identifier used the same way', '"c") DROP TABLE Orders --"'],
    ['an unterminated bracket identifier', '[abc > 0'],
    ['an unterminated double-quoted identifier', '"abc > 0'],
    ['an unterminated bracket hiding a payload', "[a'] ) DROP TABLE Orders [b"],
  ])('rejects when %s', (_label, expression) => {
    rejects(expression);
  });

  it('names the delimited identifier, not a string the user never wrote', () => {
    expect(validCheckExpression('[abc > 0')).toMatch(/delimited identifier/);
    expect(validCheckExpression('"abc > 0')).toMatch(/delimited identifier/);
  });
});

// ---------------------------------------------------------------------------
// Legitimate expressions — a containment rule that rejects real constraints
// would simply be deleted by the next person who hit it.
// ---------------------------------------------------------------------------

describe('validCheckExpression — legitimate expressions', () => {
  it.each([
    ['a simple comparison', '[Total] > 0'],
    ['balanced nested parens', '([A] > 0 AND [B] < 10)'],
    ['a comparison against an empty literal', "[Name] <> ''"],
    ['a LIKE pattern', "[Code] LIKE 'A%'"],
    ['an IN list', "[Status] IN ('open', 'closed')"],
    ['a BETWEEN range', '[Qty] BETWEEN 1 AND 99'],
    ['a negative-number subtraction (not a comment)', '[A] - -1 > 0'],
    ['a scalar UDF call (engine-permitted — see the threat-model note)', 'dbo.Fn([col]) = 1'],
  ])('accepts %s', (_label, expression) => {
    accepts(expression);
  });

  it.each([
    ['an apostrophe in a column name', "[Owner's Name] <> ''"],
    ['another apostrophe name', "[Driver's License] IS NOT NULL"],
    ['a semicolon in a column name', '[Note; internal] IS NOT NULL'],
    ['a double dash in a column name', '[rate--adj] > 0'],
    ['an open paren in a column name', '[Formula(] > 0'],
    ['a close paren in a column name', '[Formula)] > 0'],
    ['a "]]" escape inside a bracket identifier', '[a]]b] > 0'],
    ['a double-quoted identifier holding an apostrophe', '"Owner\'s Name" IS NOT NULL'],
    ['a "" escape inside a double-quoted identifier', '"a""b" > 0'],
  ])('accepts %s (delimited identifiers are opaque)', (_label, expression) => {
    accepts(expression);
  });

  it('is literal-aware: ";" and "--" and ")" INSIDE a string are data', () => {
    accepts("[Note] <> ';'");
    accepts("[Note] <> '-- )'");
    accepts("[Name] <> 'o''brien'");
  });
});

// ---------------------------------------------------------------------------
// Region interleaving — a literal inside a name-shaped span and vice versa.
// ---------------------------------------------------------------------------

describe('validCheckExpression — region interleaving', () => {
  it('a bracket inside a string literal is data, not a region', () => {
    accepts("[Note] <> '[unclosed'");
  });

  it('a quote inside a bracket does not open a literal for the rest of the input', () => {
    // If it did, the trailing ; would be swallowed and this would be accepted.
    rejects("[c'] ; DROP TABLE Orders");
  });

  it('an escaped ]] does not end the identifier early', () => {
    // The ")" here is INSIDE the name, so nothing closes CHECK(.
    accepts('[a]]b)c] > 0');
  });
});

// ---------------------------------------------------------------------------
// consumeQuoted — the shared primitive both region kinds use.
// ---------------------------------------------------------------------------

describe('consumeQuoted', () => {
  it('returns the closing index and honours the doubled escape', () => {
    expect(consumeQuoted("'abc'", 0, "'")).toBe(4);
    expect(consumeQuoted("'a''b'", 0, "'")).toBe(5);
    expect(consumeQuoted('[a]]b]', 0, ']')).toBe(5);
  });

  it('returns -1 when the region is never closed', () => {
    expect(consumeQuoted("'abc", 0, "'")).toBe(-1);
    expect(consumeQuoted('[abc', 0, ']')).toBe(-1);
    // A trailing doubled pair is an escape, not a close.
    expect(consumeQuoted("'a''", 0, "'")).toBe(-1);
  });
});
