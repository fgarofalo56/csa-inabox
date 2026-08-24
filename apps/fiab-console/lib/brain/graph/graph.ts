/**
 * LOOM BRAIN — the graph: build, resolve, query.
 *
 * `buildGraph()` takes the output of every extractor and produces an IMMUTABLE
 * {@link BrainGraphView}. Two things happen here and nowhere else:
 *
 *   1. TARGET RESOLUTION. Extractors emit {@link PendingEdge}s whose target is
 *      whatever the artifact said — an FQDN, an ARM id, a module name, a path,
 *      or the empty string. Resolution happens HERE, after every extractor has
 *      contributed its nodes, because an edge's target is very frequently
 *      discovered by a DIFFERENT extractor than the one that found the wire. The
 *      bicep extractor reads `LOOM_BROKER_URL` off the console app; the node it
 *      points at comes from Resource Graph. Neither can resolve it alone.
 *
 *   2. THE RESOLVED / DANGLING SPLIT. See the header of `../types.ts`. A
 *      `PendingEdge` with `emptyValue: true` becomes a `DanglingEdge` with
 *      reason `empty-value` — it is EMITTED (so the evidence survives) and its
 *      `to` is `null` (so reachability does not count it).
 *
 * ── REACHABILITY IS A QUERY, NOT A RULE ────────────────────────────────────
 * PRP §0: every detector is a graph query. So this module exposes reachability
 * as composable primitives — `inboundEdges`, `nodesWithNoInboundEdge` — rather
 * than a bespoke "find the unreachable broker" function. The founding finding is
 * then one CALL, and the same call finds every other instance of its class.
 *
 * Everything here is PURE. No fetch, no Azure SDK, no ARM writes, no mutation of
 * anything outside this module. Per PRP §1 decision 1 and the program's
 * non-negotiable rule, nothing in `lib/brain` may delete, scale or mutate an
 * Azure resource — this module cannot, because it has no client.
 */

import {
  EDGE_PROVENANCES,
  NODE_KINDS,
  type AzureResourceNode,
  type BrainEdge,
  type BrainGraphView,
  type BrainNode,
  type DanglingEdge,
  type DanglingReason,
  type EdgeProvenance,
  type ExtractionResult,
  type ExtractorSource,
  type GraphBuildReport,
  type NodeId,
  type NodeKind,
  type PendingEdge,
  type Population,
  type QueryResult,
  type ResolvedEdge,
  type SkippedSubject,
} from '../types';
import { azureResourceNodeId, canonicalPath, edgeId } from './node-id';

// ---------------------------------------------------------------------------
// Population helpers
// ---------------------------------------------------------------------------

function zeroProvenanceCounts(): Record<EdgeProvenance, number> {
  const r = {} as Record<EdgeProvenance, number>;
  for (const p of EDGE_PROVENANCES) r[p] = 0;
  return r;
}

/**
 * The minimum an edge must carry to be counted into a {@link Population}.
 *
 * Deliberately STRUCTURAL rather than `BrainEdge`. Extractors report their
 * population over {@link PendingEdge}s — edges whose target has not been
 * resolved yet — and `PendingEdge` is not assignable to `BrainEdge`. Requiring
 * the resolved type here is what forced every extractor to pass `edges: []`,
 * which pinned `blind` to `true` and `byProvenance` to all zeros no matter what
 * the extractor actually emitted. A population that cannot count its own
 * subject is precisely the failure P3 exists to prevent, so the parameter is
 * widened to the one field the count needs.
 */
export type ProvenanceBearing = { readonly provenance: EdgeProvenance };

function countByProvenance(edges: readonly ProvenanceBearing[]): Record<EdgeProvenance, number> {
  const r = zeroProvenanceCounts();
  for (const e of edges) r[e.provenance] += 1;
  return r;
}

/**
 * Build a {@link Population}. `blind` is DERIVED from `subject`, never passed
 * in, so a caller cannot hand-wave an empty set into a confident answer.
 *
 * CALLERS: `edges` must be the edges you actually ranged over. Passing `[]` to
 * satisfy the type is what made every edge-subject population permanently blind
 * — see {@link ProvenanceBearing}.
 */
export function makePopulation(args: {
  subject: 'nodes' | 'edges';
  nodes: readonly BrainNode[];
  edges: readonly ProvenanceBearing[];
  scope: string;
}): Population {
  const examined = args.nodes.length;
  const edgesExamined = args.edges.length;
  return {
    subject: args.subject,
    examined,
    edgesExamined,
    scope: args.scope,
    blind: args.subject === 'nodes' ? examined === 0 : edgesExamined === 0,
    byProvenance: countByProvenance(args.edges),
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * The lookup index used to turn a `targetRef` string into a node.
 *
 * Built once per `buildGraph` over ALL nodes from ALL extractors. Every key is
 * lowercased, matching `node-id`'s normalization — see that module's header for
 * why case-folding identity is safety-critical rather than cosmetic.
 */
interface ResolverIndex {
  /** Node id (already canonical) → node. */
  readonly byId: ReadonlyMap<string, BrainNode>;
  /** Lowercased ingress FQDN → node id. How a live env var URL finds its app. */
  readonly byFqdn: ReadonlyMap<string, NodeId>;
  /** Lowercased resource NAME → node ids. Ambiguous names map to several. */
  readonly byResourceName: ReadonlyMap<string, readonly NodeId[]>;
  /** Canonical repo-relative path → node id. For artifacts and code modules. */
  readonly byPath: ReadonlyMap<string, NodeId>;
}

function buildResolverIndex(nodes: readonly BrainNode[]): ResolverIndex {
  const byId = new Map<string, BrainNode>();
  const byFqdn = new Map<string, NodeId>();
  const byResourceName = new Map<string, NodeId[]>();
  const byPath = new Map<string, NodeId>();

  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.kind === 'azure-resource') {
      const fqdn = n.ingress?.fqdn;
      if (fqdn) byFqdn.set(fqdn.trim().toLowerCase(), n.id);
      const nameKey = n.displayName.trim().toLowerCase();
      if (nameKey) {
        const existing = byResourceName.get(nameKey);
        if (existing) existing.push(n.id);
        else byResourceName.set(nameKey, [n.id]);
      }
    } else if (n.kind === 'deploy-artifact' || n.kind === 'code-module') {
      byPath.set(canonicalPath(n.path).toLowerCase(), n.id);
    }
  }
  return { byId, byFqdn, byResourceName, byPath };
}

/** Strip scheme, port, path and trailing dot from a URL or bare host. */
function hostOf(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const noScheme = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = noScheme.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  const noPort = host.replace(/:\d+$/, '');
  const clean = noPort.replace(/\.$/, '').trim().toLowerCase();
  return clean || null;
}

interface Resolution {
  readonly to: NodeId | null;
  readonly reason: DanglingReason | null;
}

/**
 * Resolve one non-empty `targetRef` against the index.
 *
 * The order matters: an ARM id is unambiguous, an FQDN is unambiguous, a bare
 * NAME is not. A name that matches more than one resource resolves to NOTHING
 * (`unresolved-target`) rather than picking one — guessing between two
 * candidates would attach a real edge to a possibly-wrong node, and every
 * downstream finding would inherit that guess with no way to see it. R7: if the
 * code does not know, it says it does not know.
 */
function resolveTarget(targetRef: string, index: ResolverIndex): Resolution {
  const raw = targetRef.trim();
  if (!raw) return { to: null, reason: 'empty-value' };

  // 1. Already a canonical node id from a previous run or a direct reference.
  const asId = raw.toLowerCase();
  if (index.byId.has(asId)) return { to: asId as NodeId, reason: null };

  // 2. An ARM resource id.
  //
  // The prefix test is CASE-INSENSITIVE, and that is not a stylistic choice.
  // Written as `raw.startsWith('/subscriptions/')` it misses `/SUBSCRIPTIONS/…`
  // entirely — the ref then falls through to FQDN, path and name resolution,
  // matches none of them, and becomes a DANGLING edge. The target resource
  // silently loses an inbound edge and starts looking unreachable. That failure
  // was live in this function until `__tests__/graph/node-id.test.ts` caught it:
  // it manufactures the exact finding this system exists to report, which is the
  // worst possible way to be wrong.
  if (/^\/subscriptions\//i.test(raw)) {
    const id = azureResourceNodeId(raw);
    if (index.byId.has(id)) return { to: id, reason: null };
    // It IS an ARM id, and the resource is not in the graph. That is a
    // materially different remediation from "this string means nothing".
    return { to: null, reason: 'missing-resource' };
  }

  // 3. An FQDN or a URL containing one.
  const host = hostOf(raw);
  if (host) {
    const byFqdn = index.byFqdn.get(host);
    if (byFqdn) return { to: byFqdn, reason: null };
  }

  // 4. A repo-relative path (imports, module references).
  const path = canonicalPath(raw).toLowerCase();
  const byPath = index.byPath.get(path);
  if (byPath) return { to: byPath, reason: null };

  // 5. A bare resource name — ONLY when unambiguous.
  const named = index.byResourceName.get(raw.toLowerCase());
  if (named && named.length === 1) return { to: named[0]!, reason: null };

  return { to: null, reason: 'unresolved-target' };
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

/**
 * The immutable graph. Constructed only by {@link buildGraph}.
 *
 * Detectors receive this as {@link BrainGraphView} — read-only, with no method
 * that adds or removes anything, so one detector cannot perturb the evidence
 * another detector cites.
 */
class BrainGraph implements BrainGraphView {
  readonly nodes: readonly BrainNode[];
  readonly edges: readonly BrainEdge[];
  readonly report: GraphBuildReport;

  private readonly byId: ReadonlyMap<string, BrainNode>;
  private readonly inbound: ReadonlyMap<string, ResolvedEdge[]>;
  private readonly outbound: ReadonlyMap<string, ResolvedEdge[]>;
  private readonly danglingIntendedFor: ReadonlyMap<string, DanglingEdge[]>;

  constructor(nodes: readonly BrainNode[], edges: readonly BrainEdge[], report: GraphBuildReport) {
    this.nodes = Object.freeze([...nodes]);
    this.edges = Object.freeze([...edges]);
    this.report = report;

    const byId = new Map<string, BrainNode>();
    for (const n of nodes) byId.set(n.id, n);
    this.byId = byId;

    const inbound = new Map<string, ResolvedEdge[]>();
    const outbound = new Map<string, ResolvedEdge[]>();
    const dangling = new Map<string, DanglingEdge[]>();

    for (const e of edges) {
      if (e.resolution === 'resolved') {
        // `to` is NodeId here by the discriminated union — a dangling edge
        // cannot reach this branch, which is precisely the reachability
        // property that finds `loom-capacity-broker`.
        const list = inbound.get(e.to);
        if (list) list.push(e);
        else inbound.set(e.to, [e]);

        const out = outbound.get(e.from);
        if (out) out.push(e);
        else outbound.set(e.from, [e]);
      } else if (e.intendedTo !== null) {
        // The wire exists and is empty/unresolvable, but we KNOW who it was
        // meant to reach. This is the evidence chain and nothing else — it is
        // deliberately NOT in `inbound`.
        const list = dangling.get(e.intendedTo);
        if (list) list.push(e);
        else dangling.set(e.intendedTo, [e]);
      }
    }
    this.inbound = inbound;
    this.outbound = outbound;
    this.danglingIntendedFor = dangling;
  }

  node(id: NodeId): BrainNode | undefined {
    return this.byId.get(id);
  }

  /**
   * Inbound edges that COUNT. Resolved only, by construction.
   *
   * `provenance` is optional to match the shared signature, but the returned
   * population ALWAYS carries `byProvenance`, so even the "all" call cannot be
   * read as an undifferentiated total. Where you want the split as data, use
   * {@link inboundEdgesByProvenance}.
   */
  inboundEdges(id: NodeId, provenance?: EdgeProvenance): QueryResult<readonly ResolvedEdge[]> {
    const all = this.inbound.get(id) ?? [];
    const result = provenance ? all.filter((e) => e.provenance === provenance) : all;
    return {
      result,
      population: makePopulation({
        subject: 'edges',
        nodes: this.nodes,
        edges: this.edges,
        scope:
          `inbound edges of ${id}` +
          (provenance ? ` with provenance '${provenance}'` : ' (all provenances)') +
          `; ${this.edges.length} edges in graph`,
      }),
    };
  }

  outboundEdges(id: NodeId, provenance?: EdgeProvenance): QueryResult<readonly ResolvedEdge[]> {
    const all = this.outbound.get(id) ?? [];
    const result = provenance ? all.filter((e) => e.provenance === provenance) : all;
    return {
      result,
      population: makePopulation({
        subject: 'edges',
        nodes: this.nodes,
        edges: this.edges,
        scope:
          `outbound edges of ${id}` +
          (provenance ? ` with provenance '${provenance}'` : ' (all provenances)') +
          `; ${this.edges.length} edges in graph`,
      }),
    };
  }

  /**
   * The dangling wires that were MEANT to reach this node.
   *
   * This is the other half of the founding finding. `inboundEdges(broker,
   * 'configured')` returns `[]` — the broker is unreachable. This returns the
   * `LOOM_BROKER_URL: ''` edge with its file, its line and its raw value, which
   * is what turns "unreachable" into a remediation someone can act on.
   */
  danglingEdgesIntendedFor(id: NodeId): QueryResult<readonly DanglingEdge[]> {
    const result = this.danglingIntendedFor.get(id) ?? [];
    return {
      result,
      population: makePopulation({
        subject: 'edges',
        nodes: this.nodes,
        edges: this.edges,
        scope: `dangling edges whose intendedTo is ${id}; ${this.edges.length} edges in graph`,
      }),
    };
  }

  /** Inbound edges split by provenance. The `declared` vs `configured` answer as data. */
  inboundEdgesByProvenance(id: NodeId): QueryResult<Record<EdgeProvenance, readonly ResolvedEdge[]>> {
    const all = this.inbound.get(id) ?? [];
    const out = {} as Record<EdgeProvenance, ResolvedEdge[]>;
    for (const p of EDGE_PROVENANCES) out[p] = [];
    for (const e of all) out[e.provenance].push(e);
    return {
      result: out,
      population: makePopulation({
        subject: 'edges',
        nodes: this.nodes,
        edges: this.edges,
        scope: `inbound edges of ${id} grouped by provenance; ${this.edges.length} edges in graph`,
      }),
    };
  }
}

/**
 * Assemble the graph from every extractor's output.
 *
 * Node de-duplication: two extractors legitimately see the same resource (a
 * container app is a Resource Graph row AND the subject of a bicep module). The
 * FIRST node wins on identity and the later one is merged field-by-field, filling
 * only fields the first left `undefined`. Merging rather than overwriting is what
 * lets Resource Graph supply the live `ingress.fqdn` while bicep supplies the
 * declared `scale`, without either erasing the other.
 */
export function buildGraph(extractions: readonly ExtractionResult[]): BrainGraph {
  const nodes: BrainNode[] = [];
  const nodeIndex = new Map<string, number>();
  const skipped: SkippedSubject[] = [];
  const extractorsRun: ExtractorSource[] = [];

  for (const ex of extractions) {
    if (!extractorsRun.includes(ex.source)) extractorsRun.push(ex.source);
    for (const s of ex.skipped) skipped.push(s);
    for (const n of ex.nodes) {
      const at = nodeIndex.get(n.id);
      if (at === undefined) {
        nodeIndex.set(n.id, nodes.length);
        nodes.push(n);
      } else {
        nodes[at] = mergeNodes(nodes[at]!, n);
      }
    }
  }

  const index = buildResolverIndex(nodes);
  const edges: BrainEdge[] = [];
  const danglingNodeRefs: string[] = [];
  const seenEdgeIds = new Set<string>();

  for (const ex of extractions) {
    for (const p of ex.edges) {
      // An edge whose SOURCE node does not exist is a graph-integrity defect —
      // recorded, not silently dropped, because it means an extractor minted an
      // id that disagrees with the one that defined the node (see node-id.ts).
      if (!nodeIndex.has(p.from)) {
        danglingNodeRefs.push(p.from);
      }
      const e = resolvePendingEdge(p, index, seenEdgeIds);
      edges.push(e);
    }
  }

  const nodesByKind = {} as Record<NodeKind, number>;
  for (const k of NODE_KINDS) nodesByKind[k] = 0;
  for (const n of nodes) nodesByKind[n.kind] += 1;

  let resolved = 0;
  let dangling = 0;
  for (const e of edges) {
    if (e.resolution === 'resolved') resolved += 1;
    else dangling += 1;
  }

  const report: GraphBuildReport = {
    nodesByKind,
    edgesByProvenance: countByProvenance(edges),
    edgesByResolution: { resolved, dangling },
    extractorsRun,
    skipped,
    danglingNodeRefs,
  };

  return new BrainGraph(nodes, edges, report);
}

/**
 * Turn a {@link PendingEdge} into a resolved or dangling edge.
 *
 * THE EMPTY CASE IS CHECKED FIRST AND EXPLICITLY. `emptyValue: true` produces a
 * `DanglingEdge` with reason `empty-value` — it is NOT dropped, and it is NOT
 * resolved. Dropping it would erase the `loom-capacity-broker` evidence chain;
 * resolving it would make the broker look wired. `__tests__/graph/mutation.test.ts`
 * proves a test goes red if this branch stops emitting.
 */
function resolvePendingEdge(
  p: PendingEdge,
  index: ResolverIndex,
  seenEdgeIds: Set<string>,
): BrainEdge {
  const discriminator = `${p.evidence.artifact}:${p.evidence.line ?? ''}:${p.evidence.symbol ?? ''}`;
  let id = edgeId(p.provenance, p.from, p.targetRef, discriminator);
  // Two identical wires from the same file/line/symbol should not silently
  // collapse into one edge — the second would vanish from every count.
  if (seenEdgeIds.has(id)) {
    let n = 2;
    while (seenEdgeIds.has(`${id}#${n}`)) n += 1;
    id = `${id}#${n}` as typeof id;
  }
  seenEdgeIds.add(id);

  if (p.emptyValue) {
    return {
      id,
      provenance: p.provenance,
      from: p.from,
      evidence: p.evidence,
      resolution: 'dangling',
      to: null,
      intendedTo: p.intendedTo ?? null,
      danglingReason: 'empty-value',
    };
  }

  const r = resolveTarget(p.targetRef, index);
  if (r.to !== null) {
    return {
      id,
      provenance: p.provenance,
      from: p.from,
      evidence: p.evidence,
      resolution: 'resolved',
      to: r.to,
    };
  }
  return {
    id,
    provenance: p.provenance,
    from: p.from,
    evidence: p.evidence,
    resolution: 'dangling',
    to: null,
    intendedTo: p.intendedTo ?? null,
    danglingReason: r.reason ?? 'unresolved-target',
  };
}

/**
 * Merge a duplicate node into the one already held.
 *
 * Fill-only: an existing defined field is never overwritten. `tags` is merged
 * with a deliberate asymmetry — a `null` (COULD NOT READ) never overwrites a
 * populated map, because "I failed to read the tags" must not erase tags another
 * extractor successfully read. The inverse is also true: real tags DO replace a
 * null, since that strictly increases what is established.
 */
function mergeNodes(existing: BrainNode, incoming: BrainNode): BrainNode {
  if (existing.kind !== 'azure-resource' || incoming.kind !== 'azure-resource') {
    return existing;
  }
  const a = existing as AzureResourceNode;
  const b = incoming as AzureResourceNode;
  return {
    ...a,
    location: a.location ?? b.location,
    tags: a.tags ?? b.tags,
    tagsError: a.tags ? a.tagsError : (a.tagsError ?? b.tagsError),
    scale: a.scale ?? b.scale,
    ingress: a.ingress ?? b.ingress,
    provisioningState: a.provisioningState ?? b.provisioningState,
  };
}

// ---------------------------------------------------------------------------
// Reachability queries — PRP §0: a detector is a QUERY, not a bespoke rule
// ---------------------------------------------------------------------------

/** Restrict a reachability query to a subset of nodes. */
export interface ReachabilityFilter {
  readonly kind?: NodeKind;
  /** ARM type, compared case-insensitively. */
  readonly resourceType?: string;
  /** Free-form predicate for anything the fields above cannot express. */
  readonly where?: (n: BrainNode) => boolean;
  /** Describes the filter for the population's `scope`. Supply it. */
  readonly describe?: string;
}

function applyFilter(nodes: readonly BrainNode[], f?: ReachabilityFilter): BrainNode[] {
  if (!f) return [...nodes];
  return nodes.filter((n) => {
    if (f.kind && n.kind !== f.kind) return false;
    if (f.resourceType) {
      if (n.kind !== 'azure-resource') return false;
      if (n.resourceType.toLowerCase() !== f.resourceType.toLowerCase()) return false;
    }
    if (f.where && !f.where(n)) return false;
    return true;
  });
}

/**
 * THE CORE QUERY. Nodes with no inbound edge of the given provenance.
 *
 * `nodesWithNoInboundEdge(graph, 'configured', { resourceType: 'Microsoft.App/containerApps' })`
 * is the founding finding, and the same call finds every other member of its
 * class — which is the entire argument for a graph substrate over hand-written
 * rules.
 *
 * READ THE POPULATION BEFORE THE RESULT. Two different empty-ish states:
 *
 *   `population.blind === true`     the node filter matched NOTHING. The answer
 *                                   establishes nothing at all.
 *   `population.byProvenance[p] === 0`
 *                                   the graph holds ZERO edges of that
 *                                   provenance, so "no inbound edge" is
 *                                   vacuously true of every node returned. The
 *                                   result will be LOUD (everything) rather than
 *                                   silent, but it is still not a finding — it
 *                                   means the extractor for that provenance did
 *                                   not run or produced nothing.
 */
export function nodesWithNoInboundEdge(
  graph: BrainGraphView,
  provenance: EdgeProvenance,
  filter?: ReachabilityFilter,
): QueryResult<readonly BrainNode[]> {
  const candidates = applyFilter(graph.nodes, filter);
  const result = candidates.filter(
    (n) => graph.inboundEdges(n.id, provenance).result.length === 0,
  );
  const scope =
    `${candidates.length} node(s)` +
    (filter?.describe ? ` matching ${filter.describe}` : '') +
    (filter?.kind ? ` of kind '${filter.kind}'` : '') +
    (filter?.resourceType ? ` of type '${filter.resourceType}'` : '') +
    `, tested for inbound edges with provenance '${provenance}'`;
  return {
    result,
    population: makePopulation({
      subject: 'nodes',
      nodes: candidates,
      edges: graph.edges,
      scope,
    }),
  };
}

/**
 * Nodes that have an inbound edge of `present` but NONE of `absent`.
 *
 * This is the shape behind the two headline findings from `../types.ts`:
 *
 *   `declaredButNotConfigured` — `hasInboundOnly(g, 'declared', 'configured')`
 *       wired in the template, DEAD in the deployment.
 *   `configuredButNotObserved` — `hasInboundOnly(g, 'configured', 'observed')`
 *       reachable and UNUSED.
 *
 * They are one query with different arguments, which is the point: conflating
 * them is a mistake you have to actively make, not one you can slide into.
 */
export function hasInboundOnly(
  graph: BrainGraphView,
  present: EdgeProvenance,
  absent: EdgeProvenance,
  filter?: ReachabilityFilter,
): QueryResult<readonly BrainNode[]> {
  const candidates = applyFilter(graph.nodes, filter);
  const result = candidates.filter(
    (n) =>
      graph.inboundEdges(n.id, present).result.length > 0 &&
      graph.inboundEdges(n.id, absent).result.length === 0,
  );
  return {
    result,
    population: makePopulation({
      subject: 'nodes',
      nodes: candidates,
      edges: graph.edges,
      scope:
        `${candidates.length} node(s)` +
        (filter?.describe ? ` matching ${filter.describe}` : '') +
        `, tested for inbound '${present}' AND no inbound '${absent}'`,
    }),
  };
}

/**
 * Every dangling edge in the graph, optionally filtered by reason.
 *
 * `danglingEdges(g, 'empty-value')` is the inventory of wires that exist and
 * point at nothing — the `LOOM_BROKER_URL: ''` class, estate-wide.
 */
export function danglingEdges(
  graph: BrainGraphView,
  reason?: DanglingReason,
  provenance?: EdgeProvenance,
): QueryResult<readonly DanglingEdge[]> {
  const all = graph.edges.filter((e): e is DanglingEdge => e.resolution === 'dangling');
  const result = all.filter(
    (e) =>
      (reason === undefined || e.danglingReason === reason) &&
      (provenance === undefined || e.provenance === provenance),
  );
  return {
    result,
    population: makePopulation({
      subject: 'edges',
      nodes: graph.nodes,
      edges: graph.edges,
      scope:
        `${graph.edges.length} edge(s) in graph, ${all.length} dangling; filtered by ` +
        `reason='${reason ?? 'any'}' provenance='${provenance ?? 'any'}'`,
    }),
  };
}

/**
 * Azure resource nodes that are ALWAYS ON — `scale.minReplicas > 0`.
 *
 * The population deliberately reports how many nodes had NO scale facts at all.
 * Absent scale is NOT MEASURED, not zero; treating it as zero silently exonerates
 * every resource whose scale could not be read, which is R7's failure in its
 * cheapest form. Callers must read {@link scaleUnknownCount} alongside the result.
 */
export function alwaysOnNodes(
  graph: BrainGraphView,
  filter?: ReachabilityFilter,
): QueryResult<readonly AzureResourceNode[]> {
  const candidates = applyFilter(graph.nodes, filter);
  const azure = candidates.filter((n): n is AzureResourceNode => n.kind === 'azure-resource');
  const unknown = azure.filter((n) => n.scale === undefined).length;
  const result = azure.filter((n) => n.scale !== undefined && n.scale.minReplicas > 0);
  return {
    result,
    population: makePopulation({
      subject: 'nodes',
      // `azure`, NOT `candidates`. The subject of this query is the
      // azure-resource nodes, so that is the set `blind` must be computed
      // against. Reporting `candidates` here made a graph with bicep/source
      // nodes but ZERO azure-resource nodes answer "no always-on resources, and
      // I am not blind" — a false clean in the query that names the billing,
      // and reachable any time the Resource Graph pull returns nothing (auth
      // expiry, wrong subscription, throttling).
      nodes: azure,
      edges: graph.edges,
      scope:
        `${azure.length} azure-resource node(s)` +
        (filter?.describe ? ` matching ${filter.describe}` : '') +
        `; ${unknown} had NO scale facts (not measured — NOT counted as minReplicas 0)`,
    }),
  };
}

/** How many nodes in scope carry no scale facts. Read this with {@link alwaysOnNodes}. */
export function scaleUnknownCount(
  graph: BrainGraphView,
  filter?: ReachabilityFilter,
): number {
  return applyFilter(graph.nodes, filter).filter(
    (n) => n.kind === 'azure-resource' && n.scale === undefined,
  ).length;
}

export type { BrainGraph };
