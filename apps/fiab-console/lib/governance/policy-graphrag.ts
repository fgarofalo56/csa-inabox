/**
 * policy-graphrag — B-N14b: GraphRAG retrieval over the POLICY graph.
 *
 * This is deliberately NOT a second retriever. It REUSES the N11 primitives
 * verbatim (`lib/azure/ontology-graphrag.ts`):
 *
 *   • `extractSeedTerms`        — which declared node kinds the question named,
 *                                 its content tokens, its quoted phrases
 *   • `filterSeedObjects` /
 *     `scoreSeedObject`         — the JS-side property predicate that ranks REAL
 *                                 rows into seeds (identical scoring)
 *   • `pathCitationsFromVisits` — the shared pure walk-back-to-seed citation
 *                                 builder (extracted from N11 for this item)
 *   • `graphContextBlock`       — the grounding block renderer, with governance
 *                                 wording supplied through its label overrides
 *   • `GraphRagContext` / `GraphPathCitation` — the SAME typed shapes, so the
 *                                 citations flow into N10's Answer Receipt with
 *                                 no new receipt type.
 *
 * Only the FRONTIER EXPANSION differs: N11 expands by issuing one Cypher hop per
 * frontier against Apache AGE; the policy graph is already an in-memory
 * adjacency list assembled from Cosmos (`policy-graph-load.ts`), so expansion is
 * a pure map lookup. Everything before and after that step is shared code.
 *
 * Per-cloud identical, IL5-safe: pure computation over in-boundary reads.
 */

import {
  extractSeedTerms,
  filterSeedObjects,
  graphContextBlock,
  pathCitationsFromVisits,
  MAX_PATH_CITATIONS,
  type GraphPathCitation,
  type GraphRagContext,
  type GraphSeed,
  type GraphVisit,
} from '@/lib/azure/ontology-graphrag';
import {
  buildAdjacency,
  indexNodes,
  policyNodeAsWeaveObject,
  POLICY_NODE_KINDS,
  POLICY_SEED_KIND_ORDER,
  type PolicyGraph,
  type PolicyNode,
} from '@/lib/governance/policy-graph';

/** Traversal depth for a governance question. `principal → grant → asset →
 *  field → classification` is 4 hops, so 4 is the useful default (and the N11
 *  clamp ceiling). */
export const POLICY_GRAPH_MAX_HOPS = 4;
/** Seeds carried into traversal (governance questions name more terms than an
 *  entity lookup — "read", "PII", "EU" are three distinct anchors). */
export const POLICY_MAX_SEEDS = 8;
/** Nodes visited per retrieval — the fan-out bound. */
export const POLICY_VISIT_CAP = 400;

/** Governance wording for the reused {@link graphContextBlock} renderer. */
export const POLICY_CONTEXT_LABELS = {
  heading: '## POLICY GRAPH GROUNDING (this tenant\'s REAL authorization + governance facts)',
  lead:
    'These are REAL grants, policies, contracted columns, classifications, and regions read from ' +
    'this deployment\'s own stores (entitlement ledger, workspace ACLs, governance policy document, ' +
    'ODCS data-contract registry, Purview built-in classification catalog). Treat them as the ONLY ' +
    'evidence available. They are the complete evidence set for this question.',
  seedsLabel: 'Policy-graph entities matched from the question:',
  pathsLabel: 'Policy paths (real edges — each one is a citable authorization/governance fact):',
  closing:
    'Answer ONLY from the paths above and CITE the numbered path(s) each claim rests on. ' +
    'If the paths do not establish a claim, say so explicitly and REFUSE to guess — do not infer ' +
    'a grant, a classification, a residency, or a principal that is not on a listed path.',
} as const;

/** The retrieval result: an N11 {@link GraphRagContext} plus policy provenance. */
export interface PolicyGraphRagResult extends GraphRagContext {
  /** Distinct node kinds the traversal touched (evidence breadth). */
  kindsTouched: string[];
  /** Nodes in the assembled graph (the search space). */
  graphSize: number;
}

/**
 * Retrieve grounded policy context for a governance question.
 *
 * PURE — the caller supplies the already-assembled graph, so this is fully
 * unit-testable with no Cosmos. Never throws.
 */
export function retrievePolicyContext(opts: {
  question: string;
  graph: PolicyGraph;
  maxHops?: number;
  maxSeeds?: number;
}): PolicyGraphRagResult {
  const started = Date.now();
  const maxHops = Math.min(Math.max(Math.trunc(opts.maxHops ?? POLICY_GRAPH_MAX_HOPS), 1), 4);
  const maxSeeds = Math.max(1, Math.trunc(opts.maxSeeds ?? POLICY_MAX_SEEDS));
  const graph = opts.graph;

  const base = (extra: Partial<PolicyGraphRagResult>): PolicyGraphRagResult => ({
    ok: false, seeds: [], paths: [], communities: [], vertexIds: [], hops: maxHops,
    scanned: 0, contextText: '', durationMs: Date.now() - started,
    kindsTouched: [], graphSize: graph.nodes.length, ...extra,
  });

  if (!graph.nodes.length) {
    return base({ note: 'The policy graph is empty for this tenant — no grants, policies, or contracts were readable.' });
  }

  // ── 1. SEEDS — the N11 term extractor + the N11 JS-side property scorer ────
  // The "declared object types" the extractor takes are the policy NODE KINDS,
  // so a question naming "policy" or "classification" gets a type hint exactly
  // the way naming an ontology object type does.
  const { typeHints, terms, phrases } = extractSeedTerms(opts.question, POLICY_NODE_KINDS);
  if (terms.length === 0 && phrases.length === 0) {
    return base({ note: 'The question named no governance terms to seed a policy-graph traversal.' });
  }

  const byKind = new Map<string, PolicyNode[]>();
  for (const n of graph.nodes) {
    const list = byKind.get(n.kind);
    if (list) list.push(n);
    else byKind.set(n.kind, [n]);
  }

  // Kinds the question NAMED are scanned first; then the standard governance
  // priority order (the N11 "widen when nothing matched" behaviour).
  const hinted = POLICY_SEED_KIND_ORDER.filter((k) => typeHints.includes(k));
  const rest = POLICY_SEED_KIND_ORDER.filter((k) => !hinted.includes(k));
  const seedPool: GraphSeed[] = [];
  let scanned = 0;
  const scanKinds = (kinds: readonly string[]) => {
    for (const kind of kinds) {
      const nodes = byKind.get(kind) || [];
      if (!nodes.length) continue;
      scanned += nodes.length;
      seedPool.push(
        ...filterSeedObjects(nodes.map(policyNodeAsWeaveObject), terms, phrases, undefined, maxSeeds),
      );
    }
  };
  scanKinds(hinted);
  if (seedPool.length === 0) scanKinds(rest);
  seedPool.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const seeds = seedPool.slice(0, maxSeeds);
  if (seeds.length === 0) {
    return base({
      scanned,
      note:
        `No grant, policy, contracted column, classification, or region in this tenant's policy graph ` +
        `matched the question's terms (${scanned} node(s) scanned).`,
    });
  }

  // ── 2. TRAVERSAL — bounded BFS over the in-memory adjacency ────────────────
  const adj = buildAdjacency(graph);
  const nodeById = indexNodes(graph);
  const visited = new Map<string, GraphVisit>();
  for (const s of seeds) {
    visited.set(s.id, { node: { id: s.id, objectType: s.objectType, title: s.title }, depth: 0, seedId: s.id });
  }
  let frontier = seeds.map((s) => s.id);
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const step of adj.get(from) || []) {
        if (visited.size >= POLICY_VISIT_CAP) break;
        if (visited.has(step.to)) continue;
        const target = nodeById.get(step.to);
        const parent = visited.get(from);
        if (!target || !parent) continue;
        visited.set(step.to, {
          node: { id: target.id, objectType: target.kind, title: target.title },
          depth: hop,
          parent: from,
          linkType: step.type,
          dir: step.direction,
          seedId: parent.seedId,
        });
        next.push(step.to);
      }
    }
    frontier = next;
  }

  // ── 3. PATH CITATIONS — the SHARED N11 walker ─────────────────────────────
  const paths: GraphPathCitation[] = pathCitationsFromVisits(visited, MAX_PATH_CITATIONS);
  const vertexIds = [...visited.keys()];
  const kindsTouched = [...new Set([...visited.values()].map((v) => v.node.objectType))].sort();

  const ctx: PolicyGraphRagResult = {
    ok: true,
    seeds,
    paths,
    communities: [],
    vertexIds,
    hops: maxHops,
    scanned,
    contextText: '',
    durationMs: Date.now() - started,
    kindsTouched,
    graphSize: graph.nodes.length,
  };
  // The SAME renderer N11 uses, with the governance wording overrides.
  ctx.contextText = graphContextBlock(ctx, POLICY_CONTEXT_LABELS);
  if (!paths.length) {
    ctx.note =
      'The question matched policy-graph entities, but no edge connects them — the graph cannot ' +
      'establish a relationship between them.';
  }
  return ctx;
}
