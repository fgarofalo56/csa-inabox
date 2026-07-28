/**
 * policy-graph — B-N14b: the POLICY GRAPH model.
 *
 * The NL governance copilot ("who can read PII in EU?") needs the same
 * multi-hop, path-citable retrieval N11 gave data agents over the authored
 * ontology — but over a DIFFERENT graph: the tenant's authorization + data
 * governance facts. This module is the PURE model + builder for that graph.
 *
 * NODES (every one derived from a REAL persisted row — never synthesized):
 *   principal      — an Entra user / group / service principal that holds a grant
 *                    (`loom-access-assignments` ledger, `workspace-roles`, and the
 *                    principal named on an Access-kind governance policy)
 *   grant          — one effective grant row (role + permission + source)
 *   policy         — one governance policy (DLP / Label / Masking / RLS /
 *                    Retention / Access) from the tenant policy doc
 *   asset          — a workspace item / data-contract subject the grants land on
 *   field          — a contracted column (ODCS property) on an asset
 *   classification — a Purview built-in sensitive-information type the field or
 *                    policy references (the 59-entry reference catalog)
 *   region         — a residency/region term declared on a policy scope, a
 *                    contract custom property, or an asset's declared region
 *
 * EDGES: `HOLDS` (principal→grant), `GRANTS` (grant→asset), `APPLIES_TO`
 * (policy→asset / policy→field), `DETECTS` (policy→classification),
 * `HAS_FIELD` (asset→field), `CLASSIFIED_AS` (field→classification),
 * `LOCATED_IN` (asset/policy→region), `DERIVED_FROM` (asset→asset lineage).
 *
 * The graph is an ADJACENCY LIST held in memory for ONE question — it is small
 * (bounded by the tenant's grants + contracts) and is assembled by
 * `policy-graph-load.ts` from real Cosmos reads. It deliberately does NOT live
 * in Apache AGE: the policy facts already have authoritative homes (the
 * assignment ledger, the policy doc, the contract registry) and duplicating them
 * into a second store would create a drift surface. Retrieval REUSES the N11
 * primitives (`extractSeedTerms` / `filterSeedObjects` / `pathCitationsFromVisits`
 * / `graphContextBlock`) — see `policy-graphrag.ts`.
 *
 * No Microsoft Fabric / Power BI dependency (no-fabric-dependency.md): every
 * source is Loom-native Cosmos + the static Purview reference catalog. IL5: the
 * whole retrieval runs in-boundary with zero external egress.
 */

import type { WeaveObject } from '@/lib/azure/weave-ontology-store';

/** The node kinds the policy graph carries. Used verbatim as the `objectType`
 *  in the reused N11 seed/citation shapes, so a path reads
 *  `Alice (principal) —[HOLDS]→ Storage Blob Data Reader (grant)`. */
export const POLICY_NODE_KINDS = [
  'principal',
  'grant',
  'policy',
  'asset',
  'field',
  'classification',
  'region',
] as const;
export type PolicyNodeKind = (typeof POLICY_NODE_KINDS)[number];

/** The typed edge labels. */
export const POLICY_EDGE_TYPES = [
  'HOLDS',
  'GRANTS',
  'APPLIES_TO',
  'DETECTS',
  'HAS_FIELD',
  'CLASSIFIED_AS',
  'LOCATED_IN',
  'DERIVED_FROM',
] as const;
export type PolicyEdgeType = (typeof POLICY_EDGE_TYPES)[number];

/** One node. `properties` is what the reused N11 seed matcher scores against. */
export interface PolicyNode {
  /** Stable id, namespaced by kind (`principal:<oid>`, `asset:<itemId>`, …). */
  id: string;
  kind: PolicyNodeKind;
  /** Human title rendered in the path citation. */
  title: string;
  /** Searchable string properties — REAL field values, never invented. */
  properties: Record<string, unknown>;
}

/** One directed edge. Traversal walks it in BOTH directions (an authorization
 *  question reads "who can reach X" and "what can P reach" equally). */
export interface PolicyEdge {
  from: string;
  to: string;
  type: PolicyEdgeType;
}

/** The assembled graph for one question. */
export interface PolicyGraph {
  nodes: PolicyNode[];
  edges: PolicyEdge[];
  /** Provenance counters surfaced in the honest "what was searched" note. */
  sources: PolicyGraphSourceCounts;
}

export interface PolicyGraphSourceCounts {
  assignments: number;
  workspaceRoles: number;
  policies: number;
  contracts: number;
  items: number;
  classifications: number;
}

/** Empty source counters. */
export function emptySourceCounts(): PolicyGraphSourceCounts {
  return { assignments: 0, workspaceRoles: 0, policies: 0, contracts: 0, items: 0, classifications: 0 };
}

// ── Builder ────────────────────────────────────────────────────────────────

/**
 * Incremental, de-duplicating graph builder. Pure: it only ever records what
 * the caller hands it, so every node in the finished graph traces to a real row.
 */
export class PolicyGraphBuilder {
  private readonly nodes = new Map<string, PolicyNode>();
  private readonly edgeKeys = new Set<string>();
  private readonly edges: PolicyEdge[] = [];
  readonly sources: PolicyGraphSourceCounts = emptySourceCounts();

  /** Add (or merge into) a node. Later property writes win for non-empty values. */
  node(id: string, kind: PolicyNodeKind, title: string, properties: Record<string, unknown> = {}): string {
    const key = String(id || '').trim();
    if (!key) return '';
    const prior = this.nodes.get(key);
    if (prior) {
      for (const [k, v] of Object.entries(properties)) {
        if (v !== undefined && v !== null && String(v) !== '') prior.properties[k] = v;
      }
      if (!prior.title && title) prior.title = title;
      return key;
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(properties)) {
      if (v !== undefined && v !== null && String(v) !== '') clean[k] = v;
    }
    this.nodes.set(key, { id: key, kind, title: title || key, properties: clean });
    return key;
  }

  /** Add an edge (no-op when either endpoint is missing or it already exists). */
  edge(from: string, type: PolicyEdgeType, to: string): void {
    if (!from || !to || from === to) return;
    if (!this.nodes.has(from) || !this.nodes.has(to)) return;
    const k = `${from}|${type}|${to}`;
    if (this.edgeKeys.has(k)) return;
    this.edgeKeys.add(k);
    this.edges.push({ from, to, type });
  }

  build(): PolicyGraph {
    return { nodes: [...this.nodes.values()], edges: this.edges, sources: { ...this.sources } };
  }
}

// ── Adjacency + traversal support ──────────────────────────────────────────

/** One outgoing step from a node during traversal. */
export interface PolicyAdjacency {
  to: string;
  type: PolicyEdgeType;
  direction: 'out' | 'in';
}

/**
 * Build the BIDIRECTIONAL adjacency index. Authorization questions traverse
 * both ways (`principal → grant → asset` and `classification ← field ← asset`),
 * so every edge is indexed from both endpoints with its real direction kept for
 * the citation arrow.
 */
export function buildAdjacency(graph: PolicyGraph): Map<string, PolicyAdjacency[]> {
  const adj = new Map<string, PolicyAdjacency[]>();
  const push = (from: string, entry: PolicyAdjacency) => {
    const list = adj.get(from);
    if (list) list.push(entry);
    else adj.set(from, [entry]);
  };
  for (const e of graph.edges) {
    push(e.from, { to: e.to, type: e.type, direction: 'out' });
    push(e.to, { to: e.from, type: e.type, direction: 'in' });
  }
  return adj;
}

/** Index nodes by id for O(1) traversal lookups. */
export function indexNodes(graph: PolicyGraph): Map<string, PolicyNode> {
  return new Map(graph.nodes.map((n) => [n.id, n]));
}

/**
 * Adapt a {@link PolicyNode} to the {@link WeaveObject} shape the REUSED N11
 * seed scorer (`scoreSeedObject` / `filterSeedObjects`) consumes. The node kind
 * becomes the `objectType`, so the resulting seeds and path citations read with
 * the policy vocabulary and no second scorer is needed.
 */
export function policyNodeAsWeaveObject(n: PolicyNode): WeaveObject {
  return {
    id: n.id,
    objectType: n.kind,
    // `title` is included so a question naming the entity by name still matches
    // even when the title is not repeated in another property.
    properties: { ...n.properties, title: n.title },
  };
}

/** Node kinds a governance question is USUALLY asking about, in seed priority
 *  order — the retriever scans these first, then widens (mirrors N11's
 *  typeHints-then-widen behavior). */
export const POLICY_SEED_KIND_ORDER: readonly PolicyNodeKind[] = [
  'classification',
  'region',
  'asset',
  'field',
  'policy',
  'principal',
  'grant',
];
