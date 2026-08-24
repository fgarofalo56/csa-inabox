/**
 * Shared fixtures for the agent-layer tests.
 *
 * ── NO REAL IDENTIFIERS ────────────────────────────────────────────────────
 * `csa-inabox` is a PUBLIC repository. Every subscription, resource group and
 * resource name below is a made-up placeholder in an obviously non-GUID shape
 * (`sub-a`, `rg-brain-test`) so that nothing here can be mistaken for — or grep
 * back to — a real tenant. The estate figures quoted in comments (63 container
 * apps, 13 environments, 0 `owns` edges) are aggregate counts from the PRP and
 * name nothing.
 *
 * ── FIXTURES MODEL THE CONTRACT, NOT THE IMPLEMENTATION ────────────────────
 * `makeFinding` builds a valid `Finding` from the substrate's own type — every
 * required field present, populations internally consistent. Where a test needs
 * a defective finding it says so by name (`blindFinding`, `vacuousFinding`), so
 * a reader can see which defect is under test without reading the object.
 */

import {
  buildGraph,
  extractFromResourceGraph,
  nodeIdFromPersisted,
  edgeIdFromPersisted,
  proposal,
  derivedCost,
  type BrainGraphView,
  type EdgeProvenance,
  type Finding,
  type NodeId,
  type Population,
  type DetectorResult,
  type ResourceGraphRow,
} from '@/lib/brain/graph';
import type { BrainModelClient, BrainModelReply, BrainModelRequest } from '@/lib/brain/agents';

// ---------------------------------------------------------------------------
// Populations
// ---------------------------------------------------------------------------

const ALL_PROVENANCE_ZERO: Record<EdgeProvenance, number> = {
  declared: 0,
  configured: 0,
  imports: 0,
  observed: 0,
  owns: 0,
};

/** A healthy population: non-empty subject set, edges of several provenances. */
export function population(over: Partial<Population> = {}): Population {
  const byProvenance = { ...ALL_PROVENANCE_ZERO, declared: 12, configured: 9, imports: 40, ...(over.byProvenance ?? {}) };
  const examined = over.examined ?? 29;
  const subject = over.subject ?? 'nodes';
  const edgesExamined = over.edgesExamined ?? 61;
  return {
    subject,
    examined,
    edgesExamined,
    scope: over.scope ?? '29 node(s) of type Microsoft.App/containerApps',
    blind: over.blind ?? (subject === 'nodes' ? examined === 0 : edgesExamined === 0),
    byProvenance,
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

let seq = 0;

/**
 * A well-formed finding that every measured Critic check should pass.
 *
 * NOTE — `evidence.nodes` DEFAULTS TO `subjects`, and that is load-bearing.
 * When it was a fixed constant instead, two findings built with different
 * `subjects` still shared the constant evidence node, so the correlator
 * correctly grouped two supposedly-unrelated findings and the negative test
 * failed. A fixture with a hidden shared key cannot express "these do not
 * correlate". Do not replace this with a literal.
 */
export function makeFinding(over: Partial<Finding> = {}): Finding {
  seq += 1;
  const id = over.id ?? `f-${seq}`;
  const subjects = over.subjects ?? [azureNodeId('rg-brain-test', 'app-alpha')];
  return {
    id,
    detector: over.detector ?? 'unreachable-always-on',
    severity: over.severity ?? 'high',
    title: over.title ?? 'A container app is always-on with no inbound configured edge',
    summary:
      over.summary ??
      'The app runs at minReplicas above zero and no live environment variable resolves to it.',
    subjects,
    evidence: over.evidence ?? {
      nodes: subjects,
      edges: [edgeIdFromPersisted('configured|azure:x|<empty>|main.bicep:10:VAR')],
      query: "nodesWithNoInboundEdge(graph, 'configured')",
      notes: ['minReplicas 2, ingress internal, provisioningState Succeeded'],
    },
    population: over.population ?? population(),
    confidence: over.confidence ?? 'high',
    cost: over.cost,
    remediation: over.remediation ?? proposal('Wire the variable or scale to zero', 'edit main.bicep:4730'),
  };
}

/**
 * A finding whose OWN population is blind — the check that must refute.
 *
 * `examined: 0` on a `'nodes'` subject. This is the shape the graph module's
 * `makePopulation` produces when a reachability filter matched nothing.
 */
export function blindFinding(over: Partial<Finding> = {}): Finding {
  return makeFinding({
    ...over,
    population: population({ examined: 0, edgesExamined: 0, blind: true, scope: '0 node(s) matched the filter' }),
  });
}

/**
 * A finding that queried a provenance the graph holds ZERO edges of.
 *
 * The node set is NOT empty, so `population.blind` is false and nothing looks
 * wrong — which is exactly why this needs its own check.
 */
export function vacuousFinding(over: Partial<Finding> = {}): Finding {
  return makeFinding({
    ...over,
    population: population({
      byProvenance: { ...ALL_PROVENANCE_ZERO, declared: 12, configured: 0, imports: 40 },
    }),
    evidence: {
      nodes: [azureNodeId('rg-brain-test', 'app-alpha')],
      edges: [],
      query: "nodesWithNoInboundEdge(graph, 'configured')",
      notes: [],
    },
  });
}

/** A finding with an empty evidence chain — an assertion, not a finding. */
export function noEvidenceFinding(over: Partial<Finding> = {}): Finding {
  return makeFinding({
    ...over,
    evidence: { nodes: [], edges: [], query: "nodesWithNoInboundEdge(graph, 'configured')", notes: [] },
  });
}

/** A finding whose cost claims `billed` with a basis naming no export. */
export function billedWithoutExportFinding(over: Partial<Finding> = {}): Finding {
  return makeFinding({
    ...over,
    cost: { amountUsd: 41.5, source: 'billed', basis: 'looked about right', asOf: '2026-08-23T00:00:00.000Z' },
  });
}

/** A finding carrying a derived cost — the normal case. */
export function costedFinding(over: Partial<Finding> = {}): Finding {
  return makeFinding({
    ...over,
    cost: derivedCost(41.5, '2 replicas x 0.5 vCPU x list rate', '2026-08-23T00:00:00.000Z'),
  });
}

/**
 * The #3893 shape: nine findings that are ONE dead gate.
 *
 * All nine cite the same deploy-artifact node — `landing-zone/main.bicep`, the
 * module that is never instantiated on any shipped params file. They must
 * collapse into ONE component with no model involved.
 */
export function nineBicepFindings(): Finding[] {
  const artifact = nodeIdFromPersisted('deploy:platform/fiab/bicep/modules/landing-zone/main.bicep');
  return Array.from({ length: 9 }, (_, i) =>
    makeFinding({
      id: `bicep-${i}`,
      detector: 'inert-bicep-module',
      title: `Module invocation ${i} is never reached`,
      subjects: [artifact],
      evidence: {
        nodes: [artifact],
        edges: [],
        query: "nodesWithNoInboundEdge(graph, 'declared')",
        notes: [`declaration ${i} inside an uninstantiated module`],
      },
    }),
  );
}

/** Wrap findings as a detector result, the shape the pipeline consumes. */
export function detectorResult(
  detector: string,
  findings: readonly Finding[],
  over: Partial<DetectorResult> = {},
): DetectorResult {
  return {
    detector,
    findings,
    population: over.population ?? population(),
    skipped: over.skipped ?? [],
  };
}

/** A detector that examined NOTHING — green and blind. */
export function blindDetectorResult(detector = 'empty-detector'): DetectorResult {
  return {
    detector,
    findings: [],
    population: population({ examined: 0, edgesExamined: 0, blind: true, scope: '0 node(s) in scope' }),
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// Node ids and graphs
// ---------------------------------------------------------------------------

/** A placeholder ARM-shaped node id. `sub-a` is not a GUID and never was one. */
export function azureNodeId(rg: string, name: string): NodeId {
  return nodeIdFromPersisted(
    `azure:/subscriptions/sub-a/resourcegroups/${rg}/providers/microsoft.app/containerapps/${name}`.toLowerCase(),
  );
}

function armId(rg: string, name: string): string {
  return `/subscriptions/sub-a/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${name}`;
}

/**
 * A tiny graph of container apps.
 *
 * `scale` is present only when `minReplicas` is supplied — matching the real
 * extractor, where an absent `properties.template.scale` means NOT MEASURED
 * rather than zero.
 */
export function makeGraph(
  apps: readonly { name: string; minReplicas?: number; tags?: Record<string, string> | null }[],
): BrainGraphView {
  const rows: ResourceGraphRow[] = apps.map((a) => ({
    id: armId('rg-brain-test', a.name),
    type: 'Microsoft.App/containerApps',
    name: a.name,
    resourceGroup: 'rg-brain-test',
    subscriptionId: 'sub-a',
    location: 'centralus',
    tags: a.tags === undefined ? {} : a.tags,
    properties:
      a.minReplicas === undefined
        ? { provisioningState: 'Succeeded' }
        : {
            provisioningState: 'Succeeded',
            template: { scale: { minReplicas: a.minReplicas, maxReplicas: 10 } },
          },
  }));
  return buildGraph([extractFromResourceGraph(rows, {})]);
}

// ---------------------------------------------------------------------------
// Model stubs
// ---------------------------------------------------------------------------

/** Every request a stub client received, in order. */
export interface StubLog {
  readonly calls: BrainModelRequest[];
}

/**
 * A deterministic model stub.
 *
 * `replyFor` is keyed by agent, so one stub can serve a whole pipeline run while
 * each agent gets a shape it can actually parse. Anything not keyed returns an
 * empty object, which every parser must survive.
 */
export function stubClient(
  replyFor: Partial<Record<BrainModelRequest['agent'], unknown>>,
  log?: StubLog,
): BrainModelClient {
  return async (req: BrainModelRequest): Promise<BrainModelReply> => {
    log?.calls.push(req);
    return { json: replyFor[req.agent] ?? {}, usage: null };
  };
}

/** A client that always throws — the outage case. */
export function throwingClient(message = 'AOAI 503: no deployment configured'): BrainModelClient {
  return async () => {
    throw new Error(message);
  };
}

/** A client that reports REAL token counts, for the usage-source tests. */
export function reportingClient(
  replyFor: Partial<Record<BrainModelRequest['agent'], unknown>>,
  usage: { promptTokens: number; completionTokens: number },
): BrainModelClient {
  return async (req: BrainModelRequest): Promise<BrainModelReply> => ({
    json: replyFor[req.agent] ?? {},
    usage,
  });
}
