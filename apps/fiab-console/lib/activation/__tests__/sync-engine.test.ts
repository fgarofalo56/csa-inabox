import { describe, it, expect, vi } from 'vitest';
import {
  runActivationSync, mapFields, buildAbfssUri, isSafeFilePath, rowsToObjects,
  type SyncEngineDeps,
} from '../sync-engine';
import type { ActivationSyncSpec } from '../types';
import type { DataverseWriteRow } from '../dataverse-sink';

function baseDeps(over: Partial<SyncEngineDeps> = {}): SyncEngineDeps {
  return {
    runDuckSql: async () => ({ columns: [], rows: [] }),
    listVersions: async () => [{ version: 4 }, { version: 3 }],
    downloadCommit: async () => '',
    account: () => 'acct',
    dfsSuffix: () => 'dfs.core.windows.net',
    writeDataverse: async () => ({ upserts: 0, deletes: 0, errors: 0 }),
    sendWebhook: async () => ({ upserts: 0, deletes: 0, errors: 0 }),
    sendEventGrid: async () => ({ upserts: 0, deletes: 0, errors: 0 }),
    sendServiceBus: async () => ({ upserts: 0, deletes: 0, errors: 0 }),
    now: () => new Date('2026-07-24T00:00:00Z'),
    newId: () => 'run-1',
    ...over,
  };
}

const dvSpec = (mode: 'full' | 'incremental', lastSyncedVersion?: number): ActivationSyncSpec => ({
  source: { kind: 'audience', container: 'gold', path: 'segments/vip' },
  destination: { kind: 'dataverse', environmentId: 'env', entitySetName: 'contacts', keyAttribute: 'emailaddress1' },
  keyColumn: 'email',
  mapping: [{ source: 'email', target: 'emailaddress1' }, { source: 'name', target: 'firstname' }],
  mode,
  ...(lastSyncedVersion != null ? { lastSyncedVersion } : {}),
});

describe('sync-engine — pure helpers', () => {
  it('mapFields renames by mapping and drops CDF meta on pass-through', () => {
    expect(mapFields({ email: 'a', name: 'A' }, [{ source: 'email', target: 'emailaddress1' }])).toEqual({ emailaddress1: 'a' });
    expect(mapFields({ x: 1, _change_type: 'insert', _commit_version: 4 }, [])).toEqual({ x: 1 });
  });
  it('buildAbfssUri composes a cloud-aware abfss uri', () => {
    expect(buildAbfssUri('acct', 'dfs.core.windows.net', 'gold', 'segments/vip', '_change_data/x.parquet'))
      .toBe('abfss://gold@acct.dfs.core.windows.net/segments/vip/_change_data/x.parquet');
  });
  it('isSafeFilePath rejects quotes', () => {
    expect(isSafeFilePath("part'.parquet")).toBe(false);
    expect(isSafeFilePath('_change_data/a-b.parquet')).toBe(true);
  });
  it('rowsToObjects zips columns with row arrays', () => {
    expect(rowsToObjects({ columns: [{ name: 'a' }, { name: 'b' }], rows: [[1, 2]] })).toEqual([{ a: 1, b: 2 }]);
  });
});

describe('sync-engine — FULL run to Dataverse', () => {
  it('reads the whole source, maps, upserts, and records the watermark', async () => {
    let captured: DataverseWriteRow[] = [];
    const deps = baseDeps({
      runDuckSql: async (sql) => {
        expect(sql).toContain('delta_scan');
        return { columns: [{ name: 'email' }, { name: 'name' }], rows: [['a@b.com', 'A'], ['c@d.com', 'C']] };
      },
      writeDataverse: async (_c, rows) => { captured = rows; return { upserts: rows.length, deletes: 0, errors: 0 }; },
    });
    const { run, lastSyncedVersion } = await runActivationSync(deps, { itemId: 'it1', spec: dvSpec('full'), mode: 'full' });
    expect(run.status).toBe('succeeded');
    expect(run.rowsRead).toBe(2);
    expect(run.upserts).toBe(2);
    expect(lastSyncedVersion).toBe(4); // max listed version
    expect(captured[0]).toEqual({ keyValue: 'a@b.com', fields: { emailaddress1: 'a@b.com', firstname: 'A' }, op: 'upsert' });
  });
});

describe('sync-engine — INCREMENTAL run via Delta CDF', () => {
  it('reads only changed rows, applies inserts+deletes, drops preimages, advances watermark', async () => {
    let captured: DataverseWriteRow[] = [];
    const commit = JSON.stringify({ cdc: { path: '_change_data/v4.parquet' } });
    const deps = baseDeps({
      listVersions: async () => [{ version: 4 }, { version: 3 }],
      downloadCommit: async (_c, _p, v) => (v === 4 ? commit : ''),
      runDuckSql: async (sql) => {
        expect(sql).toContain('read_parquet');
        return {
          columns: [{ name: 'email' }, { name: 'name' }, { name: '_change_type' }],
          rows: [
            ['c@d.com', 'C', 'insert'],
            ['a@b.com', 'A', 'delete'],
            ['x@y.com', 'X', 'update_preimage'], // dropped
          ],
        };
      },
      writeDataverse: async (_c, rows) => { captured = rows; return { upserts: 1, deletes: 1, errors: 0 }; },
    });
    const { run, lastSyncedVersion } = await runActivationSync(deps, { itemId: 'it1', spec: dvSpec('incremental', 3), mode: 'incremental' });
    expect(run.status).toBe('succeeded');
    expect(run.fromVersion).toBe(4);
    expect(run.toVersion).toBe(4);
    expect(lastSyncedVersion).toBe(4);
    // preimage dropped → 2 write rows: one upsert (insert), one delete.
    expect(captured).toHaveLength(2);
    expect(captured.find((r) => r.keyValue === 'c@d.com')!.op).toBe('upsert');
    expect(captured.find((r) => r.keyValue === 'a@b.com')!.op).toBe('delete');
    expect(run.rowsRead).toBe(2);
  });

  it('does nothing when the source is already at the watermark', async () => {
    const deps = baseDeps({
      listVersions: async () => [{ version: 4 }],
      writeDataverse: async (_c, rows) => ({ upserts: rows.length, deletes: 0, errors: 0 }),
    });
    const { run, lastSyncedVersion } = await runActivationSync(deps, { itemId: 'it1', spec: dvSpec('incremental', 4), mode: 'incremental' });
    expect(run.rowsRead).toBe(0);
    expect(run.status).toBe('succeeded');
    expect(lastSyncedVersion).toBe(4);
  });
});

describe('sync-engine — failure handling + O1 alert', () => {
  it('marks the run failed and routes an alert when the destination reports errors', async () => {
    const dispatchAlert = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({
      runDuckSql: async () => ({ columns: [{ name: 'email' }], rows: [['a@b.com']] }),
      writeDataverse: async () => ({ upserts: 0, deletes: 0, errors: 1, firstError: 'boom' }),
      dispatchAlert,
    });
    const { run, lastSyncedVersion } = await runActivationSync(deps, { itemId: 'it1', spec: dvSpec('full'), mode: 'full' });
    expect(run.status).toBe('failed');
    expect(lastSyncedVersion).toBeUndefined(); // watermark NOT advanced on failure
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
    expect(dispatchAlert.mock.calls[0][0]).toMatchObject({ source: 'activation-sync', severity: 'P2', dedupKey: 'activation-sync:it1' });
  });

  it('alerts and fails the run when the source read throws', async () => {
    const dispatchAlert = vi.fn(async () => ({}));
    const deps = baseDeps({
      runDuckSql: async () => { throw new Error('duckdb down'); },
      dispatchAlert,
    });
    const { run } = await runActivationSync(deps, { itemId: 'it1', spec: dvSpec('full'), mode: 'full' });
    expect(run.status).toBe('failed');
    expect(run.detail).toContain('duckdb down');
    expect(dispatchAlert).toHaveBeenCalledTimes(1);
  });
});

describe('sync-engine — webhook destination pass-through', () => {
  it('builds dedup ids and forwards to the webhook sender', async () => {
    let outRows: any[] = [];
    const spec: ActivationSyncSpec = {
      source: { kind: 'table', container: 'gold', path: 't' },
      destination: { kind: 'webhook', url: 'https://h' },
      keyColumn: 'email',
      mapping: [],
      mode: 'full',
    };
    const deps = baseDeps({
      runDuckSql: async () => ({ columns: [{ name: 'email' }, { name: 'name' }], rows: [['a@b.com', 'A']] }),
      sendWebhook: async (_d, rows) => { outRows = rows; return { upserts: rows.length, deletes: 0, errors: 0 }; },
    });
    const { run } = await runActivationSync(deps, { itemId: 'it1', spec, mode: 'full' });
    expect(run.upserts).toBe(1);
    expect(outRows[0]).toMatchObject({ key: 'a@b.com', op: 'upsert', dedupId: 'it1:a@b.com:4', data: { email: 'a@b.com', name: 'A' } });
  });
});
