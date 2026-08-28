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
const stopTrigger = vi.fn(async () => {});
// A mirror that has NEVER been provisioned — ADF answers 404 for both. Tests
// that model an already-provisioned mirror override these per case.
//
// `status` rides on the error object because that is how adf-client's
// jsonOrThrow reports it, and the disarm path keys on exactly that field to tell
// "absent" (nothing to repair) apart from "unreadable" (repair state UNKNOWN).
// A mock that threw a bare Error would collapse those two into one and let the
// disarm claim a clean estate it never observed.
const notFound = (label: string) =>
  Object.assign(new Error(`${label} failed 404: not found`), { status: 404 });
// The explicit `Promise<any>` matters: without it TypeScript infers
// `Promise<never>` from a body that only ever throws, and every
// `mockImplementation` below that returns a real pipeline/trigger becomes a type
// error — which would push tests toward `as never` casts instead of modelling a
// provisioned mirror honestly.
const getPipeline = vi.fn(async (n: string): Promise<any> => { throw notFound(`getPipeline(${n})`); });
const getTrigger = vi.fn(async (n: string): Promise<any> => { throw notFound(`getTrigger(${n})`); });
const upsertLinkedService = vi.fn(async (n: string) => ({ name: n, properties: { type: 'SnowflakeV2' } }));
// Name-AWARE so the staging read and the source read cannot be confused for one
// another. The engine now reads BOTH linked services back from the factory (the
// staging one to prove it is Blob-typed, the source one to pick V1 vs V2
// dataset types), so a name-blind mock would answer the staging probe with a
// Snowflake type and gate every otherwise-healthy test.
const defaultLinkedServiceTypes = async (n: string) => (
  n === 'ls-stage-blob'
    ? { name: n, properties: { type: 'AzureBlobStorage' } }
    : { name: n, properties: { type: 'SnowflakeV2' } }
);
const getLinkedService = vi.fn(defaultLinkedServiceTypes);
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
  stopTrigger: (...a: any[]) => stopTrigger(...a),
  getPipeline: (...a: any[]) => getPipeline(...a),
  getTrigger: (...a: any[]) => getTrigger(...a),
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
// The staging SAS. The value is an obvious NON-credential: these tests assert
// the SHAPE that reaches ADF (container-scoped, SecureString) and must never
// carry anything that looks like a real token.
const generateContainerWriteSasUri = vi.fn(async (container: string, _ttlHours: number, account: string) => ({
  containerSasUri: `https://${account}.blob.core.windows.net/${container}?sv=TEST-NOT-A-CREDENTIAL`,
  expiresAt: '2026-09-02T00:00:00.000Z',
}));
vi.mock('../adls-client', () => ({
  getAccountName: () => 'acct',
  pathToHttpsUrl: (c: string, p: string) => `https://acct.dfs.core.windows.net/${c}/${p}`,
  listPaths: vi.fn(async () => []),
  resolveAbfssRoot: (c: string, p: string) => `abfss://${c}@acct.dfs.core.windows.net/${p}`,
  uploadFile: (...a: any[]) => uploadFile(...a),
  generateContainerWriteSasUri: (...a: any[]) => generateContainerWriteSasUri(...a),
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
import { adfDenialEvidence, describeTriggerStartFailure, planSnowflakeCopyTransfer } from '../mirror-adf-copy';

const SNOW = {
  sourceType: 'Snowflake', server: 'myorg-acct123', database: 'ANALYTICS',
  tenantId: 't1', connectionId: 'conn-1234abcd',
};
const TABLES = [{ schema: 'PUBLIC', table: 'ORDERS' }];
// MAX_TABLES is 50, and the live estate's own mirror (`loom_copy_1ac5d678`)
// carries THREE tables — so a single-table fixture never exercises the loop that
// actually authors production pipelines. Every ordering assertion below runs
// against this instead, because `acts.find(a => a.type === 'Delete')` only ever
// returns the FIRST pair: with one table that is the whole pipeline, and a
// delete-first regression on tables 2..N would ship green.
const TABLES_MULTI = [
  { schema: 'PUBLIC', table: 'ORDERS' },
  { schema: 'SALES', table: 'CUSTOMERS' },
];

/**
 * The EXACT shape measured on the live estate (`loom_copy_1ac5d678`,
 * 2026-08-26): per table a Delete with `dependsOn: []` — a ROOT activity ADF
 * runs unconditionally — and the Copy chained behind it. This is what an older
 * build left in the factory, and what a gate alone does nothing about.
 */
const deleteFirstPipeline = (tables: string[]) => ({
  name: 'loom_copy_abcd1234',
  properties: {
    folder: { name: 'loom-mirrors' },
    annotations: ['loom-mirror', 'abcd1234-ef'],
    activities: tables.flatMap((t) => [
      { name: `Delete_${t}`, type: 'Delete', dependsOn: [], typeProperties: {} },
      {
        name: `Copy_${t}`, type: 'Copy',
        dependsOn: [{ activity: `Delete_${t}`, dependencyConditions: ['Succeeded'] }],
        typeProperties: {},
      },
    ]),
  },
});

/** The CORRECTED shape: Copy is the root, Delete is gated on its success. */
const copyFirstPipeline = (tables: string[]) => ({
  name: 'loom_copy_abcd1234',
  properties: {
    folder: { name: 'loom-mirrors' },
    activities: tables.flatMap((t) => [
      { name: `Copy_${t}`, type: 'Copy', dependsOn: [], typeProperties: {} },
      {
        name: `DeletePrev_${t}`, type: 'Delete',
        dependsOn: [{ activity: `Copy_${t}`, dependencyConditions: ['Succeeded'] }],
        typeProperties: {},
      },
    ]),
  },
});

const startedTrigger = async (n: string) => ({
  name: n, properties: { type: 'ScheduleTrigger', runtimeState: 'Started' },
});

describe('runMirrorAdfCopy (Snowflake)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const f of [upsertDataset, upsertPipeline, runPipeline, upsertTrigger, startTrigger, stopTrigger, getPipeline, getTrigger, upsertLinkedService, getLinkedService, listActivityRuns, loadConnection]) f.mockClear();
    // mockClear does NOT undo a mockImplementation, so a per-test override
    // would leak into every later test. Restore the name-aware default.
    getLinkedService.mockImplementation(defaultLinkedServiceTypes);
    // Same hazard, and worse here: a leaked "this mirror already exists"
    // override would silently turn every later test into a disarm test.
    getPipeline.mockImplementation(async (n: string) => { throw notFound(`getPipeline(${n})`); });
    getTrigger.mockImplementation(async (n: string) => { throw notFound(`getTrigger(${n})`); });
    stopTrigger.mockImplementation(async () => {});
    upsertPipeline.mockImplementation(async (n: string) => ({ name: n }));
    process.env.LOOM_ADF_NAME = 'adf-loom';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub';
    process.env.LOOM_DLZ_RG = 'rg';
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls';
    // Snowflake's COPY INTO unload only writes to an Azure Blob endpoint, so a
    // staged copy through a Blob linked service is what makes the pairing legal
    // (#4083). Without it ADF rejects every Copy up front.
    process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE = 'ls-stage-blob';
    // Most cases below model a deployment that PINS a staging linked service.
    // The auto-bind cases set LOOM_MIRROR_STAGING_ACCOUNT explicitly; deleting
    // it here stops one of those leaking into a gate test and silently turning
    // "this deployment is gated" into "this deployment binds for itself".
    delete process.env.LOOM_MIRROR_STAGING_ACCOUNT;
    generateContainerWriteSasUri.mockClear();
    generateContainerWriteSasUri.mockImplementation(async (container: string, _t: number, account: string) => ({
      containerSasUri: `https://${account}.blob.core.windows.net/${container}?sv=TEST-NOT-A-CREDENTIAL`,
      expiresAt: '2026-09-02T00:00:00.000Z',
    }));
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
  // Measured live on `loom_copy_1ac5d678` (2026-08-26): three tables, each with
  // its Delete as a ROOT activity (`dependsOn: []`); the trigger Started and
  // hourly; 14 triggered runs that day, every Delete `Succeeded` and every Copy
  // `Failed`. Those Deletes removed nothing ONLY because the Copy had never once
  // succeeded, so the Bronze prefix had never been populated. The ordering below
  // is what makes a failed copy a no-op instead of data loss once it has.
  //
  // Asserted PER TABLE. The previous version of this test used
  // `acts.find(a => a.type === 'Copy'|'Delete')` on a one-table fixture, so it
  // could only ever see the first pair — a mutation restoring delete-as-root for
  // tables 2..50 passed it.
  it('copies BEFORE deleting for EVERY table, not just the first', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES_MULTI, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const acts: any[] = pipeSpec.properties.activities;

    // The whole population, counted — not a sample of it.
    const copies = acts.filter((a) => a.type === 'Copy');
    const deletes = acts.filter((a) => a.type === 'Delete');
    expect(copies).toHaveLength(TABLES_MULTI.length);
    expect(deletes).toHaveLength(TABLES_MULTI.length);

    // Every Copy is a root activity: nothing runs before any of them.
    for (const copy of copies) {
      expect(copy.dependsOn, `Copy ${copy.name} must be a root activity`).toEqual([]);
    }

    const byName = new Map(acts.map((a) => [a.name, a]));
    for (const del of deletes) {
      // Never a root activity again — for ANY table.
      expect(del.dependsOn, `Delete ${del.name} must not be a root activity`).not.toEqual([]);
      // Gated on a COPY that SUCCEEDED, resolved THROUGH THE GRAPH. A dependency
      // on some other activity, or on a Copy with a Completed/Failed/Skipped
      // condition, does not satisfy this.
      const gatedOnCopySuccess = del.dependsOn.some(
        (d: any) => d.dependencyConditions?.includes('Succeeded') && byName.get(d.activity)?.type === 'Copy',
      );
      expect(gatedOnCopySuccess, `Delete ${del.name} must depend on a SUCCEEDED Copy`).toBe(true);
    }

    // ...and each table's Delete is chained to ITS OWN table's Copy. A Delete
    // wired to a DIFFERENT table's Copy would satisfy every check above while
    // clearing table B's Bronze on table A's success.
    for (const t of TABLES_MULTI) {
      const copy = acts.find((a) => a.type === 'Copy' && a.name.includes(t.table));
      const del = acts.find((a) => a.type === 'Delete' && a.name.includes(t.table));
      expect(copy, `no Copy authored for ${t.schema}.${t.table}`).toBeTruthy();
      expect(del, `no Delete authored for ${t.schema}.${t.table}`).toBeTruthy();
      expect(del.dependsOn).toEqual([{ activity: copy.name, dependencyConditions: ['Succeeded'] }]);
      // Positionally too: whatever ADF does with the graph, the authored order
      // puts each table's Copy ahead of its Delete.
      expect(acts.indexOf(copy)).toBeLessThan(acts.indexOf(del));
    }
  });

  it('scopes the Delete to the PREVIOUS generation for EVERY table', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES_MULTI, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const deletes = (pipeSpec.properties.activities as any[]).filter((a) => a.type === 'Delete');
    expect(deletes).toHaveLength(TABLES_MULTI.length);
    for (const del of deletes) {
      const ss = del.typeProperties.storeSettings;
      // Scoped to files last modified before this run started. A bare recursive
      // delete would also remove the freshly copied Parquet.
      expect(ss.modifiedDatetimeEnd, `Delete ${del.name} unscoped`).toEqual({
        value: '@pipeline().TriggerTime', type: 'Expression',
      });
      // Documented limitation: a modifiedDatetime filter is ignored unless
      // wildcardFileName is set too.
      //   https://learn.microsoft.com/azure/data-factory/delete-activity
      expect(ss.wildcardFileName, `Delete ${del.name} missing wildcard`).toBe('*');
    }
  });

  it('stages EVERY table through Blob — never a bare Gen2 direct copy', async () => {
    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES_MULTI, 'note');
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const copies = (pipeSpec.properties.activities as any[]).filter((a) => a.type === 'Copy');
    expect(copies).toHaveLength(TABLES_MULTI.length);
    for (const copy of copies) {
      const tp = copy.typeProperties;
      // SnowflakeExportCopyCommand delegates the unload to Snowflake, which can
      // only write to a Blob endpoint — so it is ONLY legal with staging on.
      expect(tp.source.exportSettings.type, `Copy ${copy.name}`).toBe('SnowflakeExportCopyCommand');
      expect(tp.enableStaging, `Copy ${copy.name} unstaged`).toBe(true);
      expect(tp.stagingSettings.linkedServiceName.referenceName).toBe('ls-stage-blob');
      // Without MergeFiles only the last partitioned file of the unload lands.
      expect(tp.sink.storeSettings.copyBehavior).toBe('MergeFiles');
    }
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
    // No NEW pipeline was authored. This mirror does not exist in the factory —
    // getPipeline/getTrigger 404 by default — which is the ONLY case in which
    // "nothing can reach Bronze" is a true statement. For an already-provisioned
    // mirror the gate alone changes nothing; that is what the disarm tests below
    // cover.
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(upsertDataset).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
    // The gate names the real cause, not a generic failure.
    expect(r.gate?.message).toContain('Azure Blob');
    // ...and states the true post-state of the estate rather than leaving the
    // operator to assume the gate made an existing mirror safe (R7).
    expect(r.gate?.message).toContain('no previously provisioned pipeline exists');
  });

  // ── The hole a gate alone leaves open ─────────────────────────────────────
  // Every gate returns before `upsertPipeline`, so for a mirror provisioned by
  // an older build the delete-first definition survives untouched and its
  // trigger keeps firing. Landing a Copy fix while that is still armed is
  // strictly MORE dangerous than the broken state — the machinery is harmless
  // today only because the Copy never succeeds, so Bronze is never populated for
  // the Delete to destroy.
  it('DISARMS an already-provisioned delete-first pipeline when it gates', async () => {
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    getPipeline.mockImplementation(async () => deleteFirstPipeline(['CUSTOMERS', 'PRODUCTS', 'ORDERS']) as any);
    getTrigger.mockImplementation(startedTrigger as any);

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.status).toBe('Gated');

    // The trigger that was firing hourly is STOPPED.
    expect(stopTrigger).toHaveBeenCalledWith('loom_copy_abcd1234_trg');

    // ...and the STORED definition no longer holds a delete-first activity.
    expect(upsertPipeline).toHaveBeenCalledTimes(1);
    const [name, spec] = upsertPipeline.mock.calls[0] as any[];
    expect(name).toBe('loom_copy_abcd1234');
    const acts: any[] = spec.properties.activities;
    expect(acts.filter((a) => a.type === 'Delete')).toHaveLength(0);
    // The Copies are kept — removing them would just be deleting the mirror.
    expect(acts.filter((a) => a.type === 'Copy')).toHaveLength(3);
    // Every dependency on a removed Delete is pruned. A dangling dependsOn
    // makes the whole pipeline invalid, so a half-done strip would be worse
    // than none.
    for (const a of acts) expect(a.dependsOn, `${a.name} still chained to a removed activity`).toEqual([]);
    // Unrelated properties survive the rewrite.
    expect(spec.properties.folder).toEqual({ name: 'loom-mirrors' });

    // The gate SAYS what it did, in countable terms.
    expect(r.gate?.message).toContain('3 delete-first activities were REMOVED');
    expect(r.gate?.message).toContain('was STOPPED');
  });

  it('stops the trigger BEFORE rewriting the definition', async () => {
    // Order matters for the half-done case. Stop-then-rewrite leaves a
    // still-dangerous definition that cannot FIRE; rewrite-then-stop leaves a
    // live trigger on a delete-first pipeline if the rewrite fails, which is the
    // exact state the disarm exists to eliminate.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    getPipeline.mockImplementation(async () => deleteFirstPipeline(['ORDERS']) as any);
    getTrigger.mockImplementation(startedTrigger as any);

    await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(stopTrigger).toHaveBeenCalled();
    expect(upsertPipeline).toHaveBeenCalled();
    expect(stopTrigger.mock.invocationCallOrder[0])
      .toBeLessThan(upsertPipeline.mock.invocationCallOrder[0]);
  });

  it('leaves a CORRECTLY ordered Delete alone — it is load-bearing', async () => {
    // Stripping every Delete would trade data loss for unbounded duplicate
    // accumulation: the copy-then-swap Delete is what retires the previous
    // generation. Only Deletes NOT gated on a successful Copy are removed.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    getPipeline.mockImplementation(async () => copyFirstPipeline(['ORDERS', 'CUSTOMERS']) as any);
    getTrigger.mockImplementation(startedTrigger as any);

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.status).toBe('Gated');
    // Nothing to repair in the definition, so it is not rewritten at all.
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(r.gate?.message).toContain('no delete-first activity');
    // The trigger is still stopped: a mirror Loom cannot run correctly should
    // not keep firing failing runs on a cadence.
    expect(stopTrigger).toHaveBeenCalledWith('loom_copy_abcd1234_trg');
  });

  it('REPORTS a failed rewrite instead of implying the mirror is now safe', async () => {
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    getPipeline.mockImplementation(async () => deleteFirstPipeline(['ORDERS']) as any);
    getTrigger.mockImplementation(startedTrigger as any);
    upsertPipeline.mockRejectedValue(new Error('authorization failed for the Console UAMI'));

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.status).toBe('Gated');
    // The failure is named, with its cause, not swallowed into a cheerful gate.
    expect(r.gate?.message).toContain('could NOT be rewritten');
    expect(r.gate?.message).toContain('authorization failed for the Console UAMI');
    // ...and because the stop ran FIRST, the still-dangerous definition is at
    // least unreachable from a schedule. That is the payoff of the ordering.
    expect(stopTrigger).toHaveBeenCalled();
    expect(r.gate?.message).toContain('was STOPPED');
  });

  it('does NOT claim a clean estate when it could not read the factory', async () => {
    // 403 is not 404. "I could not look" must never be reported as "there is
    // nothing there" (memory: csa_loom_unknown_as_negative_class), which is the
    // failure mode deploy-integrity R7 was written for.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    const denied = (label: string) => Object.assign(new Error(`${label} failed 403: Forbidden`), { status: 403 });
    getPipeline.mockImplementation(async () => { throw denied('getPipeline'); });
    getTrigger.mockImplementation(async () => { throw denied('getTrigger'); });
    stopTrigger.mockRejectedValue(denied('stopTrigger'));

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.status).toBe('Gated');
    expect(r.gate?.message).toContain('UNKNOWN');
    expect(r.gate?.message).not.toContain('no previously provisioned pipeline exists');
    expect(r.gate?.message).not.toContain('has no schedule trigger');
  });

  // ── auto-bind-by-default.md §5: the staging hop is DEPLOYED, not requested ──
  // The gate above is what a deployment predating mirror-staging.bicep sees. On
  // a current deploy the platform provisions the scratch account and Loom binds
  // the linked service itself, so the operator sets nothing.
  it('AUTO-BINDS the staging linked service from the deployed scratch account', async () => {
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    process.env.LOOM_MIRROR_STAGING_ACCOUNT = 'saloomstgtest';
    // The auto-bound linked service reads back as Blob-typed, as ADF would.
    getLinkedService.mockImplementation(async (n: string) => (
      n === 'loom_mirror_staging_blob'
        ? { name: n, properties: { type: 'AzureBlobStorage' } }
        : { name: n, properties: { type: 'SnowflakeV2' } }
    ));

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    // NOT gated — this is the whole point.
    expect(r.ok).toBe(true);

    const stageLs = upsertLinkedService.mock.calls.find(
      ([, spec]: any[]) => spec?.properties?.type === 'AzureBlobStorage',
    ) as any[];
    expect(stageLs, 'no AzureBlobStorage linked service was bound').toBeTruthy();
    expect(stageLs[0]).toBe('loom_mirror_staging_blob');

    // The SAS is minted against the DEPLOYED account, for the staging container.
    expect(generateContainerWriteSasUri).toHaveBeenCalledWith('loom-mirror-staging', expect.any(Number), 'saloomstgtest');
    // ...and reaches ADF as an encrypted SecureString, never a plain property.
    const tp = stageLs[1].properties.typeProperties;
    expect(tp.sasUri.type).toBe('SecureString');
    expect(tp.sasUri.value).toContain('saloomstgtest.blob.');
    // No account key anywhere — the account is deployed with shared-key access off.
    expect(JSON.stringify(stageLs[1])).not.toContain('accountKey');

    // The pipeline stages through the linked service Loom just bound.
    const [, pipeSpec] = upsertPipeline.mock.calls[0] as any[];
    const copy = (pipeSpec.properties.activities as any[]).find((a) => a.type === 'Copy');
    expect(copy.typeProperties.stagingSettings.linkedServiceName.referenceName).toBe('loom_mirror_staging_blob');
    // The SAS URI is CONTAINER-scoped, so the path must be RELATIVE to it.
    // Prefixing the container again resolves to
    // `loom-mirror-staging/loom-mirror-staging/<id>`, which ADF would create as
    // a nested folder the Delete never sweeps.
    expect(copy.typeProperties.stagingSettings.path).toBe('abcd1234-ef');
    expect(copy.typeProperties.stagingSettings.path).not.toContain('loom-mirror-staging');

    // The note states when the credential runs out rather than leaving a
    // week-from-now failure as a mystery (deploy-integrity.md R7).
    expect(r.note).toContain('2026-09-02T00:00:00.000Z');
  });

  it('an operator-PINNED staging linked service still wins over the convention name', async () => {
    // Brownfield estates hand-tune linked services (private endpoints, SHIRs).
    process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE = 'ls-stage-handmade';
    process.env.LOOM_MIRROR_STAGING_ACCOUNT = 'saloomstgtest';
    getLinkedService.mockImplementation(async (n: string) => (
      n === 'ls-stage-handmade'
        ? { name: n, properties: { type: 'AzureBlobStorage' } }
        : { name: n, properties: { type: 'SnowflakeV2' } }
    ));

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    const stageLs = upsertLinkedService.mock.calls.find(
      ([, spec]: any[]) => spec?.properties?.type === 'AzureBlobStorage',
    ) as any[];
    expect(stageLs[0]).toBe('ls-stage-handmade');
    expect(upsertLinkedService.mock.calls.some(([n]: any[]) => n === 'loom_mirror_staging_blob')).toBe(false);
  });

  it('GATES with the real reason when the staging bind FAILS', async () => {
    // The likeliest live failure: Storage Blob Delegator has not propagated to
    // the Console UAMI yet, so getUserDelegationKey is refused. Say that,
    // rather than reporting a missing env var the operator did not forget.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    process.env.LOOM_MIRROR_STAGING_ACCOUNT = 'saloomstgtest';
    generateContainerWriteSasUri.mockRejectedValue(
      new Error('AuthorizationPermissionMismatch: getUserDelegationKey denied'),
    );

    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(r.gate?.missing).toBe('staging-linked-service-bind-failed');
    expect(r.gate?.message).toContain('getUserDelegationKey denied');
    expect(r.gate?.message).toContain('saloomstgtest');
    // It names the module that deploys the account + grants, so the fix is
    // locatable rather than a guess.
    expect(r.gate?.message).toContain('mirror-staging.bicep');
    // And nothing was authored on a pairing Loom could not establish.
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('the staging gate no longer blames a bicep module that has no linked service', async () => {
    // deploy-integrity.md R7. The previous message asserted that
    // landing-zone/adf.bicep deploys this linked service. It does not — that
    // file declares ZERO linked services, and no bicep in the repo declares
    // one, because the SAS a Snowflake staging linked service needs cannot be
    // minted in bicep without shared-key access this estate's policy denies.
    delete process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE;
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.status).toBe('Gated');
    expect(r.gate?.message).not.toContain('adf.bicep');
    expect(r.gate?.message).toContain('mirror-staging.bicep');
    expect(r.gate?.message).toContain('LOOM_MIRROR_STAGING_ACCOUNT');
  });

  it('planSnowflakeCopyTransfer decides the shape without touching Azure', () => {
    expect(planSnowflakeCopyTransfer('ls-stage-blob', 'AzureBlobStorage')).toEqual({
      kind: 'staged', stagingLinkedService: 'ls-stage-blob',
    });
    const gated = planSnowflakeCopyTransfer(null, null);
    expect(gated.kind).toBe('unsupported');
    // An empty string is not a linked service name.
    expect(planSnowflakeCopyTransfer('', null).kind).toBe('unsupported');
  });

  it('REJECTS a staging linked service that is set but not Blob-typed', () => {
    // The defect this replaced: the gate checked only that a NON-EMPTY STRING
    // was set. Pointing the variable at `ls-adls` — the ADLS Gen2 linked
    // service every Loom deployment already has, and the obvious thing to reach
    // for when a gate says "point it at one" — passed, authored the pipeline,
    // and reproduced the original #4083 error at run time.
    const r = planSnowflakeCopyTransfer('ls-adls', 'AzureBlobFS');
    expect(r.kind).toBe('unsupported');
    // The message names the type ACTUALLY found, so the operator is not left
    // guessing which linked service is wrong (deploy-integrity.md R7).
    expect(r.kind === 'unsupported' && r.message).toContain('AzureBlobFS');
    expect(r.kind === 'unsupported' && r.message).toContain('ls-adls');

    // Every other type ADF can return is rejected the same way.
    for (const t of ['AzureSqlDatabase', 'SnowflakeV2', 'AzureKeyVault', 'AzureDatabricks']) {
      expect(planSnowflakeCopyTransfer('ls-x', t).kind).toBe('unsupported');
    }
  });

  it('UNKNOWN type is reported as unreadable, not as the wrong type', () => {
    // null = the linked service could not be READ. That is not evidence the
    // type is wrong, and it is not evidence the pairing is fine. It fails
    // closed and says which of the two it is
    // (memory: csa_loom_unknown_as_negative_class).
    const r = planSnowflakeCopyTransfer('ls-stage-blob', null);
    expect(r.kind).toBe('unsupported');
    expect(r.kind === 'unsupported' && r.missing).toBe('staging-linked-service-unreadable');
    expect(r.kind === 'unsupported' && r.message).toContain('could not READ');
    // It must NOT claim the type is wrong — that would be an untrue error.
    expect(r.kind === 'unsupported' && r.message).not.toContain('which is a ');
  });

  it('GATES when the staging linked service is the Gen2 sink — END TO END', async () => {
    // The same defect, proven through the real entry point rather than only the
    // pure function: a name that resolves to an AzureBlobFS linked service must
    // author NOTHING.
    process.env.LOOM_MIRROR_STAGING_BLOB_LINKED_SERVICE = 'ls-adls';
    getLinkedService.mockImplementation(async (n: string) => (
      n === 'ls-adls'
        ? { name: n, properties: { type: 'AzureBlobFS' } }
        : { name: n, properties: { type: 'SnowflakeV2' } }
    ));
    const r = await runMirrorAdfCopy('abcd1234-ef', 'ws1', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(r.gate?.message).toContain('AzureBlobFS');
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(upsertDataset).not.toHaveBeenCalled();
    expect(runPipeline).not.toHaveBeenCalled();
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
    // Keyed by NAME, not by call order. The staging linked service is read
    // FIRST (the pairing gate runs before the source is bound), so a
    // `mockResolvedValueOnce` here would be consumed by the staging probe and
    // this test would silently stop exercising the V1 path.
    getLinkedService.mockImplementation(async (n: string) => (
      n === 'ls-stage-blob'
        ? { name: n, properties: { type: 'AzureBlobStorage' } }
        : { name: n, properties: { type: 'Snowflake' } }
    ));
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

  it('syncMode=snapshot RETIRES a trigger left by a previous sync mode', async () => {
    // Switching a mirror from incremental to snapshot used to leave the old
    // ScheduleTrigger firing the pipeline on the old cadence forever, which made
    // the sync-mode selector a lie — the same stale-binding class as the
    // delete-first pipeline (auto-bind-by-default.md §3).
    getTrigger.mockImplementation(startedTrigger as any);
    const r = await runMirrorAdfCopy('id2', 'ws', { ...SNOW, syncMode: 'snapshot' as const }, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(upsertTrigger).not.toHaveBeenCalled();
    expect(stopTrigger).toHaveBeenCalledWith('loom_copy_id2_trg');
    expect(r.note).toContain('was stopped');
  });

  it('snapshot says so when it could NOT check for a stale trigger', async () => {
    getTrigger.mockImplementation(async () => {
      throw Object.assign(new Error('getTrigger failed 403: Forbidden'), { status: 403 });
    });
    const r = await runMirrorAdfCopy('id2', 'ws', { ...SNOW, syncMode: 'snapshot' as const }, TABLES, 'note');
    expect(r.ok).toBe(true);
    // It must not imply the one-time load is the only thing that will run.
    expect(r.note).toContain('could NOT confirm');
    expect(r.note).toContain('403');
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

  it('AUTO-CREATES the ADLS Bronze sink when no linked service is pinned', async () => {
    // The defect this locks: the Snowflake path used to GATE here, demanding
    // LOOM_MIRROR_ADLS_LINKED_SERVICE — a value no shipped deployment sets and
    // that Loom can compose itself from LOOM_BRONZE_URL. The SQL mirror path has
    // always auto-created its own sink; this is the asymmetry closed.
    delete process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(r.status).toBe('Running');
    const sink = upsertLinkedService.mock.calls.find(
      ([n]) => n === 'loom_mirror_sink_adls',
    ) as any[] | undefined;
    expect(sink).toBeTruthy();
    expect(sink![1].properties.type).toBe('AzureBlobFS');
    // Sovereign-correct by construction: the host comes from dfsSuffix(), and
    // there is NO credential field — the factory's own MI authenticates.
    expect(sink![1].properties.typeProperties.url).toBe('https://acct.dfs.core.windows.net');
    expect(JSON.stringify(sink![1])).not.toContain('SecureString');
    // ...and the Parquet sink datasets bind to it.
    const sinkDs = upsertDataset.mock.calls.find(
      ([, spec]: any[]) => spec.properties.type === 'Parquet',
    ) as any[];
    expect(sinkDs[1].properties.linkedServiceName.referenceName).toBe('loom_mirror_sink_adls');
    expect(r.note).toContain('auto-bound by Loom');
  });

  it('honours an operator-PINNED ADLS sink instead of creating one', async () => {
    process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE = 'ls-adls-byo';
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(upsertLinkedService.mock.calls.some(([n]) => n === 'loom_mirror_sink_adls')).toBe(false);
    const sinkDs = upsertDataset.mock.calls.find(
      ([, spec]: any[]) => spec.properties.type === 'Parquet',
    ) as any[];
    expect(sinkDs[1].properties.linkedServiceName.referenceName).toBe('ls-adls-byo');
    expect(r.note).toContain('pinned by LOOM_MIRROR_ADLS_LINKED_SERVICE');
  });

  it('gates on the LAKE, never on a linked-service env var, when Bronze is unwired', async () => {
    delete process.env.LOOM_MIRROR_ADLS_LINKED_SERVICE;
    delete process.env.LOOM_BRONZE_URL;
    const r = await runMirrorAdfCopy('id', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    expect(upsertPipeline).not.toHaveBeenCalled();
    expect(r.gate?.missing).toBe('LOOM_BRONZE_URL');
    // The remediation names the DEPLOY, not a linked service the operator would
    // have to hand-build — that instruction is the thing this change removed.
    expect(r.gate?.message).not.toContain('LOOM_MIRROR_ADLS_LINKED_SERVICE');
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

  // ── R7: the remediation must match the failure the BACKEND reported ───────
  it('an MFA rejection reaches the operator WITHOUT grant advice (the live regression)', async () => {
    // END TO END through the real call path — the pure classifier being right
    // proves nothing if `listSnowflakeTables` does not use it. With no table
    // subset the engine enumerates, the enumeration pipeline fails, and the
    // gate message is what the operator actually reads.
    //
    // Identifiers are elided exactly as they were reported (PUBLIC REPO); the
    // Snowflake driver's own sentence is verbatim, because that string IS the
    // regression.
    const MFA =
      'Operation on target CountSchemas failed: ... [Snowflake] 394509 (08004): '
      + 'Failed to authenticate: MFA authentication is required, but none of your current '
      + 'MFA methods are supported for programmatic authentication.';
    getPipelineRun.mockResolvedValueOnce({ runId: 'run-1', pipelineName: 'p', status: 'Failed', message: MFA } as any);

    const r = await runMirrorAdfCopy('id7', 'ws', SNOW, [], 'note');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('Gated');
    // Snowflake's own words survive, verbatim. That part was always right.
    expect(r.gate?.message).toContain(MFA);
    // …and the advice that used to follow them does not.
    expect(r.gate?.message).not.toMatch(/USAGE on|SELECT on/i);
    expect(r.gate?.message).not.toContain('warehouse can start');
    expect(r.gate?.message).not.toContain(SNOW.database);
    // The remediation that IS true of an MFA rejection.
    expect(r.gate?.message).toMatch(/key-pair|TYPE = SERVICE/i);
    expect(r.gate?.missing).toBe('snowflake-authentication');
  }, 20_000);

  it('a GRANTS failure still gets the grant advice — the fix is conditional, not a deletion', async () => {
    const AUTHZ =
      'Operation on target ListTables failed: 003001 (42501): SQL access control error: '
      + "Insufficient privileges to operate on schema 'PLACEHOLDER_SCHEMA'.";
    getPipelineRun.mockResolvedValueOnce({ runId: 'run-1', pipelineName: 'p', status: 'Failed', message: AUTHZ } as any);

    const r = await runMirrorAdfCopy('id8', 'ws', SNOW, [], 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.message).toContain(AUTHZ);
    expect(r.gate?.message).toContain(`USAGE on database ${SNOW.database}`);
    expect(r.gate?.missing).toBe('snowflake-grants');
  }, 20_000);

  it('an UNRECOGNISED enumeration failure asserts no cause at all', async () => {
    const ODD = 'Operation on target ListTables failed: ErrorCode=UserErrorOdbcOperationFailed.';
    getPipelineRun.mockResolvedValueOnce({ runId: 'run-1', pipelineName: 'p', status: 'Failed', message: ODD } as any);

    const r = await runMirrorAdfCopy('id9', 'ws', SNOW, [], 'note');
    expect(r.ok).toBe(false);
    expect(r.gate?.message).toContain(ODD);
    expect(r.gate?.message).toMatch(/asserts NO cause/);
    expect(r.gate?.message).not.toMatch(/USAGE on|SELECT on|AUTO_RESUME|firewall/i);
    // Unknown keeps the pre-existing key: the read failed, cause unclassified.
    expect(r.gate?.missing).toBe('snowflake-read');
  }, 20_000);

  it('a trigger that fails for a NON-permission reason is not blamed on RBAC', async () => {
    startTrigger.mockRejectedValueOnce(new Error('startTrigger failed 409: {"error":{"code":"Conflict"}}'));
    const r = await runMirrorAdfCopy('id10', 'ws', SNOW, TABLES, 'note');
    // The initial load DID run — that is established and stated.
    expect(r.ok).toBe(true);
    expect(r.note).toContain('Initial load ran');
    expect(r.note).toContain('Conflict');
    expect(r.note).not.toContain('Data Factory Contributor');
    expect(r.note).toContain('did NOT establish why');
  });

  it('a trigger REFUSED by ARM still names the exact role to grant', async () => {
    startTrigger.mockRejectedValueOnce(
      Object.assign(new Error('startTrigger failed 403: {"error":{"code":"AuthorizationFailed"}}'), { status: 403 }),
    );
    const r = await runMirrorAdfCopy('id11', 'ws', SNOW, TABLES, 'note');
    expect(r.ok).toBe(true);
    expect(r.note).toContain('Data Factory Contributor');
    expect(r.note).toContain('ARM answered 403');
  });
});

describe('adfDenialEvidence / describeTriggerStartFailure', () => {
  it('reads the STRUCTURED status first — adf-client rides it along for exactly this', () => {
    expect(adfDenialEvidence(Object.assign(new Error('nope'), { status: 403 }))).toBe('ARM answered 403');
    expect(adfDenialEvidence(Object.assign(new Error('nope'), { statusCode: 401 }))).toBe('ARM answered 401');
  });

  it('falls back to ARM denial codes in the message, because startTrigger throws a bare Error', () => {
    expect(adfDenialEvidence(new Error('startTrigger failed 403: AuthorizationFailed'))).toMatch(/refused the call/);
    expect(adfDenialEvidence(new Error('LinkedAuthorizationFailed on the factory'))).toMatch(/refused the call/);
  });

  it('returns null for everything that is not evidence of a refusal', () => {
    for (const e of [
      new Error('startTrigger failed 409: Conflict'),
      new Error('startTrigger failed 429: TooManyRequests'),
      new Error('startTrigger failed 404: the pipeline reference was not found'),
      new Error('socket hang up'),
      null,
      undefined,
    ]) {
      expect(adfDenialEvidence(e), `for ${String(e)}`).toBeNull();
    }
  });

  it('#4049 F4 — each anchor HALF is independently discriminated in THIS suite', () => {
    // `status-token.ts` claims each anchor half has a fixture the other half
    // alone would not block. That was true in `status-token.test.ts` and NOT
    // here: every numeric fixture in this suite (`loom_copy_403abc_trg`-shaped
    // names, `403: Forbidden`) is blocked by BOTH anchors, so neither half was
    // discriminated. Measured — dropping either half left this suite at RC=0,
    // and MX14 (re-inlining a lookahead-only anchor in this very file) ESCAPED.
    //
    // Two shapes, each blocked by exactly ONE half:
    //
    //   TRAILING token — digits END a word run: only the LOOKBEHIND blocks it.
    //   LEADING  token — digits START a word run: only the LOOKAHEAD blocks it.
    //
    // Both must stay null. Drop the lookbehind and the first matches; drop the
    // lookahead and the second does.
    expect(
      adfDenialEvidence(new Error('startTrigger loom_copy_403 failed: socket hang up')),
      'TRAILING token — the LOOKBEHIND is the only thing blocking this',
    ).toBeNull();
    expect(
      adfDenialEvidence(new Error('startTrigger on trigger 403abc failed: socket hang up')),
      'LEADING token — the LOOKAHEAD is the only thing blocking this',
    ).toBeNull();
  });

  it('CONTROL: a REAL standalone status in the same sentence shape IS evidence', () => {
    // Without this, the two nulls above are equally satisfied by a classifier
    // that stopped recognising numeric refusals at all — which is how an anchor
    // "fix" becomes a silent removal.
    expect(adfDenialEvidence(new Error('startTrigger loom_copy failed 403: socket hang up')))
      .toMatch(/refused the call/);
  });

  it('does not read 403 out of a TRIGGER NAME (the rg-loom-503 defect)', () => {
    expect(adfDenialEvidence(new Error('startTrigger loom_copy_403abc_trg failed: socket hang up'))).toBeNull();
    expect(describeTriggerStartFailure('schedule', new Error('startTrigger loom_copy_403abc_trg failed: socket hang up')))
      .not.toContain('Data Factory Contributor');
  });

  it('names the trigger kind and carries the ADF message verbatim in both branches', () => {
    const denied = describeTriggerStartFailure('tumbling', Object.assign(new Error('AuthorizationFailed'), { status: 403 }));
    expect(denied).toContain('tumbling-window');
    expect(denied).toContain('AuthorizationFailed');
    const unknown = describeTriggerStartFailure('schedule', new Error('socket hang up'));
    expect(unknown).toContain('schedule');
    expect(unknown).toContain('socket hang up');
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
