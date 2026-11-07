/**
 * #5099 phase B, handler level. Only the network edges are mocked (Resource Graph,
 * ARM reads, the actuator, Cosmos); discovery, the dependency guard, the gateway
 * guard, the planner, the ordering, the state machine and the re-stop are the REAL
 * code. Every `it` names the input that breaks it (assertion-design.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ESTATE = 'loom:estate-b';
const SUB = 's';
const armGetWithRetry = vi.fn();
const armPost = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGetWithRetry: (...a: unknown[]) => armGetWithRetry(...a),
  armPost: (...a: unknown[]) => armPost(...a),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async (d: unknown) => ({ resource: d })) } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert: vi.fn(async (d: any) => ({ resource: d })) },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/estate/estate-pipeline-activity', () => ({
  loadPipelineActivity: async () => ({ ok: true, runs: [], sources: [] }),
}));

let actuatorImpl: any;
let storedSnapshot: any = null;
const savePauseSnapshot = vi.fn(async (_s?: unknown) => {});
const resolveDeployManifest = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: async () => actuatorImpl,
    loadPauseSnapshot: async () => storedSnapshot,
    savePauseSnapshot: (...a: unknown[]) => savePauseSnapshot(...(a as [])),
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
    createManifestTagReader: () => async () => ({}),
  };
});

import { handlePausePost, handleStateRead, type EstateCaller } from '../estate-power-handlers';
import { clearStateCache } from '../estate-state-cache';
import { armPowerReading, type EstatePauseSnapshot, type PausedResourceSnapshot } from '../pause-state';
import { CONSUMERS_TAG_KEY } from '../pause-guards';

const caller: EstateCaller = { tenantId: 't1', who: 'admin@x', actorOid: 'o', actorTid: 't1', auditExtra: {} };
const mine = { 'loom-estate-id': ESTATE };
const argRow = (type: string, provider: string, name: string, tags: Record<string, string> = mine) => ({
  id: `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/${provider}/${name}`,
  name, type, resourceGroup: 'rg-admin', subscriptionId: SUB, tags,
});
const PG = (n: string, consumers?: string) =>
  argRow('microsoft.dbforpostgresql/flexibleservers', 'Microsoft.DBforPostgreSQL/flexibleServers', n,
    consumers === undefined ? mine : { ...mine, [CONSUMERS_TAG_KEY]: consumers });
const MYSQL = (n: string, consumers?: string) =>
  argRow('microsoft.dbformysql/flexibleservers', 'Microsoft.DBforMySQL/flexibleServers', n,
    consumers === undefined ? mine : { ...mine, [CONSUMERS_TAG_KEY]: consumers });
const AGW = (n: string) => argRow('microsoft.network/applicationgateways', 'Microsoft.Network/applicationGateways', n);
const PBI = (n: string) => argRow('microsoft.powerbidedicated/capacities', 'Microsoft.PowerBIDedicated/capacities', n);

function graph(rows: unknown[]) {
  armPost.mockImplementation(async (_p: string, body: any) =>
    String(body.query).startsWith('resourcecontainers') ? { data: [{ subscriptionId: SUB }] } : { data: rows });
}

/** ARM reads: the Container Apps list, and per-gateway config by id. */
let gatewayConfigs: Record<string, unknown>;
const appRow = (name: string, tags: Record<string, string> = mine) => ({
  id: `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/${name}`,
  name, tags, properties: { template: { scale: { minReplicas: 1, maxReplicas: 3 } } },
});
let apps: unknown[];

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  clearStateCache();
  storedSnapshot = null;
  actuatorImpl = { readTags: async () => ({}), readPower: async () => ({ reading: null }) };
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  process.env.LOOM_ACA_RG = 'rg-admin';
  process.env.CONTAINER_APP_NAME = 'loom-console';
  process.env.LOOM_PUBLIC_BASE_URL = 'https://loom.contoso.example';
  delete process.env.LOOM_CONTAINER_PLATFORM;
  delete process.env.KUBERNETES_SERVICE_HOST;
  process.env.LOOM_ESTATE_PAUSE_ENABLED = 'true';
  resolveDeployManifest.mockReturnValue({
    manifest: { estateId: ESTATE, resourceIds: [] }, entries: [], unresolved: [], manifestGated: false, namedByDeploy: 0,
  });
  gatewayConfigs = {};
  apps = [appRow('loom-udf-runtime'), appRow('loom-brain')];
  armGetWithRetry.mockImplementation(async (p: string) => {
    if (String(p).includes('applicationGateways/')) {
      const key = Object.keys(gatewayConfigs).find((k) => String(p).includes(`/${k}?`));
      if (key === undefined) throw new Error(`ARM GET ${p} failed 404: not found`);
      return gatewayConfigs[key];
    }
    return { value: apps };
  });
  graph([]);
});
afterEach(() => { process.env = { ...savedEnv }; });

const preview = async () => (await (await handlePausePost(caller, { dryRun: true })).json()) as any;
const wouldPause = (j: any) => j.preview.wouldPause.map((r: any) => r.name) as string[];
const outOfTier = (j: any, name: string) => j.outOfTier.find((o: any) => o.name === name);

describe('the preview: databases are dependency-aware, gateways read their pools', () => {
  // Breaks if: a server whose consumers are all in the set is not paused, or is listed BEFORE its consumers.
  it('a PostgreSQL whose consumers are all in the set is paused AFTER them (preview order = pause order)', async () => {
    graph([PG('psql-ok', 'loom-udf-runtime,loom-brain'), MYSQL('mysql-ok', 'loom-brain'), PBI('pbi-1')]);
    const j = await preview();
    const names = wouldPause(j);
    expect(names).toEqual(expect.arrayContaining(['psql-ok', 'mysql-ok', 'pbi-1', 'loom-udf-runtime', 'loom-brain']));
    const idx = (n: string) => names.indexOf(n);
    expect(idx('psql-ok')).toBeGreaterThan(idx('loom-udf-runtime'));
    expect(idx('psql-ok')).toBeGreaterThan(idx('loom-brain'));
    expect(idx('mysql-ok')).toBeGreaterThan(idx('loom-brain'));
  });

  // Breaks if: no consumers tag is read as "free to pause" (fail-open), or the panel loses the reason.
  it('a server with NO consumers tag is HELD OUT with "consumers unknown", visible in outOfTier', async () => {
    graph([PG('psql-unknown')]);
    const j = await preview();
    expect(wouldPause(j)).not.toContain('psql-unknown');
    expect(outOfTier(j, 'psql-unknown').reason).toContain('consumers unknown');
  });

  // Breaks if: the exact pinning consumer is not surfaced.
  it('a server pinned by a never-pause app shows that consumer', async () => {
    graph([PG('psql-unity', 'loom-udf-runtime,loom-unity')]);
    const j = await preview();
    expect(wouldPause(j)).not.toContain('psql-unity');
    expect(outOfTier(j, 'psql-unity')).toMatchObject({ pinnedBy: 'loom-unity' });
  });

  // Breaks if: the gateway read is skipped (the gateway fronting the console would be paused) or applied to the wrong gateway.
  it('a gateway whose pool targets the console is held out; one with an unrelated pool is paused; an unreadable one is held out', async () => {
    graph([AGW('agw-front'), AGW('agw-clean'), AGW('agw-dark')]);
    gatewayConfigs = {
      'agw-front': { properties: { backendAddressPools: [{ name: 'console-backend', properties: { backendAddresses: [{ fqdn: 'loom-console.int.example' }] } }] } },
      'agw-clean': { properties: { backendAddressPools: [{ name: 'shop', properties: { backendAddresses: [{ fqdn: 'shop.contoso.example' }] } }] } },
      // agw-dark: no entry -> the mock throws 404 -> the config could not be read
    };
    const j = await preview();
    expect(wouldPause(j)).toContain('agw-clean');
    expect(wouldPause(j)).not.toContain('agw-front');
    expect(wouldPause(j)).not.toContain('agw-dark');
    expect(outOfTier(j, 'agw-front').reason).toContain('console-backend');
    expect(outOfTier(j, 'agw-dark').reason).toContain('could not be established');
  });

  // Breaks if: a throttled gateway read is only a hold-out; it must refuse the pause with a retry (readFailures).
  it('a THROTTLED gateway read is a read failure (the pause refuses and says retry), not just a hold-out', async () => {
    graph([AGW('agw-hot')]);
    armGetWithRetry.mockImplementation(async (p: string) => {
      if (String(p).includes('applicationGateways/')) throw new Error('ARM GET was throttled (429) after 3 attempts');
      return { value: apps };
    });
    const j = await preview();
    expect(j.readFailures.map((f: any) => f.name)).toContain('agw-hot');
    expect(j.readFailures.find((f: any) => f.name === 'agw-hot').throttled).toBe(true);
    expect(wouldPause(j)).not.toContain('agw-hot');
  });
});

describe('the 7-day (PostgreSQL) / 30-day (MySQL) auto-restart under a PAUSED estate', () => {
  const PGID = `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-ok`;
  const APPID = `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/loom-brain`;
  const entry = (id: string, type: string, name: string, extra: Partial<PausedResourceSnapshot> = {}): PausedResourceSnapshot => ({
    resourceId: id, resourceType: type, name, resourceGroup: 'rg-admin', subscriptionId: SUB,
    prePausePowerState: 'Online', powerStateSource: 'arm', powerStateReadAt: '2026-10-10T00:00:00.000Z',
    powerStateApiVersion: 'x', ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...extra,
  });
  const pausedSnapshot = (pgExtra: Partial<PausedResourceSnapshot> = { consumers: ['loom-brain'] }): EstatePauseSnapshot => ({
    schemaVersion: 1, id: 'snap', tenantId: 't1', estateId: ESTATE, state: 'PAUSED',
    createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', pausedAt: '2026-10-10T00:00:00.000Z',
    createdBy: 'x',
    resources: [
      entry(APPID, 'microsoft.app/containerapps', 'loom-brain'),
      entry(PGID, 'microsoft.dbforpostgresql/flexibleservers', 'psql-ok', pgExtra),
    ],
  } as unknown as EstatePauseSnapshot);

  function world(states: Record<string, string>) {
    const pauseCalls: string[] = [];
    actuatorImpl = {
      readTags: async () => ({}),
      readPower: async (r: any) => ({
        reading: armPowerReading({ resourceId: r.resourceId, powerState: states[r.resourceId] as any, armApiVersion: 'x' }),
      }),
      pause: vi.fn(async (c: any) => { pauseCalls.push(c.resource.name); return { ok: true, detail: 'ARM accepted the stop.' }; }),
    };
    return pauseCalls;
  }
  const read = async (pipelineActivity: boolean) => (await (await handleStateRead(caller, { pipelineActivity })).json()) as any;
  const data = (j: any) => j.data ?? j;

  // Breaks if: the estate flips to an error state (or anything but PAUSED) because a member reads Ready, or the
  // server is NOT re-stopped by the idle lane.
  it('PostgreSQL reads Ready under a PAUSED estate: the estate stays PAUSED, the idle lane re-stops it, and the answer says so', async () => {
    storedSnapshot = pausedSnapshot();
    const calls = world({ [APPID]: 'Paused', [PGID]: 'Online' });
    const d = data(await read(true));
    expect(d.state).toBe('PAUSED');
    expect(calls).toEqual(['psql-ok']); // re-stopped, and ONLY it (the app is not touched)
    expect(d.reassert).toEqual([expect.objectContaining({ name: 'psql-ok', status: 'restopped' })]);
    expect(d.drifted).toBe(true); // this read DID see it running; only the next read can say it stopped
    expect(d.reason).toContain('Loom re-sent the stop');
    expect(d.reason).not.toContain('not built yet'); // the stock "nothing was re-paused" text is replaced, not left contradicting
    expect(savePauseSnapshot).not.toHaveBeenCalled(); // no state change to persist
  });

  // Breaks if: a panel poll (not the idle lane) starts mutating the estate.
  it('a read that is NOT the idle lane reports the drift and sends NO stop', async () => {
    storedSnapshot = pausedSnapshot();
    const calls = world({ [APPID]: 'Paused', [PGID]: 'Online' });
    const d = data(await read(false));
    expect(d.state).toBe('PAUSED');
    expect(d.drifted).toBe(true);
    expect(calls).toEqual([]);
    expect(d.reassert).toEqual([]);
  });

  // Breaks if: the re-stop ignores that a consumer is running again (the server would be stopped under a live app).
  it('a consumer that is RUNNING again blocks the re-stop and the row says which consumer', async () => {
    storedSnapshot = pausedSnapshot();
    const calls = world({ [APPID]: 'Online', [PGID]: 'Online' });
    const d = data(await read(true));
    expect(calls).toEqual([]);
    expect(d.reassert).toEqual([expect.objectContaining({ name: 'psql-ok', status: 'blocked' })]);
    expect(d.reassert[0].detail).toContain('loom-brain');
  });

  // Breaks if: the arming switch stops gating the re-stop.
  it('is inert when LOOM_ESTATE_PAUSE_ENABLED is unset', async () => {
    delete process.env.LOOM_ESTATE_PAUSE_ENABLED;
    storedSnapshot = pausedSnapshot();
    const calls = world({ [APPID]: 'Paused', [PGID]: 'Online' });
    await read(true);
    expect(calls).toEqual([]);
  });

  // Breaks if: a server that was ALREADY stopped before Loom paused (not Loom's) gets re-stopped.
  it('a server that was stopped before the pause is never re-stopped by Loom', async () => {
    storedSnapshot = pausedSnapshot({ consumers: ['loom-brain'], prePausePowerState: 'Stopped' });
    const calls = world({ [APPID]: 'Paused', [PGID]: 'Online' });
    const d = data(await read(true));
    expect(calls).toEqual([]);
    expect(d.reassert[0]).toMatchObject({ status: 'blocked' });
  });

  // Breaks if: a Container App that drifted (a roll of the estate) is re-stopped: only the two flexible-server types are.
  it('a drifted Container App is reported, not re-stopped', async () => {
    storedSnapshot = pausedSnapshot();
    const calls = world({ [APPID]: 'Online', [PGID]: 'Paused' });
    const d = data(await read(true));
    expect(calls).toEqual([]);
    expect(d.driftedResources).toEqual([APPID]);
  });
});

describe('the confirm path still refuses without a token (phase B did not open a bypass)', () => {
  // Breaks if: the new guards sit on a path that skips the typed-confirm / drift-token gates.
  it('a real pause with no confirmToken is refused 409 and sends nothing', async () => {
    graph([PG('psql-ok', 'loom-brain')]);
    const res = await handlePausePost(caller, { dryRun: false, confirm: ESTATE });
    expect(res.status).toBe(409);
  });
});
