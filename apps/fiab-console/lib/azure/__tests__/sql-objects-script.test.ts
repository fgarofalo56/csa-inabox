/**
 * Unit tests for the SQL object-navigator catalog client extensions
 * (indexes, rename, data preview, script-as). The TDS layer
 * (`executeParameterized` / `executeQuery`) is mocked so we exercise the pure
 * mapping + DDL-generation + injection-safety logic without a live database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fully mock the TDS client (importing the real one pulls in @azure/identity's
// ESM build, which vitest cannot resolve transitively — see the repo's other
// azure-client tests, which mock siblings fully rather than via importOriginal).
// AzureSqlError is reproduced as a real Error subclass so `instanceof` + status
// mapping behave the same; executeParameterized/executeQuery are spies.
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

import {
  executeParameterized,
  executeQuery,
} from '../azure-sql-client';
import {
  listIndexes,
  dropIndex,
  renameObject,
  previewObject,
  scriptObject,
} from '../sql-objects-client';

const ep = executeParameterized as unknown as ReturnType<typeof vi.fn>;
const eq = executeQuery as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  ep.mockReset();
  eq.mockReset();
});

describe('listIndexes', () => {
  it('maps sys.indexes rows into typed SqlIndexRow objects', async () => {
    ep.mockResolvedValueOnce([
      {
        indexId: 1, name: 'PK_Customer', type: 1, typeDesc: 'CLUSTERED',
        isUnique: true, isPrimaryKey: true, isUniqueConstraint: false,
        filterDefinition: null, keyColumns: '[Id] ASC', includeColumns: '',
      },
      {
        indexId: 2, name: 'IX_Customer_Name', type: 2, typeDesc: 'NONCLUSTERED',
        isUnique: false, isPrimaryKey: false, isUniqueConstraint: false,
        filterDefinition: '([IsActive]=(1))', keyColumns: '[LastName] ASC, [FirstName] ASC',
        includeColumns: '[Email]',
      },
    ]);
    const rows = await listIndexes('srv', 'db', 100);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'PK_Customer', isPrimaryKey: true, isUnique: true, keyColumns: '[Id] ASC' });
    expect(rows[1]).toMatchObject({ name: 'IX_Customer_Name', isPrimaryKey: false, includeColumns: '[Email]', filterDefinition: '([IsActive]=(1))' });
  });

  it('rejects a non-integer objectId before touching the DB', async () => {
    await expect(listIndexes('srv', 'db', 1.5)).rejects.toThrow(/objectId must be an integer/);
    expect(ep).not.toHaveBeenCalled();
  });
});

describe('dropIndex', () => {
  it('resolves the catalog name then emits a bracket-quoted DROP INDEX', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', tname: 'Customer', iname: 'IX_Customer_Name' }]); // resolveIndex
    ep.mockResolvedValueOnce([]); // DROP INDEX exec
    const r = await dropIndex('srv', 'db', 100, 2);
    expect(r).toEqual({ ok: true, dropped: 'dbo.Customer.IX_Customer_Name' });
    const dropSql = ep.mock.calls[1][2] as string;
    expect(dropSql).toBe('DROP INDEX [IX_Customer_Name] ON [dbo].[Customer];');
  });

  it('404s when the index does not resolve', async () => {
    ep.mockResolvedValueOnce([]); // no resolveIndex hit
    const r = await dropIndex('srv', 'db', 100, 99);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe('renameObject', () => {
  it('rejects a multi-part / bracketed new name without a DB call', async () => {
    for (const bad of ['dbo.Other', 'Name]', '[Name', '', 'a'.repeat(129)]) {
      const r = await renameObject('srv', 'db', 'table', 100, bad);
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    expect(ep).not.toHaveBeenCalled();
  });

  it('renames a table via sp_rename with a parameterized new name', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'OldName' }]); // resolveObject
    ep.mockResolvedValueOnce([]); // sp_rename exec
    const r = await renameObject('srv', 'db', 'table', 100, 'NewName');
    expect(r).toMatchObject({ ok: true, renamed: { oldName: 'dbo.OldName', newName: 'dbo.NewName' } });
    expect((r as any).warningDefinitionStale).toBeUndefined();
    // @objname is the bracket-quoted catalog name; @newname (params[1]) is the bare user name.
    const params = ep.mock.calls[1][3] as unknown[];
    expect(params[0]).toBe('[dbo].[OldName]');
    expect(params[1]).toBe('NewName');
  });

  it('flags warningDefinitionStale for a view rename', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'vOld' }]);
    ep.mockResolvedValueOnce([]);
    const r = await renameObject('srv', 'db', 'view', 200, 'vNew');
    expect(r).toMatchObject({ ok: true, warningDefinitionStale: true });
  });
});

describe('previewObject', () => {
  it('resolves the table name then runs SELECT TOP N against the catalog name', async () => {
    ep.mockResolvedValueOnce([{ schema: 'sales', name: 'Orders' }]);
    eq.mockResolvedValueOnce({ columns: ['Id'], rows: [[1]], rowCount: 1, executionMs: 3, truncated: false });
    const r = await previewObject('srv', 'db', 100, 1000);
    expect(r).toMatchObject({ ok: true, objectName: 'sales.Orders' });
    const sql = eq.mock.calls[0][2] as string;
    expect(sql).toBe('SELECT TOP 1000 * FROM [sales].[Orders];');
  });

  it('clamps the row cap to 5000', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'T' }]);
    eq.mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, executionMs: 1, truncated: false });
    await previewObject('srv', 'db', 100, 99999);
    expect(eq.mock.calls[0][2]).toBe('SELECT TOP 5000 * FROM [dbo].[T];');
  });
});

describe('scriptObject', () => {
  it('returns the verbatim module definition for a view CREATE', async () => {
    const def = 'CREATE VIEW [dbo].[vActive] AS SELECT * FROM dbo.Customer WHERE IsActive = 1;';
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'vActive' }]); // resolveObject
    ep.mockResolvedValueOnce([{ definition: def }]);               // sys.sql_modules
    const r = await scriptObject('srv', 'db', 'view', 300, 'CREATE');
    expect(r).toEqual({ ok: true, script: def });
  });

  it('swaps the leading CREATE for ALTER on a procedure', async () => {
    const def = 'CREATE PROCEDURE [dbo].[p] AS SELECT 1;';
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'p' }]);
    ep.mockResolvedValueOnce([{ definition: def }]);
    const r = await scriptObject('srv', 'db', 'procedure', 400, 'ALTER');
    expect(r).toMatchObject({ ok: true });
    expect((r as any).script).toBe('ALTER PROCEDURE [dbo].[p] AS SELECT 1;');
  });

  it('generates DROP … IF EXISTS for a function', async () => {
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'fnX' }]); // resolveObject only
    const r = await scriptObject('srv', 'db', 'function', 500, 'DROP');
    expect(r).toEqual({ ok: true, script: 'DROP FUNCTION IF EXISTS [dbo].[fnX];' });
  });

  it('reconstructs CREATE TABLE with identity, PK and a secondary index', async () => {
    // 1) resolveObject(table) → schema/name
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Customer' }]);
    // 2) scriptTableCreate columns
    ep.mockResolvedValueOnce([
      { name: 'Id', typeName: 'int', maxLength: 4, prec: 10, scale: 0, isNullable: false, isIdentity: true, isComputed: false, collationName: null, seedValue: 1, incrementValue: 1, computedDefinition: null, isPersisted: false, defaultDefinition: null },
      { name: 'Name', typeName: 'nvarchar', maxLength: 400, prec: 0, scale: 0, isNullable: false, isIdentity: false, isComputed: false, collationName: null, seedValue: null, incrementValue: null, computedDefinition: null, isPersisted: false, defaultDefinition: null },
    ]);
    // 3) PK
    ep.mockResolvedValueOnce([{ pkName: 'PK_Customer', typeDesc: 'CLUSTERED', keyCols: '[Id] ASC' }]);
    // 4) listIndexes (for secondary indexes)
    ep.mockResolvedValueOnce([
      { indexId: 1, name: 'PK_Customer', type: 1, typeDesc: 'CLUSTERED', isUnique: true, isPrimaryKey: true, isUniqueConstraint: false, filterDefinition: null, keyColumns: '[Id] ASC', includeColumns: '' },
      { indexId: 2, name: 'IX_Name', type: 2, typeDesc: 'NONCLUSTERED', isUnique: false, isPrimaryKey: false, isUniqueConstraint: false, filterDefinition: null, keyColumns: '[Name] ASC', includeColumns: '' },
    ]);
    const r = await scriptObject('srv', 'db', 'table', 600, 'CREATE');
    expect(r).toMatchObject({ ok: true });
    const script = (r as any).script as string;
    expect(script).toContain('CREATE TABLE [dbo].[Customer] (');
    expect(script).toContain('[Id] int IDENTITY(1,1) NOT NULL');
    expect(script).toContain('[Name] nvarchar(200) NOT NULL');
    expect(script).toContain('CONSTRAINT [PK_Customer] PRIMARY KEY CLUSTERED ([Id] ASC)');
    expect(script).toContain('CREATE NONCLUSTERED INDEX [IX_Name] ON [dbo].[Customer] ([Name] ASC);');
    // The PK index must NOT be re-emitted as a CREATE INDEX.
    expect(script).not.toContain('CREATE CLUSTERED INDEX [PK_Customer]');
  });

  it('scripts a CREATE INDEX from sys.indexes (index group)', async () => {
    // index branch: listIndexes then resolveObject(table)
    ep.mockResolvedValueOnce([
      { indexId: 3, name: 'IX_Email', type: 2, typeDesc: 'NONCLUSTERED', isUnique: true, isPrimaryKey: false, isUniqueConstraint: false, filterDefinition: null, keyColumns: '[Email] ASC', includeColumns: '[Phone]' },
    ]);
    ep.mockResolvedValueOnce([{ schema: 'dbo', name: 'Customer' }]);
    const r = await scriptObject('srv', 'db', 'index', 600, 'CREATE', 3);
    expect(r).toEqual({ ok: true, script: 'CREATE UNIQUE NONCLUSTERED INDEX [IX_Email] ON [dbo].[Customer] ([Email] ASC) INCLUDE ([Phone]);' });
  });

  it('requires an indexId for the index group', async () => {
    const r = await scriptObject('srv', 'db', 'index', 600, 'CREATE');
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(ep).not.toHaveBeenCalled();
  });
});
