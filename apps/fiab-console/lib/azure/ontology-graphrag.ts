/**
 * ontology-graphrag — N11: the GraphRAG RETRIEVER over the authored Weave
 * ontology (Apache AGE on Azure Database for PostgreSQL flexible server).
 *
 * THE HEADLINE. A data agent's PLAN→EXECUTE→VERIFY loop no longer grounds only
 * on tables — it retrieves over the ontology the customer AUTHORED:
 *
 *   1. SEED ENTITY EXTRACTION — the question's content tokens are matched
 *      against the declared object types AND against the REAL instances read
 *      off AGE. Every property predicate is applied in **JS post-fetch**, never
 *      pushed into Cypher (AGE GOTCHA, live receipt 2026-07-19: AGE's
 *      openCypher lacks the map/list machinery a generic property predicate
 *      needs — `keys(properties(n))`, dynamic `properties(n)[k]`, `any(...)` —
 *      and a server-side predicate built on them silently matches NOTHING).
 *      Only `id(n) = <literal>` / label predicates go into Cypher; those are
 *      the forms already proven live by `weave-explore.traverseObject`.
 *   2. MULTI-HOP TRAVERSAL — a bounded breadth-first expansion assembles one
 *      Cypher statement per hop over the whole frontier, so a 2-hop retrieval
 *      is 2 round-trips (not N). Real edges, real labels, real ids.
 *   3. SUBGRAPH + PRECOMPUTED COMMUNITY SUMMARIES — the touched vertices are
 *      intersected with the offline GraphRAG index (`graphrag-index.ts`) so the
 *      agent sees the cluster-level story, not just the local edges.
 *   4. GROUNDED CONTEXT + GRAPH-PATH CITATIONS — a typed
 *      {@link GraphPathCitation} per discovered path, flowing into N10's
 *      AnswerReceipt so an auditor sees the exact traversal that grounded the
 *      answer.
 *
 * FLAG0: the whole path is behind the DEFAULT-ON runtime flag
 * {@link GRAPHRAG_FLAG_ID} (`n11-graphrag-grounding`) — a seconds-fast revert to
 * the pre-N11 grounding with no revision roll.
 *
 * Honest gate (no-vaporware.md): when the Weave AGE backend is not wired the
 * retriever returns `{ ok:false, gate }` naming the exact env var + bicep module
 * — the agent turn still runs, just without graph grounding. NEVER a mock.
 *
 * SOVEREIGN MOAT / IL5: AGE is in-VNet PostgreSQL with **zero external egress**
 * — the entire retrieval (seed match, traversal, community summaries) executes
 * inside the boundary. The full capability runs DISCONNECTED in a GCC-High /
 * IL5 / air-gapped enclave with no code-path change. That is the moat headline:
 * a graph-grounded, receipt-backed analytical agent that needs no internet.
 *
 * Per-cloud: identical Commercial / GCC-High / IL5. No Fabric, no Power BI, no
 * Cosmos Gremlin dependency (no-fabric-dependency.md).
 */

import { runCypher, weaveGate, parseAgtype, type WeaveGate, type WeaveObject } from './weave-ontology-store';
import { searchObjects } from './weave-explore';
import { summariesForVertices } from './graphrag-index';
import { vertexTitle, type GraphNodeLite } from './graphrag-index-model';
import { normalizeTokens } from './semantic-contract-model';

/** FLAG0 runtime kill-switch id for the whole N11 grounding path (default ON). */
export const GRAPHRAG_FLAG_ID = 'n11-graphrag-grounding';

/** Traversal depth default (code default — NOT a required env var). */
export const GRAPHRAG_DEFAULT_MAX_HOPS = 2;
/** Instances scanned per candidate object type when matching seeds. */
export const SEED_SCAN_CAP = 300;
/** Neighbours fetched per hop across the whole frontier. */
export const HOP_FETCH_CAP = 200;
/** Seed entities carried into traversal. */
export const MAX_SEEDS = 4;
/** Graph-path citations returned (and rendered in the receipt). */
export const MAX_PATH_CITATIONS = 12;

/**
 * Traversal depth. Optional tuning knob `LOOM_GRAPHRAG_MAX_HOPS` (G2-registered
 * as an optionalDefault gate) — UNSET is the fully-functional default.
 */
export function graphRagMaxHops(): number {
  // NOTE: `Number('')` is 0, not NaN — an UNSET var must fall through to the
  // code default, never clamp to a 1-hop traversal.
  const raw = (process.env.LOOM_GRAPHRAG_MAX_HOPS || '').trim();
  const n = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return GRAPHRAG_DEFAULT_MAX_HOPS;
  return Math.min(Math.max(Math.trunc(n), 1), 4);
}

// ── Types ────────────────────────────────────────────────────────────────────

/** One seed entity the question resolved to, on the REAL graph. */
export interface GraphSeed {
  /** Numeric AGE vertex id. */
  id: string;
  objectType: string;
  title: string;
  /** The question token(s) that matched, for the citation/receipt. */
  matchedOn: string[];
  /** Match score in [0,1] (JS-side; see {@link scoreSeedObject}). */
  score: number;
}

export interface GraphPathNode {
  id: string;
  objectType: string;
  title: string;
}

/** A typed graph-path citation — the audit artifact for graph grounding. */
export interface GraphPathCitation {
  /** Stable id `<seedId>-><endId>` (unique per retrieval). */
  id: string;
  /** Number of edges traversed (>= 1). */
  hops: number;
  /** Ordered nodes, seed first. */
  nodes: GraphPathNode[];
  /** Ordered link types, one per hop. */
  links: string[];
  /** Human-readable path, e.g. `Acme (Customer) —[PLACED]→ SO-9 (Order)`. */
  text: string;
  /** The precomputed community the terminal node belongs to, when indexed. */
  communityId?: string;
}

/** A precomputed community summary attached to the retrieved subgraph. */
export interface GraphCommunityContext {
  communityId: string;
  summary: string;
  size: number;
  objectTypes: string[];
  /** How many of the retrieved vertices fall inside this community. */
  overlap: number;
  /** FALSE when the summary is the deterministic extractive fallback. */
  modelGenerated: boolean;
}

/** The assembled grounded context handed to the reasoning loop. */
export interface GraphRagContext {
  ok: boolean;
  /** Honest infra gate (Weave AGE not wired) — the ONLY non-functional state. */
  gate?: WeaveGate;
  ontologyId?: string;
  seeds: GraphSeed[];
  paths: GraphPathCitation[];
  communities: GraphCommunityContext[];
  /** Distinct vertices touched by the traversal (seeds included). */
  vertexIds: string[];
  hops: number;
  /** Instances scanned across candidate types while matching seeds. */
  scanned: number;
  /** The grounding block to layer onto the agent instructions ('' when empty). */
  contextText: string;
  /** Real elapsed ms of the retrieval (AGE round-trips + index read). */
  durationMs: number;
  /** Set when nothing matched — an honest "no graph grounding" note. */
  note?: string;
}

export interface RetrieveGraphContextOptions {
  question: string;
  /** Declared object type apiNames from the ontology item state. */
  objectTypes: readonly string[];
  /** Optional authored title property per object type. */
  titleKeys?: Record<string, string>;
  /** Ontology item id — enables the precomputed community-summary join. */
  ontologyId?: string;
  /** Traversal depth override (tests / callers); defaults to {@link graphRagMaxHops}. */
  maxHops?: number;
  /** Seed cap override. */
  maxSeeds?: number;
}

// ── Seed extraction (pure) ───────────────────────────────────────────────────

/** Singular/plural-tolerant normalization of an identifier-ish token. */
function stem(t: string): string {
  const s = t.toLowerCase();
  if (s.length > 4 && s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.length > 3 && s.endsWith('es')) return s.slice(0, -2);
  if (s.length > 3 && s.endsWith('s')) return s.slice(0, -1);
  return s;
}

/** Split an apiName like `PurchaseOrder` / `purchase_order` into its words. */
function identWords(name: string): string[] {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export interface SeedTerms {
  /** Declared object types the question named (traversal starts here first). */
  typeHints: string[];
  /** Content tokens used for the JS-side instance predicate. */
  terms: string[];
  /** Quoted phrases in the question — high-signal literal entity names. */
  phrases: string[];
}

/**
 * Extract seed candidates from the question: which DECLARED object types it
 * names, the content tokens to match instance properties against, and any
 * quoted literal phrases. Pure — no AGE, no Cosmos.
 */
export function extractSeedTerms(question: string, objectTypes: readonly string[]): SeedTerms {
  const q = String(question || '');
  const tokens = normalizeTokens(q);
  const stems = new Set(tokens.map(stem));

  const typeHints: string[] = [];
  for (const t of objectTypes || []) {
    const words = identWords(t);
    if (words.length === 0) continue;
    const hit = words.every((w) => stems.has(stem(w)));
    if (hit) typeHints.push(t);
  }

  const phrases: string[] = [];
  for (const m of q.matchAll(/"([^"]{2,60})"|'([^']{2,60})'/g)) {
    const p = (m[1] || m[2] || '').trim();
    if (p) phrases.push(p);
  }

  // Drop tokens that ONLY exist because they named an object type — they are
  // schema words, not entity names, and would match every instance.
  const typeWords = new Set(typeHints.flatMap(identWords).map(stem));
  const terms = tokens.filter((t) => t.length >= 3 && !typeWords.has(stem(t)));

  return { typeHints, terms, phrases: Array.from(new Set(phrases)) };
}

/**
 * Score ONE real instance against the seed terms — the JS-SIDE PREDICATE
 * FILTER. This is deliberately NOT a Cypher `WHERE`: AGE silently returns zero
 * rows for generic property predicates (the 2026-07-19 live gotcha), so the
 * predicate lives here, over rows AGE actually returned.
 *
 * A quoted phrase found in any string property is decisive (1). Otherwise the
 * score is the fraction of seed terms present across the instance's string
 * property values. Internal (`_`-prefixed) properties are ignored. Pure.
 */
export function scoreSeedObject(
  obj: Pick<WeaveObject, 'properties'>,
  terms: readonly string[],
  phrases: readonly string[] = [],
): { score: number; matchedOn: string[] } {
  const values: string[] = [];
  for (const [k, v] of Object.entries(obj.properties || {})) {
    if (k.startsWith('_')) continue;
    if (v == null) continue;
    values.push(String(v).toLowerCase());
  }
  if (values.length === 0) return { score: 0, matchedOn: [] };
  const hay = values.join('  ');

  const matchedPhrases = phrases.filter((p) => p && hay.includes(p.toLowerCase()));
  if (matchedPhrases.length) return { score: 1, matchedOn: matchedPhrases };

  const matched = (terms || []).filter((t) => t && hay.includes(t.toLowerCase()));
  if (matched.length === 0) return { score: 0, matchedOn: [] };
  return { score: Math.min(1, matched.length / Math.max(1, terms.length)), matchedOn: matched };
}

/**
 * Rank real instances into seeds using {@link scoreSeedObject}. Pure — the
 * caller supplies instances already read off AGE.
 */
export function filterSeedObjects(
  objects: readonly WeaveObject[],
  terms: readonly string[],
  phrases: readonly string[],
  titleKeys: Record<string, string> | undefined,
  top: number,
): GraphSeed[] {
  const scored: GraphSeed[] = [];
  for (const o of objects) {
    if (!o || !o.id) continue;
    const { score, matchedOn } = scoreSeedObject(o, terms, phrases);
    if (score <= 0) continue;
    scored.push({
      id: String(o.id),
      objectType: o.objectType,
      title: vertexTitle(o, titleKeys?.[o.objectType]),
      matchedOn,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, Math.max(1, top));
}

// ── Multi-hop Cypher assembly (pure) ─────────────────────────────────────────

/**
 * Assemble the one-hop expansion statement for a whole frontier.
 *
 * Only `id(a) = <numeric literal>` disjunctions and `type(r)` / `label(b)`
 * projections appear — the exact forms `weave-explore.traverseObject` proves
 * live on AGE. We deliberately do NOT use `IN [...]`, variable-length
 * `-[*1..n]-`, or any property predicate: those either silently match nothing
 * or return path agtypes AGE renders inconsistently. Depth comes from calling
 * this once per hop; PREDICATES ARE APPLIED IN JS.
 *
 * Ids are validated as digits by the caller and re-validated here — the last
 * line of defence against Cypher injection through a vertex id.
 */
export function assembleHopCypher(vertexIds: readonly string[], limit: number): string {
  const ids = Array.from(new Set((vertexIds || []).map((v) => String(v).trim()))).filter((v) => /^\d+$/.test(v));
  if (ids.length === 0) return '';
  const cap = Math.min(Math.max(Math.trunc(limit) || HOP_FETCH_CAP, 1), 1000);
  const where = ids.map((v) => `id(a) = ${v}`).join(' OR ');
  return (
    `MATCH (a)-[r]-(b) WHERE ${where} ` +
    'RETURN id(a) AS aid, type(r) AS lt, startNode(r) = a AS isOut, id(b) AS bid, label(b) AS blabel, b ' +
    `LIMIT ${cap}`
  );
}

/** The agtype column projection {@link assembleHopCypher} returns. */
export const HOP_COLUMNS = [
  { name: 'aid', type: 'agtype' },
  { name: 'lt', type: 'agtype' },
  { name: 'isOut', type: 'agtype' },
  { name: 'bid', type: 'agtype' },
  { name: 'blabel', type: 'agtype' },
  { name: 'b', type: 'agtype' },
] as const;

/** Strip agtype quoting from a scalar cell. */
function agScalar(cell: unknown): string {
  const v = parseAgtype(cell);
  return v == null ? '' : String(v);
}

/** One parsed neighbour row from a hop expansion. */
export interface HopEdge {
  fromId: string;
  toId: string;
  linkType: string;
  direction: 'out' | 'in';
  neighbor: GraphNodeLite;
}

/** Parse the raw agtype rows of a hop expansion into typed edges. Pure. */
export function parseHopRows(
  rows: readonly unknown[][],
  titleKeys?: Record<string, string>,
): HopEdge[] {
  const out: HopEdge[] = [];
  for (const row of rows || []) {
    const [aid, lt, isOut, bid, blabel, b] = row;
    const fromId = agScalar(aid);
    const toId = agScalar(bid);
    if (!fromId || !toId) continue;
    const v = parseAgtype(b) as { id?: unknown; label?: string; properties?: Record<string, unknown> } | null;
    const objectType = String((v && v.label) || agScalar(blabel) || '');
    const neighbor: GraphNodeLite = {
      id: toId,
      objectType,
      title: vertexTitle(
        { id: toId, objectType, properties: (v && (v.properties as Record<string, unknown>)) || {} },
        titleKeys?.[objectType],
      ),
    };
    out.push({
      fromId,
      toId,
      linkType: String(agScalar(lt) || ''),
      direction: agScalar(isOut) === 'true' ? 'out' : 'in',
      neighbor,
    });
  }
  return out;
}

/** Render a path's human text, e.g. `Acme (Customer) —[PLACED]→ SO-9 (Order)`. */
export function renderPathText(nodes: readonly GraphPathNode[], links: readonly string[], dirs: readonly ('out' | 'in')[]): string {
  if (nodes.length === 0) return '';
  let s = `${nodes[0].title} (${nodes[0].objectType})`;
  for (let i = 1; i < nodes.length; i++) {
    const lt = links[i - 1] || 'RELATED';
    const arrow = dirs[i - 1] === 'in' ? `←[${lt}]—` : `—[${lt}]→`;
    s += ` ${arrow} ${nodes[i].title} (${nodes[i].objectType})`;
  }
  return s;
}

/**
 * Heuristic: does this question need relational (multi-hop) grounding? Used by
 * the reasoning loop to decide whether graph retrieval is worth a round-trip.
 * Pure — deliberately generous (a false positive costs one bounded AGE read).
 */
export function isMultiHopQuestion(question: string): boolean {
  const q = String(question || '').toLowerCase();
  if (!q.trim()) return false;
  return /\b(related|relationship|connect|connected|linked|link|through|via|between|downstream|upstream|impact|affect|depends?|dependency|chain|path|network|who else|which other|associated|belongs? to|owns?|owned by|supplier|customer of|traverse|hop)\b/.test(q);
}

// ── Retrieval (REAL AGE reads) ───────────────────────────────────────────────

/**
 * Retrieve grounded graph context for a question over the authored ontology.
 * Every read is a real Apache AGE round-trip; every property predicate runs in
 * JS post-fetch. Never throws for an unreachable backend — the honest gate (or
 * an empty, noted context) is returned so the agent turn survives.
 */
export async function retrieveGraphContext(opts: RetrieveGraphContextOptions): Promise<GraphRagContext> {
  const started = Date.now();
  const maxHops = Math.min(Math.max(Math.trunc(opts.maxHops ?? graphRagMaxHops()), 1), 4);
  const maxSeeds = Math.max(1, Math.trunc(opts.maxSeeds ?? MAX_SEEDS));
  const empty = (extra: Partial<GraphRagContext>): GraphRagContext => ({
    ok: false, seeds: [], paths: [], communities: [], vertexIds: [], hops: maxHops,
    scanned: 0, contextText: '', durationMs: Date.now() - started,
    ontologyId: opts.ontologyId, ...extra,
  });

  const gate = weaveGate();
  if (gate) return empty({ gate });

  const declared = Array.from(new Set((opts.objectTypes || []).map((t) => String(t).trim()).filter(Boolean)));
  if (declared.length === 0) {
    return empty({ note: 'This agent has no declared ontology object types — graph grounding was skipped.' });
  }

  const { typeHints, terms, phrases } = extractSeedTerms(opts.question, declared);
  if (terms.length === 0 && phrases.length === 0) {
    return empty({ note: 'The question named no entity terms to seed a graph traversal.' });
  }

  // ── 1. SEED ENTITIES — one real AGE read per candidate type, JS-filtered ──
  // Types the question NAMED are scanned first; otherwise every declared type
  // (bounded) so an entity named without its type still resolves.
  const rest = declared.filter((t) => !typeHints.includes(t));
  const seedPool: GraphSeed[] = [];
  const scannedTypes: string[] = [];
  let scanned = 0;
  const scanTypes = async (types: readonly string[]) => {
    for (const type of types) {
      let objs: WeaveObject[] = [];
      try {
        // q='' → a plain `MATCH (n:Label) RETURN n LIMIT n` read. The predicate
        // is applied below, in JS (AGE GOTCHA).
        objs = await searchObjects(type, '', SEED_SCAN_CAP);
      } catch {
        continue; // a never-instantiated label must not fail the retrieval
      }
      scannedTypes.push(type);
      scanned += objs.length;
      seedPool.push(...filterSeedObjects(objs, terms, phrases, opts.titleKeys, maxSeeds));
    }
  };
  // Types the question NAMED are scanned first; when none of them yields a seed
  // we widen to the remaining declared types, so an entity named WITHOUT its
  // type ("how is Contoso connected to …") still resolves.
  await scanTypes(typeHints.slice(0, 8));
  if (seedPool.length === 0) await scanTypes(rest.slice(0, 8));
  seedPool.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const seeds = seedPool.slice(0, maxSeeds);
  if (seeds.length === 0) {
    return empty({
      scanned,
      note: `No instance of ${(scannedTypes.length ? scannedTypes : declared).join(', ')} matched the question's entity terms (${scanned} instance(s) scanned).`,
    });
  }

  // ── 2. MULTI-HOP TRAVERSAL — one assembled statement per hop ──────────────
  interface Visit { node: GraphPathNode; depth: number; parent?: string; linkType?: string; dir?: 'out' | 'in'; seedId: string }
  const visited = new Map<string, Visit>();
  for (const s of seeds) {
    visited.set(s.id, { node: { id: s.id, objectType: s.objectType, title: s.title }, depth: 0, seedId: s.id });
  }
  let frontier = seeds.map((s) => s.id);
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const stmt = assembleHopCypher(frontier, HOP_FETCH_CAP);
    if (!stmt) break;
    let rows: unknown[][] = [];
    try {
      const res = await runCypher(stmt, HOP_COLUMNS.map((c) => ({ name: c.name, type: c.type })));
      rows = res.rows;
    } catch {
      break; // an unreachable hop degrades to the depth we already have
    }
    const edges = parseHopRows(rows, opts.titleKeys);
    const next: string[] = [];
    for (const e of edges) {
      if (visited.has(e.toId)) continue;
      const from = visited.get(e.fromId);
      if (!from) continue;
      visited.set(e.toId, {
        node: e.neighbor,
        depth: hop,
        parent: e.fromId,
        linkType: e.linkType,
        dir: e.direction,
        seedId: from.seedId,
      });
      next.push(e.toId);
    }
    frontier = next;
  }

  // ── 3. PATH CITATIONS — walk each discovered node back to its seed ─────────
  const paths: GraphPathCitation[] = [];
  const discovered = [...visited.values()].filter((v) => v.depth > 0).sort((a, b) => a.depth - b.depth);
  for (const v of discovered) {
    if (paths.length >= MAX_PATH_CITATIONS) break;
    const nodes: GraphPathNode[] = [];
    const links: string[] = [];
    const dirs: ('out' | 'in')[] = [];
    let cur: Visit | undefined = v;
    const guard = new Set<string>();
    while (cur && !guard.has(cur.node.id)) {
      guard.add(cur.node.id);
      nodes.unshift(cur.node);
      if (cur.parent) {
        links.unshift(cur.linkType || 'RELATED');
        dirs.unshift(cur.dir || 'out');
        cur = visited.get(cur.parent);
      } else break;
    }
    if (nodes.length < 2) continue;
    paths.push({
      id: `${nodes[0].id}->${nodes[nodes.length - 1].id}`,
      hops: nodes.length - 1,
      nodes,
      links,
      text: renderPathText(nodes, links, dirs),
    });
  }

  const vertexIds = [...visited.keys()];

  // ── 4. PRECOMPUTED COMMUNITY SUMMARIES ────────────────────────────────────
  let communities: GraphCommunityContext[] = [];
  if (opts.ontologyId) {
    const docs = await summariesForVertices(opts.ontologyId, vertexIds, 4);
    const memberOf = new Map<string, string>();
    communities = docs.map((d) => {
      for (const m of d.memberIds || []) if (!memberOf.has(String(m))) memberOf.set(String(m), d.communityId);
      return {
        communityId: d.communityId,
        summary: d.summary,
        size: d.size,
        objectTypes: d.objectTypes || [],
        overlap: (d.memberIds || []).filter((m) => visited.has(String(m))).length,
        modelGenerated: !!d.modelGenerated,
      };
    });
    for (const p of paths) {
      const end = p.nodes[p.nodes.length - 1];
      const cid = memberOf.get(end.id);
      if (cid) p.communityId = cid;
    }
  }

  const ctx: GraphRagContext = {
    ok: true,
    ontologyId: opts.ontologyId,
    seeds,
    paths,
    communities,
    vertexIds,
    hops: maxHops,
    scanned,
    contextText: '',
    durationMs: Date.now() - started,
  };
  ctx.contextText = graphContextBlock(ctx);
  return ctx;
}

/**
 * Render the grounding block layered onto the agent instructions. Pure — every
 * line is a REAL fact read off AGE; nothing is synthesized.
 */
export function graphContextBlock(ctx: GraphRagContext): string {
  if (!ctx.ok || (ctx.seeds.length === 0 && ctx.paths.length === 0)) return '';
  const lines: string[] = [
    '## GRAPH GROUNDING (authored ontology — Apache AGE on in-VNet PostgreSQL)',
    'These are REAL entities and REAL relationships read from the ontology graph for this question. Treat them as authoritative facts.',
    '',
    'Seed entities matched from the question:',
    ...ctx.seeds.map((s) => `- ${s.title} (${s.objectType}, id ${s.id})${s.matchedOn.length ? ` — matched on ${s.matchedOn.join(', ')}` : ''}`),
  ];
  if (ctx.paths.length) {
    lines.push('', `Traversal paths (≤ ${ctx.hops} hop${ctx.hops === 1 ? '' : 's'}, real edges):`);
    ctx.paths.forEach((p, i) => lines.push(`${i + 1}. ${p.text}`));
  }
  if (ctx.communities.length) {
    lines.push('', 'Precomputed community summaries covering these entities:');
    for (const c of ctx.communities) {
      lines.push(`- [${c.communityId}, ${c.size} instances] ${c.summary}`);
    }
  }
  lines.push(
    '',
    'Use these graph facts to resolve entity relationships before you write any query, and cite the path you relied on (by its numbered line) in your answer. Do NOT invent nodes, edges, or relationships that are not listed above.',
  );
  return lines.join('\n');
}
