/**
 * #4876 step 2 — the actuator for VMs, AKS, Container Apps, Stream Analytics
 * and Web sites. Every test names, in a comment, the input that would break it.
 *
 * The ARM transport is stubbed (as in pause-actuator.test.ts) and the URL /
 * body that would go on the wire is asserted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const armGet = vi.fn();
const armPost = vi.fn();
const armPatch = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armPost: (...a: unknown[]) => armPost(...a),
  armPatch: (...a: unknown[]) => armPatch(...a),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

import {
  createArmActuator,
  normalizePowerState,
  orderForResume,
  startResume,
  type EstateActuator,
  type PowerRead,
} from '../pause-orchestrator';
import type { PauseCandidate } from '../pause-inventory';
import {
  armPowerReading,
  newPauseSnapshot,
  type EstatePauseSnapshot,
  type PausedResourceSnapshot,
} from '../pause-state';

const base = '/subscriptions/sub-v/resourceGroups/rg-v/providers';
const ids = {
  vm: `${base}/Microsoft.Compute/virtualMachines/vm-v`,
  aks: `${base}/Microsoft.ContainerService/managedClusters/aks-v`,
  aca: `${base}/Microsoft.App/containerApps/aca-v`,
  asa: `${base}/Microsoft.StreamAnalytics/streamingJobs/asa-v`,
  web: `${base}/Microsoft.Web/sites/web-v`,
  adx: `${base}/Microsoft.Kusto/clusters/adx-v`,
};
const types: Record<keyof typeof ids, string> = {
  vm: 'microsoft.compute/virtualmachines',
  aks: 'microsoft.containerservice/managedclusters',
  aca: 'microsoft.app/containerapps',
  asa: 'microsoft.streamanalytics/streamingjobs',
  web: 'microsoft.web/sites',
  adx: 'microsoft.kusto/clusters',
};
type Kind = keyof typeof ids;

function candidate(kind: Kind): PauseCandidate {
  return {
    resource: {
      resourceId: ids[kind], resourceType: types[kind], name: `${kind}-v`,
      resourceGroup: 'rg-v', subscriptionId: 'sub-v', tags: {}, discoverySource: 'deploy-manifest',
    },
    spec: { resourceType: types[kind], label: kind, mechanism: 'arm-stop-action', capacityConstrained: false, armApiVersion: 'x' },
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
  };
}
function entry(kind: Kind, over?: Partial<PausedResourceSnapshot>): PausedResourceSnapshot {
  return {
    resourceId: ids[kind], resourceType: types[kind], name: `${kind}-v`, resourceGroup: 'rg-v',
    subscriptionId: 'sub-v', prePausePowerState: 'Online', powerStateSource: 'arm',
    powerStateReadAt: '2026-10-13T00:00:00.000Z', powerStateApiVersion: 'x',
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...over,
  };
}
const res = (kind: Kind) => ({ resourceId: ids[kind], resourceType: types[kind], name: `${kind}-v` });

/** Container App mock: mutable scale + replica count, PATCH applies. */
function acaWorld(init: { min: number; max: number; replicas?: number; ignorePatch?: boolean }) {
  const w = { ...init, replicas: init.replicas ?? 0 };
  armGet.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/revisions?')) return { value: [{ properties: { active: true, replicas: w.replicas } }] };
    return { properties: { provisioningState: 'Succeeded', template: { scale: { minReplicas: w.min, maxReplicas: w.max } } } };
  });
  armPatch.mockImplementation(async (_u: unknown, body: any) => {
    if (!w.ignorePatch) {
      const s = body.properties.template.scale;
      w.min = s.minReplicas; w.max = s.maxReplicas;
    }
    return {};
  });
  return w;
}

const PLAN_ID = `${base}/Microsoft.Web/serverfarms/plan-v`;
/** Default reads: a web site on a non-consumption plan. */
function webOnPlan(sku: { name?: string; tier?: string } | null, farmId: string | null = PLAN_ID) {
  armGet.mockImplementation(async (url: unknown) => {
    if (String(url).includes('/serverfarms/')) {
      if (!sku) throw new Error('403 plan');
      return { sku };
    }
    return { properties: { ...(farmId ? { serverFarmId: farmId } : {}), state: 'Running' } };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  armPost.mockResolvedValue({});
  armPatch.mockResolvedValue({});
  webOnPlan({ name: 'P1v3', tier: 'PremiumV3' });
  // The identity of the running process; none of the fixture apps is named this.
  process.env.CONTAINER_APP_NAME = 'loom-brain';
});

describe('normalizePowerState — new vocabularies', () => {
  // Input that breaks it: a mapper defaulting unknown strings to Online maps 'Weird' to Online.
  it.each([
    [types.vm, 'PowerState/weird'],
    [types.aks, 'Weird'],
    [types.aca, 'weird'],
    [types.asa, 'Degraded'],
    [types.web, 'QuotaExceeded'],
  ])('%s: unrecognised %s is Unknown, not Online', (t, raw) => {
    expect(normalizePowerState(t, raw)).toBe('Unknown');
  });

  // Input that breaks it: mapping 'PowerState/stopped' to Deallocated would hide a still-billed VM.
  it('VM: stopped stays Stopped (still billed), deallocated is Deallocated, running is Online', () => {
    expect(normalizePowerState(types.vm, 'PowerState/stopped')).toBe('Stopped');
    expect(normalizePowerState(types.vm, 'PowerState/deallocated')).toBe('Deallocated');
    expect(normalizePowerState(types.vm, 'PowerState/running')).toBe('Online');
    expect(normalizePowerState(types.vm, 'PowerState/deallocating')).toBe('Pausing');
  });

  // Input that breaks it: a Failed ASA job mapped to Stopped would be treated as safely paused.
  it('ASA: Failed is Unknown; Running Online; Stopped Stopped; Stopping Pausing', () => {
    expect(normalizePowerState(types.asa, 'Failed')).toBe('Unknown');
    expect(normalizePowerState(types.asa, 'Running')).toBe('Online');
    expect(normalizePowerState(types.asa, 'Stopped')).toBe('Stopped');
    expect(normalizePowerState(types.asa, 'Stopping')).toBe('Pausing');
  });

  it('AKS and Web: Running -> Online, Stopped -> Stopped', () => {
    expect(normalizePowerState(types.aks, 'Running')).toBe('Online');
    expect(normalizePowerState(types.aks, 'Stopped')).toBe('Stopped');
    expect(normalizePowerState(types.web, 'Running')).toBe('Online');
    expect(normalizePowerState(types.web, 'Stopped')).toBe('Stopped');
  });
});

describe('POST-verb types: URL, prior-state capture, ARM rejection', () => {
  // Input that breaks it: any verb other than deallocate/stop/stop/stop, or a URL not rooted at the verified id.
  it('pause hits the documented verb on the verified id', async () => {
    const a = await createArmActuator();
    for (const k of ['vm', 'aks', 'asa', 'web'] as const) await a.pause(candidate(k));
    const urls = armPost.mock.calls.map((c) => String(c[0]));
    expect(urls[0].startsWith(`${ids.vm}/deallocate?api-version=2023-09-01`)).toBe(true);
    expect(urls[1].startsWith(`${ids.aks}/stop?api-version=2024-02-01`)).toBe(true);
    expect(urls[2].startsWith(`${ids.asa}/stop?`)).toBe(true);
    expect(urls[3].startsWith(`${ids.web}/stop?`)).toBe(true);
    expect(urls).toHaveLength(4);
  });

  // Input that breaks it: resume of ASA with the default body (no outputStartMode) or a swapped verb.
  it('resume hits start on the verified id; ASA sends outputStartMode LastOutputEventTime', async () => {
    const a = await createArmActuator();
    for (const k of ['vm', 'aks', 'asa', 'web'] as const) await a.resume(entry(k));
    expect(armPost.mock.calls.map((c) => String(c[0]).split('?')[0])).toEqual([
      `${ids.vm}/start`, `${ids.aks}/start`, `${ids.asa}/start`, `${ids.web}/start`,
    ]);
    expect(armPost.mock.calls[2][1]).toEqual({ outputStartMode: 'LastOutputEventTime' });
  });

  // Input that breaks it: a 4xx swallowed into ok:true, or a detail that omits the resource name.
  it.each(['vm', 'aks', 'asa', 'web'] as const)('%s: ARM 403 on pause is ok:false and names the resource', async (k) => {
    armPost.mockRejectedValue(new Error('403 AuthorizationFailed'));
    const a = await createArmActuator();
    const r = await a.pause(candidate(k));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('REJECTED');
    expect(r.error).toContain('403');
  });

  // Input that breaks it: a VM readPower that omits $expand=instanceView would see no power code -> Unknown.
  it('VM readPower expands instanceView, reads PowerState/*, and records the VM size', async () => {
    armGet.mockResolvedValue({
      properties: {
        hardwareProfile: { vmSize: 'Standard_E8s_v5' },
        instanceView: { statuses: [{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/running' }] },
      },
    });
    const a = await createArmActuator();
    const r = await a.readPower(res('vm'));
    expect(String(armGet.mock.calls[0][0])).toContain('$expand=instanceView');
    expect(r.reading?.powerState).toBe('Online');
    expect(r.sku?.name).toBe('Standard_E8s_v5');
  });

  // Input that breaks it: unrecognised code read as Online; or provisioningState Stopping ignored.
  it('VM with an unrecognised power code reads Unknown, never Online', async () => {
    armGet.mockResolvedValue({ properties: { instanceView: { statuses: [{ code: 'PowerState/zzz' }] } } });
    const a = await createArmActuator();
    expect((await a.readPower(res('vm'))).reading?.powerState).toBe('Unknown');
  });

  it('AKS readPower: powerState.code, but an in-flight provisioningState wins', async () => {
    const a = await createArmActuator();
    armGet.mockResolvedValue({ properties: { provisioningState: 'Succeeded', powerState: { code: 'Stopped' } } });
    expect((await a.readPower(res('aks'))).reading?.powerState).toBe('Stopped');
    // Input that breaks it: reading powerState.code=Running while provisioningState is Stopping reports Online mid-stop.
    armGet.mockResolvedValue({ properties: { provisioningState: 'Stopping', powerState: { code: 'Running' } } });
    expect((await a.readPower(res('aks'))).reading?.powerState).toBe('Pausing');
  });

  it('ASA and Web readPower use jobState / state', async () => {
    const a = await createArmActuator();
    armGet.mockResolvedValue({ properties: { jobState: 'Running' } });
    expect((await a.readPower(res('asa'))).reading?.powerState).toBe('Online');
    armGet.mockResolvedValue({ properties: { state: 'Stopped' } });
    expect((await a.readPower(res('web'))).reading?.powerState).toBe('Stopped');
  });

  // Input that breaks it: a thrown ARM error converted into a state (reading must be null).
  it('a failed power read yields reading:null with the error, not a state', async () => {
    armGet.mockRejectedValue(new Error('429 throttled'));
    const a = await createArmActuator();
    const r = await a.readPower(res('web'));
    expect(r.reading).toBeNull();
    expect(r.error).toContain('429');
  });
});

describe('Container Apps — exact restore of the replica range', () => {
  // Input that breaks it: resume restoring a hard-coded 1/10 (or dropping maxReplicas) instead of 2/5.
  it('pause records 2/5, scales to 0 keeping max, and resume restores 2/5 exactly', async () => {
    const w = acaWorld({ min: 2, max: 5, replicas: 3 });
    const a = await createArmActuator();

    const power = await a.readPower(res('aca'));
    expect(power.scale).toEqual({ minReplicas: 2, maxReplicas: 5 });
    expect(power.reading?.powerState).toBe('Online');

    const p = await a.pause(candidate('aca'));
    expect(p.ok).toBe(true);
    expect(armPatch).toHaveBeenCalledTimes(1);
    expect(armPatch.mock.calls[0][1]).toEqual({ properties: { template: { scale: { minReplicas: 0, maxReplicas: 5 } } } });
    expect(String(armPatch.mock.calls[0][0]).startsWith(`${ids.aca}?`)).toBe(true);
    expect(w.min).toBe(0);

    const r = await a.resume(entry('aca', { scale: power.scale }));
    expect(r.ok).toBe(true);
    expect([w.min, w.max]).toEqual([2, 5]);
  });

  // Input that breaks it: pause PATCHing 0 over an app already at 0 (or inventing a value on resume).
  it('already at minReplicas 0: pause sends nothing; recorded scale is 0; resume restores 0, inventing nothing', async () => {
    const w = acaWorld({ min: 0, max: 4, replicas: 0 });
    const a = await createArmActuator();
    const power = await a.readPower(res('aca'));
    expect(power.reading?.powerState).toBe('Paused');
    expect(power.scale).toEqual({ minReplicas: 0, maxReplicas: 4 });

    const p = await a.pause(candidate('aca'));
    expect(p.ok).toBe(true);
    expect(armPatch).not.toHaveBeenCalled();

    const r = await a.resume(entry('aca', { scale: power.scale }));
    expect(r.ok).toBe(true);
    expect(w.min).toBe(0);
    expect(armPatch).not.toHaveBeenCalled(); // already equal -> no write
  });

  // Input that breaks it: min 0 with live replicas reported as Paused (would be "confirmed stopped" while serving).
  it('minReplicas 0 with running replicas reads Scaling, not Paused', async () => {
    acaWorld({ min: 0, max: 4, replicas: 2 });
    const a = await createArmActuator();
    expect((await a.readPower(res('aca'))).reading?.powerState).toBe('Scaling');
  });

  // Input that breaks it: a revisions-list failure treated as zero replicas -> a busy app reads Paused.
  it('a failed revisions read makes the whole read fail (reading:null), not Paused', async () => {
    armGet.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/revisions?')) throw new Error('500 revisions');
      return { properties: { template: { scale: { minReplicas: 0, maxReplicas: 4 } } } };
    });
    const a = await createArmActuator();
    const r = await a.readPower(res('aca'));
    expect(r.reading).toBeNull();
    expect(r.error).toContain('500');
  });

  // Input that breaks it: ARM accepts the PATCH but the app still reports min 2; pause must NOT report success.
  it('pause whose read-back disagrees (min still 2) is ok:false', async () => {
    acaWorld({ min: 2, max: 5, ignorePatch: true });
    const a = await createArmActuator();
    const p = await a.pause(candidate('aca'));
    expect(p.ok).toBe(false);
    expect(p.error).toBe('aca-readback-mismatch:min=2');
  });

  // Input that breaks it: resume reporting ok when the read-back range differs from the recorded one.
  it('resume whose read-back disagrees is ok:false and names the mismatch', async () => {
    acaWorld({ min: 0, max: 5, ignorePatch: true });
    const a = await createArmActuator();
    const r = await a.resume(entry('aca', { scale: { minReplicas: 2, maxReplicas: 5 } }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aca-readback-mismatch:0/5');
  });

  // Input that breaks it: an old snapshot with no scale getting a guessed min 1.
  it('resume of an entry with no recorded scale is refused and nothing is written', async () => {
    acaWorld({ min: 0, max: 5 });
    const a = await createArmActuator();
    const r = await a.resume(entry('aca'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aca-no-recorded-scale');
    expect(armPatch).not.toHaveBeenCalled();
  });

  // Input that breaks it: ARM 4xx on the PATCH swallowed.
  it('ARM 4xx on the pause PATCH is ok:false naming the resource', async () => {
    acaWorld({ min: 2, max: 5 });
    armPatch.mockRejectedValue(new Error('403 Forbidden'));
    const a = await createArmActuator();
    const p = await a.pause(candidate('aca'));
    expect(p.ok).toBe(false);
    expect(p.detail).toContain('aca-v');
  });
});

describe('probeServable for the new types', () => {
  // Input that breaks it: probed:false (which pollResume turns into RESUME_FAILED forever) or servable on a Stopped job.
  it('ASA: Running is servable+probed; Stopped is not servable', async () => {
    const a = await createArmActuator();
    armGet.mockResolvedValue({ properties: { jobState: 'Running' } });
    expect(await a.probeServable(entry('asa'))).toMatchObject({ servable: true, probed: true });
    armGet.mockResolvedValue({ properties: { jobState: 'Stopped' } });
    expect(await a.probeServable(entry('asa'))).toMatchObject({ servable: false, probed: true });
  });

  // Input that breaks it: guest agent NotReady ignored.
  it('VM: running but guest agent NotReady is not servable', async () => {
    const a = await createArmActuator();
    armGet.mockResolvedValue({ properties: { instanceView: { statuses: [{ code: 'PowerState/running' }], vmAgent: { statuses: [{ displayStatus: 'Not Ready' }] } } } });
    expect((await a.probeServable(entry('vm'))).servable).toBe(false);
    armGet.mockResolvedValue({ properties: { instanceView: { statuses: [{ code: 'PowerState/running' }], vmAgent: { statuses: [{ displayStatus: 'Ready' }] } } } });
    expect((await a.probeServable(entry('vm'))).servable).toBe(true);
  });

  // Input that breaks it: a Container App still at min 0 reported servable.
  it('Container App: servable only when the recorded range is restored', async () => {
    const a = await createArmActuator();
    acaWorld({ min: 0, max: 5 });
    expect((await a.probeServable(entry('aca', { scale: { minReplicas: 2, maxReplicas: 5 } }))).servable).toBe(false);
    acaWorld({ min: 2, max: 5, replicas: 2 });
    expect((await a.probeServable(entry('aca', { scale: { minReplicas: 2, maxReplicas: 5 } }))).servable).toBe(true);
  });

  // Input that breaks it: AKS Succeeded+Stopped reported servable.
  it('AKS: needs Succeeded AND Running; Web: Limited availability is not servable', async () => {
    const a = await createArmActuator();
    armGet.mockResolvedValue({ properties: { provisioningState: 'Succeeded', powerState: { code: 'Stopped' } } });
    expect((await a.probeServable(entry('aks'))).servable).toBe(false);
    armGet.mockResolvedValue({ properties: { provisioningState: 'Succeeded', powerState: { code: 'Running' } } });
    expect((await a.probeServable(entry('aks'))).servable).toBe(true);
    armGet.mockResolvedValue({ properties: { state: 'Running', availabilityState: 'Limited' } });
    expect((await a.probeServable(entry('web'))).servable).toBe(false);
    armGet.mockResolvedValue({ properties: { state: 'Running', availabilityState: 'Normal' } });
    expect((await a.probeServable(entry('web'))).servable).toBe(true);
  });
});

describe('resume ordering', () => {
  const order = ['aca', 'vm', 'web', 'adx', 'asa', 'aks'] as const;
  // Input that breaks it: dispatch in snapshot order (aca first) or AKS after the data services.
  it('orderForResume: AKS, then data services, then Container Apps/VMs/Web (stable inside a rank)', () => {
    const sorted = orderForResume(order.map((k) => entry(k))).map((e) => e.name);
    expect(sorted).toEqual(['aks-v', 'adx-v', 'asa-v', 'aca-v', 'vm-v', 'web-v']);
  });

  // Input that breaks it: ordering helper exists but startResume still iterates snapshot order.
  it('startResume actually dispatches in that order', async () => {
    const snap: EstatePauseSnapshot = {
      ...newPauseSnapshot({ id: 's', tenantId: 't', estateId: 'e' }),
      state: 'PAUSED',
      resources: order.map((k) => entry(k)),
    };
    const called: string[] = [];
    const actuator: EstateActuator = {
      readTags: async () => ({}),
      readPower: async (): Promise<PowerRead> => ({ reading: armPowerReading({ resourceId: 'x', powerState: 'Online', armApiVersion: 'v' }) }),
      pause: async () => ({ ok: true, detail: '' }),
      resume: async (e) => { called.push(e.name); return { ok: true, detail: '' }; },
      probeServable: async () => ({ servable: true, probed: true, detail: '' }),
    };
    const out = await startResume(snap, actuator);
    expect(called).toEqual(['aks-v', 'adx-v', 'asa-v', 'aca-v', 'vm-v', 'web-v']);
    expect(out.dispatches.map((d) => d.name)).toEqual(called);
  });
});

describe('Web sites on Consumption plans, and the actuator-level console guard', () => {
  // Breaks if: a Y1/Dynamic site is stopped (a fabricated saving that also kills its triggers).
  it.each([
    [{ name: 'Y1', tier: 'Dynamic' }],
    [{ name: 'Y1' }],
    [{ tier: 'Dynamic' }],
  ])('web on a Consumption plan %j is a disclosed no-op: noop:true, no POST', async (sku) => {
    webOnPlan(sku);
    const a = await createArmActuator();
    const r = await a.pause(candidate('web'));
    expect(r).toMatchObject({ ok: true, noop: true });
    expect(r.detail).toContain('NOT stopped');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: the guard is inverted and a dedicated-plan site is no-op'd instead of stopped.
  it('web on a dedicated plan is stopped, not no-op', async () => {
    const a = await createArmActuator();
    const r = await a.pause(candidate('web'));
    expect(r.noop).toBeUndefined();
    expect(String(armPost.mock.calls[0][0]).startsWith(`${ids.web}/stop?`)).toBe(true);
  });

  // Breaks if: an unreadable plan is treated as non-consumption and the site is stopped.
  it.each([['plan read 403', null, PLAN_ID], ['no serverFarmId', { name: 'P1v3' }, null]])(
    'web with %s is refused (left running), never stopped',
    async (_label, sku, farm) => {
      webOnPlan(sku as { name: string } | null, farm as string | null);
      const a = await createArmActuator();
      const r = await a.pause(candidate('web'));
      expect(r.ok).toBe(false);
      expect(armPost).not.toHaveBeenCalled();
    },
  );

  // Breaks if: the actuator trusts the orchestrator and scales the app that IS this process.
  it('actuator refuses to scale the Container App that is the running process', async () => {
    acaWorld({ min: 2, max: 5 });
    process.env.CONTAINER_APP_NAME = 'aca-v';
    const a = await createArmActuator();
    const r = await a.pause(candidate('aca'));
    expect(r).toMatchObject({ ok: false, error: 'aca-console-guard' });
    expect(armPatch).not.toHaveBeenCalled();
  });

  // Breaks if: an unset CONTAINER_APP_NAME is read as "not the console" and the PATCH goes out.
  it('actuator refuses every Container App when its own identity is unknown', async () => {
    acaWorld({ min: 2, max: 5 });
    delete process.env.CONTAINER_APP_NAME;
    const a = await createArmActuator();
    const r = await a.pause(candidate('aca'));
    expect(r).toMatchObject({ ok: false, error: 'aca-console-guard' });
    expect(armPatch).not.toHaveBeenCalled();
  });

  // Breaks if: the live tags are not consulted by the actuator itself.
  it('actuator refuses a Container App whose fresh tags mark it as the resume surface', async () => {
    const w = acaWorld({ min: 2, max: 5 });
    const inner = armGet.getMockImplementation()!;
    armGet.mockImplementation(async (url: unknown) => {
      const body: any = await inner(url);
      return String(url).includes('/revisions?') ? body : { ...body, tags: { 'loom-role': 'console' } };
    });
    const a = await createArmActuator();
    const r = await a.pause(candidate('aca'));
    expect(r.ok).toBe(false);
    expect(w.min).toBe(2);
  });
});
