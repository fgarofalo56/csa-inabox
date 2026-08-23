/**
 * LOOM BRAIN — the Resource Graph extractor, and the ownership rules.
 *
 * THIS IS THE SAFETY-CRITICAL EXTRACTOR. PRP §1 decision 1, measured: of the 13
 * Container App environments visible across these six subscriptions, ONE is
 * Loom's. The other 12 are the operator's blog, Sentinel, two Atlas estates,
 * simplechat, imgrotator, dabdemo, assurancenet, forzelite and artemis. An
 * `owns` edge is what scopes a cleanup recommendation, so a false positive here
 * is a recommendation pointed at someone else's production.
 *
 * The rules asserted below mirror `lib/estate/pause-inventory.ts`, deliberately,
 * so the Brain and the pause machinery cannot disagree about who owns what:
 *
 *   • Ownership requires the `loom-estate-id` tag. Nothing else confers it.
 *   • Resource-group NAME is never read. It is measurably wrong in BOTH
 *     directions on this estate.
 *   • `tags === null` is INDETERMINATE, never "not owned".
 *   • A DIFFERENT estate's tag does not confer ownership of THIS estate.
 *
 * And one that is easy to lose: every row still becomes a NODE. Reports cover
 * all subscriptions (PRP §1 decision 4); ownership only scopes what may be
 * recommended.
 */
import { describe, it, expect } from 'vitest';
import {
  azureResourceNodeId,
  buildGraph,
  extractFromResourceGraph,
  LOOM_ESTATE_TAG_KEY,
  type ResourceGraphRow,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';
const OTHER_SUB = '22222222-2222-2222-2222-222222222222';
const ESTATE = 'loom-example-estate';

function row(over: Partial<ResourceGraphRow> & { name: string; rg: string; sub?: string }): ResourceGraphRow {
  const sub = over.sub ?? SUB;
  return {
    id: `/subscriptions/${sub}/resourceGroups/${over.rg}/providers/Microsoft.App/containerApps/${over.name}`,
    type: 'Microsoft.App/containerApps',
    name: over.name,
    resourceGroup: over.rg,
    subscriptionId: sub,
    location: 'centralus',
    tags: over.tags === undefined ? {} : over.tags,
    tagsError: over.tagsError,
    properties: over.properties,
  };
}

describe('ownership is a POSITIVE test', () => {
  it('the estate tag confers ownership and emits an owns edge', () => {
    const r = extractFromResourceGraph(
      [row({ name: 'loom-console', rg: 'rg-loom', tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE } })],
      { estateId: ESTATE },
    );
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]!.provenance).toBe('owns');
    expect(r.edges[0]!.evidence.symbol).toBe(LOOM_ESTATE_TAG_KEY);
    expect(r.edges[0]!.evidence.rawValue).toBe(ESTATE);
  });

  it('an untagged resource is still a NODE but gets NO owns edge', () => {
    const r = extractFromResourceGraph([row({ name: 'someones-blog', rg: 'rg-blog', tags: {} })], {
      estateId: ESTATE,
    });
    // Estate-wide report…
    expect(r.nodes.filter((n) => n.kind === 'azure-resource')).toHaveLength(1);
    // …ownership-scoped recommendation.
    expect(r.edges).toHaveLength(0);
  });

  it('R-SCOPE-2 FALSE POSITIVE: an RG named for "Loomis" is NOT swept in', () => {
    const r = extractFromResourceGraph([row({ name: 'loomis-billing', rg: 'rg-loomis-prod', tags: {} })], {
      estateId: ESTATE,
    });
    expect(r.edges).toHaveLength(0);
  });

  it('R-SCOPE-2 FALSE NEGATIVE: a tagged resource in an RG with no "loom" in its name IS owned', () => {
    // `rg-dlz-aiml-stack-dev` holds a genuine Loom component on the real estate
    // and contains no "loom" anywhere. A name filter MISSES it.
    const r = extractFromResourceGraph(
      [row({ name: 'func-csa-inabox-copilot', rg: 'rg-dlz-aiml-stack-dev', tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE } })],
      { estateId: ESTATE },
    );
    expect(r.edges).toHaveLength(1);
  });

  it('a DIFFERENT estate id does not confer ownership, and the reason is recorded', () => {
    const r = extractFromResourceGraph(
      [row({ name: 'other-loom', rg: 'rg-loom-b', tags: { [LOOM_ESTATE_TAG_KEY]: 'a-different-estate' } })],
      { estateId: ESTATE },
    );
    expect(r.edges).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/DIFFERENT estate/);
  });

  it('the tag key is matched case-insensitively, as Azure treats it', () => {
    const r = extractFromResourceGraph(
      [row({ name: 'x', rg: 'rg', tags: { 'LOOM-Estate-Id': ESTATE } })],
      { estateId: ESTATE },
    );
    expect(r.edges).toHaveLength(1);
  });

  it('tags === null is INDETERMINATE — no owns edge, and a reason that says so', () => {
    const r = extractFromResourceGraph(
      [row({ name: 'unreadable', rg: 'rg', tags: null, tagsError: 'read denied by policy' })],
      { estateId: ESTATE },
    );
    expect(r.edges).toHaveLength(0);
    const skip = r.skipped.find((s) => s.subject.includes('unreadable'))!;
    expect(skip.reason).toMatch(/INDETERMINATE/);
    // R7 — the reason states what happened, not a conclusion the code never established.
    expect(skip.reason).toMatch(/read denied by policy/);
  });

  it('a MISSING tags field is indeterminate too, not "no tags"', () => {
    const r = extractFromResourceGraph([{ id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/x`, type: 'Microsoft.App/containerApps' }], {
      estateId: ESTATE,
    });
    expect(r.nodes[0]!.kind).toBe('azure-resource');
    if (r.nodes[0]!.kind !== 'azure-resource') throw new Error('unreachable');
    expect(r.nodes[0]!.tags).toBeNull();
    expect(r.nodes[0]!.tagsError).toMatch(/indeterminate, not "no tags"/i);
  });

  it('spans subscriptions: the report is estate-wide, ownership is not', () => {
    const r = extractFromResourceGraph(
      [
        row({ name: 'a', rg: 'rg-1', sub: SUB, tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE } }),
        row({ name: 'b', rg: 'rg-2', sub: OTHER_SUB, tags: {} }),
      ],
      { estateId: ESTATE },
    );
    expect(r.nodes.filter((n) => n.kind === 'azure-resource')).toHaveLength(2);
    expect(r.edges).toHaveLength(1);
  });
});

describe('facts read from Resource Graph properties', () => {
  it('reads scale and ingress off the Container Apps projection', () => {
    const r = extractFromResourceGraph([
      row({
        name: 'loom-capacity-broker',
        rg: 'rg-loom',
        tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE },
        properties: {
          provisioningState: 'Succeeded',
          configuration: { ingress: { external: false, fqdn: 'b.internal.example.io', targetPort: 8080 } },
          template: {
            containers: [{ name: 'b', resources: { cpu: 0.5, memory: '1Gi' } }],
            scale: { minReplicas: 2, maxReplicas: 5 },
          },
        },
      }),
    ]);
    const n = r.nodes[0]!;
    if (n.kind !== 'azure-resource') throw new Error('unreachable');
    expect(n.scale).toEqual({ minReplicas: 2, maxReplicas: 5, cpu: 0.5, memory: '1Gi', source: 'resource-graph' });
    expect(n.ingress).toEqual({ external: false, fqdn: 'b.internal.example.io', targetPort: 8080 });
    expect(n.provisioningState).toBe('Succeeded');
  });

  it('a row with NO scale block yields undefined scale — not minReplicas 0', () => {
    const r = extractFromResourceGraph([row({ name: 'x', rg: 'rg', properties: {} })]);
    const n = r.nodes[0]!;
    if (n.kind !== 'azure-resource') throw new Error('unreachable');
    // The distinction that stops an always-on query from exonerating everything
    // it failed to read.
    expect(n.scale).toBeUndefined();
  });

  it('derives subscription and resource group from the ARM id when the row omits them', () => {
    const r = extractFromResourceGraph([
      { id: `/subscriptions/${SUB}/resourceGroups/rg-derived/providers/Microsoft.App/containerApps/x`, type: 'Microsoft.App/containerApps' },
    ]);
    const n = r.nodes[0]!;
    if (n.kind !== 'azure-resource') throw new Error('unreachable');
    expect(n.subscriptionId).toBe(SUB);
    expect(n.resourceGroup).toBe('rg-derived');
    expect(n.displayName).toBe('x');
  });

  it('accepts the DiscoveredResource field names as well as the ARG-native ones', () => {
    const r = extractFromResourceGraph([
      {
        resourceId: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.App/containerApps/y`,
        resourceType: 'Microsoft.App/containerApps',
        name: 'y',
        resourceGroup: 'rg',
        subscriptionId: SUB,
        tags: {},
      },
    ]);
    expect(r.nodes).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });
});

describe('rows that cannot become nodes are REPORTED, not dropped', () => {
  it('a row with no ARM id is skipped with a reason', () => {
    const r = extractFromResourceGraph([{ type: 'Microsoft.App/containerApps', name: 'x' }]);
    expect(r.nodes).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/neither `id` nor `resourceId`/);
  });

  it('a row with no type is skipped with a reason', () => {
    const r = extractFromResourceGraph([{ id: `/subscriptions/${SUB}/resourceGroups/rg/providers/x/y/z` }]);
    expect(r.nodes).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/neither `type` nor `resourceType`/);
  });

  it('an EMPTY input is BLIND, not clean', () => {
    const r = extractFromResourceGraph([]);
    expect(r.population.blind).toBe(true);
  });
});

describe('the owns edge resolves against the built graph', () => {
  it('the estate manifest node owns the tagged resource', () => {
    const r = extractFromResourceGraph(
      [row({ name: 'loom-console', rg: 'rg-loom', tags: { [LOOM_ESTATE_TAG_KEY]: ESTATE } })],
      { estateId: ESTATE },
    );
    const g = buildGraph([r]);
    const consoleId = azureResourceNodeId(
      `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/loom-console`,
    );
    const owns = g.inboundEdges(consoleId, 'owns');
    expect(owns.result).toHaveLength(1);
    expect(g.node(owns.result[0]!.from)?.displayName).toBe(`Loom estate ${ESTATE}`);
    expect(g.report.edgesByResolution.dangling).toBe(0);
  });
});
