/**
 * LOOM BRAIN — the graph model and its reachability queries.
 *
 * The load-bearing assertions:
 *
 *   • A DANGLING edge does not make its target reachable (P2). Collapse that and
 *     `loom-capacity-broker` looks wired.
 *   • A dangling edge is still REACHABLE AS EVIDENCE via
 *     `danglingEdgesIntendedFor`. Collapse that and the finding has no receipt.
 *   • `declared` and `configured` never bleed into each other (P1).
 *   • Every query reports its POPULATION, and an empty subject set is BLIND
 *     rather than green (P3).
 *   • The VACUOUS case — a graph with zero edges of the queried provenance —
 *     is visible in `population.byProvenance`, because `blind` does not fire
 *     there and the result is loud rather than silent.
 */
import { describe, it, expect } from 'vitest';
import {
  alwaysOnNodes,
  azureResourceNodeId,
  buildGraph,
  danglingEdges,
  hasInboundOnly,
  nodesWithNoInboundEdge,
  scaleUnknownCount,
  type AzureResourceNode,
  type EdgeProvenance,
  type ExtractionResult,
  type NodeId,
  type PendingEdge,
  type ScaleFacts,
} from '../../graph';

const SUB = '11111111-1111-1111-1111-111111111111';

function arm(name: string): string {
  return `/subscriptions/${SUB}/resourceGroups/rg-loom/providers/Microsoft.App/containerApps/${name}`;
}

function appNode(name: string, scale?: ScaleFacts, fqdn?: string): AzureResourceNode {
  return {
    id: azureResourceNodeId(arm(name)),
    kind: 'azure-resource',
    displayName: name,
    source: 'resource-graph',
    resourceId: arm(name),
    resourceType: 'Microsoft.App/containerApps',
    subscriptionId: SUB,
    resourceGroup: 'rg-loom',
    tags: {},
    scale,
    ingress: fqdn ? { external: false, fqdn } : undefined,
  };
}

function extraction(nodes: AzureResourceNode[], edges: PendingEdge[]): ExtractionResult {
  return {
    source: 'resource-graph',
    nodes,
    edges,
    population: {
      subject: 'nodes',
      examined: nodes.length,
      edgesExamined: edges.length,
      scope: 'test fixture',
      blind: nodes.length === 0,
      byProvenance: { declared: 0, configured: 0, imports: 0, observed: 0, owns: 0 },
    },
    skipped: [],
  };
}

function wire(from: NodeId, targetRef: string, provenance: EdgeProvenance, symbol: string): PendingEdge {
  return {
    provenance,
    from,
    targetRef,
    emptyValue: false,
    evidence: { artifact: 'fixture', symbol, extractor: 'container-app-env' },
  };
}

function emptyWire(from: NodeId, intendedTo: NodeId, provenance: EdgeProvenance, symbol: string): PendingEdge {
  return {
    provenance,
    from,
    targetRef: '',
    emptyValue: true,
    intendedTo,
    evidence: { artifact: 'fixture', symbol, rawValue: '', extractor: 'bicep' },
  };
}

describe('buildGraph — the resolved / dangling split (P2)', () => {
  const caller = appNode('caller', { minReplicas: 1, source: 'resource-graph' });
  const wired = appNode('wired', { minReplicas: 1, source: 'resource-graph' }, 'wired.internal.example.io');
  const abandoned = appNode('abandoned', { minReplicas: 2, source: 'resource-graph' }, 'abandoned.internal.example.io');

  const graph = buildGraph([
    extraction(
      [caller, wired, abandoned],
      [
        wire(caller.id, 'https://wired.internal.example.io', 'configured', 'GOOD_URL'),
        emptyWire(caller.id, abandoned.id, 'configured', 'ABANDONED_URL'),
      ],
    ),
  ]);

  it('a RESOLVED edge makes its target reachable', () => {
    expect(graph.inboundEdges(wired.id, 'configured').result).toHaveLength(1);
  });

  it('a DANGLING edge does NOT make its target reachable', () => {
    // The whole point. The wire exists, it names `abandoned` via intendedTo, and
    // it still must not count.
    expect(graph.inboundEdges(abandoned.id, 'configured').result).toHaveLength(0);
  });

  it('a DANGLING edge IS reachable as evidence', () => {
    const ev = graph.danglingEdgesIntendedFor(abandoned.id);
    expect(ev.result).toHaveLength(1);
    expect(ev.result[0]!.danglingReason).toBe('empty-value');
    expect(ev.result[0]!.evidence.symbol).toBe('ABANDONED_URL');
    expect(ev.result[0]!.to).toBeNull();
  });

  it('the build report counts resolved and dangling separately', () => {
    expect(graph.report.edgesByResolution).toEqual({ resolved: 1, dangling: 1 });
  });

  it('an ARM-shaped ref to a resource NOT in the graph is `missing-resource`, not `unresolved-target`', () => {
    // Different remediations: one means "deploy/restore the resource", the other
    // means "this string does not name anything". Collapsing them loses that.
    const g = buildGraph([
      extraction([caller], [wire(caller.id, arm('never-deployed'), 'configured', 'GONE')]),
    ]);
    const d = danglingEdges(g);
    expect(d.result).toHaveLength(1);
    expect(d.result[0]!.danglingReason).toBe('missing-resource');
  });

  it('a bare name matching TWO resources resolves to NOTHING rather than guessing', () => {
    const a = appNode('twin');
    const b: AzureResourceNode = { ...appNode('twin'), id: azureResourceNodeId(arm('twin-2')), resourceId: arm('twin-2') };
    const g = buildGraph([extraction([caller, a, b], [wire(caller.id, 'twin', 'configured', 'AMBIG')])]);
    const d = danglingEdges(g);
    expect(d.result).toHaveLength(1);
    expect(d.result[0]!.danglingReason).toBe('unresolved-target');
  });
});

describe('provenance never bleeds (P1)', () => {
  const caller = appNode('caller');
  const target = appNode('target', undefined, 'target.internal.example.io');
  const graph = buildGraph([
    extraction(
      [caller, target],
      [wire(caller.id, 'https://target.internal.example.io', 'declared', 'DECLARED_ONLY')],
    ),
  ]);

  it('a `declared` edge does not answer a `configured` query', () => {
    expect(graph.inboundEdges(target.id, 'declared').result).toHaveLength(1);
    expect(graph.inboundEdges(target.id, 'configured').result).toHaveLength(0);
  });

  it('hasInboundOnly names the "wired in the template, dead in the deployment" class', () => {
    const q = hasInboundOnly(graph, 'declared', 'configured', {
      resourceType: 'Microsoft.App/containerApps',
      describe: 'container apps',
    });
    expect(q.result.map((n) => n.id)).toEqual([target.id]);
    expect(q.population.blind).toBe(false);
  });

  it('the unfiltered inbound query still reports the per-provenance split', () => {
    const all = graph.inboundEdges(target.id);
    expect(all.result).toHaveLength(1);
    // Even the "give me everything" call cannot be read as an undifferentiated
    // total — the breakdown is right there in the population.
    expect(all.population.byProvenance.declared).toBe(1);
    expect(all.population.byProvenance.configured).toBe(0);
  });

  it('inboundEdgesByProvenance gives the split as DATA, with every key present', () => {
    const split = graph.inboundEdgesByProvenance(target.id);
    expect(split.result.declared).toHaveLength(1);
    expect(split.result.configured).toHaveLength(0);
    // Every provenance is a key even at zero, so a caller indexing into it
    // cannot get `undefined` and treat it as "none" by accident.
    for (const p of ['declared', 'configured', 'imports', 'observed', 'owns'] as const) {
      expect(Array.isArray(split.result[p])).toBe(true);
    }
    expect(split.population.byProvenance.declared).toBe(1);
  });
});

describe('population reporting (P3)', () => {
  it('a query over ZERO nodes is BLIND, not green', () => {
    const empty = buildGraph([extraction([], [])]);
    const q = nodesWithNoInboundEdge(empty, 'configured', {
      resourceType: 'Microsoft.App/containerApps',
      describe: 'container apps',
    });
    expect(q.result).toHaveLength(0);
    // This is the failure mode: zero findings looks identical to a clean estate.
    expect(q.population.blind).toBe(true);
    expect(q.population.examined).toBe(0);
  });

  it('a filter that matches nothing is BLIND even when the graph is full', () => {
    const g = buildGraph([extraction([appNode('a'), appNode('b')], [])]);
    const q = nodesWithNoInboundEdge(g, 'configured', {
      resourceType: 'Microsoft.Sql/servers',
      describe: 'SQL servers',
    });
    expect(q.population.blind).toBe(true);
    expect(q.population.examined).toBe(0);
    // …while the same graph with no filter is NOT blind.
    expect(nodesWithNoInboundEdge(g, 'configured').population.blind).toBe(false);
  });

  it('THE VACUOUS CASE: zero edges of the queried provenance returns EVERYTHING', () => {
    const g = buildGraph([extraction([appNode('a'), appNode('b')], [])]);
    const q = nodesWithNoInboundEdge(g, 'configured');
    // Loud, not silent — but still not a finding.
    expect(q.result).toHaveLength(2);
    // `blind` does NOT fire here, because the node set was not empty. The signal
    // that this result is vacuous is the provenance count.
    expect(q.population.blind).toBe(false);
    expect(q.population.byProvenance.configured).toBe(0);
  });

  it('an edge-subject query is blind on zero EDGES, not zero nodes', () => {
    const g = buildGraph([extraction([appNode('a')], [])]);
    const q = g.inboundEdges(appNode('a').id, 'configured');
    expect(q.population.subject).toBe('edges');
    expect(q.population.blind).toBe(true);
    expect(q.population.examined).toBe(1); // a node exists…
    expect(q.population.edgesExamined).toBe(0); // …but there was nothing to examine
  });
});

describe('alwaysOnNodes — absent scale is NOT MEASURED, never zero', () => {
  const measured = appNode('always-on', { minReplicas: 2, source: 'resource-graph' });
  const scaleToZero = appNode('scale-to-zero', { minReplicas: 0, source: 'resource-graph' });
  const unmeasured = appNode('unknown-scale'); // no scale facts at all
  const graph = buildGraph([extraction([measured, scaleToZero, unmeasured], [])]);

  it('returns only nodes MEASURED at minReplicas > 0', () => {
    expect(alwaysOnNodes(graph).result.map((n) => n.id)).toEqual([measured.id]);
  });

  it('does NOT silently exonerate a node whose scale could not be read', () => {
    const ids = alwaysOnNodes(graph).result.map((n) => n.id);
    expect(ids).not.toContain(unmeasured.id);
    // …and the fact that it was excluded for lack of data is REPORTED, so the
    // caller can tell "measured at 0" from "never measured".
    expect(scaleUnknownCount(graph)).toBe(1);
    expect(alwaysOnNodes(graph).population.scope).toMatch(/1 had NO scale facts/);
  });
});

describe('buildGraph — node de-duplication', () => {
  it('merges two views of the same resource without either erasing the other', () => {
    const fromArg: AzureResourceNode = {
      ...appNode('svc'),
      tags: { 'loom-estate-id': 'e1' },
      ingress: { external: false, fqdn: 'svc.internal.example.io' },
      scale: undefined,
    };
    const fromBicep: AzureResourceNode = {
      ...appNode('svc'),
      tags: null,
      tagsError: 'not read by this extractor',
      ingress: undefined,
      scale: { minReplicas: 2, source: 'bicep' },
    };
    const g = buildGraph([extraction([fromArg], []), extraction([fromBicep], [])]);
    expect(g.nodes).toHaveLength(1);
    const n = g.node(fromArg.id) as AzureResourceNode;
    expect(n.ingress?.fqdn).toBe('svc.internal.example.io');
    expect(n.scale?.minReplicas).toBe(2);
    // A "could not read" NEVER overwrites tags another extractor read.
    expect(n.tags).toEqual({ 'loom-estate-id': 'e1' });
  });

  it('real tags DO replace a null, because that strictly increases what is known', () => {
    const unread: AzureResourceNode = { ...appNode('svc'), tags: null, tagsError: 'not read' };
    const read: AzureResourceNode = { ...appNode('svc'), tags: { 'loom-estate-id': 'e1' } };
    const g = buildGraph([extraction([unread], []), extraction([read], [])]);
    expect((g.node(unread.id) as AzureResourceNode).tags).toEqual({ 'loom-estate-id': 'e1' });
  });

  it('records an edge whose SOURCE node was never defined, rather than dropping it', () => {
    const ghost = azureResourceNodeId(arm('ghost'));
    const g = buildGraph([extraction([appNode('a')], [wire(ghost, 'x', 'configured', 'S')])]);
    expect(g.report.danglingNodeRefs).toContain(ghost);
  });

  it('two identical wires from the same file/line do not collapse into one edge', () => {
    const caller = appNode('caller');
    const w = emptyWire(caller.id, caller.id, 'declared', 'DUP');
    const g = buildGraph([extraction([caller], [w, w])]);
    expect(g.edges).toHaveLength(2);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(2);
  });
});
