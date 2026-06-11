/**
 * Unit tests for the ADF Copy mirror path (runMirrorAdfCopy) + the PG/Snowflake
 * routing in runMirrorSnapshot. These lock in:
 *   - Snowflake mirrors via a real ADF Copy pipeline (delete-then-copy → Bronze
 *     Parquet) + a schedule trigger, with honest gates when unconfigured.
 *   - PostgreSQL is NEVER routed through the ADF CDC resource (`adfcdcs`) — it is
 *     not a valid `adfcdcs` source; PG uses the built-in snapshot/watermark engine.
 *
 * ADF ARM, ADLS, Cosmos/PG clients, and cloud-endpoints are mocked — these assert
 * the payloads we build + the dispatch, not live Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const upsertAdfCdc = vi.fn(async () => ({ name: 'x', properties: {} }));
const startAdfCdc = vi.fn(async () => {});
const upsertDataset = vi.fn(async (n: string) => ({ name: n }));
const upsertPipeline = vi.fn(async (n: string) => ({ name: n }));
const runPipeline = vi.fn(async () => ({ runId: 'run-1' }));
const upsertTrigger = vi.fn(async (n: string) => ({ name: n }));
const startTrigger = vi.fn(async () => {});

vi.mock('../adf-client', () => ({
  upsertAdfCdc: (...a: any[]) => upsertAdfCdc(...a),
  startAdfCdc: (...a: any[]) => startAdfCdc(...a),
  upsertDataset: (...a: any[]) => upsertDataset(...a),
  upsertPipeline: (...a: any[]) => upsertPipeline(...a),
  runPipeline: (...a: any[]) => runPipeline(...a),
  upsertTrigger: (...a: any[]) => upsertTrigger(...a),
  startTrigger: (...a: any[]) => startTrigger(...a),
  listPipelineRuns: vi.fn(async () => []),
  adfConfigGate: () => null,
  adfCdcConfigGate: () =>
    process.env.LOOM_ADF_NAME && process.env.LOOM_SUBSCRIPTION_ID && process.env.LOOM_DLZ_RG
      ? null
      : { missing: 'LOOM_ADF_NAME' },
}));
const uploadFile = vi.fn(async () => {});
vi.mock('../adls-client', () => ({
  getAccountName: () => 'acct',
  pathToHttpsUrl: (c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`,
  listPaths: vi.fn(async () => []),
  resolveAbfssRoot: (c: string, p: string) => `abfss://${c}@acct.dfs.core.windows.net/${p}`,
  uploadFile: (...a: any[]) => uploadFile(...a),
}));
vi.mock('../cloud-endpoints', () => ({ dfsSuffix: () => 'dfs.core.windows.net', httpsToAbfss: (u: string) => u }));
vi.mock('../azure-sql-client', () => ({ executeParameterized: vi.fn(), enableMirroring: vi.fn() }));
vi.mock('../sql-objects-client', () => ({ listTables: vi.fn(async () => []), sqlConfigGate: () => null }));
const executePostgresQuery = vi.fn(async () => ({ columns: ['id', 'name'], rows: [[1, 'a']], rowCount: 1, executionMs: 1 }));
const listPostgresTables = vi.fn(async () => [{ schema: 'public', table: 'orders' }]);
vi.mock('../postgres-flex-client', () => ({
  executePostgresQuery: (...a: any[]) => executePostgresQuery(...a),
  listPostgresTables: (...a: any[]) => listPostgresTables(...a),
  postgresQueryGate: () => null,
}));
vi.mock('../cosmos-data-client', () => ({ queryItems: vi.fn(async () => ({ documents: [], requestCharge: 0, continuation: null, count: 0 })) }));
vi.mock('../cosmos-account-client', () => ({ listContainers: vi.fn(async () => []) }));

import { runMirrorAdfCopy, runMirrorSnapshot } from '../mirror-engine';

const SNOW = { sourceType: 'Snowflake', server: 'acct.snowflakecomputing.com', database: 'ANALYTICS' };
const TABLES = [{ schema: 'PUBLIC', table: 'ORDERS' }];

describe('runMirrorAdfCopy (Snowflake)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const f of [upsertDataset, upsertPipeline, runPipeline, upsertTrigger, startTrigger]) f.mockClear();
    process.env.LOOM_ADF_NAME = 'adf-loom';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_DLZ_RG = 'rg';
    process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE = 'ls-snow';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls';
    process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
    delete process.env.LOOM_MIRROR_COPY_CADENCE;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('provisions a delete-then-copy Parquet pipeline + schedule trigger', async () => {
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('adf-copy');
    expect(r.status).toBe('Running');
    expect(r.cdcName).toBe('loom_copy_abcd1234');
    // Two datasets (source + sink) per table.
    expect(upsertDataset).toHaveBeenCalledTimes(2);
    // The pipeline carries a Delete then a Copy activity (dependsOn Succeeded).
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const acts = pipeSpec.properties.activities;
    expect(acts.map((a: any) => a.type)).toEqual(['Delete', 'Copy']);
    expect(acts[1].dependsOn[0].dependencyConditions).toEqual(['Succeeded']);
    expect(acts[1].typeProperties.source.type).toBe('SnowflakeSource');
    expect(acts[1].typeProperties.sink.type).toBe('ParquetSink');
    // Initial load fired + ongoing schedule trigger started (default incremental).
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(upsertTrigger).toHaveBeenCalledTimes(1);
    expect(startTrigger).toHaveBeenCalledTimes(1);
    const [, trgSpec] = upsertTrigger.mock.calls[0] as any[];
    expect(trgSpec.properties.type).toBe('ScheduleTrigger');
    expect(trgSpec.properties.typeProperties.recurrence.frequency).toBe('Hour');
    // Per-table receipt is a Parquet OPENROWSET.
    expect(r.tables[0].openrowset).toContain("FORMAT = 'PARQUET'");
  });

  it('syncMode=snapshot does a one-time load with NO schedule trigger', async () => {
    const r = await runMirrorAdfCopy('id2', 'ws', { ...SNOW, syncMode: 'snapshot' }, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(upsertTrigger).not.toHaveBeenCalled();
    expect(startTrigger).not.toHaveBeenCalled();
  });

  it('gates honestly when the Snowflake linked service is unset', async () => {
    delete process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE;
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(r.gate?.message).toContain('LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE');
  });

  it('gates when no tables are selected', async () => {
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, [], 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.missing).toBe('tables');
    expect(upsertPipeline).not.toHaveBeenCalled();
  });

  it('surfaces ADF pipeline authoring errors verbatim (no fake success)', async () => {
    upsertPipeline.mockRejectedValueOnce(new Error('linked service not found'));
    const r = await runMirrorAdfCopy('id3', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Error');
    expect(r.error).toContain('linked service not found');
  });

  it('Snowflake routes through runMirrorSnapshot into the Copy engine', async () => {
    const r = await runMirrorSnapshot('mid', 'ws', { ...SNOW, tables: TABLES });
    expect(r.engine).toBe('adf-copy');
    expect(upsertPipeline).toHaveBeenCalledTimes(1);
    // Never touches the CDC resource.
    expect(upsertAdfCdc).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL is never routed through the ADF CDC resource', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    upsertAdfCdc.mockClear(); uploadFile.mockClear();
    // Full ADF CDC config present — a SQL source WOULD use adfcdcs here, but PG must not.
    process.env.LOOM_ADF_NAME = 'adf-loom';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_DLZ_RG = 'rg';
    process.env.LOOM_MIRROR_SOURCE_LINKED_SERVICE = 'ls-src';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls';
    process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
    process.env.LOOM_POSTGRES_AAD_USER = 'loom-uami';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('uses the built-in snapshot engine, not upsertAdfCdc', async () => {
    const r = await runMirrorSnapshot('pgmid', 'ws', {
      sourceType: 'AzurePostgreSql', server: 'pg.postgres.database.azure.com', database: 'prod',
      tables: [{ schema: 'public', table: 'orders' }],
    });
    expect(upsertAdfCdc).not.toHaveBeenCalled();
    // It actually wrote a CSV snapshot to Bronze (real backend path, not gated).
    expect(uploadFile).toHaveBeenCalled();
    expect(r.engine).not.toBe('adf-cdc');
  });
});
