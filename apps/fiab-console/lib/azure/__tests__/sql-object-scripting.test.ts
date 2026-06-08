/**
 * sql-object-scripting — unit tests.
 *
 * Verifies the catalog enumeration mapping, the DROP script generation
 * (bracket-sanitized), the CREATE/ALTER OBJECT_DEFINITION path, and the
 * string-narrowing guards. executeQuery is mocked so the tests exercise the
 * pure scripting/mapping logic without a live TDS endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQuery = vi.fn();
vi.mock('@/lib/azure/synapse-sql-client', () => ({
  executeQuery: (...args: unknown[]) => executeQuery(...args),
}));

import {
  enumerateSqlObjects,
  scriptOutSqlObject,
  dropScript,
  asScriptObjectType,
  asScriptMode,
} from '../sql-object-scripting';

const target = {} as any;

beforeEach(() => {
  executeQuery.mockReset();
});

describe('dropScript', () => {
  it('emits a bracket-quoted DROP per object type', () => {
    expect(dropScript('view', 'dbo', 'v1')).toBe('DROP VIEW IF EXISTS [dbo].[v1];');
    expect(dropScript('procedure', 'sales', 'usp_x')).toBe('DROP PROCEDURE IF EXISTS [sales].[usp_x];');
    expect(dropScript('function', 'dbo', 'fn_y')).toBe('DROP FUNCTION IF EXISTS [dbo].[fn_y];');
  });
  it('strips closing brackets so the identifier cannot break out', () => {
    expect(dropScript('view', 'd]bo', 'v]1')).toBe('DROP VIEW IF EXISTS [dbo].[v1];');
  });
});

describe('asScriptObjectType / asScriptMode', () => {
  it('narrows valid values and rejects others', () => {
    expect(asScriptObjectType('view')).toBe('view');
    expect(asScriptObjectType('procedure')).toBe('procedure');
    expect(asScriptObjectType('function')).toBe('function');
    expect(asScriptObjectType('table')).toBeNull();
    expect(asScriptObjectType(null)).toBeNull();
    expect(asScriptMode('create')).toBe('create');
    expect(asScriptMode('alter')).toBe('alter');
    expect(asScriptMode('drop')).toBe('drop');
    expect(asScriptMode('truncate')).toBeNull();
  });
});

describe('enumerateSqlObjects', () => {
  it('maps views / procedures / functions and classifies function type', async () => {
    executeQuery
      .mockResolvedValueOnce({ rows: [['dbo', 'vSales']] })            // views
      .mockResolvedValueOnce({ rows: [['dbo', 'uspLoad']] })           // procedures
      .mockResolvedValueOnce({ rows: [['dbo', 'fnScalar', 'FN'], ['dbo', 'fnInline', 'IF'], ['dbo', 'fnTable', 'TF']] }); // functions
    const inv = await enumerateSqlObjects(target);
    expect(inv.views).toEqual([{ schema: 'dbo', name: 'vSales' }]);
    expect(inv.procedures).toEqual([{ schema: 'dbo', name: 'uspLoad' }]);
    expect(inv.functions).toEqual([
      { schema: 'dbo', name: 'fnScalar', type: 'FN' },
      { schema: 'dbo', name: 'fnInline', type: 'IF' },
      { schema: 'dbo', name: 'fnTable', type: 'TF' },
    ]);
    expect(inv.warnings).toEqual([]);
  });

  it('degrades to a warning (not a throw) when one catalog query fails', async () => {
    executeQuery
      .mockResolvedValueOnce({ rows: [['dbo', 'vSales']] })
      .mockRejectedValueOnce(new Error('procs boom'))
      .mockResolvedValueOnce({ rows: [] });
    const inv = await enumerateSqlObjects(target);
    expect(inv.views).toHaveLength(1);
    expect(inv.procedures).toEqual([]);
    expect(inv.warnings.join(' ')).toMatch(/procedures: procs boom/);
  });
});

describe('scriptOutSqlObject', () => {
  it('returns the real OBJECT_DEFINITION body for create', async () => {
    executeQuery.mockResolvedValueOnce({ rows: [['CREATE VIEW dbo.vSales AS SELECT 1 AS x']] });
    const r = await scriptOutSqlObject(target, { type: 'view', schema: 'dbo', name: 'vSales', mode: 'create' });
    expect(r.ok).toBe(true);
    expect(r.script).toBe('CREATE VIEW dbo.vSales AS SELECT 1 AS x');
  });

  it('rewrites the leading CREATE to CREATE OR ALTER for alter', async () => {
    executeQuery.mockResolvedValueOnce({ rows: [['CREATE VIEW dbo.vSales AS SELECT 1 AS x']] });
    const r = await scriptOutSqlObject(target, { type: 'view', schema: 'dbo', name: 'vSales', mode: 'alter' });
    expect(r.ok).toBe(true);
    expect(r.script).toBe('CREATE OR ALTER VIEW dbo.vSales AS SELECT 1 AS x');
  });

  it('builds DROP without hitting the backend', async () => {
    const r = await scriptOutSqlObject(target, { type: 'procedure', schema: 'dbo', name: 'uspLoad', mode: 'drop' });
    expect(r.ok).toBe(true);
    expect(r.script).toBe('DROP PROCEDURE IF EXISTS [dbo].[uspLoad];');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('returns an honest not-found when no definition exists', async () => {
    executeQuery.mockResolvedValueOnce({ rows: [] });
    const r = await scriptOutSqlObject(target, { type: 'view', schema: 'dbo', name: 'ghost', mode: 'create' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No definition found/);
  });

  it('escapes single quotes in the lookup predicate', async () => {
    executeQuery.mockResolvedValueOnce({ rows: [['CREATE VIEW x']] });
    await scriptOutSqlObject(target, { type: 'view', schema: "d'b", name: "v'1", mode: 'create' });
    const sql = String(executeQuery.mock.calls[0][1]);
    expect(sql).toContain("N'd''b'");
    expect(sql).toContain("N'v''1'");
  });
});
