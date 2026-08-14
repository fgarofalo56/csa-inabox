/**
 * #789 (js/sql-injection, HIGH) — the WIRING half of the CHECK-expression fix.
 *
 * The grammar itself is proven directly in
 * `lib/sql/__tests__/check-expression-injection.test.ts`. This file proves the
 * part that file cannot: that `addConstraint` actually CONSULTS the scan, that
 * it does so BEFORE any DB round-trip, and that a payload therefore never
 * reaches the reported sink. A correct scan nobody calls is worth nothing.
 *
 * The taint path this closes:
 *
 *   POST /api/sqldb/constraints            (body.spec, unvalidated free text)
 *     -> sql-objects-client.addConstraint  (spec.expression)
 *        -> `ALTER TABLE … ADD CONSTRAINT [c] CHECK (${expr});`
 *           -> executeParameterized(server, database, ddl)
 *              -> request.query(sqlText)          <- the reported sink
 *
 * Binding cannot help: the payload never travels as a value. Every REJECT case
 * asserts the DB was never touched at all, not merely that the statement looked
 * different — a test that only inspected the emitted DDL would pass just as well
 * against a route that died early for an unrelated reason.
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

describe('addConstraint CHECK — the scan runs BEFORE any DB round-trip', () => {
  it.each([
    ['the canonical breakout', '1=1); DROP TABLE Orders; --'],
    ['the delimited-identifier desync', "[c'] OR 1=1) DROP TABLE Orders --'"],
    ['a bracketed payload', "[a'] ) DROP TABLE Orders [b']"],
    ['an unterminated string literal', "[Code] = 'x"],
    ['an unterminated bracket identifier', '[abc > 0'],
  ])('refuses %s with a 400 and no catalog read at all', async (_label, expression) => {
    const r = await add(expression);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
  });

  it('surfaces the scan\'s reason rather than a generic failure', async () => {
    const r = await add('1=1); DROP TABLE Orders; --');
    expect((r as any).error).toMatch(/CHECK expression/);
  });
});

describe('addConstraint CHECK — no DROP reaches the TDS layer', () => {
  it.each([
    ['the canonical breakout', '1=1); DROP TABLE Orders; --'],
    ['the delimited-identifier desync', "[c'] OR 1=1) DROP TABLE Orders --'"],
  ])('refuses %s even with the catalog reads SUCCEEDING', async (_label, expression) => {
    // The cases above refuse before the first read, so they prove "did not get
    // that far". This hands addConstraint a fully working catalog so the ONLY
    // thing between the payload and `request.query()` is the scan. Pre-fix the
    // canonical case emitted, and executed:
    //   ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X]
    //   CHECK (1=1); DROP TABLE Orders; --);
    mockHappyPath();
    const r = await add(expression);
    expect(r).toMatchObject({ ok: false, status: 400 });
    const executed = ep.mock.calls.map((c) => String(c[2] ?? ''));
    expect(executed.some((s) => /DROP\s+TABLE/i.test(s))).toBe(false);
    expect(executed).toHaveLength(0);
  });
});

describe('addConstraint CHECK — accepted expressions still emit their DDL', () => {
  it.each([
    ['a simple comparison', '[Total] > 0'],
    ['an apostrophe in a column name (rejected before the fix)', "[Owner's Name] <> ''"],
    ['a semicolon in a column name (rejected before the fix)', '[Note; internal] IS NOT NULL'],
    ['a literal containing a semicolon', "[Note] <> ';'"],
  ])('emits byte-exact DDL for %s', async (_label, expression) => {
    mockHappyPath();
    const r = await add(expression);
    expect(r).toMatchObject({ ok: true });
    expect(ep.mock.calls[1][2]).toBe(
      `ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_X] CHECK (${expression});`,
    );
  });

  it('still rejects an empty expression (unchanged behaviour)', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);
    const r = await addConstraint('srv', 'db', 100, { type: 'CK', name: 'CK_X', expression: '   ', noCheck: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});
