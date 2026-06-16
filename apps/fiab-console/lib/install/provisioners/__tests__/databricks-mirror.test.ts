/**
 * Unit tests for the Databricks-UC-mirror pairing helpers (audit H8).
 *
 * Covers splitAbfss (the abfss/https → external-data-source root + relative path
 * parser used to register one EXTERNAL DATA SOURCE per storage account) and the
 * mirrored-databricks → synapse-serverless-sql-pool pairing rule's deriveContent
 * (the gate that only pairs when real UC Delta tables were resolved).
 */
import { describe, it, expect } from 'vitest';
import { splitAbfss } from '../synapse-serverless-sql-pool';
import { ITEM_PAIRING_RULES } from '@/lib/items/registry';

describe('splitAbfss', () => {
  it('parses an abfss:// Delta location into root + relative', () => {
    const r = splitAbfss('abfss://unity@dbxstore.dfs.core.windows.net/catalogs/main/sales/_external');
    expect(r).toEqual({
      root: 'abfss://unity@dbxstore.dfs.core.windows.net/',
      relative: 'catalogs/main/sales/_external',
    });
  });

  it('parses an https dfs location into an abfss root + relative', () => {
    const r = splitAbfss('https://dbxstore.dfs.core.windows.net/unity/catalogs/main/orders');
    expect(r).toEqual({
      root: 'abfss://unity@dbxstore.dfs.core.windows.net/',
      relative: 'catalogs/main/orders',
    });
  });

  it('groups tables in the same container under one root', () => {
    const a = splitAbfss('abfss://unity@acct.dfs.core.windows.net/a/t1');
    const b = splitAbfss('abfss://unity@acct.dfs.core.windows.net/b/t2');
    expect(a?.root).toBe(b?.root);
  });

  it('returns null for an unparseable URI (caller falls back to absolute BULK)', () => {
    expect(splitAbfss('s3://bucket/path')).toBeNull();
  });
});

describe("ITEM_PAIRING_RULES['mirrored-databricks'] deriveContent", () => {
  const rule = ITEM_PAIRING_RULES['mirrored-databricks'][0];
  const input: any = { cosmosItemId: 'mdbx-1', displayName: 'Unity main', content: { catalogName: 'main' } };

  it('pairs when UC Delta tables were resolved', () => {
    const tables = [{ schema: 'sales', table: 'orders', storageLocation: 'abfss://u@a.dfs.core.windows.net/orders' }];
    const result: any = { secondaryIds: { ucTablesJson: JSON.stringify(tables), catalogName: 'main' } };
    const out = rule.deriveContent(result, input);
    expect(out).not.toBeNull();
    expect(out!.databricksMirrorItemId).toBe('mdbx-1');
    expect(out!.ucCatalogName).toBe('main');
    expect(Array.isArray(out!.ucTables)).toBe(true);
    expect((out!.ucTables as unknown[]).length).toBe(1);
  });

  it('honest-skips (null) when Databricks resolved no tables', () => {
    const result: any = { secondaryIds: {} };
    expect(rule.deriveContent(result, input)).toBeNull();
  });

  it('honest-skips (null) on an empty table list', () => {
    const result: any = { secondaryIds: { ucTablesJson: '[]' } };
    expect(rule.deriveContent(result, input)).toBeNull();
  });
});
