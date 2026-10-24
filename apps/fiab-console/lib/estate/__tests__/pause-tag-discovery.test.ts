/**
 * #5099 phase A - tag discovery. Pure module tests: the query, paging, the
 * fail-closed answers, the ownership re-check, the union, and the AKS guard.
 * Every `it` names the input that breaks it (assertion-design.md).
 */
import { describe, it, expect } from 'vitest';
import { kqlEscapeSingle } from '@/lib/azure/kql-escape';
import {
  MAX_PAGES,
  TAG_DISCOVERY_TYPES,
  buildEstateTagQuery,
  classifyTagRows,
  configuredSubscriptions,
  discoverByEstateTag,
  queryAllPages,
  unionDiscovered,
  type ArgPost,
  type ArgRow,
} from '../pause-tag-discovery';
import { aksPauseGuard, tierPauseGuard } from '../pause-guards';
import { ESTATE_PAUSE_TIER } from '../pause-tier';
import type { DiscoveredResource } from '../pause-inventory';

const EST = 'loom:e093f4fd:rg-csa-loom-admin-centralus';
const SUB = 'e093f4fd-5047-4ee4-968d-a56942c665f3';
const rid = (type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/rg-x/providers/${type}/${name}`;
const row = (type: string, name: string, tags: Record<string, string> | null = { 'loom-estate-id': EST }): ArgRow => ({
  id: rid(type.replace(/^microsoft\./, 'Microsoft.'), name),
  name,
  type,
  resourceGroup: 'rg-x',
  subscriptionId: SUB,
  tags,
});
const ENV_CA = { LOOM_CONTAINER_PLATFORM: 'containerApps', LOOM_SUBSCRIPTION_ID: SUB } as NodeJS.ProcessEnv;

describe('buildEstateTagQuery', () => {
  // Breaks if: a tier type is dropped from the query (the pre-change gap: AKS, VM, ADB, ASA, web never discovered).
  it('names every tier type except Container Apps, and filters on THIS estate id exactly', () => {
    const q = buildEstateTagQuery(EST);
    expect(TAG_DISCOVERY_TYPES).toHaveLength(ESTATE_PAUSE_TIER.length - 1);
    for (const t of TAG_DISCOVERY_TYPES) expect(q).toContain(`'${t}'`);
    // Positive pair for the absence below: Container Apps are the one type left to their own policy source.
    expect(q).not.toContain('microsoft.app/containerapps');
    expect(q).toContain(`tags['loom-estate-id']`);
    // `==` is case-sensitive, like resolveOwnership; `=~` here would claim a differently-cased estate id.
    expect(q).toContain(`== '${EST}'`);
    expect(q).not.toMatch(/tags\['loom-estate-id'\]\)? =~/);
  });

  // Breaks if: a quote in the estate id is not escaped (KQL injection widening the filter).
  it('escapes a single quote in the estate id', () => {
    const evil = `x' or 1==1 or '`;
    const q = buildEstateTagQuery(evil);
    expect(q).toContain(`== '${kqlEscapeSingle(evil)}'`);
    expect(kqlEscapeSingle(evil)).not.toBe(evil); // the fixture really needs escaping
    expect(q).not.toContain(`== '${evil}'`);
  });
});

describe('queryAllPages ($skipToken)', () => {
  // Breaks if: the token is not echoed (only page 1 is read) or rows of page 2 are dropped.
  it('follows $skipToken: page 2 is requested WITH the token and its rows are kept', async () => {
    const bodies: any[] = [];
    const post: ArgPost = async (body) => {
      bodies.push(body);
      const tok = (body as any).options.$skipToken;
      return tok ? { data: [row('microsoft.compute/virtualmachines', 'vm2')] } : { data: [row('microsoft.compute/virtualmachines', 'vm1')], $skipToken: 'tok-1' };
    };
    const { rows, pages } = await queryAllPages('q', post);
    expect(rows.map((r) => r.name)).toEqual(['vm1', 'vm2']);
    expect(pages).toBe(2);
    expect(bodies[0].options.$skipToken).toBeUndefined();
    expect(bodies[1].options.$skipToken).toBe('tok-1');
  });

  // Breaks if: the page budget is dropped (infinite loop) or a partial list is returned as if complete.
  it(`refuses a partial list when ${MAX_PAGES} pages still leave a token`, async () => {
    let calls = 0;
    const post: ArgPost = async () => { calls += 1; return { data: [], $skipToken: `t${calls}` }; };
    await expect(queryAllPages('q', post)).rejects.toThrow(/refusing a partial list/);
    expect(calls).toBe(MAX_PAGES);
  });

  // Breaks if: a 2xx carrying `error` (or no `data` array) is read as zero rows, complete.
  // Without the check, { error: {...} } and {} both come back as rows=[] - the inputs below.
  it('a 2xx error body or a missing data array throws instead of reading as zero rows', async () => {
    const errBody = { error: { code: 'BadRequest', message: 'Query is invalid' } } as any;
    await expect(queryAllPages('q', async () => errBody)).rejects.toThrow(/error body on page 1: .*BadRequest/);
    await expect(queryAllPages('q', async () => ({}))).rejects.toThrow(/no data array/);
    // A page-2 error after a good page 1 also throws: no partial list from a mid-stream failure.
    const post: ArgPost = async (body) =>
      (body as any).options.$skipToken ? errBody : { data: [row('microsoft.compute/virtualmachines', 'vm1')], $skipToken: 't' };
    await expect(queryAllPages('q', post)).rejects.toThrow(/page 2/);
    // Positive control: an empty-but-valid page is a genuine zero.
    await expect(queryAllPages('q', async () => ({ data: [] }))).resolves.toEqual({ rows: [], pages: 1 });
  });

  // Breaks if: discoverByEstateTag stops routing a 2xx error body into the fail-closed path.
  it('a 2xx error body surfaces as "discovery incomplete" end to end', async () => {
    const r = await discoverByEstateTag({
      estateId: EST,
      env: ENV_CA,
      post: async () => ({ error: { code: 'BadRequest' } }) as any,
    });
    expect(r.status.incomplete).toBe(true);
    expect(r.status.note).toMatch(/^discovery incomplete: .*BadRequest/);
    expect(r.discovered).toEqual([]);
  });
});

describe('discoverByEstateTag - fail closed', () => {
  const ok = (rows: ArgRow[]): ArgPost => async (body) => {
    const q = String((body as any).query);
    return q.startsWith('resourcecontainers') ? { data: [{ subscriptionId: SUB }] } : { data: rows };
  };

  // Breaks if: a Resource Graph 403 is swallowed into an empty, "complete" result (the R7 defect).
  it('a 403 yields "discovery incomplete", never an empty complete answer', async () => {
    const post: ArgPost = async () => { throw new Error('ARM POST /providers/Microsoft.ResourceGraph/resources failed 403: AuthorizationFailed'); };
    const r = await discoverByEstateTag({ estateId: EST, env: ENV_CA, post });
    expect(r.discovered).toEqual([]);
    expect(r.status.incomplete).toBe(true);
    expect(r.status.note).toMatch(/^discovery incomplete:/);
    expect(r.status.note).toContain('AuthorizationFailed'); // the raw reason, not an invented cause
    expect(r.status.note).toContain('NOT a statement that there is nothing to pause');
    expect(r.readFailures).toEqual([]); // non-throttle: disclosed, does not block the manifest pause
    // Positive control: the same call over a healthy graph is complete (so `incomplete` can be false).
    const good = await discoverByEstateTag({ estateId: EST, env: ENV_CA, post: ok([row('microsoft.compute/virtualmachines', 'vm1')]) });
    expect(good.status.incomplete).toBe(false);
    expect(good.discovered.map((d) => d.name)).toEqual(['vm1']);
  });

  // Breaks if: a 500 is treated like "no rows".
  it('a 500 is incomplete as well', async () => {
    const post: ArgPost = async () => { throw new Error('ARM POST x failed 500: InternalServerError'); };
    const r = await discoverByEstateTag({ estateId: EST, env: ENV_CA, post });
    expect(r.status.incomplete).toBe(true);
    expect(r.status.matched).toBe(0);
  });

  // Breaks if: a throttle is not turned into a blocking read failure (the pause would proceed on a partial set).
  it('a 429 also blocks (a retryable read failure), and says throttled', async () => {
    const post: ArgPost = async () => { throw new Error('ARM POST x failed 429: SubscriptionRequestsThrottled'); };
    const r = await discoverByEstateTag({ estateId: EST, env: ENV_CA, post });
    expect(r.status.incomplete).toBe(true);
    expect(r.readFailures).toHaveLength(1);
    expect(r.readFailures[0]).toMatchObject({ kind: 'throttled', throttled: true });
    expect(r.status.note).toContain('throttled');
  });

  // Breaks if: the subscription-readability probe is dropped (an unreadable DLZ sub looks exactly like an empty one).
  it('a configured subscription the identity cannot read makes the answer incomplete and names it', async () => {
    const DLZ = '363ef5d1-0e77-4594-a530-f51af23dbf8c';
    const env = { ...ENV_CA, LOOM_DLZ_SUBSCRIPTION_ID: DLZ } as NodeJS.ProcessEnv;
    const r = await discoverByEstateTag({ estateId: EST, env, post: ok([row('microsoft.compute/virtualmachines', 'vm1')]) });
    expect(r.status.incomplete).toBe(true);
    expect(r.status.unreadableSubscriptions).toEqual([DLZ]);
    expect(r.status.note).toContain(DLZ);
    expect(r.discovered.map((d) => d.name)).toEqual(['vm1']); // what WAS found is still returned
  });

  // Breaks if: the probe's own failure is ignored (silently complete).
  it('a failing readability probe is incomplete, not complete', async () => {
    const post: ArgPost = async (body) => {
      if (String((body as any).query).startsWith('resourcecontainers')) throw new Error('boom-probe');
      return { data: [] };
    };
    const r = await discoverByEstateTag({ estateId: EST, env: ENV_CA, post });
    expect(r.status.incomplete).toBe(true);
    expect(r.status.note).toContain('boom-probe');
  });

  // Breaks if: an unbound console (no estate id) runs the query with a synthetic id.
  it('an unbound estate id never queries and is disclosed as incomplete', async () => {
    let calls = 0;
    const post: ArgPost = async () => { calls += 1; return { data: [] }; };
    const r = await discoverByEstateTag({ estateId: 'loom:unbound', env: ENV_CA, post });
    expect(calls).toBe(0);
    expect(r.status.incomplete).toBe(true);
  });
});

describe('classifyTagRows - ownership is re-checked on the row', () => {
  // Breaks if: the row's tag is not re-compared (a widened query or a wrong estate leaks in).
  it('drops a row tagged for ANOTHER estate or untagged, keeps the matching one', () => {
    const { discovered } = classifyTagRows({
      rows: [
        row('microsoft.compute/virtualmachines', 'mine'),
        row('microsoft.compute/virtualmachines', 'other-estate', { 'loom-estate-id': 'loom:zzzzzzzz:rg-other' }),
        row('microsoft.compute/virtualmachines', 'untagged-same-rg', {}),
        row('microsoft.compute/virtualmachines', 'null-tags', null),
        row('microsoft.compute/virtualmachines', 'wrong-case', { 'loom-estate-id': EST.toUpperCase() }),
      ],
      estateId: EST,
      env: ENV_CA,
    });
    expect(discovered.map((d) => d.name)).toEqual(['mine']);
    expect(discovered[0]).toMatchObject({ discoverySource: 'resource-graph', resourceType: 'microsoft.compute/virtualmachines' });
  });

  // Breaks if: a type outside the tier (or Container Apps) is accepted from a stray row.
  it('ignores a non-tier type and a Container App row even when tagged for this estate', () => {
    const { discovered } = classifyTagRows({
      rows: [row('microsoft.compute/virtualmachines', 'vm'), row('microsoft.storage/storageaccounts', 'st'), row('microsoft.app/containerapps', 'ca')],
      estateId: EST,
      env: ENV_CA,
    });
    expect(discovered.map((d) => d.name)).toEqual(['vm']);
  });

  // Breaks if: the same id (differently cased) is returned twice into the plan.
  it('collapses duplicate ids (case-insensitive)', () => {
    const a = row('microsoft.compute/virtualmachines', 'vm1');
    const b = { ...a, id: String(a.id).toUpperCase() };
    expect(classifyTagRows({ rows: [a, b], estateId: EST, env: ENV_CA }).discovered).toHaveLength(1);
  });

  // Breaks if: the exempt marker is ignored for a discovered resource.
  it('holds out loom-estate-pause=exempt with a reason and keeps its sibling', () => {
    const { discovered, heldOut } = classifyTagRows({
      rows: [
        row('microsoft.compute/virtualmachines', 'keep'),
        row('microsoft.compute/virtualmachines', 'pinned', { 'loom-estate-id': EST, 'loom-estate-pause': 'exempt' }),
      ],
      estateId: EST,
      env: ENV_CA,
    });
    expect(discovered.map((d) => d.name)).toEqual(['keep']);
    expect(heldOut).toHaveLength(1);
    expect(heldOut[0]).toMatchObject({ name: 'pinned' });
    expect(heldOut[0]!.reason).toContain('exempt');
  });

  // Breaks if: the AKS guard is not applied to discovered clusters (the console's own cluster would be paused).
  it('holds out the console-hosting AKS cluster and keeps another cluster', () => {
    const env = { LOOM_CONTAINER_PLATFORM: 'aks', LOOM_AKS_CLUSTER_NAME: 'aks-console' } as NodeJS.ProcessEnv;
    const { discovered, heldOut } = classifyTagRows({
      rows: [
        row('microsoft.containerservice/managedclusters', 'aks-console'),
        row('microsoft.containerservice/managedclusters', 'aks-batch'),
      ],
      estateId: EST,
      env,
    });
    expect(discovered.map((d) => d.name)).toEqual(['aks-batch']);
    expect(heldOut.map((h) => h.name)).toEqual(['aks-console']);
    expect(heldOut[0]!.reason).toContain('hosting this console');
  });
});

describe('unionDiscovered', () => {
  const mk = (id: string, source: DiscoveredResource['discoverySource']): DiscoveredResource => ({
    resourceId: id, resourceType: 'microsoft.kusto/clusters', name: id.split('/').pop()!, resourceGroup: 'rg', subscriptionId: SUB, tags: {}, discoverySource: source,
  });
  // Breaks if: tagged rows displace manifest rows, duplicate them, or manifest-only rows vanish.
  it('keeps manifest-only rows, adds tag-only rows, and lets the EXISTING row win a shared id', () => {
    const existing = [mk('/subscriptions/s/a/Adx', 'deploy-manifest'), mk('/subscriptions/s/a/ManifestOnly', 'deploy-manifest')];
    const tagged = [mk('/SUBSCRIPTIONS/S/A/ADX', 'resource-graph'), mk('/subscriptions/s/a/TagOnly', 'resource-graph')];
    const out = unionDiscovered(existing, tagged);
    expect(out.map((d) => d.name)).toEqual(['Adx', 'ManifestOnly', 'TagOnly']);
    expect(out.find((d) => d.name === 'Adx')!.discoverySource).toBe('deploy-manifest');
    expect(out.find((d) => d.name === 'TagOnly')!.discoverySource).toBe('resource-graph');
  });
});

describe('configuredSubscriptions', () => {
  // Breaks if: a configured DLZ sub is not collected (its unreadability would go unnoticed) or duplicates are kept.
  it('collects distinct lower-cased ids from the known env vars', () => {
    const subs = configuredSubscriptions({ LOOM_SUBSCRIPTION_ID: 'AAA', LOOM_DLZ_SUB: 'aaa', LOOM_SYNAPSE_SUB: 'bbb' } as NodeJS.ProcessEnv);
    expect(subs.sort()).toEqual(['aaa', 'bbb']);
  });
});

describe('aksPauseGuard', () => {
  const tags = { 'loom-estate-id': EST };
  // Breaks if: the console's own cluster is eligible on containerPlatform=aks.
  it('the console-hosting cluster is held out; a different cluster is eligible', () => {
    const env = { LOOM_CONTAINER_PLATFORM: 'aks', LOOM_AKS_CLUSTER_NAME: 'AKS-Console' } as NodeJS.ProcessEnv;
    const own = aksPauseGuard({ name: 'aks-console', tags }, env);
    expect(own.eligible).toBe(false);
    expect(own.reason).toContain('hosting this console');
    expect(aksPauseGuard({ name: 'aks-batch', tags }, env).eligible).toBe(true);
  });
  // Breaks if: an unknown own-cluster name on AKS lets any cluster through (cannot tell which is ours).
  it('on AKS with the own cluster name unknown, every cluster is held out', () => {
    const env = { LOOM_CONTAINER_PLATFORM: 'aks' } as NodeJS.ProcessEnv;
    const g = aksPauseGuard({ name: 'aks-batch', tags }, env);
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('LOOM_AKS_CLUSTER_NAME unset');
  });
  // Breaks if: the in-cluster signal is only LOOM_CONTAINER_PLATFORM (a pod with the var unset would pause itself).
  it('a pod-injected KUBERNETES_SERVICE_HOST also counts as running on AKS', () => {
    const g = aksPauseGuard({ name: 'aks-batch', tags }, { KUBERNETES_SERVICE_HOST: '10.0.0.1' } as NodeJS.ProcessEnv);
    expect(g.eligible).toBe(false);
  });
  // Breaks if: Commercial (Container Apps) estates cannot pause an ordinary AKS cluster at all.
  it('on Container Apps (not in a cluster) an ordinary cluster is eligible; unreadable tags and exempt tags are not', () => {
    expect(aksPauseGuard({ name: 'aks-batch', tags }, ENV_CA).eligible).toBe(true);
    expect(aksPauseGuard({ name: 'aks-batch', tags: null }, ENV_CA).eligible).toBe(false);
    expect(aksPauseGuard({ name: 'aks-batch', tags: { ...tags, 'loom-estate-pause': 'exempt' } }, ENV_CA).eligible).toBe(false);
    expect(aksPauseGuard({ name: 'aks-batch', tags: { ...tags, 'loom-role': 'console' } }, ENV_CA).eligible).toBe(false);
  });
  // Breaks if: tierPauseGuard stops routing AKS to its guard (planner/actuator would skip the hold-out).
  it('tierPauseGuard routes AKS to aksPauseGuard and leaves other types eligible', () => {
    const env = { LOOM_CONTAINER_PLATFORM: 'aks', LOOM_AKS_CLUSTER_NAME: 'aks-console' } as NodeJS.ProcessEnv;
    expect(tierPauseGuard({ resourceType: 'Microsoft.ContainerService/managedClusters', name: 'aks-console', tags }, 'loom-console', env).eligible).toBe(false);
    expect(tierPauseGuard({ resourceType: 'microsoft.compute/virtualmachines', name: 'aks-console', tags }, 'loom-console', env).eligible).toBe(true);
  });
});
