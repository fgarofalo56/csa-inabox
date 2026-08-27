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
import { adfDenialEvidence, describeTriggerStartFailure } from '../mirror-adf-copy';

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
    process.env.LOOM_BRONZE_URL = 'https://acct.dfs.core.windows.net/bronze';
    delete process.env.LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE;
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
    // The CURRENT connector, not the retired V1 one.
    expect(acts[1].typeProperties.source.type).toBe('SnowflakeV2Source');
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
    expect(pipeSpec.properties.activities[1].typeProperties.source.type).toBe('SnowflakeSource');
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
