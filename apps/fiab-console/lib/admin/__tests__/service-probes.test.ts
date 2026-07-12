/**
 * Unit tests for the service-exercise probe registry (lib/admin/service-probes).
 *
 * Every Azure client is mocked at the module boundary so each probe's THREE
 * branches are pinned: 'gate' (backend not configured — honest, never a fail),
 * 'pass' (the real exercise executed), 'fail' (configured but the exercise
 * failed). Also pins the spark probe's self-clean contract (the Livy session is
 * DELETED even on failure/timeout) and the faulted-pool signature (instant
 * 'dead' state, appId=null → fail with the driver-log tail as evidence).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── client mocks ─────────────────────────────────────────────────────────────

const livyMock = {
  defaultSparkPool: vi.fn(() => 'loompool'),
  createLivySession: vi.fn(),
  getLivySession: vi.fn(),
  submitLivyStatement: vi.fn(),
  getLivyStatement: vi.fn(),
  killLivySession: vi.fn(async () => {}),
  normalizeLivyOutput: vi.fn((o: any) => o ?? null),
};
vi.mock('@/lib/azure/synapse-livy-client', () => livyMock);

const sqlMock = {
  serverlessTarget: vi.fn(() => ({ server: 'ws-ondemand.sql.azuresynapse.net', database: 'master', cacheKey: 'serverless:ws:master' })),
  executeQuery: vi.fn(),
};
vi.mock('@/lib/azure/synapse-sql-client', () => sqlMock);

const kustoMock = {
  kustoConfigGate: vi.fn(() => null as { missing: string } | null),
  defaultDatabase: vi.fn(() => 'loomdb-default'),
  clusterUri: vi.fn(() => 'https://adx.example.kusto.windows.net'),
  executeQuery: vi.fn(),
};
vi.mock('@/lib/azure/kusto-client', () => kustoMock);

const adlsMock = {
  hasConfiguredContainers: vi.fn(() => true),
  listContainers: vi.fn(),
};
vi.mock('@/lib/azure/adls-client', () => adlsMock);

const cosmosQueryFetchAll = vi.fn(async () => ({ resources: [{ id: 'x' }] }));
const cosmosItemRead = vi.fn(async () => ({ resource: null }));
const cosmosUpsert = vi.fn(async () => ({}));
const cosmosMock = {
  probeCosmosReachable: vi.fn(async () => {}),
  featurePermissionsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: cosmosQueryFetchAll }) },
  })),
  tenantSettingsContainer: vi.fn(async () => ({
    items: { upsert: cosmosUpsert },
    item: () => ({ read: cosmosItemRead }),
  })),
};
vi.mock('@/lib/azure/cosmos-client', () => cosmosMock);

class NoAoaiDeploymentError extends Error {}
const orchMock = {
  NoAoaiDeploymentError,
  resolveAoaiTarget: vi.fn(async () => ({ endpoint: 'https://aoai.openai.azure.com/', deployment: 'gpt-test' })),
};
vi.mock('@/lib/azure/copilot-orchestrator', () => orchMock);

const chatMock = { aoaiChat: vi.fn(async () => 'pong') };
vi.mock('@/lib/azure/aoai-chat-client', () => chatMock);

const domainSyncMock = { runDomainSync: vi.fn() };
vi.mock('@/lib/azure/domain-sync', () => domainSyncMock);

const adfMock = {
  adfConfigGate: vi.fn(() => null as { missing: string } | null),
  listPipelines: vi.fn(async () => [{ name: 'pl-copy' }, { name: 'pl-mirror' }]),
};
vi.mock('@/lib/azure/adf-client', () => adfMock);

// ── helpers ──────────────────────────────────────────────────────────────────

import { runServiceProbes, SERVICE_PROBES, isKnownService, probeTimeoutMs } from '../service-probes';

const BASE = { tenantId: 't-1', who: 'admin@contoso.com' };

async function runOne(service: string) {
  const report = await runServiceProbes(BASE, { services: [service] });
  expect(report.results).toHaveLength(1);
  return report.results[0];
}

const ENV_KEYS = [
  'LOOM_SYNAPSE_WORKSPACE', 'LOOM_COSMOS_ENDPOINT', 'COSMOS_ENDPOINT',
  'LOOM_EXERCISE_TIMEOUT_MS', 'LOOM_EXERCISE_SPARK_TIMEOUT_MS',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws-loom';
  process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.documents.azure.com:443/';
  vi.clearAllMocks();
  // restore default happy-path mock behaviors cleared by clearAllMocks
  livyMock.defaultSparkPool.mockReturnValue('loompool');
  livyMock.killLivySession.mockResolvedValue(undefined);
  livyMock.normalizeLivyOutput.mockImplementation((o: any) => o ?? null);
  sqlMock.serverlessTarget.mockReturnValue({ server: 'ws-ondemand.sql.azuresynapse.net', database: 'master', cacheKey: 'serverless:ws:master' });
  kustoMock.kustoConfigGate.mockReturnValue(null);
  kustoMock.defaultDatabase.mockReturnValue('loomdb-default');
  kustoMock.clusterUri.mockReturnValue('https://adx.example.kusto.windows.net');
  adlsMock.hasConfiguredContainers.mockReturnValue(true);
  cosmosMock.probeCosmosReachable.mockResolvedValue(undefined);
  cosmosMock.featurePermissionsContainer.mockResolvedValue({
    items: { query: () => ({ fetchAll: cosmosQueryFetchAll }) },
  } as any);
  orchMock.resolveAoaiTarget.mockResolvedValue({ endpoint: 'https://aoai.openai.azure.com/', deployment: 'gpt-test' });
  chatMock.aoaiChat.mockResolvedValue('pong');
  adfMock.adfConfigGate.mockReturnValue(null);
  adfMock.listPipelines.mockResolvedValue([{ name: 'pl-copy' }, { name: 'pl-mirror' }]);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ── registry shape ───────────────────────────────────────────────────────────

describe('registry', () => {
  it('exposes one probe per backend with unique ids', () => {
    const ids = SERVICE_PROBES.map((p) => p.service);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'spark', 'warehouse-sql', 'adx', 'adls', 'cosmos', 'aoai', 'domain-sync', 'adf',
    ]));
    expect(isKnownService('spark')).toBe(true);
    expect(isKnownService('nope')).toBe(false);
  });

  it('probeTimeoutMs honors service-specific then global env overrides', () => {
    expect(probeTimeoutMs('spark', 240_000)).toBe(240_000);
    process.env.LOOM_EXERCISE_TIMEOUT_MS = '1000';
    expect(probeTimeoutMs('spark', 240_000)).toBe(1000);
    process.env.LOOM_EXERCISE_SPARK_TIMEOUT_MS = '2000';
    expect(probeTimeoutMs('spark', 240_000)).toBe(2000);
    expect(probeTimeoutMs('warehouse-sql', 45_000)).toBe(1000);
  });
});

// ── spark ────────────────────────────────────────────────────────────────────

describe('spark probe', () => {
  it('gates when LOOM_SYNAPSE_WORKSPACE is unset', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const r = await runOne('spark');
    expect(r.status).toBe('gate');
    expect(r.detail).toContain('LOOM_SYNAPSE_WORKSPACE');
    expect(livyMock.createLivySession).not.toHaveBeenCalled();
  });

  it('passes when the session reaches idle and the statement executes — and deletes the session', async () => {
    // idle straight away — polling transitions are covered by the timeout spec
    // (a starting-forever session) without burning real 5s poll sleeps here.
    livyMock.createLivySession.mockResolvedValue({ id: 7, state: 'idle', appId: 'application_1_0007', log: [] });
    livyMock.submitLivyStatement.mockResolvedValue({ id: 0, state: 'available', output: { status: 'ok', textPlain: '1' } });
    const r = await runOne('spark');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('spark.range(1).count()');
    expect(r.evidence).toBe('1');
    expect(livyMock.killLivySession).toHaveBeenCalledWith('loompool', 7);
  });

  it('FAILS on the faulted-pool signature (instant dead, appId=null) with the log tail — and still deletes the session', async () => {
    livyMock.createLivySession.mockResolvedValue({
      id: 42, state: 'dead', appId: null,
      log: ['stdout:', 'YarnScheduler: pool faulted', 'Session 42 unexpectedly reached final status dead'],
    });
    const r = await runOne('spark');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain("state 'dead'");
    expect(r.detail).toContain('appId=null');
    expect(r.detail).toContain('faulted-pool');
    expect(r.evidence).toContain('unexpectedly reached final status dead');
    expect(livyMock.killLivySession).toHaveBeenCalledWith('loompool', 42);
  });

  it('fails when the statement errors on a healthy session', async () => {
    livyMock.createLivySession.mockResolvedValue({ id: 8, state: 'idle', appId: 'app', log: [] });
    livyMock.submitLivyStatement.mockResolvedValue({ id: 0, state: 'available', output: { status: 'error', ename: 'Py4JJavaError', evalue: 'boom', traceback: ['t1', 't2'] } });
    const r = await runOne('spark');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('Py4JJavaError');
    expect(livyMock.killLivySession).toHaveBeenCalledWith('loompool', 8);
  });

  it('times out via the probe budget (env override) and STILL deletes the session', async () => {
    process.env.LOOM_EXERCISE_SPARK_TIMEOUT_MS = '1';
    livyMock.createLivySession.mockResolvedValue({ id: 9, state: 'starting', appId: null, log: [] });
    livyMock.getLivySession.mockResolvedValue({ id: 9, state: 'starting', appId: null, log: [] });
    const r = await runOne('spark');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('timed out');
    expect(livyMock.killLivySession).toHaveBeenCalledWith('loompool', 9);
  });
});

// ── warehouse-sql ────────────────────────────────────────────────────────────

describe('warehouse-sql probe', () => {
  it('gates without a Synapse workspace', async () => {
    delete process.env.LOOM_SYNAPSE_WORKSPACE;
    const r = await runOne('warehouse-sql');
    expect(r.status).toBe('gate');
    expect(sqlMock.executeQuery).not.toHaveBeenCalled();
  });

  it('passes on a real SELECT 1', async () => {
    sqlMock.executeQuery.mockResolvedValue({ columns: ['loom_exercise'], rows: [[1]], rowCount: 1, executionMs: 12, truncated: false, messages: [] });
    const r = await runOne('warehouse-sql');
    expect(r.status).toBe('pass');
    expect(sqlMock.executeQuery).toHaveBeenCalledWith(expect.anything(), 'SELECT 1 AS loom_exercise', 30_000);
    expect(r.evidence).toContain('loom_exercise');
  });

  it('fails when the TDS path throws', async () => {
    sqlMock.executeQuery.mockRejectedValue(new Error('Login failed for token-identified principal'));
    const r = await runOne('warehouse-sql');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('Login failed');
  });
});

// ── adx ──────────────────────────────────────────────────────────────────────

describe('adx probe', () => {
  it('gates when kustoConfigGate reports missing config', async () => {
    kustoMock.kustoConfigGate.mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    const r = await runOne('adx');
    expect(r.status).toBe('gate');
    expect(r.detail).toContain('LOOM_KUSTO_CLUSTER_URI');
    expect(kustoMock.executeQuery).not.toHaveBeenCalled();
  });

  it('passes on print 1', async () => {
    kustoMock.executeQuery.mockResolvedValue({ columns: [{ name: 'loom_exercise' }], rows: [[1]] });
    const r = await runOne('adx');
    expect(r.status).toBe('pass');
    expect(kustoMock.executeQuery).toHaveBeenCalledWith('loomdb-default', 'print loom_exercise=1');
  });

  it('fails when the cluster rejects the query', async () => {
    kustoMock.executeQuery.mockRejectedValue(new Error('403 Forbidden: principal is not authorized'));
    const r = await runOne('adx');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('not authorized');
  });
});

// ── adls ─────────────────────────────────────────────────────────────────────

describe('adls probe', () => {
  it('gates when no container URLs are configured', async () => {
    adlsMock.hasConfiguredContainers.mockReturnValue(false);
    const r = await runOne('adls');
    expect(r.status).toBe('gate');
    expect(adlsMock.listContainers).not.toHaveBeenCalled();
  });

  it('passes when configured containers answer', async () => {
    adlsMock.listContainers.mockResolvedValue([{ name: 'bronze', url: 'https://acct.dfs.core.windows.net/bronze' }]);
    const r = await runOne('adls');
    expect(r.status).toBe('pass');
    expect(r.evidence).toContain('bronze');
  });

  it('FAILS when configured but zero containers are reachable (broken PE/DNS class)', async () => {
    adlsMock.listContainers.mockResolvedValue([]);
    const r = await runOne('adls');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('NONE were reachable');
  });
});

// ── cosmos ───────────────────────────────────────────────────────────────────

describe('cosmos probe', () => {
  it('gates when no endpoint is configured', async () => {
    delete process.env.LOOM_COSMOS_ENDPOINT;
    delete process.env.COSMOS_ENDPOINT;
    const r = await runOne('cosmos');
    expect(r.status).toBe('gate');
    expect(cosmosMock.probeCosmosReachable).not.toHaveBeenCalled();
  });

  it('passes on reachability + a real query', async () => {
    const r = await runOne('cosmos');
    expect(r.status).toBe('pass');
    expect(cosmosMock.probeCosmosReachable).toHaveBeenCalled();
    expect(cosmosQueryFetchAll).toHaveBeenCalled();
  });

  it('fails when the account is unreachable', async () => {
    cosmosMock.probeCosmosReachable.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const r = await runOne('cosmos');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('ETIMEDOUT');
  });
});

// ── aoai ─────────────────────────────────────────────────────────────────────

describe('aoai probe', () => {
  it('gates on NoAoaiDeploymentError', async () => {
    orchMock.resolveAoaiTarget.mockRejectedValue(new NoAoaiDeploymentError('no deployment'));
    const r = await runOne('aoai');
    expect(r.status).toBe('gate');
    expect(r.detail).toContain('LOOM_AOAI_ENDPOINT');
    expect(chatMock.aoaiChat).not.toHaveBeenCalled();
  });

  it('passes on a real completion (target pinned to skip a second resolve)', async () => {
    const r = await runOne('aoai');
    expect(r.status).toBe('pass');
    expect(chatMock.aoaiChat).toHaveBeenCalledWith(expect.objectContaining({
      maxCompletionTokens: 16,
      target: expect.objectContaining({ deployment: 'gpt-test' }),
    }));
    expect(r.evidence).toBe('pong');
  });

  it('fails when the deployment answers an empty completion', async () => {
    chatMock.aoaiChat.mockResolvedValue('   ');
    const r = await runOne('aoai');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('EMPTY completion');
  });

  it('fails when the completion call throws (configured but broken)', async () => {
    chatMock.aoaiChat.mockRejectedValue(new Error('AOAI 401: PermissionDenied'));
    const r = await runOne('aoai');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('AOAI 401');
  });
});

// ── domain-sync ──────────────────────────────────────────────────────────────

const DS = (over: Record<string, unknown> = {}) => ({
  applied: false, ranAt: 't', ranBy: 'admin', domainCount: 3,
  purview: { configured: true, mirrored: 3, created: 0, missing: 0, errors: 0 },
  unity: { configured: false, mirrored: 0, created: 0, missing: 0, errors: 0, hint: 'set LOOM_DATABRICKS_HOSTNAME' },
  rows: [], drift: [],
  ...over,
});

describe('domain-sync probe', () => {
  it('gates when neither Purview nor Unity Catalog is configured', async () => {
    domainSyncMock.runDomainSync.mockResolvedValue(DS({
      purview: { configured: false, mirrored: 0, created: 0, missing: 0, errors: 0, hint: 'set LOOM_PURVIEW_ACCOUNT' },
    }));
    const r = await runOne('domain-sync');
    expect(r.status).toBe('gate');
    expect(r.detail).toContain('LOOM_PURVIEW_ACCOUNT');
  });

  it('passes a clean dry run (apply:false — never mutates)', async () => {
    domainSyncMock.runDomainSync.mockResolvedValue(DS());
    const r = await runOne('domain-sync');
    expect(r.status).toBe('pass');
    expect(domainSyncMock.runDomainSync).toHaveBeenCalledWith('t-1', 'admin@contoso.com', { apply: false });
    expect(r.evidence).toContain('purview{configured:true');
  });

  it('fails when the dry run reports errors against a configured target', async () => {
    domainSyncMock.runDomainSync.mockResolvedValue(DS({
      purview: { configured: true, mirrored: 1, created: 0, missing: 0, errors: 2 },
    }));
    const r = await runOne('domain-sync');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('2 error(s)');
  });
});

// ── adf ──────────────────────────────────────────────────────────────────────

describe('adf probe', () => {
  it('gates when the factory env is missing', async () => {
    adfMock.adfConfigGate.mockReturnValue({ missing: 'LOOM_ADF_NAME' });
    const r = await runOne('adf');
    expect(r.status).toBe('gate');
    expect(r.detail).toContain('LOOM_ADF_NAME');
    expect(adfMock.listPipelines).not.toHaveBeenCalled();
  });

  it('passes when the control plane lists pipelines', async () => {
    const r = await runOne('adf');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('2 pipeline(s)');
    expect(r.evidence).toContain('pl-copy');
  });

  it('fails when ARM rejects the call', async () => {
    adfMock.listPipelines.mockRejectedValue(new Error('AuthorizationFailed'));
    const r = await runOne('adf');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('AuthorizationFailed');
  });
});

// ── runner aggregation ───────────────────────────────────────────────────────

describe('runServiceProbes', () => {
  it('filters to the requested services and aggregates the summary', async () => {
    kustoMock.kustoConfigGate.mockReturnValue({ missing: 'LOOM_KUSTO_CLUSTER_URI' });
    adfMock.listPipelines.mockRejectedValue(new Error('AuthorizationFailed'));
    sqlMock.executeQuery.mockResolvedValue({ columns: ['c'], rows: [[1]], rowCount: 1, executionMs: 5, truncated: false, messages: [] });
    const report = await runServiceProbes(BASE, { services: ['warehouse-sql', 'adx', 'adf'] });
    expect(report.results.map((r) => r.service).sort()).toEqual(['adf', 'adx', 'warehouse-sql']);
    expect(report.summary).toEqual({ pass: 1, gate: 1, fail: 1, total: 3 });
    expect(report.ranBy).toBe('admin@contoso.com');
    for (const r of report.results) expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('runs everything when no filter is given', async () => {
    // make every probe deterministic
    livyMock.createLivySession.mockResolvedValue({ id: 1, state: 'idle', appId: 'a', log: [] });
    livyMock.submitLivyStatement.mockResolvedValue({ id: 0, state: 'available', output: { status: 'ok', textPlain: '1' } });
    sqlMock.executeQuery.mockResolvedValue({ columns: ['c'], rows: [[1]], rowCount: 1, executionMs: 5, truncated: false, messages: [] });
    kustoMock.executeQuery.mockResolvedValue({ columns: [], rows: [[1]] });
    adlsMock.listContainers.mockResolvedValue([{ name: 'bronze', url: 'u' }]);
    domainSyncMock.runDomainSync.mockResolvedValue(DS());
    const report = await runServiceProbes(BASE);
    expect(report.summary.total).toBe(SERVICE_PROBES.length);
    expect(report.summary.pass + report.summary.gate + report.summary.fail).toBe(SERVICE_PROBES.length);
  });
});
