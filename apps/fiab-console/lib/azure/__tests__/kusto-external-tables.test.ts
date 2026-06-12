/**
 * Contract tests for the ADX external-table control commands.
 *
 * Per .claude/rules/no-vaporware.md these assert the EXACT Kusto control command
 * shapes that `createExternalStorageTable` / `dropExternalTable` post to
 * /v1/rest/mgmt — the `kind=storage dataformat=<f>` clause, the bracket-quoted
 * table name, the `;managed_identity=system` storage auth, and the structured
 * `col:type` schema guard. Nothing is faked beyond stubbing global.fetch + the
 * AAD credential.
 *
 * Grounding:
 *   .create external table kind=storage — https://learn.microsoft.com/kusto/management/external-tables-azure-storage
 *   .drop external table               — https://learn.microsoft.com/kusto/management/drop-external-table
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'AAD.ADX.TOKEN', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});
vi.mock('../cosmos-client', () => ({ itemsContainer: vi.fn(), workspacesContainer: vi.fn() }));

import {
  createExternalStorageTable, dropExternalTable, KUSTO_EXTERNAL_TABLE_FORMATS,
} from '../kusto-client';

const realFetch = global.fetch;

/** Minimal v1 /rest/mgmt OK response with zero data rows. */
function v1Ok() {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      Tables: [{ TableName: 'Table_0', Columns: [{ ColumnName: 'x', DataType: 'String' }], Rows: [] }],
    }),
  } as unknown as Response;
}

describe('createExternalStorageTable', () => {
  let lastBody: any;
  beforeEach(() => {
    lastBody = null;
    global.fetch = vi.fn(async (_url: any, init: any) => { lastBody = JSON.parse(init.body); return v1Ok(); }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('builds .create-or-alter external table with kind=storage, dataformat, schema, and system MI auth', async () => {
    await createExternalStorageTable(
      'db1', 'bronze_events', 'ts:datetime, tenant:string, value:long',
      'abfss://bronze@acct.dfs.core.windows.net/events', 'parquet',
    );
    const csl: string = lastBody.csl;
    expect(csl).toContain('.create-or-alter external table ["bronze_events"]');
    expect(csl).toContain('(ts:datetime, tenant:string, value:long)');
    expect(csl).toContain('kind=storage');
    expect(csl).toContain('dataformat=parquet');
    expect(csl).toContain("h@'abfss://bronze@acct.dfs.core.windows.net/events;managed_identity=system'");
  });

  it('uses a user-assigned MI object id when supplied', async () => {
    await createExternalStorageTable(
      'db1', 'T', 'a:int', 'abfss://c@a.dfs.core.windows.net/p', 'csv',
      { miObjectId: '11111111-1111-1111-1111-111111111111' },
    );
    expect((lastBody.csl as string)).toContain(';managed_identity=11111111-1111-1111-1111-111111111111');
  });

  it('emits a with(...) clause for folder + docstring', async () => {
    await createExternalStorageTable(
      'db1', 'T', 'a:int', 'abfss://c@a.dfs.core.windows.net/p', 'json',
      { folder: 'Loom', docString: 'mine' },
    );
    const csl = lastBody.csl as string;
    expect(csl).toContain('with (folder = "Loom", docstring = "mine")');
  });

  it('rejects an abfssUri that is not abfss://', async () => {
    await expect(createExternalStorageTable('db1', 'T', 'a:int', 'https://x', 'csv')).rejects.toThrow(/abfss/);
  });

  it('rejects a schema that is not a CSL col:type list', async () => {
    await expect(createExternalStorageTable('db1', 'T', 'drop table x', 'abfss://c@a.dfs.core.windows.net/p', 'csv')).rejects.toThrow(/CSL/);
  });

  it('rejects an unsupported data format', async () => {
    await expect(
      createExternalStorageTable('db1', 'T', 'a:int', 'abfss://c@a.dfs.core.windows.net/p', 'avro' as any),
    ).rejects.toThrow(/dataFormat/);
  });

  it('exposes the four export-capable formats', () => {
    expect([...KUSTO_EXTERNAL_TABLE_FORMATS]).toEqual(['csv', 'tsv', 'json', 'parquet']);
  });
});

describe('dropExternalTable', () => {
  let lastBody: any;
  beforeEach(() => {
    lastBody = null;
    global.fetch = vi.fn(async (_url: any, init: any) => { lastBody = JSON.parse(init.body); return v1Ok(); }) as any;
  });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it('builds .drop external table with bracket-quoting + ifexists', async () => {
    await dropExternalTable('db1', 'bronze_events');
    expect((lastBody.csl as string)).toBe('.drop external table ["bronze_events"] ifexists');
  });

  it('rejects an empty name', async () => {
    await expect(dropExternalTable('db1', '   ')).rejects.toThrow(/name is required/);
  });
});
