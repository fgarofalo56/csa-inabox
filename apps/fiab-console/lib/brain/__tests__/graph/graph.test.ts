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
  codeModuleNodeId,
  danglingEdges,
  extractFromBicep,
  extractFromContainerAppEnv,
  hasInboundOnly,
  nodesWithNoInboundEdge,
  scaleUnknownCount,
  type AzureResourceNode,
  type BrainNode,
  type CodeModuleNode,
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

/** A non-azure-resource node, for asserting that a query reports its SUBJECT. */
function codeNode(path: string): CodeModuleNode {
  return {
    id: codeModuleNodeId(path),
    kind: 'code-module',
    displayName: path,
    source: 'source-imports',
    path,
  };
}

function extraction(nodes: BrainNode[], edges: PendingEdge[]): ExtractionResult {
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

  it('is BLIND over a graph with ZERO azure-resource nodes, however many other nodes exist', () => {
    // THE REGRESSION THIS PINS. The population must be computed against the
    // SUBJECT — the azure-resource nodes — not against the pre-filter candidate
    // list. Reporting the candidates made this answer "no always-on resources,
    // and I am not blind" over a graph that contains no Azure resources at all.
    //
    // That is not an exotic input. Whenever the Resource Graph pull returns
    // nothing (auth expiry, wrong subscription, throttling) the graph still
    // carries its bicep and source nodes, and this is the query that names the
    // billing. A false clean here is the exact green-and-blind failure P3 exists
    // to make impossible.
    const nonAzure = buildGraph([
      extraction(
        [codeNode('apps/fiab-console/lib/brain/a.ts'), codeNode('apps/fiab-console/lib/brain/b.ts')],
        [],
      ),
    ]);
    expect(nonAzure.nodes).toHaveLength(2); // the graph is NOT empty…
    const q = alwaysOnNodes(nonAzure);
    expect(q.result).toHaveLength(0);
    expect(q.population.examined).toBe(0); // …but the SUBJECT set is
    expect(q.population.blind).toBe(true);
    // The prose and the machine-readable field must agree. They did not.
    expect(q.population.scope).toMatch(/^0 azure-resource node\(s\)/);
  });

  it('a filter that selects only NON-azure nodes is BLIND, not clean', () => {
    // The same defect reached through the FILTER rather than through the node
    // kinds, and deliberately built so the two sets can DIFFER: the filter
    // matches two nodes, so `candidates` is non-empty while `azure` is empty.
    //
    // A first version of this test filtered on a resourceType present nowhere in
    // the graph. That cannot discriminate — it drives BOTH sets to zero, so it
    // passed just as happily with the defect restored. Measured: the mutation
    // `nodes: filter ? candidates : azure` SURVIVED it at 110/110.
    const mixed = buildGraph([
      extraction(
        [
          appNode('always-on', { minReplicas: 2, source: 'resource-graph' }),
          codeNode('apps/fiab-console/lib/brain/a.ts'),
          codeNode('apps/fiab-console/lib/brain/b.ts'),
        ],
        [],
      ),
    ]);
    // Embedded control: the filter really does match something, so `examined: 0`
    // below is "no azure resources in scope", never "the filter matched nothing".
    expect(mixed.nodes.filter((n) => n.kind === 'code-module')).toHaveLength(2);

    const q = alwaysOnNodes(mixed, { kind: 'code-module', describe: 'code modules' });
    expect(q.result).toHaveLength(0);
    expect(q.population.examined).toBe(0);
    expect(q.population.blind).toBe(true);

    // …and the same graph unfiltered IS measured, so blindness is a property of
    // the scope rather than of the graph.
    expect(alwaysOnNodes(mixed).population.examined).toBe(1);
    expect(alwaysOnNodes(mixed).population.blind).toBe(false);
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

// ---------------------------------------------------------------------------
// #3963 — PRODUCTION CARDINALITY.
//
// Every other fixture in this file is 1-3 nodes. That is the right size for the
// contract assertions above and it is exactly the wrong size to catch a mutation
// whose CONDITION is the size itself. Four such mutations survived a fully green
// 104-test suite during the independent review of #3945:
//
//   N1   container-app-env: an empty wire emits an edge ONLY when the name
//        starts with `LOOM_BROKER`                                     SURVIVED
//   N2   graph.ts: dangling edges count as inbound reachability ONLY
//        when `edges > 500`                                            SURVIVED
//   N1'  graph.ts: alwaysOnNodes reports `candidates` instead of its
//        subject ONLY above 500 nodes                                  SURVIVED
//   N2'  bicep.ts: population reports `edges: []` ONLY above 100 edges  SURVIVED
//
// Each is live at the REAL values — the measured estate graph is ~2.4k nodes /
// ~9.4k edges and the 180-file bicep tree emits 829 declared edges — and each is
// inert in a 3-node fixture. N1 in particular is not merely adversarial: it is
// the shape a well-meaning "reduce empty-flag noise" edit takes, sitting right
// next to the `looksLikeATarget` filter that already exists, and on the measured
// estate it would collapse 157 configured empty-value edges to 1.
//
// So this block builds the graph AT that cardinality. The fixture is generated,
// not stored, so it is cheap — and it converts "inert in fixtures" from an
// escape hatch into a failure.
// ---------------------------------------------------------------------------

/** ~2.4k nodes / ~9.6k edges — the measured shape of the real estate graph. */
const BIG_APPS = 1_200;
const BIG_CODE = 1_200;
const WIRES_PER_APP = 8;

describe('#3963 — the detectors hold at PRODUCTION cardinality, not only in fixtures', () => {
  /**
   * The planted subject: an always-on app that nothing RESOLVES to, reached only
   * by empty wires. `loom-capacity-broker` in miniature, buried in 2.4k nodes so
   * a size-conditioned bypass has somewhere to hide.
   */
  const broker = appNode('planted-broker', { minReplicas: 2, source: 'resource-graph' }, 'broker.internal.example.io');

  /**
   * The empty-wire CLASS, not one pinned symbol. Deliberately spread across
   * three prefixes with only ONE `LOOM_BROKER_*`, so a detector that keeps the
   * pinned symbol and drops the rest (N1) shows up as a COUNT rather than as a
   * single missing edge nobody asserted on.
   */
  const EMPTY_WIRE_NAMES = Array.from({ length: 150 }, (_, i) =>
    i === 0 ? 'LOOM_BROKER_URL' : i % 2 === 0 ? `LOOM_SERVICE_${i}_URL` : `CSA_TARGET_${i}_ENDPOINT`,
  );

  const apps: AzureResourceNode[] = Array.from({ length: BIG_APPS }, (_, i) =>
    appNode(`app-${i}`, { minReplicas: i % 3 === 0 ? 1 : 0, source: 'resource-graph' }, `app-${i}.internal.example.io`),
  );
  const codeModules: CodeModuleNode[] = Array.from({ length: BIG_CODE }, (_, i) =>
    codeNode(`apps/fiab-console/lib/generated/mod-${i}.ts`),
  );

  const bigEdges: PendingEdge[] = [];
  // Resolved traffic: every app wires to eight of its neighbours. This is the
  // bulk that takes the graph over the 500-edge threshold N2 hides behind.
  for (let i = 0; i < BIG_APPS; i++) {
    for (let w = 0; w < WIRES_PER_APP; w++) {
      const target = apps[(i + w + 1) % BIG_APPS]!;
      bigEdges.push(wire(apps[i]!.id, `https://${target.ingress!.fqdn}`, 'configured', `WIRE_${w}`));
    }
  }
  // The empty-wire class, all of it intended for the planted broker.
  for (const name of EMPTY_WIRE_NAMES) {
    bigEdges.push(emptyWire(apps[0]!.id, broker.id, 'configured', name));
  }

  const big = buildGraph([extraction([...apps, ...codeModules, broker], bigEdges)]);

  it('POPULATION: the fixture really is at production cardinality', () => {
    // A size-conditioned mutation is only caught if the size is actually
    // reached. Asserting it here means an edit that shrinks the fixture fails
    // HERE, loudly, instead of silently disarming every assertion below.
    expect(big.nodes.length).toBeGreaterThan(2_000);
    expect(big.edges.length).toBeGreaterThan(9_000);
    // …and above each mutation's own threshold, named.
    expect(big.edges.length).toBeGreaterThan(500); // N2's condition
    expect(big.nodes.length).toBeGreaterThan(500); // N1' 's condition
  });

  it('N2: a dangling edge does NOT confer inbound reachability at 9k+ edges', () => {
    // The mutation this kills makes the broker REACHABLE on a real graph, which
    // deletes the founding finding itself — not its receipt, the finding.
    expect(big.inboundEdges(broker.id, 'configured').result).toHaveLength(0);
    expect(big.inboundEdges(broker.id).result).toHaveLength(0);
    // …and the broker really is in the unreachable set, so the two assertions
    // above are not passing because the node is absent.
    const unreachable = nodesWithNoInboundEdge(big, 'configured', {
      resourceType: 'Microsoft.App/containerApps',
    });
    expect(unreachable.result.map((n) => n.id)).toContain(broker.id);
    expect(unreachable.population.blind).toBe(false);
  });

  it('N1: the WHOLE empty-value class survives, not one pinned symbol', () => {
    const empties = danglingEdges(big, 'empty-value', 'configured');
    // THE COUNT IS THE ASSERTION. A detector that keeps `LOOM_BROKER_URL` and
    // drops the other 149 still satisfies any single-symbol expectation, and on
    // the measured estate that is 157 findings collapsing to 1.
    expect(empties.result).toHaveLength(EMPTY_WIRE_NAMES.length);
    const symbols = new Set(empties.result.map((e) => e.evidence.symbol));
    expect(symbols.size).toBe(EMPTY_WIRE_NAMES.length);
    // Named explicitly: one that carries the pinned prefix, and two that do not.
    expect(symbols.has('LOOM_BROKER_URL')).toBe(true);
    expect(symbols.has('CSA_TARGET_1_ENDPOINT')).toBe(true);
    expect(symbols.has('LOOM_SERVICE_2_URL')).toBe(true);
    // The evidence chain survives at scale too — all of it, not a sample.
    expect(empties.result.every((e) => e.evidence.rawValue === '')).toBe(true);
    expect(big.danglingEdgesIntendedFor(broker.id).result).toHaveLength(EMPTY_WIRE_NAMES.length);
  });

  it("N1': alwaysOnNodes reports its SUBJECT as the population above 500 nodes", () => {
    // `examined` must be the azure-resource count, NOT the candidate count. With
    // 1,200 code-module nodes in the graph the two differ by half, so the
    // mutation is visible; in a 3-node fixture they are close enough to hide in.
    const azureCount = big.nodes.filter((n) => n.kind === 'azure-resource').length;
    const on = alwaysOnNodes(big);
    expect(azureCount).toBe(BIG_APPS + 1);
    expect(on.population.examined).toBe(azureCount);
    expect(on.population.examined).not.toBe(big.nodes.length);
    expect(on.population.blind).toBe(false);
    // The verdict itself still holds: the planted broker is always-on.
    expect(on.result.map((n) => n.id)).toContain(broker.id);
    expect(scaleUnknownCount(big)).toBe(0);
  });

  it("N2': the bicep extractor's population counts the edges it EMITTED, at 100+", () => {
    // `population.edgesExamined: 0` alongside a non-empty `edges` array is the
    // exact shape that survived, so the extractor is run over a generated tree
    // big enough to clear the threshold the mutation hid behind.
    const consumer = azureResourceNodeId(arm('bicep-consumer'));
    const ENTRIES = 400;
    const text = [
      "resource app 'Microsoft.App/containerApps@2024-03-01' = {",
      '  env: [',
      ...Array.from({ length: ENTRIES }, (_, i) =>
        i % 50 === 0
          ? `    { name: 'LOOM_EMPTY_${i}', value: '' }`
          : `    { name: 'LOOM_TARGET_${i}', value: 'https://app-${i % BIG_APPS}.internal.example.io' }`,
      ),
      '  ]',
      '}',
    ].join('\n');

    const ex = extractFromBicep([{ path: 'platform/fiab/bicep/generated/big.bicep', text, consumer }]);

    expect(ex.edges.length).toBe(ENTRIES);
    expect(ex.edges.length).toBeGreaterThan(100); // the mutation's own condition
    expect(ex.population.edgesExamined).toBe(ex.edges.length);
    expect(ex.population.byProvenance.declared).toBe(ex.edges.length);
    expect(ex.population.blind).toBe(false);
  });

  it('N1 (extractor arm): container-app-env emits the empty-wire class at 100+ entries', () => {
    // The same class assertion one level lower — against the extractor rather
    // than the assembled graph — because N1 was measured AS AN EXTRACTOR
    // mutation. Killing it only at the graph level would leave the arm the
    // reviewer actually ran unwatched.
    const appResourceId = arm('live-app');
    const bindings: Record<string, NodeId> = {};
    for (const n of EMPTY_WIRE_NAMES) bindings[n] = broker.id;
    const env = [
      ...EMPTY_WIRE_NAMES.map((name) => ({ name, value: '' })),
      ...Array.from({ length: 250 }, (_, i) => ({
        name: `LOOM_SET_${i}`,
        value: `https://app-${i % BIG_APPS}.internal.example.io`,
      })),
    ];

    const ex = extractFromContainerAppEnv([{ appResourceId, env, envVarBindings: bindings }]);

    const emptyEdges = ex.edges.filter((e) => e.emptyValue);
    expect(emptyEdges).toHaveLength(EMPTY_WIRE_NAMES.length);
    expect(new Set(emptyEdges.map((e) => e.evidence.symbol)).size).toBe(EMPTY_WIRE_NAMES.length);
    // Not only the pinned prefix.
    expect(emptyEdges.some((e) => e.evidence.symbol === 'CSA_TARGET_1_ENDPOINT')).toBe(true);
    expect(ex.population.edgesExamined).toBe(ex.edges.length);
    expect(ex.population.byProvenance.configured).toBe(ex.edges.length);
  });
});
