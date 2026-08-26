/**
 * Unit tests for the ADF Copy mirror path (runMirrorAdfCopy) + the PG/Snowflake
 * routing in runMirrorSnapshot. These lock in:
 *   - Snowflake mirrors via a real ADF Copy pipeline (copy-then-swap → Bronze
 *     Parquet, staged through Blob) + a schedule trigger, with honest gates when
 *     unconfigured.
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
const upsertLinkedService = vi.fn(async (n: string) => ({ name: n, properties: { type: 'SnowflakeV2' } }));
const getLinkedService = vi.fn(async (n: string) => ({ name: n, properties: { type: 'SnowflakeV2' } }));
const getPipelineRun = vi.fn(async () => ({ runId: 'run-1', pipelineName: 'p', status: 'Succeeded' as const }));
// The Lookup that enumerates Snowflake. Tests override `.value` per case.
const listActivityRuns = vi.fn(async () => ([
  { activityRunId: 'a', activityName: 'ListTables', activityType: 'Lookup', output: { value: [] as unknown[] } },
]));

vi.mock('../adf-client', () => ({
  upsertAdfCdc: (...a: any[]) => upsertAdfCdc(...a),
  startAdfCdc: (...a: any[]) => startAdfCdc(...a),
  upsertDataset: (...a: any[]) => upsertDataset(...a),
  upsertPipeline: (...a: any[]) => upsertPipeline(...a),
  runPipeline: (...a: any[]) => runPipeline(...a),
  upsertTrigger: (...a: any[]) => upsertTrigger(...a),
  startTrigger: (...a: any[]) => startTrigger(...a),
  upsertLinkedService: (...a: any[]) => upsertLinkedService(...a),
  getLinkedService: (...a: any[]) => getLinkedService(...a),
  getPipelineRun: (...a: any[]) => getPipelineRun(...a),
  listActivityRuns: (...a: any[]) => listActivityRuns(...a),
  listPipelineRuns: vi.fn(async () => []),
  adfConfigGate: () => null,
  adfCdcConfigGate: () =>
    process.env.LOOM_ADF_NAME && process.env.LOOM_SUBSCRIPTION_ID && process.env.LOOM_DLZ_RG
      ? null
      : { missing: 'LOOM_ADF_NAME' },
}));

// The Snowflake connection the mirror binds. `secretRef` is a NAME, never a
// value — the tests assert the linked service references it rather than
// carrying a credential.
const SNOW_CONN = {
  id: 'conn-1234abcd', tenantId: 't1', name: 'demo snowflake', type: 'snowflake' as const,
  authMethod: 'sql-password' as const, host: 'myorg-acct123', database: 'ANALYTICS',
  warehouse: 'COMPUTE_WH', role: 'LOOM_RO', username: 'LOOM_SVC', secretRef: 'loom-conn-1234abcd',
  createdAt: '', updatedAt: '',
};
const loadConnection = vi.fn(async () => SNOW_CONN as any);
vi.mock('../connections-store', () => ({ loadConnection: (...a: any[]) => loadConnection(...a) }));
vi.mock('../kv-secrets-client', () => ({
  vaultUrl: () => 'https://kv-loom.vault.azure.net',
  getKeyVaultSecretValue: vi.fn(async () => { throw new Error('tests must never resolve a secret value'); }),
}));

const uploadFile = vi.fn(async () => {});
vi.mock('../adls-client', () => ({
  getAccountName: () => 'acct',
  pathToHttpsUrl: (c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`,
  listPaths: vi.fn(async () => []),
  resolveAbfssRoot: (c: string, p: string) => `abfss://${c}@acct.dfs.core.windows.net/${p}`,
  uploadFile: (...a: any[]) => uploadFile(...a),
}));
// Keep the real cloud-endpoints exports (mirror-engine → synapse-dev-client
// imports armHost from here) and only override the two helpers these tests need.
vi.mock('../cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cloud-endpoints')>()),
  dfsSuffix: () => 'dfs.core.windows.net',
  httpsToAbfss: (u: string) => u,
}));
// synapse-dev-client transitively pulls @azure/identity, so stub the one export
// mirror-engine imports from it (submitSparkBatchJob).
vi.mock('../synapse-dev-client', () => ({ submitSparkBatchJob: vi.fn(async () => ({})) }));
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
import { planSnowflakeCopyTransfer } from '../mirror-adf-copy';

const SNOW = {
  sourceType: 'Snowflake', server: 'myorg-acct123', database: 'ANALYTICS',
  tenantId: 't1', connectionId: 'conn-1234abcd',
};
const TABLES = [{ schema: 'PUBLIC', table: 'ORDERS' }];

describe('runMirrorAdfCopy (Snowflake)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const f of [upsertDataset, upsertPipeline, runPipeline, upsertTrigger, startTrigger, upsertLinkedService, getLinkedService, listActivityRuns, loadConnection]) f.mockClear();
    process.env.LOOM_ADF_NAME = 'adf-loom';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_DLZ_RG = 'rg';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls';
    // Snowflake's COPY INTO unload only writes to an Azure Blob endpoint, so a
    // staged copy through a Blob linked service is what makes the pairing legal
    // (#4083). Without it ADF rejects every Copy up front.
    process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE = 'ls-stage-blob';
    process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
    delete process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE;
    delete process.env.LOOM_MIRROR_COPY_CADENCE;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('provisions a copy-then-swap Parquet pipeline + schedule trigger', async () => {
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('adf-copy');
    expect(r.status).toBe('Running');
    expect(r.cdcName).toBe('loom_copy_abcd1234');
    // Two datasets (source + sink) per table.
    expect(upsertDataset).toHaveBeenCalledTimes(2);
    // The pipeline carries a Copy then a Delete activity (dependsOn Succeeded).
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const acts = pipeSpec.properties.activities;
    expect(acts.map((a: any) => a.type)).toEqual(['Copy', 'Delete']);
    expect(acts[1].dependsOn[0].dependencyConditions).toEqual(['Succeeded']);
    // The CURRENT connector, not the retired V1 one.
    expect(acts[0].typeProperties.source.type).toBe('SnowflakeV2Source');
    expect(acts[0].typeProperties.sink.type).toBe('ParquetSink');
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

  // ── #4083 defect 2: the Delete must never destroy the previous snapshot ────
  // Measured live on `loom_copy_1ac5d678`: the Delete ran FIRST with
  // `dependsOn: []`, succeeded, and the Copy then failed — four consecutive
  // runs, `rowsCopied: null` each time, Bronze emptied every run. The ordering
  // below is what makes a failed copy a no-op instead of data loss.
  it('copies BEFORE deleting, so a failed Copy cannot empty Bronze', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const acts: any[] = pipeSpec.properties.activities;
    const copy = acts.find((a) => a.type === 'Copy');
    const del = acts.find((a) => a.type === 'Delete');

    // The Copy is the ROOT of the graph — nothing runs before it.
    expect(copy.dependsOn).toEqual([]);
    // ...and the Delete is gated on that Copy having SUCCEEDED. If the Copy
    // fails the Delete is skipped and the previous snapshot survives.
    expect(del.dependsOn).toEqual([
      { activity: copy.name, dependencyConditions: ['Succeeded'] },
    ]);
    // The Delete must never be the root activity again.
    expect(del.dependsOn).not.toEqual([]);
    // Positionally too: whatever ADF does with the graph, the authored order
    // puts Copy first.
    expect(acts.indexOf(copy)).toBeLessThan(acts.indexOf(del));
  });

  it('deletes only the PREVIOUS generation, not the rows this run just wrote', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const del = (pipeSpec.properties.activities as any[]).find((a) => a.type === 'Delete');
    const ss = del.typeProperties.storeSettings;
    // Scoped to files last modified before this run started. A bare recursive
    // delete would also remove the freshly copied Parquet.
    expect(ss.modifiedDatetimeEnd).toEqual({
      value: '@pipeline().TriggerTime', type: 'Expression',
    });
    // Documented limitation: a modifiedDatetime filter is ignored unless
    // wildcardFileName is set too.
    //   https://learn.microsoft.com/azure/data-factory/delete-activity
    expect(ss.wildcardFileName).toBe('*');
  });

  // ── #4083 defect 1: the source/sink pairing must be legal ─────────────────
  it('stages the Snowflake unload through Blob — never a bare Gen2 direct copy', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const copy = (pipeSpec.properties.activities as any[]).find((a) => a.type === 'Copy');
    const tp = copy.typeProperties;
    // SnowflakeExportCopyCommand delegates the unload to Snowflake, which can
    // only write to a Blob endpoint — so it is ONLY legal with staging on.
    expect(tp.source.exportSettings.type).toBe('SnowflakeExportCopyCommand');
    expect(tp.enableStaging).toBe(true);
    expect(tp.stagingSettings.linkedServiceName.referenceName).toBe('ls-stage-blob');
    // Without MergeFiles only the last partitioned file of the unload lands.
    expect(tp.sink.storeSettings.copyBehavior).toBe('MergeFiles');
  });

  it('GATES instead of authoring a pipeline ADF would reject on every run', async () => {
    // No staging Blob linked service → there is no supported way to move a
    // Snowflake row into a Gen2 sink. Refuse at construction time rather than
    // shipping a pipeline whose Copy fails after the Delete already ran.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(r.gate?.missing).toBe('LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE');
    // Nothing was authored and nothing was run — no Delete can reach Bronze.
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(upsertDataset).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
    // The gate names the real cause, not a generic failure.
    expect(r.gate?.message).toContain('Azure Blob');
  });

  it('planSnowflakeCopyTransfer decides the shape without touching Azure', () => {
    expect(planSnowflakeCopyTransfer('ls-stage-blob')).toEqual({
      kind: 'staged', stagingLinkedService: 'ls-stage-blob',
    });
    const gated = planSnowflakeCopyTransfer(null);
    expect(gated.kind).toBe('unsupported');
    // An empty string is not a linked service name.
    expect(planSnowflakeCopyTransfer('').kind).toBe('unsupported');
  });

  it('AUTO-BINDS the Snowflake linked service from the connection — no env var needed', async () => {
    // The whole point of the change: LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE is
    // unset (see beforeEach) and the mirror still starts, because Loom builds
    // the linked service itself (auto-bind-by-default.md §5).
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);

    const snowLs = upsertLinkedService.mock.calls.find(
      ([, spec]: any[]) => spec?.properties?.type === 'SnowflakeV2',
    ) as any[];
    expect(snowLs).toBeTruthy();
    const tp = snowLs[1].properties.typeProperties;
    // Every coordinate the ADF Snowflake connector documents as required.
    expect(tp.accountIdentifier).toBe('myorg-acct123');
    expect(tp.database).toBe('ANALYTICS');
    expect(tp.warehouse).toBe('COMPUTE_WH');
    expect(tp.user).toBe('LOOM_SVC');
    expect(tp.role).toBe('LOOM_RO');
    expect(tp.authenticationType).toBe('Basic');
    // The credential is a Key Vault REFERENCE — a secret NAME, never a value.
    expect(tp.password.type).toBe('AzureKeyVaultSecret');
    expect(tp.password.secretName).toBe('loom-conn-1234abcd');
    expect(JSON.stringify(snowLs[1])).not.toContain('SecureString');
    // A Key Vault linked service was auto-bound for it to reference.
    expect(upsertLinkedService.mock.calls.some(
      ([, spec]: any[]) => spec?.properties?.type === 'AzureKeyVault',
    )).toBe(true);
    // The linked service is named after the Loom connection, not a random id.
    expect(snowLs[0]).toContain('demo_snowflake');
    expect(r.note).toContain(snowLs[0]);
  });

  it('key-pair auth maps onto privateKey, not password', async () => {
    loadConnection.mockResolvedValueOnce({ ...SNOW_CONN, authMethod: 'key-pair' } as any);
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    const snowLs = upsertLinkedService.mock.calls.find(
      ([, spec]: any[]) => spec?.properties?.type === 'SnowflakeV2',
    ) as any[];
    const tp = snowLs[1].properties.typeProperties;
    expect(tp.authenticationType).toBe('KeyPair');
    expect(tp.privateKey.type).toBe('AzureKeyVaultSecret');
    expect(tp.password).toBeUndefined();
  });

  it('honours an operator-pinned linked service instead of auto-binding', async () => {
    // Brownfield estates hand-tune linked services (private endpoints, SHIRs).
    // The env var must still win, and Loom must not clobber it.
    process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE = 'ls-snow-handmade';
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(upsertLinkedService.mock.calls.some(
      ([, spec]: any[]) => spec?.properties?.type === 'SnowflakeV2',
    )).toBe(false);
    const [, dsSpec] = upsertDataset.mock.calls[0] as any[];
    expect(dsSpec.properties.linkedServiceName.referenceName).toBe('ls-snow-handmade');
  });

  it('a LEGACY V1 pinned linked service gets V1 dataset + source types', async () => {
    // A SnowflakeV2Table on a V1 linked service is rejected by ADF, so the type
    // is READ from the factory rather than assumed.
    process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE = 'ls-snow-v1';
    getLinkedService.mockResolvedValueOnce({ name: 'ls-snow-v1', properties: { type: 'Snowflake' } } as any);
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    const [, dsSpec] = upsertDataset.mock.calls[0] as any[];
    expect(dsSpec.properties.type).toBe('SnowflakeTable');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const copy = (pipeSpec.properties.activities as any[]).find((a) => a.type === 'Copy');
    expect(copy.typeProperties.source.type).toBe('SnowflakeSource');
  });

  it('syncMode=snapshot does a one-time load with NO schedule trigger', async () => {
    const r = await runMirrorAdfCopy('id2', 'ws', { ...SNOW, syncMode: 'snapshot' as const }, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(upsertTrigger).not.toHaveBeenCalled();
    expect(startTrigger).not.toHaveBeenCalled();
  });

  it('syncMode=continuous registers a 15-minute TUMBLING WINDOW, not a schedule', async () => {
    // The three modes must be observably DIFFERENT in the factory, or the
    // selector is decoration (no-vaporware.md).
    const r = await runMirrorAdfCopy('id4', 'ws', { ...SNOW, syncMode: 'continuous' as const }, TABLES, 'note');
    expect(r.ok).toBe(true);
    const [, trgSpec] = upsertTrigger.mock.calls[0] as any[];
    expect(trgSpec.properties.type).toBe('TumblingWindowTrigger');
    expect(trgSpec.properties.typeProperties.frequency).toBe('Minute');
    expect(trgSpec.properties.typeProperties.interval).toBe(15);
    expect(trgSpec.properties.typeProperties.maxConcurrency).toBe(1);
  });

  it('gates honestly when the ADLS sink linked service is unset', async () => {
    delete process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(r.gate?.message).toContain('LOOM_MIRROR_ADLS_LINKED_SERVICE');
    // ...and it must NOT tell the operator to go make a Snowflake linked
    // service, which is the thing Loom now does for them.
    expect(r.gate?.message).not.toContain('set LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE');
  });

  it('gates with a NAMED connection problem when the mirror has no connection', async () => {
    const r = await runMirrorAdfCopy('id', 'ws', { ...SNOW, connectionId: undefined }, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.missing).toBe('connectionId');
    expect(upsertPipeline).not.toHaveBeenCalled();
  });

  it('gates when the bound connection is not a Snowflake connection', async () => {
    // The old wizard pointed Snowflake at `generic-sql`, which cannot carry an
    // account identifier or warehouse. Say so instead of failing at run time.
    loadConnection.mockResolvedValueOnce({ ...SNOW_CONN, type: 'generic-sql' } as any);
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.missing).toBe('snowflake-connection');
    expect(r.gate?.message).toContain('generic-sql');
  });

  it('gates naming the exact missing Snowflake coordinate', async () => {
    loadConnection.mockResolvedValueOnce({ ...SNOW_CONN, warehouse: undefined } as any);
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.missing).toContain('warehouse');
  });

  it('with NO table subset it enumerates the source and EXCLUDES Iceberg tables by default', async () => {
    listActivityRuns.mockResolvedValueOnce([{
      activityRunId: 'a', activityName: 'ListTables', activityType: 'Lookup',
      output: {
        value: [
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', IS_ICEBERG: 'NO' },
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ICE_EVENTS', IS_ICEBERG: 'YES' },
        ],
      },
    }] as any);
    const r = await runMirrorAdfCopy('id5', 'ws', SNOW, [], 'note');
    expect(r.ok).toBe(true);
    expect(r.tables.map((t) => t.table)).toEqual(['ORDERS']);
    expect(r.note).toContain('excluded 1 Snowflake-managed Iceberg table');
  });

  it('includeIcebergTables=true MIRRORS the Iceberg tables too', async () => {
    // The toggle was declared on MirrorSource and plumbed through five routes
    // while the engine never read it. This asserts it actually decides what
    // replicates.
    listActivityRuns.mockResolvedValueOnce([{
      activityRunId: 'a', activityName: 'ListTables', activityType: 'Lookup',
      output: {
        value: [
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', IS_ICEBERG: 'NO' },
          { TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ICE_EVENTS', IS_ICEBERG: 'YES' },
        ],
      },
    }] as any);
    const r = await runMirrorAdfCopy('id6', 'ws', { ...SNOW, includeIcebergTables: true }, [], 'note');
    expect(r.ok).toBe(true);
    expect(r.tables.map((t) => t.table).sort()).toEqual(['ICE_EVENTS', 'ORDERS']);
    expect(r.note).toContain('including 1 Snowflake-managed Iceberg table');
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
