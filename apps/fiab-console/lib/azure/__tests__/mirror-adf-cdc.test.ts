/**
 * Unit tests for the ADF Change Data Capture mirror path (runMirrorAdfCdc) in
 * mirror-engine.ts. These lock in the no-Fabric Delta-sink wiring: the CDC spec
 * we PUT to ADF (source entities = selected tables, target = AzureBlobFS Delta in
 * Bronze) and the honest gates when the opt-in linked services are unset.
 *
 * ADF ARM (upsertAdfCdc/startAdfCdc), ADLS, and cloud-endpoints are mocked —
 * these assert the payload we build, not live Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const upsertAdfCdc = vi.fn(async () => ({ name: 'x', properties: {} }));
const startAdfCdc = vi.fn(async () => {});

vi.mock('../adf-client', () => ({
  upsertAdfCdc: (...a: any[]) => upsertAdfCdc(...a),
  startAdfCdc: (...a: any[]) => startAdfCdc(...a),
  adfCdcConfigGate: () =>
    process.env.LOOM_ADF_NAME && process.env.LOOM_SUBSCRIPTION_ID && process.env.LOOM_DLZ_RG
      ? null
      : { missing: 'LOOM_ADF_NAME' },
}));
vi.mock('../adls-client', () => ({
  getAccountName: () => 'acct',
  pathToHttpsUrl: (c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`,
  uploadFile: vi.fn(async () => {}),
}));
vi.mock('../cloud-endpoints', () => ({ dfsSuffix: () => 'dfs.core.windows.net' }));
// Stub the remaining azure-client imports of mirror-engine so the real Azure
// SDKs (@azure/identity, @azure/cosmos, mssql) never load — runMirrorAdfCdc
// exercises none of them, and the shared pnpm store omits some of their
// transitive packages under vitest's ESM loader (broken-harness workaround).
vi.mock('../azure-sql-client', () => ({ executeParameterized: vi.fn(), enableMirroring: vi.fn() }));
vi.mock('../sql-objects-client', () => ({ listTables: vi.fn(async () => []), sqlConfigGate: () => null }));
vi.mock('../postgres-flex-client', () => ({ executePostgresQuery: vi.fn(), listPostgresTables: vi.fn(async () => []), postgresQueryGate: () => null }));
vi.mock('../cosmos-data-client', () => ({ queryItems: vi.fn() }));
vi.mock('../cosmos-account-client', () => ({ listContainers: vi.fn(async () => []) }));

import { runMirrorAdfCdc } from '../mirror-engine';

const SRC = { sourceType: 'AzureSqlDatabase', server: 's.database.windows.net', database: 'prod' };
const TABLES = [
  { schema: 'dbo', table: 'orders' },
  { schema: 'sales', table: 'customers' },
];

describe('runMirrorAdfCdc', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    upsertAdfCdc.mockClear();
    startAdfCdc.mockClear();
    process.env.LOOM_ADF_NAME = 'adf-loom';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_DLZ_RG = 'rg';
    process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE = 'ls-src';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('provisions a Delta-sink CDC resource targeting the selected tables', async () => {
    const r = await runMirrorAdfCdc('abcd1234-ef56-7890', 'ws1', SRC, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('adf-cdc');
    expect(r.cdcName).toBe('loom_mirror_abcd1234');
    expect(r.status).toBe('Running');
    expect(upsertAdfCdc).toHaveBeenCalledTimes(1);
    expect(startAdfCdc).toHaveBeenCalledWith('loom_mirror_abcd1234');

    const [, spec] = upsertAdfCdc.mock.calls[0] as any[];
    // Source: one entity per selected table, bound to the source linked service.
    expect(spec.sourceConnectionsInfo[0].connection.linkedService.referenceName).toBe('ls-src');
    expect(spec.sourceConnectionsInfo[0].connection.linkedServiceType).toBe('AzureSqlDatabase');
    expect(spec.sourceConnectionsInfo[0].sourceEntities.map((e: any) => e.name)).toEqual(['dbo.orders', 'sales.customers']);
    // Target: AzureBlobFS Delta sink, one Delta folder per table under the mirror root.
    expect(spec.targetConnectionsInfo[0].connection.linkedService.referenceName).toBe('ls-adls');
    expect(spec.targetConnectionsInfo[0].connection.linkedServiceType).toBe('AzureBlobFS');
    const t0 = spec.targetConnectionsInfo[0].targetEntities[0];
    const props = Object.fromEntries((t0.dslConnectorProperties || []).map((p: any) => [p.name, p.value]));
    expect(props.fileSystem).toBe('bronze');
    expect(props.format).toBe('delta');
    expect(props.folderPath).toBe('mirrors/ws1/abcd1234-ef56-7890/dbo.orders');
    expect(spec.policy.mode).toBe('Continuous');
    // Per-table receipt carries a Delta OPENROWSET (not CSV).
    expect(r.tables[0].openrowset).toContain("FORMAT = 'DELTA'");
  });

  it('maps SQL Server family to the SqlServer connector type', async () => {
    await runMirrorAdfCdc('xyz', 'ws', { ...SRC, sourceType: 'MSSQL' }, TABLES, 'note');
    const [, spec] = upsertAdfCdc.mock.calls[0] as any[];
    expect(spec.sourceConnectionsInfo[0].connection.linkedServiceType).toBe('SqlServer');
  });

  it('gates honestly when the ADLS linked service is unset', async () => {
    delete process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
    const r = await runMirrorAdfCdc('id', 'ws', SRC, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(upsertAdfCdc).not.toHaveBeenCalled();
    expect(r.gate?.message).toContain('LOOM_MIRROR_ADLS_LINKED_SERVICE');
  });

  it('gates when no tables are selected', async () => {
    const r = await runMirrorAdfCdc('id', 'ws', SRC, [], 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(r.gate?.missing).toBe('tables');
    expect(upsertAdfCdc).not.toHaveBeenCalled();
  });

  it('surfaces ADF provisioning errors verbatim (no fake success)', async () => {
    upsertAdfCdc.mockRejectedValueOnce(new Error('linked service not found'));
    const r = await runMirrorAdfCdc('id123456', 'ws', SRC, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Error');
    expect(r.error).toContain('linked service not found');
  });
});
