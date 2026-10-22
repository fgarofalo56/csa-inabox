/**
 * The never-pause list at the THREE places a Container App can be stopped:
 * plan time (`planPause`), act time (`startPause`) and the ARM actuator. A mutation
 * at one site is proven only at that site (csa_loom_a_mutation_arm_proves_only_the_site_it_was_applied_at),
 * so each site has its own test. Every `it` names the input that breaks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const armGet = vi.fn();
const armPatch = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armGetWithRetry: (p: unknown) => armGet(p),
  armPost: vi.fn(),
  armPatch: (...a: unknown[]) => armPatch(...a),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

import { containerAppPauseGuard, NEVER_PAUSE_CONTAINER_APPS, neverPauseReason } from '../pause-guards';
import { createArmActuator, planPause, startPause, type EstateActuator } from '../pause-orchestrator';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';

const ESTATE = 'loom:e1:rg';
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const SELF = 'loom-console';
const ours = { 'loom-estate-id': ESTATE };

// The apps added by review round 1 (B1): background workers + synchronous user-path callers with unproven wake time.
const NEW_NEVER = ['loom-activator', 'loom-mirroring', 'loom-airflow', 'loom-mcp', 'loom-mcp-bridge'];
const aca = (name: string): DiscoveredResource => ({
  resourceId: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/${name}`,
  resourceType: 'Microsoft.App/containerApps',
  name, resourceGroup: 'rg', subscriptionId: 's', tags: ours, discoverySource: 'arm-rg-list',
});

const BACKGROUND = NEW_NEVER.map((n) => aca(n));

beforeEach(() => { vi.resetAllMocks(); });

describe('guard (pure)', () => {
  // Breaks if: a name is removed from the list or the guard stops consulting it.
  it.each(Object.keys(NEVER_PAUSE_CONTAINER_APPS))('%s is ineligible with a perfect tag set and a known process identity', (name) => {
    const g = containerAppPauseGuard({ name, tags: ours }, SELF);
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('never-pause list');
    expect(neverPauseReason(name)).toBeTruthy();
  });

  // Breaks if: the guard over-blocks every app (then "default-on" is a no-op).
  it('an ordinary app is eligible under the same inputs', () => {
    expect(containerAppPauseGuard({ name: 'loom-udf-runtime', tags: ours }, SELF).eligible).toBe(true);
    expect(neverPauseReason('loom-udf-runtime')).toBeNull();
  });

  // The list is the operator-visible contract; a silent shrink is a regression.
  it('the list is exactly this set (asserted literally)', () => {
    expect(Object.keys(NEVER_PAUSE_CONTAINER_APPS).sort()).toEqual([
      'iceberg-catalog', 'loom-activator', 'loom-airflow', 'loom-capacity-broker', 'loom-duckdb', 'loom-mcp', 'loom-mcp-bridge',
      'loom-mirroring', 'loom-onelake', 'loom-redis-oss', 'loom-risingwave', 'loom-unity',
    ]);
  });

  // Breaks if: the console stops being held out by name (guard branch deleted).
  it('the console is ineligible by name and by identity', () => {
    expect(containerAppPauseGuard({ name: 'loom-console', tags: ours }, 'other').eligible).toBe(false);
    expect(containerAppPauseGuard({ name: 'loom-x', tags: ours }, 'loom-x').eligible).toBe(false);
  });
});

describe('plan time', () => {
  // Breaks if: planPause stops applying the guard -> loom-risingwave lands in wouldPause.
  it('a never-pause app and the console are out of the plan, with a reason; an ordinary app is in', () => {
    const apps = [...BACKGROUND, aca('loom-risingwave'), aca('iceberg-catalog'), aca('loom-console'), aca('loom-udf-runtime')];
    const plan = planPause(apps, { scope: SCOPE, selfAppName: SELF });
    expect(plan.dryRun.wouldPause.map((r) => r.name)).toEqual(['loom-udf-runtime']);
    const held = plan.outOfTier.map((o) => o.name).sort();
    expect(held).toEqual(['iceberg-catalog', 'loom-activator', 'loom-airflow', 'loom-console', 'loom-mcp', 'loom-mcp-bridge', 'loom-mirroring', 'loom-risingwave']);
    expect(plan.outOfTier.find((o) => o.name === 'loom-risingwave')?.reason).toMatch(/never-pause list because/);
  });
});

describe('act time (startPause re-checks even a hand-built plan)', () => {
  // Breaks if: startPause trusts the plan -> the actuator pause() is called for a never-pause app.
  it.each([...NEW_NEVER, 'loom-risingwave'])('a never-pause candidate (%s) that reached the plan is SKIPPED and never actuated', async (neverName) => {
    const seed = planPause([aca('loom-udf-runtime')], { scope: SCOPE, selfAppName: SELF });
    const c = seed.inventory.pausable[0];
    const forged = { ...c, resource: { ...c.resource, name: neverName, resourceId: aca(neverName).resourceId } };
    const plan = { ...seed, inventory: { ...seed.inventory, pausable: [forged] } };
    const pause = vi.fn();
    const readPower = vi.fn();
    const actuator = { readTags: async () => ours, readPower, pause } as unknown as EstateActuator;
    const run = await startPause(plan, actuator, {
      snapshotId: 's', tenantId: 't', estateId: ESTATE, selfAppName: SELF, readManifest: async () => null,
    });
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0]).toMatchObject({ status: 'skipped' });
    expect(run.actions[0].detail).toMatch(/never-pause list because/);
    expect(pause).not.toHaveBeenCalled();
    expect(readPower).not.toHaveBeenCalled(); // skipped BEFORE any state read, not merely before the verb
  });
});

describe('actuator (last line before the PATCH)', () => {
  // Breaks if: the actuator guard is removed -> a PATCH to minReplicas 0 goes out for loom-risingwave.
  it.each([...NEW_NEVER, 'loom-risingwave'])('refuses to scale %s even when called directly; no PATCH is sent', async (neverName) => {
    process.env.CONTAINER_APP_NAME = SELF;
    armGet.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/revisions?')) return { value: [] };
      return { tags: ours, properties: { provisioningState: 'Succeeded', template: { scale: { minReplicas: 1, maxReplicas: 1 } } } };
    });
    const a = await createArmActuator();
    const d = aca(neverName);
    const r = await a.pause({
      resource: d,
      spec: { resourceType: 'microsoft.app/containerapps', label: 'aca', mechanism: 'scale-to-zero', capacityConstrained: false, armApiVersion: 'x' },
      ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
    });
    expect(r).toMatchObject({ ok: false, error: 'aca-console-guard' });
    expect(armPatch).not.toHaveBeenCalled();
  });
});
