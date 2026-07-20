/**
 * W-B live-probe tests (task #21) — the 8 new probes wired into runExtraProbes:
 *   probe-aas, probe-aml, probe-azure-sql, probe-postgres, probe-stream-analytics,
 *   probe-eventgrid, probe-batch, probe-grafana.
 * Verifies wiring (all present), the honest-gate branch (unconfigured → warn,
 * never a silent pass), and the pass branch (real client call succeeds). Clients
 * are mocked at the module boundary. Per no-vaporware.md nothing above the client
 * edge is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── client mocks (the network edge) ──────────────────────────────────────────
const armMock = { armGet: vi.fn(async () => ({ value: [{ name: 'loom-aas', properties: { state: 'Succeeded' } }], name: 'rg', properties: { provisioningState: 'Succeeded' } })) };
vi.mock('@/lib/azure/arm-client', () => armMock);
class AmlNotConfiguredError extends Error { constructor(public missing: string[]) { super('aml not configured'); this.name = 'AmlNotConfiguredError'; } }
const amlMock = {
  resolveAmlTarget: vi.fn(() => ({ subscriptionId: 's', resourceGroup: 'rg', workspace: 'ws-aml', region: 'eastus2' })),
  amlWorkspaceArmPath: vi.fn(() => '/subscriptions/s/resourceGroups/rg/providers/Microsoft.MachineLearningServices/workspaces/ws-aml'),
  AmlNotConfiguredError,
};
vi.mock('@/lib/azure/resolve-aml-target', () => amlMock);
const aasMock = { aasAvailabilityGate: vi.fn(() => null as any) };
vi.mock('@/lib/azure/aas-client', () => aasMock);
const sqlMock = { listServers: vi.fn(async () => [{ name: 'sql-1' }]) };
vi.mock('@/lib/azure/azure-sql-client', () => sqlMock);
const pgMock = { postgresQueryGate: vi.fn(() => null as any), executePostgresQuery: vi.fn(async () => ({ columns: ['loom_health'], rows: [[1]] })) };
vi.mock('@/lib/azure/postgres-flex-client', () => pgMock);
const asaMock = { listJobs: vi.fn(async () => [{ name: 'asa-1' }]) };
vi.mock('@/lib/azure/stream-analytics-client', () => asaMock);
const egMock = { eventgridTopicsConfigGate: vi.fn(() => null as any), listEventGridTopics: vi.fn(async () => [{ name: 'topic-1' }]) };
vi.mock('@/lib/azure/eventgrid-topics-client', () => egMock);
const batchMock = { batchConfigGate: vi.fn(() => null as any), getBatchAccount: vi.fn(async () => ({ name: 'batch-1', properties: { provisioningState: 'Succeeded' } })) };
vi.mock('@/lib/azure/batch-client', () => batchMock);

import { runExtraProbes, type ProbeHelpers } from '../health-probes';

const h: ProbeHelpers = {
  ctx: { app: 'loom-console', adminRg: 'rg-admin', dlzRg: 'rg-dlz', sub: 'sub-1', uamiClientId: 'uami-1', tenant: 'tid', cosmosAccount: 'cosmos' },
  envVarFix: () => ({ portalSteps: [], fixScript: '' }),
};

const NEW_IDS = ['probe-aas', 'probe-aml', 'probe-azure-sql', 'probe-postgres', 'probe-stream-analytics', 'probe-eventgrid', 'probe-batch', 'probe-grafana'];
const CONFIG_ENV = ['LOOM_AAS_SERVER', 'LOOM_SUBSCRIPTION_ID', 'LOOM_AZURE_SQL_DEFAULT_SERVER', 'LOOM_POSTGRES_HOST', 'LOOM_POSTGRES_AAD_USER', 'LOOM_ASA_RG', 'LOOM_DLZ_RG', 'LOOM_BATCH_ACCOUNT', 'LOOM_EVENTGRID_BUSINESS_TOPIC', 'LOOM_GRAFANA_ENDPOINT', 'LOOM_AAS_RG'];
const saved: Record<string, string | undefined> = {};

function byId(results: Awaited<ReturnType<typeof runExtraProbes>>, id: string) {
  return results.find((r) => r.id === id)!;
}

/** Restore every mock to its "configured/reachable" default — clearAllMocks
 *  resets calls but NOT implementations, so a gate-flip in one test would leak. */
function resetMocksConfigured() {
  armMock.armGet.mockResolvedValue({ value: [{ name: 'loom-aas', properties: { state: 'Succeeded' } }], name: 'rg', properties: { provisioningState: 'Succeeded' } });
  amlMock.resolveAmlTarget.mockReturnValue({ subscriptionId: 's', resourceGroup: 'rg', workspace: 'ws-aml', region: 'eastus2' } as any);
  aasMock.aasAvailabilityGate.mockReturnValue(null);
  sqlMock.listServers.mockResolvedValue([{ name: 'sql-1' }] as any);
  pgMock.postgresQueryGate.mockReturnValue(null);
  pgMock.executePostgresQuery.mockResolvedValue({ columns: ['loom_health'], rows: [[1]] } as any);
  asaMock.listJobs.mockResolvedValue([{ name: 'asa-1' }] as any);
  egMock.eventgridTopicsConfigGate.mockReturnValue(null);
  egMock.listEventGridTopics.mockResolvedValue([{ name: 'topic-1' }] as any);
  batchMock.batchConfigGate.mockReturnValue(null);
  batchMock.getBatchAccount.mockResolvedValue({ name: 'batch-1', properties: { provisioningState: 'Succeeded' } } as any);
}

describe('W-B live probes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocksConfigured();
    for (const k of CONFIG_ENV) saved[k] = process.env[k];
    // global fetch stub so probe-grafana (reachability) doesn't hit the network.
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 }) as any));
  });
  afterEach(() => {
    for (const k of CONFIG_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
  });

  it('all 8 new probes are wired into runExtraProbes', async () => {
    for (const k of CONFIG_ENV) delete process.env[k];
    const results = await runExtraProbes(h);
    for (const id of NEW_IDS) expect(results.some((r) => r.id === id)).toBe(true);
  });

  it('honest-gate branch: unconfigured backends warn with a remediation (never a silent pass)', async () => {
    for (const k of CONFIG_ENV) delete process.env[k];
    // Flip the config-gate mocks to "unconfigured" so the probes whose gate is a
    // client fn (aml/eventgrid/batch/postgres) take the honest-gate branch too.
    amlMock.resolveAmlTarget.mockImplementation(() => { throw new AmlNotConfiguredError(['LOOM_AML_WORKSPACE']); });
    egMock.eventgridTopicsConfigGate.mockReturnValue({ missing: 'LOOM_EVENTGRID_BUSINESS_TOPIC' });
    batchMock.batchConfigGate.mockReturnValue({ missing: 'LOOM_BATCH_ACCOUNT' });
    pgMock.postgresQueryGate.mockReturnValue({ missing: 'LOOM_POSTGRES_AAD_USER', detail: 'register the principal' } as any);
    const results = await runExtraProbes(h);
    for (const id of NEW_IDS) {
      const r = byId(results, id);
      expect(r.status).not.toBe('pass');
      expect(r.remediation || r.detail).toBeTruthy();
    }
  });

  it('pass branch: configured backends return pass from the real client call', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/loom';
    process.env.LOOM_AAS_RG = 'rg-admin';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    process.env.LOOM_AZURE_SQL_DEFAULT_SERVER = 'sql-1';
    process.env.LOOM_POSTGRES_HOST = 'pg.postgres.database.azure.com';
    process.env.LOOM_POSTGRES_AAD_USER = 'loom-uami';
    process.env.LOOM_ASA_RG = 'rg-dlz';
    process.env.LOOM_BATCH_ACCOUNT = 'batch-1';
    process.env.LOOM_EVENTGRID_BUSINESS_TOPIC = 'topic-1';
    process.env.LOOM_GRAFANA_ENDPOINT = 'https://grafana.example';
    const results = await runExtraProbes(h);
    expect(byId(results, 'probe-aas').status).toBe('pass');
    expect(byId(results, 'probe-aml').status).toBe('pass');
    expect(byId(results, 'probe-azure-sql').status).toBe('pass');
    expect(byId(results, 'probe-postgres').status).toBe('pass');
    expect(byId(results, 'probe-stream-analytics').status).toBe('pass');
    expect(byId(results, 'probe-eventgrid').status).toBe('pass');
    expect(byId(results, 'probe-batch').status).toBe('pass');
    expect(byId(results, 'probe-grafana').status).toBe('pass');
    // real client calls happened
    expect(sqlMock.listServers).toHaveBeenCalled();
    expect(pgMock.executePostgresQuery).toHaveBeenCalled();
    expect(batchMock.getBatchAccount).toHaveBeenCalled();
  });

  it('AAS probe surfaces a PAUSED server as a warn (the invisible-misconfig class)', async () => {
    process.env.LOOM_AAS_SERVER = 'asazure://eastus2.asazure.windows.net/loom';
    process.env.LOOM_AAS_RG = 'rg-admin';
    process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
    armMock.armGet.mockResolvedValueOnce({ value: [{ name: 'loom-aas', properties: { state: 'Paused' } }] });
    const results = await runExtraProbes(h);
    const r = byId(results, 'probe-aas');
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/paused/i);
  });
});
