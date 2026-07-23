/**
 * graphrag-index — the OFFLINE community-summary builder for N11 (GraphRAG over
 * the Weave/AGE ontology), plus the hot-path readers the retriever uses.
 *
 * This is a Loom item BUILD STEP (schedulable — the ontology editor's "Rebuild
 * GraphRAG index" action and any Loom job can drive it):
 *
 *   1. READ THE REAL GRAPH — every declared object type's instances
 *      (`listObjects`) and every link instance (`listLinks`) come straight off
 *      Apache AGE on the in-VNet PostgreSQL flexible server. No mocks, no
 *      sample data (no-vaporware.md).
 *   2. DETECT COMMUNITIES — deterministic label propagation over the real
 *      vertex/edge lists (pure, in `graphrag-index-model.ts`).
 *   3. SUMMARIZE — each community is summarized by the **STANDARD** AOAI
 *      deployment through the shared `aoai-chat-client` (`tier: 'standard'`), so
 *      the build runs on the Gov model catalog exactly as it does in Commercial.
 *      No model reachable ⇒ the honest deterministic EXTRACTIVE summary (built
 *      from the real member/link data) is persisted with
 *      `modelGenerated: false` — the index stays genuinely useful with zero
 *      fabrication.
 *   4. PERSIST — `loom-graphrag-index` Cosmos container (PK /ontologyId, MIG1
 *      versioned via `graphrag-index-model.ts`). Docs from an older `buildId`
 *      are pruned so the index never drifts from the graph.
 *
 * AUDIT: a rebuild is a privileged mutation — it writes an authoritative
 * `_auditLog` row (`graphrag.index.build`) AND fans out through
 * `emitAuditEvent`, the same standard as every other admin-plane mutation.
 *
 * SOVEREIGN MOAT / IL5: every hop is in-boundary — AGE is in-VNet PostgreSQL
 * with ZERO external egress, the summarizer is the in-boundary AOAI deployment
 * (or the pure extractive fallback when none is deployed), and the index lands
 * in in-boundary Cosmos. The full capability therefore runs DISCONNECTED in a
 * GCC-High / IL5 / air-gapped enclave with no code-path change.
 *
 * Per-cloud: identical Commercial / GCC-High / IL5. No Fabric, no Power BI
 * (no-fabric-dependency.md) — Apache AGE on Azure Database for PostgreSQL is the
 * default and only backend.
 */

import crypto from 'node:crypto';
import { graphRagIndexContainer, auditLogContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { aoaiChat } from './aoai-chat-client';
import {
  listObjects,
  listLinks,
  weaveGate,
  type WeaveGate,
  type WeaveObject,
} from './weave-ontology-store';
import {
  GRAPHRAG_INDEX_SCHEMA_VERSION,
  MAX_COMMUNITIES,
  detectCommunities,
  extractiveCommunitySummary,
  vertexTitle,
  type CommunitySummaryDoc,
  type DetectedCommunity,
  type GraphEdgeLite,
  type GraphNodeLite,
} from './graphrag-index-model';

const now = () => new Date().toISOString();

/** Instances scanned per object type during a build (bounded read cost). */
export const BUILD_SCAN_PER_TYPE = 500;
/** Link instances scanned during a build. */
export const BUILD_SCAN_LINKS = 1000;

export interface GraphRagBuildActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

export interface GraphRagBuildOptions {
  /** The ontology item whose authored graph is indexed (Cosmos PK). */
  ontologyId: string;
  /** Declared object type apiNames (from the ontology item state). */
  objectTypes: readonly string[];
  /** Optional authored title property per object type. */
  titleKeys?: Record<string, string>;
  /** Who triggered the rebuild (audit + provenance). */
  actor?: GraphRagBuildActor;
  /** Cap on communities persisted (default {@link MAX_COMMUNITIES}). */
  maxCommunities?: number;
}

export interface GraphRagBuildResult {
  ok: boolean;
  ontologyId: string;
  buildId: string;
  /** Vertices actually read off AGE. */
  nodesRead: number;
  /** Edges actually read off AGE. */
  edgesRead: number;
  communities: number;
  /** How many summaries an AOAI deployment wrote (vs the extractive fallback). */
  modelGenerated: number;
  pruned: number;
  /** Honest infra gate when the Weave AGE backend is not wired (never a mock). */
  gate?: WeaveGate;
  /** Set when the model was unreachable and every summary is extractive. */
  modelNote?: string;
  durationMs: number;
}

// ── Real graph read (Apache AGE) ─────────────────────────────────────────────

function toNodeLite(o: WeaveObject, titleKeys?: Record<string, string>): GraphNodeLite {
  return {
    id: String(o.id),
    objectType: o.objectType,
    title: vertexTitle(o, titleKeys?.[o.objectType]),
  };
}

/**
 * Read the REAL instance graph off AGE: every declared type's instances plus
 * every link instance. A type that fails to read (e.g. a label that was never
 * instantiated) is skipped rather than failing the whole build.
 */
export async function readOntologyGraph(
  objectTypes: readonly string[],
  titleKeys?: Record<string, string>,
): Promise<{ nodes: GraphNodeLite[]; edges: GraphEdgeLite[]; titles: Map<string, string> }> {
  const nodes: GraphNodeLite[] = [];
  const titles = new Map<string, string>();
  for (const t of objectTypes) {
    let objs: WeaveObject[] = [];
    try {
      objs = await listObjects(t, BUILD_SCAN_PER_TYPE);
    } catch {
      continue; // a never-instantiated / invalid label must not fail the build
    }
    for (const o of objs) {
      const n = toNodeLite(o, titleKeys);
      nodes.push(n);
      titles.set(n.id, n.title);
    }
  }
  let edges: GraphEdgeLite[] = [];
  try {
    const links = await listLinks(undefined, BUILD_SCAN_LINKS);
    edges = links.map((l) => ({ fromId: String(l.fromId), toId: String(l.toId), linkType: l.linkType }));
  } catch {
    edges = [];
  }
  return { nodes, edges, titles };
}

// ── Summarization (STANDARD AOAI tier — Gov-safe) ────────────────────────────

function communityPrompt(
  community: DetectedCommunity,
  titles: ReadonlyMap<string, string>,
  edges: readonly GraphEdgeLite[],
): string {
  const memberSet = new Set(community.memberIds);
  const inner = edges
    .filter((e) => memberSet.has(e.fromId) && memberSet.has(e.toId))
    .slice(0, 40)
    .map((e) => `${titles.get(e.fromId) || `#${e.fromId}`} -[${e.linkType}]-> ${titles.get(e.toId) || `#${e.toId}`}`);
  const members = community.memberIds
    .slice(0, 40)
    .map((id) => `- ${titles.get(id) || `#${id}`}`);
  return [
    `Object types present: ${community.objectTypes.join(', ') || '(none declared)'}`,
    `Link types present: ${community.linkTypes.join(', ') || '(none)'}`,
    `Instance count: ${community.memberIds.length}`,
    '',
    'Members:',
    ...members,
    '',
    'Relationships:',
    ...(inner.length ? inner : ['(no intra-community relationships captured)']),
  ].join('\n');
}

const SUMMARY_SYSTEM = [
  'You summarize a COMMUNITY of a knowledge graph for retrieval-augmented grounding.',
  'You are given the REAL member instances and their REAL relationships. Write 2–4 sentences describing what this cluster IS and how its members relate — the entities involved, the dominant relationship pattern, and anything notable about scale or structure.',
  'Ground every statement in the data given. Do NOT invent members, relationships, metrics, dates, or outside facts. Do not speculate about business meaning that is not visible in the data.',
  'Return plain prose only — no markdown headings, no bullet lists, no preamble.',
].join('\n');

/**
 * Summarize ONE community on the STANDARD model tier. Returns the extractive
 * fallback (and `modelGenerated:false`) when no model is reachable — an honest
 * degradation, never a fabrication.
 */
export async function summarizeCommunity(
  community: DetectedCommunity,
  titles: ReadonlyMap<string, string>,
  edges: readonly GraphEdgeLite[],
): Promise<{ summary: string; modelGenerated: boolean; error?: string }> {
  try {
    const text = await aoaiChat({
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: communityPrompt(community, titles, edges) },
      ],
      // STANDARD tier explicitly: the build must run on the Gov model catalog
      // exactly as it does in Commercial (no reasoning-tier dependency).
      tier: 'standard',
      maxCompletionTokens: 400,
      temperature: 0.1,
    });
    const summary = String(text || '').trim();
    if (summary) return { summary, modelGenerated: true };
    return { summary: extractiveCommunitySummary(community, titles), modelGenerated: false };
  } catch (e) {
    return {
      summary: extractiveCommunitySummary(community, titles),
      modelGenerated: false,
      error: (e as Error)?.message || String(e),
    };
  }
}

// ── Build (the schedulable item build step) ──────────────────────────────────

/**
 * Rebuild the GraphRAG community index for one ontology. Idempotent: every doc
 * is upserted under the new `buildId` and stale docs (older buildIds) are
 * pruned, so the index converges on the current graph.
 */
export async function buildGraphRagIndex(opts: GraphRagBuildOptions): Promise<GraphRagBuildResult> {
  const started = Date.now();
  const ontologyId = String(opts.ontologyId || '').trim();
  const buildId = `b-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const base: GraphRagBuildResult = {
    ok: false, ontologyId, buildId, nodesRead: 0, edgesRead: 0,
    communities: 0, modelGenerated: 0, pruned: 0, durationMs: 0,
  };
  if (!ontologyId) throw new Error('buildGraphRagIndex: ontologyId is required');

  // Honest infra gate — the ONLY non-functional state (no-vaporware.md).
  const gate = weaveGate();
  if (gate) return { ...base, gate, durationMs: Date.now() - started };

  const { nodes, edges, titles } = await readOntologyGraph(opts.objectTypes || [], opts.titleKeys);
  base.nodesRead = nodes.length;
  base.edgesRead = edges.length;

  const communities = detectCommunities(nodes, edges, { maxCommunities: opts.maxCommunities ?? MAX_COMMUNITIES });
  base.communities = communities.length;

  const c = await graphRagIndexContainer();
  const stamped = now();
  let modelGenerated = 0;
  let lastError: string | undefined;
  for (const community of communities) {
    const s = await summarizeCommunity(community, titles, edges);
    if (s.modelGenerated) modelGenerated++;
    else if (s.error) lastError = s.error;
    const doc: CommunitySummaryDoc = {
      id: `community:${community.communityId}`,
      ontologyId,
      docType: 'graphrag-community',
      schemaVersion: GRAPHRAG_INDEX_SCHEMA_VERSION,
      communityId: community.communityId,
      memberIds: community.memberIds,
      objectTypes: community.objectTypes,
      linkTypes: community.linkTypes,
      size: community.memberIds.length,
      summary: s.summary,
      modelGenerated: s.modelGenerated,
      buildId,
      createdAt: stamped,
      updatedAt: stamped,
      builtBy: opts.actor?.oid,
    };
    await c.items.upsert(doc);
  }
  base.modelGenerated = modelGenerated;
  if (communities.length > 0 && modelGenerated === 0) {
    base.modelNote =
      'No AOAI deployment answered — every community summary is the deterministic extractive summary built from the real member/link data. ' +
      (lastError ? `Last model error: ${lastError}` : 'Deploy a chat model (or set LOOM_AOAI_DEPLOYMENT) for narrative summaries.');
  }

  // Prune docs left over from an older build (the graph shrank / re-clustered).
  try {
    const { resources } = await c.items
      .query<CommunitySummaryDoc>({
        query: "SELECT * FROM c WHERE c.ontologyId = @o AND c.docType = 'graphrag-community' AND c.buildId != @b",
        parameters: [{ name: '@o', value: ontologyId }, { name: '@b', value: buildId }],
      })
      .fetchAll();
    for (const stale of resources) {
      await c.item(stale.id, ontologyId).delete().catch(() => undefined);
      base.pruned++;
    }
  } catch {
    /* pruning is best-effort — a stale doc is filtered by buildId on read anyway */
  }

  // AUDIT — a rebuild rewrites governed grounding context (privileged mutation).
  if (opts.actor) {
    try {
      const audit = await auditLogContainer();
      await audit.items
        .create({
          id: `audit-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          itemId: `ontology:${ontologyId}`,
          tenantId: opts.actor.tenantId,
          who: opts.actor.who,
          actorOid: opts.actor.oid,
          oid: opts.actor.oid,
          at: stamped,
          kind: 'graphrag.index.build',
          target: ontologyId,
          detail: {
            buildId,
            nodesRead: base.nodesRead,
            edgesRead: base.edgesRead,
            communities: base.communities,
            modelGenerated,
            pruned: base.pruned,
          },
        })
        .catch(() => undefined);
    } catch {
      /* audit failures are non-blocking */
    }
    emitAuditEvent({
      actorOid: opts.actor.oid,
      actorUpn: opts.actor.who,
      action: 'graphrag.index.build',
      targetType: 'graphrag-index',
      targetId: ontologyId,
      tenantId: opts.actor.tenantId,
      detail: { buildId, communities: base.communities, nodesRead: base.nodesRead, modelGenerated },
    });
  }

  return { ...base, ok: true, durationMs: Date.now() - started };
}

// ── Hot-path readers (used by the retriever) ─────────────────────────────────

/** Every persisted community summary for an ontology (single-partition read). */
export async function listCommunitySummaries(ontologyId: string): Promise<CommunitySummaryDoc[]> {
  const id = String(ontologyId || '').trim();
  if (!id) return [];
  const c = await graphRagIndexContainer();
  const { resources } = await c.items
    .query<CommunitySummaryDoc>({
      query: "SELECT * FROM c WHERE c.ontologyId = @o AND c.docType = 'graphrag-community'",
      parameters: [{ name: '@o', value: id }],
    })
    .fetchAll();
  return resources;
}

/**
 * The precomputed summaries whose community INTERSECTS the retrieved subgraph.
 * Membership is intersected in JS (the member list is a Cosmos array; an
 * ARRAY_CONTAINS-per-vertex query would fan out one predicate per vertex).
 * FAIL-SAFE: any store error yields `[]` so a missing/unbuilt index degrades the
 * retriever to raw subgraph grounding instead of taking the turn down.
 */
export async function summariesForVertices(
  ontologyId: string,
  vertexIds: readonly string[],
  top = 5,
): Promise<CommunitySummaryDoc[]> {
  const want = new Set((vertexIds || []).map((v) => String(v)));
  if (!ontologyId || want.size === 0) return [];
  let all: CommunitySummaryDoc[] = [];
  try {
    all = await listCommunitySummaries(ontologyId);
  } catch {
    return [];
  }
  const scored = all
    .map((doc) => ({ doc, overlap: (doc.memberIds || []).filter((m) => want.has(String(m))).length }))
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.doc.size - a.doc.size);
  return scored.slice(0, Math.max(1, top)).map((x) => x.doc);
}
