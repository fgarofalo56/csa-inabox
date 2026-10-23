/**
 * #5099 phase A, handler level: the estate preview includes AKS / VM / Databricks /
 * Stream Analytics / web sites discovered by the `loom-estate-id` tag, unioned with
 * the manifest and Container Apps sources. Only the network edges are mocked (the
 * Resource Graph POST, the ARM list, the actuator, Cosmos); the discovery module,
 * guards, planner and ordering are the REAL code. Every `it` names the input that
 * breaks it (assertion-design.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ESTATE = 'loom:estate-a';
const SUB = 's';
const armGetWithRetry = vi.fn();
const armPost = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGetWithRetry: (...a: unknown[]) => armGetWithRetry(...a),
  armPost: (...a: unknown[]) => armPost(...a),
}));

let storedAutopause: unknown;
let actuatorImpl: any = { readTags: async () => ({}), readPower: async () => ({}) };
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async (d: unknown) => ({ resource: d })) } })),
  maintenanceJobsContainer: vi.fn(async () => ({
    items: { upsert: vi.fn(async (d: any) => ({ resource: d })) },
    item: (id: string) => ({ read: async () => ({ resource: id === 'estate-autopause:current' ? storedAutopause : undefined }) }),
  })),
}));
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: vi.fn() }));

const resolveDeployManifest = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/estate/pause-orchestrator')>();
  return {
    ...real,
    createArmActuator: async () => actuatorImpl,
    loadPauseSnapshot: async () => null,
    savePauseSnapshot: async () => {},
    resolveDeployManifest: (...a: unknown[]) => resolveDeployManifest(...a),
    createManifestTagReader: () => async () => ({}),
  };
});

import { handlePausePost, type EstateCaller } from '../estate-power-handlers';
import { clearStateCache } from '../estate-state-cache';

const caller: EstateCaller = { tenantId: 't1', who: 'admin@x', actorOid: 'o', actorTid: 't1', auditExtra: {} };
const POOL = `/subscriptions/${SUB}/resourceGroups/rg-dlz/providers/Microsoft.Synapse/workspaces/ws/sqlPools/pool1`;
const mine = { 'loom-estate-id': ESTATE };

const argRow = (type: string, provider: string, name: string, tags: Record<string, string> | null = mine, rg = 'rg-admin') => ({
  id: `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${provider}/${name}`,
  name,
  type,
  resourceGroup: rg,
  subscriptionId: SUB,
  tags,
});
const AKS = (n: string, tags: Record<string, string> | null = mine) => argRow('microsoft.containerservice/managedclusters', 'Microsoft.ContainerService/managedClusters', n, tags);
const VM = (n: string, tags: Record<string, string> | null = mine, rg = 'rg-admin') => argRow('microsoft.compute/virtualmachines', 'Microsoft.Compute/virtualMachines', n, tags, rg);
const ADB = (n: string) => argRow('microsoft.databricks/workspaces', 'Microsoft.Databricks/workspaces', n);
const ASA = (n: string) => argRow('microsoft.streamanalytics/streamingjobs', 'Microsoft.StreamAnalytics/streamingjobs', n);
const WEB = (n: string) => argRow('microsoft.web/sites', 'Microsoft.Web/sites', n);

/** Route the two Resource Graph queries: the readable-subscription probe and the tag query. */
function graph(rows: unknown[], opts: { readable?: string[] } = {}) {
  armPost.mockImplementation(async (_path: string, body: any) => {
    const q = String(body.query);
    if (q.startsWith('resourcecontainers')) return { data: (opts.readable ?? [SUB]).map((s) => ({ subscriptionId: s })) };
    return { data: rows };
  });
}

const savedEnv = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  actuatorImpl = { readTags: async () => ({}), readPower: async () => ({}) };
  clearStateCache();
  storedAutopause = undefined;
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  process.env.LOOM_ACA_RG = 'rg-admin';
  process.env.CONTAINER_APP_NAME = 'loom-console';
  delete process.env.LOOM_CONTAINER_PLATFORM;
  delete process.env.LOOM_AKS_CLUSTER_NAME;
  delete process.env.KUBERNETES_SERVICE_HOST;
  resolveDeployManifest.mockReturnValue({
    manifest: { estateId: ESTATE, resourceIds: [POOL] },
    entries: [{
      resourceId: POOL, resourceType: 'microsoft.synapse/workspaces/sqlpools', name: 'pool1',
      resourceGroup: 'rg-dlz', subscriptionId: SUB, fromEnv: ['X'],
    }],
    unresolved: [], manifestGated: false, namedByDeploy: 1,
  });
  // Container Apps source: one ordinary app, tagged for this estate.
  armGetWithRetry.mockResolvedValue({
    value: [{
      id: `/subscriptions/${SUB}/resourceGroups/rg-admin/providers/Microsoft.App/containerApps/loom-udf-runtime`,
      name: 'loom-udf-runtime', tags: mine,
      properties: { template: { scale: { minReplicas: 1, maxReplicas: 3 } } },
    }],
  });
  graph([]);
});
afterEach(() => { process.env = { ...savedEnv }; });

async function preview() {
  return (await (await handlePausePost(caller, { dryRun: true })).json()) as any;
}
const names = (j: any) => j.preview.wouldPause.map((r: any) => r.name) as string[];

describe('tag-discovered resources reach the plan', () => {
  // Breaks if: the tag source is not merged into the plan (the pre-change behaviour: only pool1 + the app).
  it('AKS, VM, Databricks, Stream Analytics and a web site appear, alongside the manifest pool and the Container App', async () => {
    graph([AKS('aks-batch'), VM('vm-gh'), ADB('adb-loom'), ASA('asa-job'), WEB('func-site')]);
    const j = await preview();
    for (const n of ['aks-batch', 'vm-gh', 'adb-loom', 'asa-job', 'func-site']) expect(names(j)).toContain(n);
    // union: the sources that worked before are still present (a union that REPLACED them breaks here).
    expect(names(j)).toContain('pool1');
    expect(names(j)).toContain('loom-udf-runtime');
    expect(j.discovery).toMatchObject({ incomplete: false, matched: 5 });
    expect(j.preview.wouldPause).toHaveLength(7);
  });

  // Breaks if: the query is not scoped to this estate id (it is what Resource Graph filters on).
  it('sends THIS estate id in the Resource Graph query', async () => {
    graph([VM('vm-gh')]);
    await preview();
    const tagCall = armPost.mock.calls.map((c) => c[1]).find((b: any) => !String(b.query).startsWith('resourcecontainers'));
    expect(String(tagCall.query)).toContain(`== '${ESTATE}'`);
  });

  // Breaks if: an untagged resource in the SAME resource group, or one tagged for another estate, is claimed (R-SCOPE-2).
  it('an untagged VM in the same RG and another estate\'s VM are NOT discovered, even if the graph returns them', async () => {
    graph([
      VM('vm-mine'),
      VM('vm-untagged-same-rg', {}),
      VM('vm-null-tags', null),
      VM('vm-other-estate', { 'loom-estate-id': 'loom:other:rg' }),
    ]);
    const j = await preview();
    expect(names(j)).toContain('vm-mine');
    for (const n of ['vm-untagged-same-rg', 'vm-null-tags', 'vm-other-estate']) expect(names(j)).not.toContain(n);
  });

  // Breaks if: a resource named by BOTH the manifest and the graph is listed twice (or the graph row displaces the manifest row).
  it('a duplicate id (manifest + graph, different case) is listed once and keeps the manifest provenance', async () => {
    graph([{ ...argRow('microsoft.synapse/workspaces/sqlpools', 'Microsoft.Synapse/workspaces/ws/sqlPools', 'pool1'), id: POOL.toUpperCase() }]);
    const j = await preview();
    expect(names(j).filter((n) => n === 'pool1')).toHaveLength(1);
    // The manifest row has no tags (-> 'deploy-manifest'); the graph row carries the tag (-> 'ownership-tag').
    expect(j.preview.wouldPause.find((r: any) => r.name === 'pool1').ownershipSource).toBe('deploy-manifest');
    expect(j.discovery.matched).toBe(1);
  });

  // Breaks if: a manifest-only resource is lost when the graph returns a different set.
  it('manifest-only resources survive when the graph finds nothing', async () => {
    graph([]);
    const j = await preview();
    expect(names(j).sort()).toEqual(['loom-udf-runtime', 'pool1']);
    expect(j.discovery).toMatchObject({ incomplete: false, matched: 0 });
  });
});

describe('the AKS cluster hosting the console', () => {
  // Breaks if: the console's own cluster is in the pause set (stopping it strands the resume surface).
  it('is held out with a reason while another tagged cluster is paused', async () => {
    process.env.LOOM_CONTAINER_PLATFORM = 'aks';
    process.env.LOOM_AKS_CLUSTER_NAME = 'aks-console';
    graph([AKS('aks-console'), AKS('aks-batch')]);
    const j = await preview();
    expect(names(j)).toContain('aks-batch');
    expect(names(j)).not.toContain('aks-console');
    expect(j.discovery.heldOut).toHaveLength(1);
    expect(j.discovery.heldOut[0].name).toBe('aks-console');
    expect(j.discovery.heldOut[0].reason).toContain('hosting this console');
  });

  // Breaks if: an unknown own-cluster name lets every cluster be paused.
  it('with the own cluster name unknown on AKS, no cluster is paused', async () => {
    process.env.LOOM_CONTAINER_PLATFORM = 'aks';
    graph([AKS('aks-a'), AKS('aks-b')]);
    const j = await preview();
    expect(names(j).filter((n) => n.startsWith('aks-'))).toEqual([]);
    expect(j.discovery.heldOut.map((h: any) => h.name).sort()).toEqual(['aks-a', 'aks-b']);
    expect(names(j)).toContain('pool1'); // positive pair: the manifest pool is unaffected
  });
});

describe('Resource Graph failure is "discovery incomplete", never "nothing to pause"', () => {
  // Breaks if: a 403 is swallowed into an empty complete answer, or it drops the sources that still work.
  it('403: the preview says incomplete, and the manifest + Container App rows are still planned', async () => {
    armPost.mockRejectedValue(new Error('ARM POST /providers/Microsoft.ResourceGraph/resources failed 403: AuthorizationFailed'));
    const j = await preview();
    expect(j.discovery.incomplete).toBe(true);
    expect(j.discovery.note).toMatch(/^discovery incomplete:/);
    expect(j.discovery.note).toContain('AuthorizationFailed');
    expect(names(j).sort()).toEqual(['loom-udf-runtime', 'pool1']);
    expect(j.readFailures).toEqual([]);
  });

  // Breaks if: with nothing else in scope, the 409 reuses the "correct fail-safe answer" text over an incomplete discovery.
  it('with an EMPTY plan, the refusal says discovery is incomplete instead of "that is the correct fail-safe answer"', async () => {
    resolveDeployManifest.mockReturnValue({
      manifest: { estateId: ESTATE, resourceIds: [] }, entries: [], unresolved: [], manifestGated: false, namedByDeploy: 0,
    });
    storedAutopause = { kind: 'estate-autopause', enabled: true, idleHours: 2, containerApps: { enabled: false, exempt: [] } };
    armPost.mockRejectedValue(new Error('ARM POST x failed 500: InternalServerError'));
    const dry = await preview();
    expect(dry.preview.wouldPause).toEqual([]);
    const res = await handlePausePost(caller, { confirm: ESTATE, confirmToken: dry.confirmToken });
    const body = (await res.json()) as any;
    expect(res.status).toBe(409);
    expect(body.error).toContain('discovery incomplete:');
    expect(body.error).toContain('NOT a statement that nothing needs pausing');
    expect(body.error).not.toContain('that is the correct fail-safe answer');
    // Positive control: the same empty plan over a HEALTHY graph keeps the original statement.
    graph([]);
    const dry2 = await preview();
    const res2 = await handlePausePost(caller, { confirm: ESTATE, confirmToken: dry2.confirmToken });
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as any).error).toContain('correct fail-safe answer');
  });

  // Breaks if: a throttled graph read does not count as a failed read (the pause would proceed on a partial set).
  it('429 is a blocking read failure in the preview', async () => {
    armPost.mockRejectedValue(new Error('ARM POST x failed 429: SubscriptionRequestsThrottled'));
    const j = await preview();
    expect(j.readFailures).toHaveLength(1);
    expect(j.readFailures[0]).toMatchObject({ kind: 'throttled' });
  });

  // Breaks if: an unreadable configured subscription is not surfaced (it looks identical to an empty one).
  it('a configured subscription the identity cannot read is named in the note', async () => {
    process.env.LOOM_DLZ_SUBSCRIPTION_ID = '363ef5d1-0e77-4594-a530-f51af23dbf8c';
    graph([VM('vm-gh')], { readable: [SUB] });
    const j = await preview();
    expect(j.discovery.incomplete).toBe(true);
    expect(j.discovery.note).toContain('363ef5d1-0e77-4594-a530-f51af23dbf8c');
    expect(names(j)).toContain('vm-gh');
  });
});
