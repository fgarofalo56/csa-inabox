/**
 * loom-graphrag-index — persisted community-summary doc shape, the PURE
 * community-detection layer, and the MIG1 migrator registration for N11.
 *
 * N11 (GraphRAG over Weave/AGE) retrieves over the AUTHORED ontology: seed
 * entities → multi-hop traversal → subgraph → **precomputed community
 * summaries**. The summaries are built OFFLINE (a schedulable Loom item build
 * step, `graphrag-index.ts`) and read on the hot path by the retriever
 * (`ontology-graphrag.ts`). This module is the leaf both sides share:
 *
 *   • {@link CommunitySummaryDoc} — the persisted shape (PK /ontologyId, so
 *     "every community of this ontology" is a single-partition read);
 *   • {@link detectCommunities} — deterministic label-propagation community
 *     detection over the real vertex/edge lists read from Apache AGE. Pure:
 *     no Azure, no Cosmos, fully unit-testable;
 *   • {@link registerGraphRagIndexMigrators} — the MIG1 registration point,
 *     called at module scope so the chain is live before any read materializes.
 *
 * LEAF RULE: imports ONLY `cosmos-migrations` (no cosmos-client, no weave
 * store) so cosmos-client can import it at module scope without a cycle —
 * exactly the semantic-contract-model / answer-receipts-model precedent.
 *
 * CURRENT SCHEMA VERSION: 1 (every doc stamped `schemaVersion: 1` at write).
 * A future breaking shape change bumps GRAPHRAG_INDEX_SCHEMA_VERSION to N+1 and
 * registers its `fromVersion: N` migrator below. Per MIG1 there is deliberately
 * NO v1 migrator today — registering an inert one would claim the
 * one-owner-per-step v1 slot the first REAL migration needs.
 *
 * SOVEREIGN MOAT / IL5: the graph this index summarizes lives in Apache AGE on
 * an in-VNet Azure Database for PostgreSQL flexible server — ZERO external
 * egress. The summaries are written by the in-boundary AOAI deployment and
 * stored in in-boundary Cosmos. Community detection here is pure arithmetic.
 * The whole capability therefore runs DISCONNECTED in a GCC-High / IL5 /
 * air-gapped enclave with no code path change — that is the moat headline.
 */

import { registerMigrator, type DocMigrator } from './cosmos-migrations';

export const GRAPHRAG_INDEX_CONTAINER = 'loom-graphrag-index';
export const GRAPHRAG_INDEX_SCHEMA_VERSION = 1;

/** Hard ceiling on communities persisted per ontology (bounded index cost). */
export const MAX_COMMUNITIES = 64;
/** Label-propagation sweeps before we accept the current labelling. */
export const LABEL_PROPAGATION_SWEEPS = 8;

/** A vertex as the index/retriever sees it (parsed from an AGE agtype vertex). */
export interface GraphNodeLite {
  /** Numeric AGE vertex id, as a string. */
  id: string;
  /** AGE label == the ontology object type apiName. */
  objectType: string;
  /** Human title (titleKey property, else a best-effort name-ish property). */
  title: string;
}

/** An edge as the index/retriever sees it (parsed from an AGE agtype edge). */
export interface GraphEdgeLite {
  fromId: string;
  toId: string;
  /** AGE edge label == the ontology link type apiName. */
  linkType: string;
}

/** One detected community of the ontology instance graph. */
export interface DetectedCommunity {
  /** Stable, deterministic id — `c:<smallest member id>`. */
  communityId: string;
  /** Member vertex ids, ascending numerically. */
  memberIds: string[];
  /** Distinct object types present, ascending. */
  objectTypes: string[];
  /** Distinct link types wholly inside the community, ascending. */
  linkTypes: string[];
}

/** The persisted, precomputed summary of one community. */
export interface CommunitySummaryDoc {
  /** Cosmos id — `community:<communityId>`. */
  id: string;
  /** PK — the ontology item id this community belongs to. */
  ontologyId: string;
  docType: 'graphrag-community';
  schemaVersion: number;
  /** Deterministic community id (see {@link DetectedCommunity}). */
  communityId: string;
  /** Member vertex ids (the retriever intersects these with its subgraph). */
  memberIds: string[];
  objectTypes: string[];
  linkTypes: string[];
  /** Instance count (== memberIds.length at build time). */
  size: number;
  /** The natural-language summary the retriever attaches as grounded context. */
  summary: string;
  /**
   * TRUE when an AOAI deployment wrote the summary; FALSE when the honest
   * deterministic extractive fallback did (no model deployed / model error).
   * Never a mock — the fallback is composed from the REAL member/link data.
   */
  modelGenerated: boolean;
  /** Deployment that wrote it, when modelGenerated. */
  model?: string;
  /** Build correlation id — docs from an older build are pruned. */
  buildId: string;
  createdAt: string;
  updatedAt: string;
  /** Who triggered the build (Entra oid), for the audit trail. */
  builtBy?: string;
}

/** Property names we fall back to for a human title, in priority order. */
const TITLE_FALLBACK_KEYS = [
  'title', 'name', 'displayName', 'display_name', 'label', 'fullName', 'full_name',
  'companyName', 'customerName', 'productName', 'email', 'id', 'key', 'code',
];

/**
 * Resolve a human title for an AGE vertex: the object type's authored
 * `titleKey` property when present, else the first non-empty value among the
 * conventional name-ish keys, else `<ObjectType>#<id>`. Pure.
 */
export function vertexTitle(
  v: { id: string; objectType: string; properties?: Record<string, unknown> },
  titleKey?: string,
): string {
  const props = v.properties || {};
  const take = (k: string): string => {
    const raw = props[k];
    return raw == null ? '' : String(raw).trim();
  };
  if (titleKey) {
    const t = take(titleKey);
    if (t) return t;
  }
  for (const k of TITLE_FALLBACK_KEYS) {
    const t = take(k);
    if (t) return t;
  }
  return `${v.objectType || 'Object'}#${v.id}`;
}

// ── Pure community detection (no Azure — fully unit-testable) ────────────────

function numericAsc(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic label-propagation community detection over the real instance
 * graph. Every node starts in its own community; each sweep a node adopts the
 * most common label among its neighbours (ties broken by the numerically
 * smallest label, so the result is order-independent and reproducible across
 * replicas). Converges in a handful of sweeps at ontology scale.
 *
 * Why label propagation and not Leiden: this runs INSIDE the console process
 * against ontology-scale instance sets (thousands, not billions) with no extra
 * dependency and no external service — which is what keeps the whole capability
 * air-gap-safe. The output shape (communities of member ids) is the same
 * contract a Leiden pass would produce, so the summarizer/retriever are
 * unchanged if the algorithm is ever upgraded.
 *
 * Isolated nodes (no edges) are dropped: a single-instance "community" has no
 * relational story to summarize, and the retriever already carries the seed
 * instance itself.
 */
export function detectCommunities(
  nodes: readonly GraphNodeLite[],
  edges: readonly GraphEdgeLite[],
  opts: { maxCommunities?: number; sweeps?: number } = {},
): DetectedCommunity[] {
  const maxCommunities = Math.max(1, opts.maxCommunities ?? MAX_COMMUNITIES);
  const sweeps = Math.max(1, opts.sweeps ?? LABEL_PROPAGATION_SWEEPS);

  const known = new Map<string, GraphNodeLite>();
  for (const n of nodes) if (n && n.id) known.set(String(n.id), n);

  // Adjacency over edges whose BOTH endpoints are known vertices.
  const adj = new Map<string, Set<string>>();
  const edgeTypes = new Map<string, string[]>(); // `${a}|${b}` (sorted) → linkTypes
  for (const e of edges) {
    if (!e) continue;
    const a = String(e.fromId ?? '');
    const b = String(e.toId ?? '');
    if (!a || !b || a === b) continue;
    if (!known.has(a) || !known.has(b)) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
    const key = numericAsc(a, b) <= 0 ? `${a}|${b}` : `${b}|${a}`;
    const lt = String(e.linkType || '').trim();
    if (lt) {
      const cur = edgeTypes.get(key) || [];
      if (!cur.includes(lt)) cur.push(lt);
      edgeTypes.set(key, cur);
    }
  }

  const members = [...adj.keys()].sort(numericAsc);
  if (members.length === 0) return [];

  const label = new Map<string, string>();
  for (const id of members) label.set(id, id);

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let changed = false;
    for (const id of members) {
      const counts = new Map<string, number>();
      for (const nb of adj.get(id) || []) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) || 0) + 1);
      }
      if (counts.size === 0) continue;
      let bestLabel = label.get(id)!;
      let bestCount = -1;
      for (const [l, c] of [...counts.entries()].sort((x, y) => numericAsc(x[0], y[0]))) {
        if (c > bestCount) {
          bestCount = c;
          bestLabel = l;
        }
      }
      // Only move when the neighbourhood majority beats staying put.
      const ownCount = counts.get(label.get(id)!) || 0;
      if (bestCount > ownCount && bestLabel !== label.get(id)) {
        label.set(id, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byLabel = new Map<string, string[]>();
  for (const id of members) {
    const l = label.get(id)!;
    const arr = byLabel.get(l) || [];
    arr.push(id);
    byLabel.set(l, arr);
  }

  const out: DetectedCommunity[] = [];
  for (const [, ids] of byLabel) {
    const memberIds = [...ids].sort(numericAsc);
    if (memberIds.length < 2) continue; // no relational story to summarize
    const memberSet = new Set(memberIds);
    const objectTypes = Array.from(
      new Set(memberIds.map((id) => known.get(id)!.objectType).filter(Boolean)),
    ).sort();
    const linkTypes = new Set<string>();
    for (const [key, lts] of edgeTypes) {
      const [a, b] = key.split('|');
      if (memberSet.has(a) && memberSet.has(b)) for (const lt of lts) linkTypes.add(lt);
    }
    out.push({
      communityId: `c:${memberIds[0]}`,
      memberIds,
      objectTypes,
      linkTypes: [...linkTypes].sort(),
    });
  }

  // Largest communities first (they carry the most grounding value), capped.
  out.sort((a, b) => b.memberIds.length - a.memberIds.length || numericAsc(a.communityId, b.communityId));
  return out.slice(0, maxCommunities);
}

/**
 * The deterministic, EXTRACTIVE fallback summary — composed entirely from the
 * REAL member/link data (never a mock, never invented). Used when no AOAI
 * deployment is reachable so the index is still genuinely useful (and the
 * capability stays functional in a disconnected enclave with no model
 * deployed). `modelGenerated:false` records the honest provenance.
 */
export function extractiveCommunitySummary(
  community: DetectedCommunity,
  titles: ReadonlyMap<string, string>,
): string {
  const sample = community.memberIds
    .slice(0, 8)
    .map((id) => titles.get(id) || `#${id}`)
    .filter(Boolean);
  const parts: string[] = [];
  parts.push(
    `A connected cluster of ${community.memberIds.length} instance${community.memberIds.length === 1 ? '' : 's'}` +
      (community.objectTypes.length ? ` spanning ${community.objectTypes.join(', ')}` : '') +
      '.',
  );
  if (community.linkTypes.length) {
    parts.push(`Related through ${community.linkTypes.join(', ')}.`);
  }
  if (sample.length) {
    parts.push(
      `Members include ${sample.join('; ')}${community.memberIds.length > sample.length ? ', …' : ''}.`,
    );
  }
  return parts.join(' ');
}

// ── MIG1 registration ────────────────────────────────────────────────────────

/**
 * MIG1 registration point for this container's migrator chain. v1 is current —
 * the chain is empty. The FIRST breaking change adds:
 *
 *   const v1toV2: DocMigrator = (doc) => ({ ...doc, …, schemaVersion: 2 });
 *   registerMigrator(GRAPHRAG_INDEX_CONTAINER, 1, v1toV2);
 *
 * plus the optional backfill script
 * `scripts/csa-loom/cosmos-backfill-loom-graphrag-index.mjs`.
 */
export function registerGraphRagIndexMigrators(): void {
  // v1 → (none yet). Keeping the registerMigrator reference live reserves the
  // wiring for the first real migration without claiming the one-owner-per-step
  // v1 slot with an inert migrator (the MIG1 convention).
  const register: (containerId: string, fromVersion: number, migrate: DocMigrator) => void = registerMigrator;
  void register;
}

registerGraphRagIndexMigrators();
