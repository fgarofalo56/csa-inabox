/**
 * #5111 defects 2 and 3 - Consumption-plan sites never confirm, and the prior
 * state read as "stopped" on every row.
 *
 * Every `it` names the input that breaks it (assertion-design.md).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  planPause,
  pollPause,
  startPause,
  startResume,
  type EstateActuator,
  type PowerRead,
} from '../pause-orchestrator';
import { armPowerReading, type EstatePauseSnapshot, type EstatePowerState } from '../pause-state';
import { withIncrementalSnapshot } from '../pause-incremental';
import {
  buildEstateTagQuery,
  classifyTagRows,
  type ArgRow,
} from '../pause-tag-discovery';
import { CONSUMPTION_PLAN_REASON, isConsumptionPlanSku } from '../pause-guards';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';

const armGet = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armGetWithRetry: (p: unknown) => armGet(p),
  armPost: vi.fn(async () => ({})),
  armPatch: vi.fn(async () => ({})),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

const ESTATE = 'loom:estate-a';
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const SUB = 'sub-1';
const ours = { 'loom-estate-id': ESTATE };

function res(name: string, type: string, path?: string): DiscoveredResource {
  return {
    resourceId: `/subscriptions/${SUB}/resourceGroups/rg-x/providers/${path ?? `${type}/${name}`}`,
    resourceType: type,
    name,
    resourceGroup: 'rg-x',
    subscriptionId: SUB,
    tags: ours,
    discoverySource: 'deploy-manifest',
  };
}

const POOL = res('loompool', 'Microsoft.Synapse/workspaces/sqlPools', 'Microsoft.Synapse/workspaces/ws/sqlPools/loompool');
const ADX = res('adx-loom', 'Microsoft.Kusto/clusters');
const FUNC = res('func-csa-loom-mcp', 'Microsoft.Web/sites');

const ctx = () => ({
  snapshotId: 'snap-1',
  tenantId: 'tenant-1',
  estateId: ESTATE,
  createdBy: 'admin@contoso.com',
  now: '2026-10-23T22:38:00.000Z',
});

/**
 * A stateful fake of ARM: `pause()` really flips the resource to Paused, so a
 * read taken AFTER the dispatch returns Paused. That is what lets the
 * prior-state tests tell "recorded before the pause" from "recorded after".
 */
function statefulActuator(initial: Record<string, EstatePowerState>, extra?: Partial<EstateActuator>): EstateActuator & { live: Record<string, EstatePowerState>; resumed: string[] } {
  const live = { ...initial };
  const resumed: string[] = [];
  const a: EstateActuator & { live: Record<string, EstatePowerState>; resumed: string[] } = {
    live,
    resumed,
    async readTags() { return ours; },
    async readPower(r): Promise<PowerRead> {
      return {
        reading: armPowerReading({ resourceId: r.resourceId, powerState: live[r.resourceId] ?? 'Online', armApiVersion: '2021-06-01' }),
      };
    },
    async pause(c) {
      live[c.resource.resourceId] = 'Paused';
      return { ok: true, detail: `paused ${c.resource.name}` };
    },
    async resume(e) {
      resumed.push(e.resourceId);
      live[e.resourceId] = 'Online';
      return { ok: true, detail: `resumed ${e.name}` };
    },
    async probeServable() { return { servable: true, probed: true, detail: 'ok' }; },
    ...extra,
  };
  return a;
}

describe('#5111 defect 3 - the prior power state', () => {
  // Breaks if: the state is recorded AFTER the pause dispatch (the stateful fake then reads Paused for loompool
  // and the snapshot would say prePausePowerState 'Paused' - "was stopped before the pause").
  it('records Online for a pool that was Online, and Paused for one that already was', async () => {
    const actuator = statefulActuator({ [POOL.resourceId]: 'Online', [ADX.resourceId]: 'Paused' });
    const plan = planPause([POOL, ADX], { scope: SCOPE });
    const run = await startPause(plan, actuator, ctx());
    const byName = Object.fromEntries(run.snapshot.resources.map((r) => [r.name, r.prePausePowerState]));
    expect(byName).toEqual({ loompool: 'Online', 'adx-loom': 'Paused' });
    // The pool's live state really did change underneath: only a before-dispatch read can have recorded Online.
    expect(actuator.live[POOL.resourceId]).toBe('Paused');
  });

  // Breaks if: resume skips a resource that was Online before the pause (treats the recorded state as stopped).
  it('resume RESTARTS the Online-before-pause pool and leaves the already-paused one alone', async () => {
    const actuator = statefulActuator({ [POOL.resourceId]: 'Online', [ADX.resourceId]: 'Paused' });
    const run = await startPause(planPause([POOL, ADX], { scope: SCOPE }), actuator, ctx());
    const paused: EstatePauseSnapshot = { ...run.snapshot, state: 'PAUSED', pausedAt: '2026-10-23T22:45:00.000Z' };
    const resumed = await startResume(paused, actuator, { now: '2026-10-24T08:00:00.000Z' });
    expect(actuator.resumed).toEqual([POOL.resourceId]);
    const adx = resumed.dispatches.find((d) => d.name === 'adx-loom');
    expect(adx?.status).toBe('skipped');
    expect(adx?.detail).toContain('was Paused before the pause');
  });

  // Breaks if: `expectation` is hard-coded 'stopped' again - the panel then labels an Online-before-pause row
  // "(was stopped before the pause)". The two rows carry DIFFERENT priors so a constant cannot satisfy both.
  it('pollPause labels each row by its recorded prior: running for Online, stopped for Paused', async () => {
    const actuator = statefulActuator({ [POOL.resourceId]: 'Online', [ADX.resourceId]: 'Paused' });
    const run = await startPause(planPause([POOL, ADX], { scope: SCOPE }), actuator, ctx());
    const poll = await pollPause(run.snapshot, actuator);
    const exp = Object.fromEntries(poll.progress.map((p) => [p.name, p.expectation]));
    expect(exp).toEqual({ loompool: 'running', 'adx-loom': 'stopped' });
  });
});

describe('#5111 defect 2 - Consumption-plan sites', () => {
  const sub = SUB;
  const site = (name: string, over: Partial<ArgRow> = {}): ArgRow => ({
    id: `/subscriptions/${sub}/resourceGroups/rg-x/providers/Microsoft.Web/sites/${name}`,
    name,
    type: 'microsoft.web/sites',
    resourceGroup: 'rg-x',
    subscriptionId: sub,
    tags: ours,
    ...over,
  });
  const classify = (rows: ArgRow[]) => classifyTagRows({ rows, estateId: ESTATE, env: {} as NodeJS.ProcessEnv });

  // Breaks if: any one of the three Consumption signals is dropped (plan tier, plan sku, or the site's own `sku`).
  it.each([
    ['plan tier Dynamic', { planTier: 'Dynamic', planName: 'Y1' }],
    ['plan sku Y1 with no tier', { planName: 'Y1' }],
    ["the site's own sku 'Dynamic' when the plan join found nothing", { siteSku: 'Dynamic' }],
  ])('holds a site out of the pause set at plan time: %s', (_label, over) => {
    const { discovered, heldOut } = classify([site('func-csa-loom-mcp', over)]);
    expect(discovered).toEqual([]);
    expect(heldOut).toHaveLength(1);
    expect(heldOut[0].reason).toContain(CONSUMPTION_PLAN_REASON);
  });

  // Positive pair: breaks if EVERY site is held out (a blanket exclusion would pass the test above).
  it('keeps a PremiumV3 site, a Flex Consumption site, and a site whose plan is unknown', () => {
    const { discovered, heldOut } = classify([
      site('web-premium', { planName: 'P1v3', planTier: 'PremiumV3' }),
      site('func-flex', { planName: 'FC1', planTier: 'FlexConsumption' }),
      site('web-unknown'),
    ]);
    expect(discovered.map((d) => d.name).sort()).toEqual(['func-flex', 'web-premium', 'web-unknown']);
    expect(heldOut).toEqual([]);
  });

  it('only web sites are held for a Consumption plan: a Dynamic-tier row of another type is not', () => {
    const vm: ArgRow = { ...site('vm-1', { planTier: 'Dynamic' }), type: 'microsoft.compute/virtualmachines' };
    expect(classify([vm]).discovered.map((d) => d.name)).toEqual(['vm-1']);
  });

  // Breaks if: the query stops joining the plan (the row columns above would then always be empty in production).
  it('the Resource Graph query joins the hosting plan and projects its sku columns', () => {
    const q = buildEstateTagQuery(ESTATE);
    expect(q).toContain("microsoft.web/serverfarms");
    expect(q).toContain('on farm');
    expect(q).toMatch(/\| project id, name, type, resourceGroup, subscriptionId, location, tags, siteSku, planName, planTier/);
  });

  it('isConsumptionPlanSku: Dynamic or Y1 only (distinct non-matching values pinned)', () => {
    expect(isConsumptionPlanSku('Y1', undefined)).toBe(true);
    expect(isConsumptionPlanSku('anything', 'Dynamic')).toBe(true);
    expect(isConsumptionPlanSku('P1v3', 'PremiumV3')).toBe(false);
    expect(isConsumptionPlanSku('FC1', 'FlexConsumption')).toBe(false);
    expect(isConsumptionPlanSku(undefined, undefined)).toBe(false);
  });

  // A snapshot written BEFORE the hold-out existed: the Consumption site is in it, reads Online, and (before the fix)
  // kept the estate in PAUSING for ever.
  describe('pollPause over an EXISTING snapshot entry (the live stuck snapshot)', () => {
    const snapshotWith = async (): Promise<EstatePauseSnapshot> => {
      const actuator = statefulActuator({ [POOL.resourceId]: 'Online', [FUNC.resourceId]: 'Online' });
      // Both go through startPause so both are recorded exactly as the live ones were.
      const noopFunc = { ...actuator, async pause(c: Parameters<EstateActuator['pause']>[0]) {
        actuator.live[c.resource.resourceId] = c.resource.resourceId === POOL.resourceId ? 'Paused' : 'Online';
        return { ok: true, detail: `paused ${c.resource.name}` }; // NOT noop: reproduces the legacy recording
      } } as EstateActuator;
      const run = await startPause(planPause([POOL, FUNC], { scope: SCOPE }), noopFunc, ctx());
      return run.snapshot;
    };
    const powerOf = (live: Record<string, EstatePowerState>, consumption: Set<string>): EstateActuator => ({
      ...statefulActuator({}),
      async readPower(r): Promise<PowerRead> {
        return {
          reading: armPowerReading({ resourceId: r.resourceId, powerState: live[r.resourceId] ?? 'Online', armApiVersion: '2021-06-01' }),
          ...(consumption.has(r.resourceId) ? { consumptionPlan: true } : {}),
        };
      },
    });

    // Breaks if: the Consumption no-op is not treated as confirmed (poll stays PAUSING 1 of 2 forever).
    it('a Consumption site still reading Online is a confirmed NO-OP: the estate reaches PAUSED', async () => {
      const snap = await snapshotWith();
      expect(snap.resources.map((r) => r.name).sort()).toEqual(['func-csa-loom-mcp', 'loompool']);
      const poll = await pollPause(snap, powerOf({ [POOL.resourceId]: 'Paused', [FUNC.resourceId]: 'Online' }, new Set([FUNC.resourceId])));
      expect(poll.state).toBe('PAUSED');
      expect(poll.confirmed).toBe(2);
      const f = poll.progress.find((p) => p.name === 'func-csa-loom-mcp')!;
      expect(f.noop).toBe(true);
      // R7: it must read as a no-op, never as "stopped".
      expect(f.detail).toContain('no-op (Consumption plan)');
      expect(f.detail).toContain('never stopped');
      expect(f.detail).not.toMatch(/confirmed stopped|is Stopped/i);
      expect(poll.drifted).toBe(false);
    });

    // Positive pair / breaks if: the no-op rule is a blanket "web sites are settled" (plan NOT established).
    it('the same site with its plan NOT established stays unconfirmed: the estate stays PAUSING', async () => {
      const snap = await snapshotWith();
      const poll = await pollPause(snap, powerOf({ [POOL.resourceId]: 'Paused', [FUNC.resourceId]: 'Online' }, new Set()));
      expect(poll.state).toBe('PAUSING');
      expect(poll.confirmed).toBe(1);
      expect(poll.progress.find((p) => p.name === 'func-csa-loom-mcp')!.noop).toBeUndefined();
    });

    // Breaks if: consumptionPlan is honoured for any resource type (a pool flagged by mistake would be settled while Online).
    it('consumptionPlan on a NON-site resource that is Online does not settle it', async () => {
      const snap = await snapshotWith();
      const poll = await pollPause(snap, powerOf({ [POOL.resourceId]: 'Online', [FUNC.resourceId]: 'Online' }, new Set([POOL.resourceId, FUNC.resourceId])));
      expect(poll.progress.find((p) => p.name === 'loompool')!.atExpectedState).toBe(false);
      expect(poll.state).toBe('PAUSING');
    });
  });

  // The act-time path: a Consumption site that DOES reach the actuator is a no-op and is un-recorded.
  it('startPause un-records a Consumption no-op and the incremental snapshot follows it', async () => {
    const saved: EstatePauseSnapshot[] = [];
    const base = statefulActuator({ [FUNC.resourceId]: 'Online', [POOL.resourceId]: 'Online' });
    const actuator: EstateActuator = {
      ...base,
      async pause(c, e) {
        if (c.resource.resourceId === FUNC.resourceId) return { ok: true, noop: true, detail: 'Consumption plan; NOT stopped' };
        return base.pause(c, e);
      },
    };
    const inc = withIncrementalSnapshot(actuator, { id: 'snap-1', tenantId: 'tenant-1', estateId: ESTATE }, async (s) => { saved.push(s); });
    // FUNC first, POOL second: the POOL's progress save is the one that would leak FUNC.
    const plan = planPause([FUNC, POOL], { scope: SCOPE });
    expect(plan.dryRun.wouldPause.map((r) => r.name)).toEqual(['func-csa-loom-mcp', 'loompool']);
    const run = await startPause(plan, inc.actuator, ctx());
    expect(run.snapshot.resources.map((r) => r.name)).toEqual(['loompool']);
    expect(saved).toHaveLength(2);
    // Breaks if: the incremental copy keeps the no-op - the last save would then list BOTH.
    expect(saved[1].resources.map((r) => r.name)).toEqual(['loompool']);
  });
});

describe('#5111 actuator.readPower - the plan is READ, never assumed', () => {
  const siteId = `/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.Web/sites/func-a`;
  const farmId = `/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.Web/serverfarms/plan-a`;
  const resource = { resourceId: siteId, resourceType: 'microsoft.web/sites', name: 'func-a' };

  beforeEach(() => armGet.mockReset());

  const mockArm = (plan: unknown | Error) => armGet.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.startsWith(farmId)) {
      if (plan instanceof Error) throw plan;
      return plan;
    }
    return { properties: { state: 'Running', serverFarmId: farmId } };
  });

  it.each([
    ['Y1/Dynamic', { sku: { name: 'Y1', tier: 'Dynamic' } }, true],
    ['P1v3/PremiumV3', { sku: { name: 'P1v3', tier: 'PremiumV3' } }, false],
  ])('plan %s -> consumptionPlan=%s', async (_l, plan, expected) => {
    mockArm(plan);
    const { createArmActuator } = await import('../pause-actuator');
    const actuator = await createArmActuator();
    const p = await actuator.readPower(resource);
    expect(p.reading?.powerState).toBe('Online');
    expect(p.consumptionPlan === true).toBe(expected);
  });

  // Breaks if: an unreadable plan is read as Consumption (a site would be settled on a guess).
  it('an unreadable plan leaves consumptionPlan unset', async () => {
    mockArm(new Error('ARM 403'));
    const { createArmActuator } = await import('../pause-actuator');
    const actuator = await createArmActuator();
    const p = await actuator.readPower(resource);
    expect(p.reading?.powerState).toBe('Online');
    expect(p.consumptionPlan).toBeUndefined();
  });
});
