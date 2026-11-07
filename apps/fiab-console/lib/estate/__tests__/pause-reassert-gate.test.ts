/**
 * #5099 phase C: the re-stop in `handleStateRead` is a WRITE issued from a GET, so
 * its gate must not be bypassable. The gate is
 *   snapshot.state === 'PAUSED' && polled.drifted && opts.pipelineActivity === true && estatePauseEnabled()
 * One test per input, each with the all-true positive control so a test cannot pass
 * just because nothing ever stops (assertion-design.md #4).
 *
 * Disclosure (two equivalent mutants, measured by mutation 2026-10-23, not gaps): the explicit
 * `snapshot.state === 'PAUSED'` clause AND the `polled.drifted` clause each survive deletion,
 * because drift is only ever computed as state === 'PAUSED' && running (`pollPause`), and
 * `reassertAutoRestarted` iterates `driftedResources`, so with no drift nothing is stopped
 * either way. The no-drift and PAUSING tests below pin that behaviour (and guard against a
 * future loosening of those inner layers) but no input can kill either clause on its own.
 * The inputs with kill power are pipelineActivity and LOOM_ESTATE_PAUSE_ENABLED (RED when
 * dropped), and the all-true positive control.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ESTATE = 'loom:estate-gate';
const SUB = 's';
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
let storedSnapshot: any = null;
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: async () => actuatorImpl,
    loadPauseSnapshot: async () => storedSnapshot,
    savePauseSnapshot: vi.fn(async () => {}),
  };
});

import { handleStateRead, type EstateCaller } from '../estate-power-handlers';
import { clearStateCache } from '../estate-state-cache';
import { armPowerReading, type EstatePauseSnapshot, type PausedResourceSnapshot } from '../pause-state';

const caller: EstateCaller = { tenantId: 't1', who: 'admin@x', actorOid: 'o', actorTid: 't1', auditExtra: {} };
const PGID = `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-ok`;

const entry = (): PausedResourceSnapshot => ({
  resourceId: PGID, resourceType: 'microsoft.dbforpostgresql/flexibleservers', name: 'psql-ok',
  resourceGroup: 'rg-admin', subscriptionId: SUB, prePausePowerState: 'Online', powerStateSource: 'arm',
  powerStateReadAt: '2026-10-10T00:00:00.000Z', powerStateApiVersion: 'x',
  ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
} as unknown as PausedResourceSnapshot);

const snap = (state: string): EstatePauseSnapshot => ({
  schemaVersion: 1, id: 'snap', tenantId: 't1', estateId: ESTATE, state,
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', pausedAt: '2026-10-10T00:00:00.000Z',
  createdBy: 'x', resources: [entry()],
} as unknown as EstatePauseSnapshot);

function world(pgState: string) {
  const stops: string[] = [];
  actuatorImpl = {
    readTags: async () => ({}),
    readPower: async (r: any) => ({ reading: armPowerReading({ resourceId: r.resourceId, powerState: pgState as any, armApiVersion: 'x' }) }),
    pause: vi.fn(async (c: any) => { stops.push(c.resource.name); return { ok: true, detail: 'ARM accepted the stop.' }; }),
  };
  return stops;
}
const read = async (pipelineActivity: boolean) => {
  const j = (await (await handleStateRead(caller, { pipelineActivity })).json()) as any;
  return { data: j.data ?? j };
};

const savedEnv = { ...process.env };
beforeEach(() => {
  clearStateCache();
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  process.env.LOOM_ESTATE_PAUSE_ENABLED = 'true';
});
afterEach(() => { process.env = { ...savedEnv }; });

describe('the re-stop gate (GET /state must not write unless every input holds)', () => {
  // Positive control. Breaks if: the gate is so tight the re-stop never fires (every test below would then pass vacuously).
  it('all four inputs true: PAUSED + drifted + idle lane + armed -> exactly one stop, on psql-ok', async () => {
    storedSnapshot = snap('PAUSED');
    const stops = world('Online');
    const d = (await read(true)).data;
    expect(d.drifted).toBe(true);
    expect(stops).toEqual(['psql-ok']);
  });

  // Breaks if: `opts.pipelineActivity === true` is dropped, so any panel poll (pipelineActivity=false) re-stops.
  it('pipelineActivity=false (a panel poll): drift is reported, NO stop', async () => {
    storedSnapshot = snap('PAUSED');
    const stops = world('Online');
    const d = (await read(false)).data;
    expect(d.drifted).toBe(true); // the drift is still seen...
    expect(stops).toEqual([]); // ...and nothing is written
  });

  // Breaks if: `estatePauseEnabled()` is dropped, so an unarmed boundary still stops resources.
  it('LOOM_ESTATE_PAUSE_ENABLED unset (and "false"): NO stop even from the idle lane', async () => {
    for (const v of [undefined, 'false', '']) {
      clearStateCache();
      if (v === undefined) delete process.env.LOOM_ESTATE_PAUSE_ENABLED;
      else process.env.LOOM_ESTATE_PAUSE_ENABLED = v;
      storedSnapshot = snap('PAUSED');
      const stops = world('Online');
      const d = (await read(true)).data;
      expect(d.drifted, `value=${String(v)}`).toBe(true);
      expect(stops, `value=${String(v)}`).toEqual([]);
    }
  });

  // Documentation / guard against loosening (equivalent mutant, see the header): a correctly Paused server is never sent a redundant stop.
  it('PAUSED estate, server reads Stopped (no drift): NO stop', async () => {
    storedSnapshot = snap('PAUSED');
    const stops = world('Stopped');
    const d = (await read(true)).data;
    expect(d.drifted).toBe(false);
    expect(stops).toEqual([]);
  });

  // Documentation / guard against loosening (see the equivalent-mutant note at the top): while PAUSING, nothing is re-stopped.
  it('estate PAUSING with the server still running: NO re-stop (the pause itself is still in flight)', async () => {
    storedSnapshot = snap('PAUSING');
    const stops = world('Online');
    const d = (await read(true)).data;
    expect(d.state).not.toBe('RUNNING');
    expect(stops).toEqual([]);
  });
});
