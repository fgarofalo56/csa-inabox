/**
 * Unit tests for the SQL keys & constraints inline-designer catalog client
 * (listConstraints / addConstraint / dropConstraint / toggleConstraint). The
 * TDS layer (`executeParameterized`) is mocked, so we exercise the pure mapping
 * + DDL-generation + injection-safety logic without a live database.
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
import {
  listConstraints,
  addConstraint,
  dropConstraint,
  toggleConstraint,
} from '../sql-objects-client';

const ep = executeParameterized as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { ep.mockReset(); });

describe('listConstraints', () => {
  it('maps PK / UNIQUE / FK / CHECK rows into typed SqlConstraintRow objects', async () => {
    ep.mockResolvedValueOnce([
      { constraintType: 'PK', constraintId: 10, name: 'PK_Orders', isSystemNamed: false, isDisabled: false, isTrusted: true, columns: '[Id] ASC', indexTypeDesc: 'CLUSTERED', refTableId: null, refTableName: null, refColumns: null, onDelete: null, onUpdate: null, checkDefinition: null },
      { constraintType: 'UQ', constraintId: 11, name: 'UQ_Orders_Code', isSystemNamed: false, isDisabled: false, isTrusted: true, columns: '[Code] ASC', indexTypeDesc: 'NONCLUSTERED', refTableId: null, refTableName: null, refColumns: null, onDelete: null, onUpdate: null, checkDefinition: null },
      { constraintType: 'FK', constraintId: 12, name: 'FK_Orders_Customers', isSystemNamed: false, isDisabled: false, isTrusted: false, columns: '[CustomerId]', indexTypeDesc: null, refTableId: 99, refTableName: '[dbo].[Customers]', refColumns: '[Id]', onDelete: 'CASCADE', onUpdate: 'NO_ACTION', checkDefinition: null },
      { constraintType: 'CK', constraintId: 13, name: 'CK_Orders_Total', isSystemNamed: false, isDisabled: true, isTrusted: true, columns: '', indexTypeDesc: null, refTableId: null, refTableName: null, refColumns: null, onDelete: null, onUpdate: null, checkDefinition: '([Total]>(0))' },
    ]);
    const rows = await listConstraints('srv', 'db', 100);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ constraintType: 'PK', name: 'PK_Orders', columns: '[Id] ASC', indexTypeDesc: 'CLUSTERED', isTrusted: true });
    expect(rows[2]).toMatchObject({ constraintType: 'FK', refTableName: '[dbo].[Customers]', refColumns: '[Id]', onDelete: 'CASCADE', isTrusted: false });
    expect(rows[3]).toMatchObject({ constraintType: 'CK', checkDefinition: '([Total]>(0))', isDisabled: true });
  });

  it('rejects a non-integer objectId before touching the DB', async () => {
    await expect(listConstraints('srv', 'db', 1.5)).rejects.toThrow(/objectId must be an integer/);
    expect(ep).not.toHaveBeenCalled();
  });
});

describe('addConstraint — PRIMARY KEY', () => {
  it('resolves table + columns from the catalog and emits PRIMARY KEY CLUSTERED DDL', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);          // resolveTable
    ep.mockResolvedValueOnce([{ columnId: 1, name: 'Id' }, { columnId: 2, name: 'Region' }]); // resolveColumns
    ep.mockResolvedValueOnce([]);                                            // ALTER TABLE exec
    const r = await addConstraint('srv', 'db', 100, {
      type: 'PK', name: 'PK_Orders', clustered: true,
      columns: [{ columnId: 1, descending: false }],
    });
    expect(r).toMatchObject({ ok: true, added: 'dbo.Orders.PK_Orders' });
    const ddl = ep.mock.calls[2][2] as string;
    expect(ddl).toBe('ALTER TABLE [dbo].[Orders] ADD CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([Id] ASC);');
  });

  it('rejects a key column that does not belong to the table', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);
    ep.mockResolvedValueOnce([{ columnId: 1, name: 'Id' }]); // column 7 not present
    const r = await addConstraint('srv', 'db', 100, {
      type: 'PK', name: 'PK_Orders', clustered: true, columns: [{ columnId: 7, descending: false }],
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe('addConstraint — FOREIGN KEY', () => {
  it('emits WITH NOCHECK + ON DELETE/UPDATE from catalog-resolved names', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);          // resolveTable (parent)
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Customers' }]);       // resolveTable (ref)
    ep.mockResolvedValueOnce([{ columnId: 5, name: 'CustomerId' }]);        // local columns
    ep.mockResolvedValueOnce([{ columnId: 1, name: 'Id' }]);                // ref columns
    ep.mockResolvedValueOnce([]);                                           // ALTER exec
    const r = await addConstraint('srv', 'db', 100, {
      type: 'FK', name: 'FK_Orders_Customers', columns: [5], refTableObjectId: 99,
      refColumns: [1], onDelete: 'CASCADE', onUpdate: 'NO_ACTION', noCheck: true,
    });
    expect(r).toMatchObject({ ok: true });
    const ddl = ep.mock.calls[4][2] as string;
    expect(ddl).toBe('ALTER TABLE [dbo].[Orders] WITH NOCHECK ADD CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id]) ON DELETE CASCADE ON UPDATE NO ACTION;');
  });

  it('rejects mismatched column counts', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);
    const r = await addConstraint('srv', 'db', 100, {
      type: 'FK', name: 'FK_X', columns: [5, 6], refTableObjectId: 99,
      refColumns: [1], onDelete: 'NO_ACTION', onUpdate: 'NO_ACTION', noCheck: false,
    });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe('addConstraint — CHECK', () => {
  it('embeds the expression only inside CHECK(...) and prefixes WITH CHECK', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);
    ep.mockResolvedValueOnce([]);
    const r = await addConstraint('srv', 'db', 100, {
      type: 'CK', name: 'CK_Orders_Total', expression: '[Total] > 0', noCheck: false,
    });
    expect(r).toMatchObject({ ok: true });
    const ddl = ep.mock.calls[1][2] as string;
    expect(ddl).toBe('ALTER TABLE [dbo].[Orders] WITH CHECK ADD CONSTRAINT [CK_Orders_Total] CHECK ([Total] > 0);');
  });

  it('rejects an empty CHECK expression', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Orders' }]);
    const r = await addConstraint('srv', 'db', 100, { type: 'CK', name: 'CK_X', expression: '   ', noCheck: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});

describe('addConstraint — name validation (injection safety)', () => {
  it.each([
    ['has a dot', 'dbo.Evil'],
    ['has a bracket', 'Evil]'],
    ['leading hash', '#temp'],
    ['empty', '   '],
  ])('rejects a name that %s before any DB call', async (_label, name) => {
    const r = await addConstraint('srv', 'db', 100, { type: 'CK', name, expression: '1=1', noCheck: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
  });
});

describe('dropConstraint', () => {
  it('resolves the constraint name then emits bracket-quoted DROP CONSTRAINT', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', tname: 'Orders', cname: 'CK_Orders_Total', ctype: 'C' }]); // resolveConstraint
    ep.mockResolvedValueOnce([]); // ALTER exec
    const r = await dropConstraint('srv', 'db', 100, 13);
    expect(r).toEqual({ ok: true, dropped: 'dbo.Orders.CK_Orders_Total' });
    const ddl = ep.mock.calls[1][2] as string;
    expect(ddl).toBe('ALTER TABLE [dbo].[Orders] DROP CONSTRAINT [CK_Orders_Total];');
  });

  it('404s when the constraint does not resolve', async () => {
    ep.mockResolvedValueOnce([]);
    const r = await dropConstraint('srv', 'db', 100, 999);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe('toggleConstraint', () => {
  it('enables a FK with WITH CHECK CHECK CONSTRAINT', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', tname: 'Orders', cname: 'FK_Orders_Customers', ctype: 'F' }]);
    ep.mockResolvedValueOnce([]);
    const r = await toggleConstraint('srv', 'db', 100, 12, true);
    expect(r).toMatchObject({ ok: true, state: 'enabled' });
    expect(ep.mock.calls[1][2]).toBe('ALTER TABLE [dbo].[Orders] WITH CHECK CHECK CONSTRAINT [FK_Orders_Customers];');
  });

  it('disables a CHECK with NOCHECK CONSTRAINT', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', tname: 'Orders', cname: 'CK_Orders_Total', ctype: 'C' }]);
    ep.mockResolvedValueOnce([]);
    const r = await toggleConstraint('srv', 'db', 100, 13, false);
    expect(r).toMatchObject({ ok: true, state: 'disabled' });
    expect(ep.mock.calls[1][2]).toBe('ALTER TABLE [dbo].[Orders] NOCHECK CONSTRAINT [CK_Orders_Total];');
  });

  it('refuses to toggle a PK/UNIQUE constraint', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', tname: 'Orders', cname: 'PK_Orders', ctype: 'PK' }]);
    const r = await toggleConstraint('srv', 'db', 100, 10, false);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });
});
