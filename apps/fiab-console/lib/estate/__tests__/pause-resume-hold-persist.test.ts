/**
 * #5099 phase C review fix: a released resume hold must be PERSISTED even though the
 * estate state did not change (RESUMING -> RESUMING is not a transition, so
 * `resolveReadVerdict` says persist:false). Without it every later poll re-reads the
 * database and re-sends the consumer's start. Handler level; only the network edges are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/azure/arm-client', () => ({ armGetWithRetry: vi.fn(), armPost: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async (d: unknown) => ({ resource: d })) } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert: vi.fn(async (d: unknown) => ({ resource: d })) },
    item: () => ({ read: async () => ({ resource: undefined }) }),
  })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));
vi.mock('@/lib/estate/estate-pipeline-activity', () => ({
  loadPipelineActivity: async () => ({ ok: true, runs: [], sources: [] }),
}));

let actuatorImpl: any;
let stored: any = null;
const saved: any[] = [];
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: async () => actuatorImpl,
    loadPauseSnapshot: async () => stored,
    savePauseSnapshot: vi.fn(async (s: unknown) => { saved.push(s); stored = s; }),
  };
});

import { handleStateRead, type EstateCaller } from '../estate-power-handlers';
import { clearStateCache } from '../estate-state-cache';
import { armPowerReading, type EstatePauseSnapshot, type PausedResourceSnapshot } from '../pause-state';

const caller: EstateCaller = { tenantId: 't1', who: 'admin@x', actorOid: 'o', actorTid: 't1', auditExtra: {} };
const SUB = 's';
const PGID = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-o`;
const APPID = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/app-a`;
const entry = (id: string, type: string, name: string, extra: Partial<PausedResourceSnapshot> = {}) => ({
  resourceId: id, resourceType: type, name, resourceGroup: 'rg', subscriptionId: SUB, prePausePowerState: 'Online',
  powerStateSource: 'arm', powerStateReadAt: '2026-10-10T00:00:00.000Z', powerStateApiVersion: 'x',
  ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...extra,
}) as unknown as PausedResourceSnapshot;

const resumingSnapshot = (): EstatePauseSnapshot => ({
  schemaVersion: 1, id: 'snap', tenantId: 't1', estateId: 'loom:e', state: 'RESUMING',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pausedAt: new Date().toISOString(),
  resumeStartedAt: new Date().toISOString(), // inside the settle window: unconfirmed stays RESUMING
  createdBy: 'x',
  resources: [
    entry(PGID, 'microsoft.dbforpostgresql/flexibleservers', 'psql-o', { consumers: ['app-a'] }),
    entry(APPID, 'microsoft.app/containerapps', 'app-a'),
  ],
  resumeHeld: [{ resourceId: APPID, name: 'app-a', dbResourceId: PGID, dbName: 'psql-o' }],
} as unknown as EstatePauseSnapshot);

const savedEnv = { ...process.env };
beforeEach(() => {
  clearStateCache();
  saved.length = 0;
  stored = resumingSnapshot();
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
});
afterEach(() => { process.env = { ...savedEnv }; });

function world() {
  const resumes: string[] = [];
  actuatorImpl = {
    readTags: async () => ({}),
    readPower: async (r: any) => ({
      // DB is Online; the consumer has not come up yet (still Paused) so the estate stays RESUMING.
      reading: armPowerReading({ resourceId: r.resourceId, powerState: r.resourceId === PGID ? 'Online' : 'Paused', armApiVersion: 'x' }),
    }),
    pause: vi.fn(),
    resume: vi.fn(async (e: any) => { resumes.push(e.name); return { ok: true, detail: 'accepted' }; }),
    probeServable: async () => ({ servable: true, probed: true, detail: 'ok' }),
  };
  return resumes;
}
const read = async () => {
  clearStateCache(); // each read is a fresh poll, as a later browser poll would be
  const j = (await (await handleStateRead(caller)).json()) as any;
  return j.data ?? j;
};

describe('a released resume hold is persisted without a state change', () => {
  // Breaks if: the hold list is saved only on a state transition. The 2nd read would then
  // re-send resume:app-a (resumes === ['app-a','app-a']) because the stored hold never cleared.
  it('read 1 starts app-a and stores resumeHeld=[]; read 2 does NOT start it again', async () => {
    const resumes = world();
    const first = await read();
    expect(first.state).toBe('RESUMING'); // no transition: this is the case resolveReadVerdict does not persist
    expect(resumes).toEqual(['app-a']);
    expect(saved).toHaveLength(1);
    expect(saved[0].resumeHeld).toEqual([]);
    expect(saved[0].state).toBe('RESUMING'); // only the hold list changed

    await read();
    expect(resumes).toEqual(['app-a']); // positive pair: still exactly one start after the second poll
    expect(saved).toHaveLength(1); // and nothing to re-save
  });

  // Breaks if: the save fires on every poll (no change detection): a hold that is still held must not be re-saved.
  it('a hold that is still waiting (DB not Online) is neither started nor re-saved', async () => {
    const resumes: string[] = [];
    actuatorImpl = {
      readTags: async () => ({}),
      readPower: async (r: any) => ({ reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Resuming', armApiVersion: 'x' }) }),
      pause: vi.fn(),
      resume: vi.fn(async (e: any) => { resumes.push(e.name); return { ok: true, detail: 'x' }; }),
      probeServable: async () => ({ servable: false, probed: true, detail: 'warming' }),
    };
    await read();
    await read();
    expect(resumes).toEqual([]);
    expect(saved).toHaveLength(0);
  });
});
