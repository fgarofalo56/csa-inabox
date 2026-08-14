/**
 * #789 (js/sql-injection, HIGH) — adversarial tests for the CHECK-expression
 * call site that actually carried the injection.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT IN quoting-injection.test.ts.
 *
 * CodeQL reported the sink — `azure-sql-client.executeParameterized`, at the
 * `request.query(sqlText)` line — and that function's own docstring answered the
 * report with "inputs are bound as `@p0`, `@p1`, … so no string-injection path
 * exists". That answer was about `params`. It said nothing about `sqlText`,
 * which is itself a parameter, and the defect was a caller building `sqlText`
 * by concatenation:
 *
 *   POST /api/sqldb/constraints            (body.spec, unvalidated free text)
 *     -> sql-objects-client.addConstraint  (spec.expression)
 *        -> `ALTER TABLE … ADD CONSTRAINT [c] CHECK (${expr});`
 *           -> executeParameterized(server, database, ddl)
 *              -> request.query(sqlText)          <- the reported sink
 *
 * Binding cannot help here: the payload never travels as a value. The sibling
 * fragments were already safe (table/column names are catalog-resolved by
 * integer id and bracket-quoted via `lib/sql/quoting`); the CHECK expression was
 * the one fragment with NO defence, because it can be neither bound nor quoted —
 * it is SQL by definition. So the fix is a grammar scan, and these are its
 * proof. `quoting-injection.test.ts` proves the escaping primitives; this proves
 * the one call site that could not use them.
 *
 * Every REJECT case below asserts the DB was never touched at all, not merely
 * that the statement looked different — a test that only inspected the emitted
 * DDL would pass just as well against a route that failed for an unrelated
 * reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../azure-sql-client', () => {
  class AzureSqlError extends Error {
    status: number;
    body?: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = 'AzureSqlError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    AzureSqlError,
    executeParameterized: vi.fn(),
    executeQuery: vi.fn(),
  };
});

import { executeParameterized } from '../azure-sql-client';
import { addConstraint } from '../sql-objects-client';

const ep = executeParameterized as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { ep.mockReset(); });

/** Mock the two reads a successful CK add performs: resolveTable, then the ALTER. */
function mockHappyPath() {
  ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]); // resolveTable
  ep.mockResolvedValueOnce([]);                                  // ALTER TABLE exec
}

const add = (expression: string) =>
  addConstraint('srv', 'db', 100, { type: 'CK', name: 'CK_X', expression, noCheck: false });

// ---------------------------------------------------------------------------
// Breakout attempts — the expression must never reach statement position.
// ---------------------------------------------------------------------------

describe('addConstraint CHECK — breakout attempts are refused before any DB call', () => {
  it('the canonical payload cannot close the CHECK clause', async () => {
    // Pre-fix this emitted:
    //   ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X]
    //   CHECK (1=1); DROP TABLE Orders; --);
    // i.e. a DROP as its own statement, executed as the Console's SQL identity.
    const r = await add('1=1); DROP TABLE Orders; --');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
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
  ])('rejects an expression that %s', async (_label, expression) => {
    const r = await add(expression);
    expect(r).toMatchObject({ ok: false, status: 400 });
    // Nothing was resolved, nothing was executed — the refusal is up front.
    expect(ep).not.toHaveBeenCalled();
  });

  it('an unbalanced OPENING paren is refused too (it would swallow the trailing ");")', async () => {
    const r = await add('(1=1');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
  });

  it('with the catalog reads SUCCEEDING, no DROP ever reaches the TDS layer', async () => {
    // The cases above refuse before the first read, so they prove "did not get
    // that far". This one hands addConstraint a fully working catalog so the
    // ONLY thing standing between the payload and `request.query()` is the
    // grammar scan. Pre-fix this emitted, and executed:
    //   ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X]
    //   CHECK (1=1); DROP TABLE Orders; --);
    mockHappyPath();
    const r = await add('1=1); DROP TABLE Orders; --');
    expect(r).toMatchObject({ ok: false, status: 400 });
    const executed = ep.mock.calls.map((c) => String(c[2] ?? ''));
    expect(executed.some((s) => /DROP\s+TABLE/i.test(s))).toBe(false);
    expect(executed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Delimited identifiers — the bypass the first version of the scan had.
//
// A `'` inside [ ] (or " " under QUOTED_IDENTIFIER ON) is an ordinary NAME
// character to T-SQL, not a string delimiter. A scanner that tracks only '…'
// therefore desynchronises from the parser: the attacker's apostrophes make it
// believe a clause-closing `)` is "inside a string", and the depth check never
// sees it. Both payloads below were ACCEPTED by the first revision.
// ---------------------------------------------------------------------------

describe('addConstraint CHECK — a quote inside a delimited identifier cannot desync the scan', () => {
  it.each([
    ['brackets hide the ")" and the payload behind fake literal state', "[c'] OR 1=1) DROP TABLE Orders --'"],
    ['brackets bracket the payload on both sides', "[a'] ) DROP TABLE Orders [b']"],
    ['double-quoted identifier used the same way', '"c") DROP TABLE Orders --"'],
    ['an unterminated bracket identifier', '[abc > 0'],
    ['an unterminated double-quoted identifier', '"abc > 0'],
  ])('rejects when %s', async (_label, expression) => {
    const r = await add(expression);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
  });

  it('the desync payload is refused even with the catalog reads succeeding', async () => {
    mockHappyPath();
    const r = await add("[c'] OR 1=1) DROP TABLE Orders --'");
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep.mock.calls.map((c) => String(c[2] ?? ''))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The same root cause produced FALSE POSITIVES: SQL Server permits these
// characters in a delimited name, and the old scan rejected ordinary
// constraints while blaming a string literal the user never wrote.
// ---------------------------------------------------------------------------

describe('addConstraint CHECK — legitimate delimited identifiers are accepted', () => {
  it.each([
    ['an apostrophe in a column name', "[Owner's Name] <> ''"],
    ['another apostrophe name', "[Driver's License] IS NOT NULL"],
    ['a semicolon in a column name', '[Note; internal] IS NOT NULL'],
    ['a double dash in a column name', '[rate--adj] > 0'],
    ['an open paren in a column name', '[Formula(] > 0'],
    ['a "]]" escape inside a bracket identifier', '[a]]b] > 0'],
    ['a double-quoted identifier holding an apostrophe', '"Owner\'s Name" IS NOT NULL'],
    ['a scalar UDF call (engine-permitted, see the threat-model note)', 'dbo.Fn([col]) = 1'],
  ])('accepts %s', async (_label, expression) => {
    mockHappyPath();
    const r = await add(expression);
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      `ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK (${expression});`,
    );
  });
});

// ---------------------------------------------------------------------------
// Legitimate expressions must still work — a containment rule that rejects real
// constraints would just be removed by the next person who hit it.
// ---------------------------------------------------------------------------

describe('addConstraint CHECK — legitimate expressions still emit their DDL', () => {
  it.each([
    ['a simple comparison', '[Total] > 0'],
    ['balanced nested parens', '([A] > 0 AND [B] < 10)'],
    ['a comparison against an empty literal', "[Name] <> ''"],
    ['a LIKE pattern', "[Code] LIKE 'A%'"],
    ['an IN list', "[Status] IN ('open', 'closed')"],
    ['a BETWEEN range', '[Qty] BETWEEN 1 AND 99'],
    ['a negative-number subtraction (not a comment)', '[A] - -1 > 0'],
  ])('accepts %s', async (_label, expression) => {
    mockHappyPath();
    const r = await add(expression);
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      `ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK (${expression});`,
    );
  });

  it('the scan is literal-aware: a ";" INSIDE a string literal is data, not a terminator', async () => {
    // A blanket ";" blocklist would reject this legitimate constraint. The scan
    // tracks literal state, so the semicolon is just a character in the value.
    mockHappyPath();
    const r = await add("[Note] <> ';'");
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      "ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK ([Note] <> ';');",
    );
  });

  it('a doubled quote keeps the scan inside the literal (o\'\'brien stays one string)', async () => {
    mockHappyPath();
    const r = await add("[Name] <> 'o''brien'");
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      "ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK ([Name] <> 'o''brien');",
    );
  });

  it('a "--" and a ")" inside a literal are data, not a comment or a clause close', async () => {
    mockHappyPath();
    const r = await add("[Note] <> '-- )'");
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      "ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK ([Note] <> '-- )');",
    );
  });
});
