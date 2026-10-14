/**
 * #4876 step 2 (B) - Databricks workspace compute (SQL warehouses + clusters)
 * through the estate actuator. Every test names the input that would break it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const armGet = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armPost: vi.fn(),
  armPatch: vi.fn(),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

/** A tiny Databricks world: id -> {kind,name,state,autoStopMins}. */
type World = Map<string, { kind: 'sql-warehouse' | 'cluster'; name: string; state: string; autoStopMins?: number }>;
let world: World;
let stuck: Set<string>; // ids whose stop/start is accepted but never takes effect
const calls: string[] = [];

vi.mock('@/lib/azure/databricks-estate-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/azure/databricks-estate-client')>('@/lib/azure/databricks-estate-client');
  const toC = (id: string) => {
    const w = world.get(id);
    if (!w) throw new Error(`404 ${id}`);
    return { kind: w.kind, id, name: w.name, state: w.state, ...(w.autoStopMins === undefined ? {} : { autoStopMins: w.autoStopMins }) };
  };
  const move = (host: string, verb: string, id: string, to: string) => {
    calls.push(`${host}|${verb}|${id}`);
    if (!stuck.has(id)) world.get(id)!.state = to;
  };
  return {
    assertDatabricksHost: actual.assertDatabricksHost,
    listWarehouses: async () => [...world.keys()].filter((k) => world.get(k)!.kind === 'sql-warehouse').map(toC),
    listUserClusters: async () => [...world.keys()].filter((k) => world.get(k)!.kind === 'cluster').map(toC),
    getWarehouse: async (_h: string, id: string) => toC(id),
    getCluster: async (_h: string, id: string) => toC(id),
    stopWarehouse: async (h: string, id: string) => move(h, 'stopWarehouse', id, 'STOPPED'),
    startWarehouse: async (h: string, id: string) => move(h, 'startWarehouse', id, 'RUNNING'),
    terminateCluster: async (h: string, id: string) => move(h, 'terminateCluster', id, 'TERMINATED'),
    startCluster: async (h: string, id: string) => move(h, 'startCluster', id, 'RUNNING'),
  };
});

import { createArmActuator, dbxStateClass, dbxWorkspacePowerWord, normalizePowerState } from '../pause-actuator';
import { orderForResume, startPause, planPause, startResume, pollResume } from '../pause-orchestrator';
import { capturePrePauseState, newPauseSnapshot, armPowerReading, type PausedResourceSnapshot } from '../pause-state';
import type { PauseCandidate } from '../pause-inventory';

const WS = '/subscriptions/sub-v/resourceGroups/rg-v/providers/Microsoft.Databricks/workspaces/dbx-v';
const WS_TYPE = 'microsoft.databricks/workspaces';
const COM_URL = 'adb-1.2.azuredatabricks.net';

function arm(over?: { url?: string | null; prov?: string; tags?: Record<string, string> }) {
  armGet.mockImplementation(async () => ({
    tags: over?.tags ?? { 'loom-estate-id': 'e1' },
    properties: {
      provisioningState: over?.prov ?? 'Succeeded',
      ...(over?.url === null ? {} : { workspaceUrl: over?.url ?? COM_URL }),
    },
  }));
}

const res = { resourceId: WS, resourceType: WS_TYPE, name: 'dbx-v' };
function candidate(): PauseCandidate {
  return {
    resource: { ...res, resourceGroup: 'rg-v', subscriptionId: 'sub-v', tags: { 'loom-estate-id': 'e1' }, discoverySource: 'deploy-manifest' },
    spec: { resourceType: WS_TYPE, label: 'dbx', mechanism: 'workspace-compute-stop', capacityConstrained: false, armApiVersion: '2024-05-01' },
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
  };
}
function entry(children?: PausedResourceSnapshot['children']): PausedResourceSnapshot {
  return {
    ...res, resourceGroup: 'rg-v', subscriptionId: 'sub-v', prePausePowerState: 'Online', powerStateSource: 'arm',
    powerStateReadAt: '2026-10-13T00:00:00.000Z', powerStateApiVersion: '2024-05-01',
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...(children ? { children } : {}),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  stuck = new Set();
  world = new Map([
    ['w-run', { kind: 'sql-warehouse', name: 'loom-default', state: 'RUNNING', autoStopMins: 10 }],
    ['w-off', { kind: 'sql-warehouse', name: 'idle-wh', state: 'STOPPED', autoStopMins: 5 }],
    ['c-run', { kind: 'cluster', name: 'adhoc', state: 'RUNNING', autoStopMins: 30 }],
  ]);
  arm();
  process.env.LOOM_DATABRICKS_HOSTNAME = 'adb-FROM-ENV.9.azuredatabricks.net';
});

describe('vocabulary', () => {
  // Breaks if: an unrecognised Databricks state is classed as stopped/running instead of unknown.
  it('dbxStateClass: unrecognised -> unknown; known words classified', () => {
    expect(dbxStateClass('WEIRD')).toBe('unknown');
    expect(dbxStateClass('')).toBe('unknown');
    expect(dbxStateClass('running')).toBe('running');
    expect(dbxStateClass('PENDING')).toBe('starting');
    expect(dbxStateClass('TERMINATING')).toBe('stopping');
    expect(dbxStateClass('TERMINATED')).toBe('stopped');
  });

  // Breaks if: one unrecognised child is ignored and the workspace reads Paused/Online.
  it('dbxWorkspacePowerWord: any unknown child makes the workspace Unknown; running wins over stopped', () => {
    expect(normalizePowerState(WS_TYPE, dbxWorkspacePowerWord(['STOPPED', 'WEIRD']))).toBe('Unknown');
    expect(normalizePowerState(WS_TYPE, dbxWorkspacePowerWord(['STOPPED', 'RUNNING']))).toBe('Online');
    expect(normalizePowerState(WS_TYPE, dbxWorkspacePowerWord(['STOPPED', 'TERMINATED']))).toBe('Paused');
    expect(normalizePowerState(WS_TYPE, dbxWorkspacePowerWord(['STOPPING', 'STOPPED']))).toBe('Pausing');
    expect(normalizePowerState(WS_TYPE, 'garbage')).toBe('Unknown');
  });
});

describe('readPower records the prior state', () => {
  // Breaks if: the stopped warehouse is recorded (it would be started on resume) or autostop is dropped.
  it('children = exactly the RUNNING compute, with state and auto-stop minutes', async () => {
    const a = await createArmActuator();
    const r = await a.readPower(res);
    expect(r.reading?.powerState).toBe('Online');
    expect(r.children).toEqual([
      { kind: 'sql-warehouse', id: 'w-run', name: 'loom-default', priorState: 'RUNNING', autoStopMins: 10 },
      { kind: 'cluster', id: 'c-run', name: 'adhoc', priorState: 'RUNNING', autoStopMins: 30 },
    ]);
  });

  // Breaks if: the host falls back to LOOM_DATABRICKS_HOSTNAME - asserted via the host the client saw.
  it('addresses the host from the verified workspace ARM resource, never the env', async () => {
    arm({ url: 'adb-77.8.databricks.azure.us' });
    const a = await createArmActuator();
    await a.pause(candidate(), entry([{ kind: 'cluster', id: 'c-run', name: 'adhoc', priorState: 'RUNNING' }]));
    expect(calls).toEqual(['adb-77.8.databricks.azure.us|terminateCluster|c-run']);
  });

  // Breaks if: a workspace with no workspaceUrl/invalid host falls through to the env host.
  it.each([[null], ['evil.example.com']])('workspaceUrl %s => reading:null, nothing touched', async (url) => {
    arm({ url });
    const a = await createArmActuator();
    const r = await a.readPower(res);
    expect(r.reading).toBeNull();
    expect(r.error).toBeTruthy();
    expect(calls).toEqual([]);
  });

  // Breaks if: a workspace still provisioning is treated as addressable.
  it('a non-Succeeded workspace is not read', async () => {
    arm({ prov: 'Updating' });
    const a = await createArmActuator();
    expect((await a.readPower(res)).reading).toBeNull();
  });
});

describe('pause / resume round trip', () => {
  // Breaks if: pause stops the idle warehouse too, or resume starts it (restoring MORE than was running).
  it('pause stops exactly the recorded children; resume starts exactly them back', async () => {
    const a = await createArmActuator();
    const power = await a.readPower(res);
    const e = entry(power.children);

    const p = await a.pause(candidate(), e);
    expect(p.ok).toBe(true);
    expect(world.get('w-run')!.state).toBe('STOPPED');
    expect(world.get('c-run')!.state).toBe('TERMINATED');
    expect(calls.map((c) => c.split('|').slice(1).join('|')).sort()).toEqual(['stopWarehouse|w-run', 'terminateCluster|c-run']);

    calls.length = 0;
    const r = await a.resume(e);
    expect(r.ok).toBe(true);
    expect(world.get('w-run')!.state).toBe('RUNNING');
    expect(world.get('c-run')!.state).toBe('RUNNING');
    expect(world.get('w-off')!.state).toBe('STOPPED'); // never started
    expect(calls.some((c) => c.includes('w-off'))).toBe(false);
  });

  // Breaks if: pause acts without a recorded list (guessing at what to stop).
  it('pause without a snapshot entry is refused and touches nothing', async () => {
    const a = await createArmActuator();
    const p = await a.pause(candidate());
    expect(p).toMatchObject({ ok: false, error: 'dbx-no-recorded-children' });
    expect(calls).toEqual([]);
  });

  // Breaks if: compute started after the snapshot is stopped too (and so never restored).
  it('pause leaves compute that is NOT in the snapshot running', async () => {
    const a = await createArmActuator();
    await a.pause(candidate(), entry([{ kind: 'sql-warehouse', id: 'w-run', name: 'loom-default', priorState: 'RUNNING' }]));
    expect(world.get('c-run')!.state).toBe('RUNNING');
  });

  // Breaks if: an already-stopped child is stopped again (a needless mutation) or reported as a failure.
  it('idempotent: an already-stopped child gets no stop call and still reads back ok', async () => {
    world.get('w-run')!.state = 'STOPPED';
    const a = await createArmActuator();
    const p = await a.pause(candidate(), entry([{ kind: 'sql-warehouse', id: 'w-run', name: 'loom-default', priorState: 'RUNNING' }]));
    expect(p.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  // Breaks if: resume re-starts something already running.
  it('idempotent resume: a RUNNING child gets no start call', async () => {
    const a = await createArmActuator();
    const r = await a.resume(entry([{ kind: 'cluster', id: 'c-run', name: 'adhoc', priorState: 'RUNNING' }]));
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  // Breaks if: an accepted-but-ineffective stop is reported as success (no read-back check).
  it('read-back disagreement on pause is ok:false and names the child', async () => {
    stuck.add('c-run');
    const a = await createArmActuator();
    const p = await a.pause(candidate(), entry([
      { kind: 'sql-warehouse', id: 'w-run', name: 'loom-default', priorState: 'RUNNING' },
      { kind: 'cluster', id: 'c-run', name: 'adhoc', priorState: 'RUNNING' },
    ]));
    expect(p.ok).toBe(false);
    expect(p.detail).toContain('adhoc');
    expect(p.detail).toContain('1 stopped, 1 not');
    expect(world.get('w-run')!.state).toBe('STOPPED');
  });

  // Breaks if: an accepted-but-ineffective start is reported as success.
  it('read-back disagreement on resume is ok:false', async () => {
    world.get('w-run')!.state = 'STOPPED';
    stuck.add('w-run');
    const a = await createArmActuator();
    const r = await a.resume(entry([{ kind: 'sql-warehouse', id: 'w-run', name: 'loom-default', priorState: 'RUNNING' }]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('after the start');
  });

  // Breaks if: a 4xx from the data plane is swallowed.
  it('a data-plane error on pause is ok:false with the child named', async () => {
    world.delete('c-run'); // getCluster throws 404
    const a = await createArmActuator();
    const p = await a.pause(candidate(), entry([{ kind: 'cluster', id: 'c-run', name: 'adhoc', priorState: 'RUNNING' }]));
    expect(p.ok).toBe(false);
    expect(p.detail).toContain('adhoc');
  });

  // Breaks if: a workspace with nothing running is reported as a saving.
  it('an empty recorded list is a disclosed no-op', async () => {
    const a = await createArmActuator();
    expect(await a.pause(candidate(), entry([]))).toMatchObject({ ok: true, noop: true });
  });

  // Breaks if: resume invents work for a snapshot that recorded nothing.
  it('resume with no recorded children is refused', async () => {
    const a = await createArmActuator();
    expect(await a.resume(entry())).toMatchObject({ ok: false, error: 'dbx-no-recorded-children' });
  });
});

describe('probeServable', () => {
  const kids = [
    { kind: 'sql-warehouse' as const, id: 'w-run', name: 'loom-default', priorState: 'RUNNING', autoStopMins: 10 },
    { kind: 'cluster' as const, id: 'c-run', name: 'adhoc', priorState: 'RUNNING', autoStopMins: 30 },
  ];
  // Breaks if: servable is true while ONE recorded child is still down.
  it('servable only when EVERY recorded child is RUNNING', async () => {
    const a = await createArmActuator();
    world.get('c-run')!.state = 'TERMINATED';
    const down = await a.probeServable(entry(kids));
    expect(down).toMatchObject({ servable: false, probed: true });
    expect(down.detail).toContain('adhoc');
    world.get('c-run')!.state = 'RUNNING';
    expect(await a.probeServable(entry(kids))).toMatchObject({ servable: true, probed: true });
  });

  // Breaks if: a changed auto-stop setting is silently ignored.
  it('reports auto-stop drift in the detail without failing', async () => {
    world.get('w-run')!.autoStopMins = 99;
    const a = await createArmActuator();
    const p = await a.probeServable(entry(kids));
    expect(p.servable).toBe(true);
    expect(p.detail).toContain('loom-default auto-stop 99 vs recorded 10');
  });
});

describe('orchestrator integration', () => {
  // Breaks if: the workspace type is not in the tier, so the new verbs are unreachable.
  it('a tagged workspace is in the pause plan and a full pause -> resume cycle restores the compute', async () => {
    const disc = [{ ...candidate().resource }];
    const plan = planPause(disc, { scope: { kind: 'explicit-inventory', estateId: 'e1' } });
    expect(plan.dryRun.wouldPause.map((r) => r.resourceId)).toEqual([WS]);

    const actuator = await createArmActuator();
    const run = await startPause(plan, actuator, { snapshotId: 's', tenantId: 't', estateId: 'e1' });
    expect(run.actions[0].status).toBe('dispatched');
    expect(run.snapshot.resources[0].children?.map((c) => c.id)).toEqual(['w-run', 'c-run']);
    expect(world.get('w-run')!.state).toBe('STOPPED');

    const paused = { ...run.snapshot, state: 'PAUSED' as const };
    const resumed = await startResume(paused, actuator);
    expect(resumed.dispatches[0].status).toBe('dispatched');
    const poll = await pollResume(resumed.snapshot, actuator, { now: '2099-01-01T00:00:00.000Z' });
    expect(poll.state).toBe('RUNNING');
  });

  // Breaks if: Databricks is ranked as a consumer and resumed after apps that depend on it.
  it('resume rank puts Databricks with the data services (before Container Apps)', () => {
    const order = orderForResume([
      { resourceType: 'microsoft.app/containerapps' },
      { resourceType: WS_TYPE },
      { resourceType: 'microsoft.containerservice/managedclusters' },
    ]).map((e) => e.resourceType);
    expect(order).toEqual(['microsoft.containerservice/managedclusters', WS_TYPE, 'microsoft.app/containerapps']);
  });

  // Breaks if: capture silently drops children (resume would then have nothing to restore).
  it('capturePrePauseState carries children through', () => {
    const reading = armPowerReading({ resourceId: WS, powerState: 'Online', armApiVersion: '2024-05-01' });
    const snap = capturePrePauseState({
      ...res, resourceGroup: 'rg-v', subscriptionId: 'sub-v', reading,
      children: [{ kind: 'cluster', id: 'c', name: 'n', priorState: 'RUNNING' }],
      ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
    });
    expect(snap.children).toEqual([{ kind: 'cluster', id: 'c', name: 'n', priorState: 'RUNNING' }]);
    expect(newPauseSnapshot({ id: 'x', tenantId: 't', estateId: 'e' }).resources).toEqual([]);
  });
});
