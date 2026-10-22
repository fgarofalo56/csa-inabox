/**
 * Handler-level: the estate state read and the pause PREVIEW include the
 * Container Apps selected by the stored policy (operator decision 2026-10-22).
 * Only the network edges are mocked (ARM list, the orchestrator's actuator and
 * snapshot store, Cosmos); the policy, the guard, the planner and the ordering
 * are the REAL code. Every `it` names the input that breaks it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ESTATE = 'loom:estate-a';
const armGetWithRetry = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({ armGetWithRetry: (...a: unknown[]) => armGetWithRetry(...a) }));

let storedAutopause: unknown;
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async (d: unknown) => ({ resource: d })) } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert: vi.fn(async (d: unknown) => ({ resource: d })) },
    item: (id: string) => ({ read: async () => ({ resource: id === 'estate-autopause:current' ? storedAutopause : undefined }) }),
  })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

const resolveDeployManifest = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: async () => ({ readTags: async () => ({}), readPower: async () => ({}) }),
    loadPauseSnapshot: async () => null,
    savePauseSnapshot: async () => {},
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
    createManifestTagReader: () => async () => ({}),
  };
});

import { handlePausePost, handleStateRead, type EstateCaller } from '../estate-power-handlers';
import { clearStateCache } from '../estate-state-cache';

const caller: EstateCaller = { tenantId: 't1', who: 'admin@x', actorOid: 'o', actorTid: 't1', auditExtra: {} };
const POOL = '/subscriptions/s/resourceGroups/rg-dlz/providers/Microsoft.Synapse/workspaces/ws/sqlPools/pool1';

const armApp = (name: string, min = 1) => ({
  id: `/subscriptions/s/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/${name}`,
  name,
  tags: { 'loom-estate-id': ESTATE },
  properties: { template: { scale: { minReplicas: min, maxReplicas: 3 } } },
});

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  clearStateCache();
  storedAutopause = undefined;
  process.env.LOOM_SUBSCRIPTION_ID = 's';
  process.env.LOOM_ACA_RG = 'rg-admin';
  process.env.CONTAINER_APP_NAME = 'loom-console';
  delete process.env.LOOM_CONTAINER_PLATFORM;
  resolveDeployManifest.mockReturnValue({
    manifest: { estateId: ESTATE, resourceIds: [POOL] },
    entries: [{
      resourceId: POOL, resourceType: 'microsoft.synapse/workspaces/sqlpools', name: 'pool1',
      resourceGroup: 'rg-dlz', subscriptionId: 's', fromEnv: ['X'],
    }],
    unresolved: [], manifestGated: false, namedByDeploy: 1,
  });
  armGetWithRetry.mockResolvedValue({
    value: [armApp('loom-console', 2), armApp('loom-risingwave'), armApp('loom-mcp'), armApp('loom-airflow'), armApp('loom-trino', 0)],
  });
});
afterEach(() => { process.env = { ...savedEnv }; });

async function preview() {
  const res = await handlePausePost(caller, { dryRun: true });
  return (await res.json()) as any;
}

describe('pause preview', () => {
  // Breaks if: Container Apps are not fed to the planner (the pre-change behaviour: only the pool).
  it('by default includes ordinary apps; the console, never-pause apps and min-0 apps are not in it', async () => {
    const j = await preview();
    const names = j.preview.wouldPause.map((r: any) => r.name);
    expect(names).toContain('loom-mcp');
    expect(names).toContain('loom-airflow');
    expect(names).toContain('pool1'); // positive pair: the manifest-named resource is still there
    for (const held of ['loom-console', 'loom-risingwave', 'loom-trino']) expect(names).not.toContain(held);
    expect(j.containerApps).toMatchObject({ configured: true, willPause: 2 });
    expect(j.containerApps.apps.find((a: any) => a.name === 'loom-risingwave').state).toBe('held-out');
    expect(j.containerApps.apps.find((a: any) => a.name === 'loom-trino').state).toBe('already-zero');
  });

  // Breaks if: pause order stays discovery order (database first) -> an app is left running against a stopped pool.
  it('apps are dispatched BEFORE the Synapse pool they may depend on', async () => {
    const names = (await preview()).preview.wouldPause.map((r: any) => r.name);
    expect(names.indexOf('loom-mcp')).toBeLessThan(names.indexOf('pool1'));
    expect(names.indexOf('loom-airflow')).toBeLessThan(names.indexOf('pool1'));
  });

  // Breaks if: the stored global opt-out is not read -> apps stay in the preview.
  it('the stored GLOBAL opt-out removes every app and leaves the pool', async () => {
    storedAutopause = { kind: 'estate-autopause', enabled: true, idleHours: 2, containerApps: { enabled: false, exempt: [] } };
    const j = await preview();
    expect(j.preview.wouldPause.map((r: any) => r.name)).toEqual(['pool1']);
    expect(j.containerApps.apps.every((a: any) => ['opted-out'].includes(a.state))).toBe(true);
    expect(j.containerApps.policy.enabled).toBe(false);
  });

  // Breaks if: the stored per-app exemption is not applied (or exempts more than the one app).
  it('a stored per-app exemption removes exactly that app', async () => {
    storedAutopause = { kind: 'estate-autopause', enabled: true, idleHours: 2, containerApps: { enabled: true, exempt: ['loom-airflow'] } };
    const names = (await preview()).preview.wouldPause.map((r: any) => r.name);
    expect(names).toContain('loom-mcp');
    expect(names).not.toContain('loom-airflow');
  });

  // Breaks if: a Cosmos read failure falls back to the default and pauses apps that were exempted.
  it('an UNREADABLE setting pauses no app but still previews the pool', async () => {
    storedAutopause = { kind: 'estate-autopause', enabled: true, idleHours: 9999 }; // corrupt -> unreadable
    const j = await preview();
    expect(j.preview.wouldPause.map((r: any) => r.name)).toEqual(['pool1']);
    expect(j.containerApps.apps.every((a: any) => a.state === 'setting-unreadable')).toBe(true);
  });

  // Breaks if: a failed list silently yields an empty app set that LOOKS like "nothing to pause".
  it('a failed app listing is reported in containerApps.listError, and the pool is still previewed', async () => {
    armGetWithRetry.mockRejectedValue(new Error('ARM GET x failed 403: forbidden'));
    const j = await preview();
    expect(j.containerApps.listError).toMatch(/403/);
    expect(j.preview.wouldPause.map((r: any) => r.name)).toEqual(['pool1']);
  });

  // Breaks if: a throttled list is dropped and the confirm token ignores it (then a retry-later case pauses a partial set).
  it('a THROTTLED listing is returned as a readFailure so the preview token embeds it', async () => {
    armGetWithRetry.mockRejectedValue(new Error('ARM GET x was throttled (429) after 3 attempts'));
    const j = await preview();
    expect(j.readFailures).toHaveLength(1);
    expect(j.readFailures[0].throttled).toBe(true);
  });

  // Breaks if: an AKS-platform deployment lists Container Apps.
  it('on an AKS boundary there is no ARM listing at all', async () => {
    process.env.LOOM_CONTAINER_PLATFORM = 'aks';
    const j = await preview();
    expect(armGetWithRetry).not.toHaveBeenCalled();
    expect(j.containerApps.configured).toBe(false);
    expect(j.preview.wouldPause.map((r: any) => r.name)).toEqual(['pool1']);
  });
});

describe('state read (what the Admin panel shows)', () => {
  // Breaks if: the RUNNING payload drops containerApps -> the panel has no per-app list to toggle.
  it('a RUNNING state read carries the per-app list and the policy applied', async () => {
    const res = await handleStateRead(caller);
    const j = (await res.json()) as any;
    expect(j.state).toBe('RUNNING');
    expect(j.containerApps.apps.map((a: any) => a.name).sort()).toEqual(
      ['loom-airflow', 'loom-console', 'loom-mcp', 'loom-risingwave', 'loom-trino'],
    );
    expect(j.containerApps.policy).toEqual({ enabled: true, exempt: [] });
  });
});
