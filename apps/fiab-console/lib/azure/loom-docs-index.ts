/**
 * Loom docs index — RAG corpus for the Help Copilot widget.
 *
 * Indexes:
 *   - docs/fiab/**\/*.md      (published CSA Loom pages, incl. docs/fiab/parity/**)
 *   - docs/**\/*.md           (broader csa-inabox docs)
 *   - apps/fiab-console/lib/**\/*.{ts,tsx} summaries
 *   - PRPs/completed/csa-loom-pillar/*.md
 *   - PRPs/active/**\/*.md    (in-flight PRPs — AUDIT.md receipts, OPEN-REGISTER, etc.
 *     Without these the Copilot only ever saw *completed* PRPs and answered from
 *     stale gap analyses — e.g. claiming Foundry parity was unshipped when
 *     PRPs/active/foundry-parity/AUDIT.md carried the live shipped receipts.)
 *   - docs/fiab/adr/*.md
 *
 * Two backends:
 *   1. Azure AI Search (preferred) — `loom-docs` index, hybrid semantic.
 *   2. Cosmos `help-copilot-corpus` container — deterministic substring
 *      fallback. Used when LOOM_AI_SEARCH_SERVICE is not set.
 *
 * The corpus is built once on first reindex and persisted in either
 * backend so subsequent BFF replicas don't re-walk the FS.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Container } from '@azure/cosmos';

import { copilotSessionsContainer } from './cosmos-client';
import { chunkMarkdown, MAX_CHUNK as CHUNKER_MAX_CHUNK } from './docs-chunker';
import { recordRetrieval } from '@/lib/perf/retrieval-metrics';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  buildBm25Index,
  bm25Rank,
  createCorpusStatsAccumulator,
  diversifyByDocument,
  rankSubstring,
  surfaceTopicTerms,
  DEFAULT_MAX_CHUNKS_PER_DOC,
  DEFAULT_SURFACE_BOOST,
  DEFAULT_SOURCE_WEIGHTS,
  type Bm25CorpusStats,
  type Bm25Index,
} from './docs-ranker';

// ---------- Types ----------

export interface DocChunk {
  /** Stable doc id — `${kind}:${relpath}#${chunkIdx}` */
  id: string;
  /** docs / repo / prp / adr */
  kind: 'docs' | 'repo' | 'prp' | 'adr';
  /** Relative repo path */
  path: string;
  /** Optional H1/H2 heading the chunk lives under */
  heading?: string;
  /** Chunk text (~1500 chars) */
  content: string;
  /** Optional public URL for citations (preferred over `path`) */
  url?: string;
  /** Last-modified ISO timestamp (file mtime) */
  touchedAt: string;
}

export interface DocHit extends DocChunk {
  /** 0..1 normalized relevance */
  score: number;
}

// ---------- Credentials / config ----------

const credential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(),
  ...((process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID)
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

const SEARCH_API = '2024-07-01';
const INDEX = 'loom-docs';
const COSMOS_CONTAINER_ID = 'help-copilot-corpus';

// ---------- Incremental-index manifest (WS-G / G1 + G2) ----------
// The corpus is chunked from source docs; a content-hash manifest lets an
// incremental reindex skip unchanged docs and delete removed ones instead of
// re-uploading the whole corpus every time. The manifest is persisted in the
// SAME store the chunks live in (AI Search index doc, or the Cosmos corpus
// container) so its lifecycle is tied to the index — wipe the index and the
// manifest goes with it, forcing a safe full rebuild.
const MANIFEST_KEY = 'corpus-manifest';
/** `kind` sentinel for non-chunk bookkeeping docs (the manifest). Excluded from
 *  every retrieval query so it never surfaces as a citation. */
const META_KIND = '__meta__';
const MANIFEST_VERSION = 1 as const;

/** Per-source-doc index state: the content hash + how many chunks it produced
 *  (chunk ids are deterministic via docKey(kind, path, idx), so we don't store
 *  the id list — we regenerate it to delete orphaned/removed chunks). */
interface ManifestFileEntry {
  kind: DocChunk['kind'];
  hash: string;
  chunks: number;
}

interface CorpusManifest {
  version: typeof MANIFEST_VERSION;
  /** Backend the manifest (and thus the indexed chunks) belong to. */
  backend: 'ai-search' | 'cosmos';
  /** Index/container the chunks live in. */
  indexName: string;
  /** ISO timestamp of the build that produced this manifest. */
  builtAt: string;
  /** Source commit / build SHA at index time (LOOM_BUILD_SHA), or null. */
  sourceCommit: string | null;
  /** Fast stat-only fingerprint (path:size:mtime) over every enumerated source
   *  file — the cheap staleness signal the health probe compares. */
  statFingerprint: string;
  /** Content-hash fingerprint over every indexed file (authoritative). */
  contentFingerprint: string;
  /** path → { kind, content-hash, chunk count }. */
  files: Record<string, ManifestFileEntry>;
  /** Total indexed chunk count (excludes the manifest doc itself). */
  chunkCount: number;
}

function searchServiceName(): string | null {
  return process.env.LOOM_AI_SEARCH_SERVICE || null;
}

export function isSearchConfigured(): boolean {
  return !!searchServiceName();
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire token for AI Search');
  return t.token;
}

// ---------- AI Search backend ----------

const INDEX_DEFINITION = {
  fields: [
    { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
    { name: 'kind', type: 'Edm.String', filterable: true, facetable: true, retrievable: true },
    { name: 'path', type: 'Edm.String', filterable: true, retrievable: true, searchable: true,
      analyzer: 'standard.lucene' },
    { name: 'heading', type: 'Edm.String', searchable: true, retrievable: true,
      analyzer: 'standard.lucene' },
    { name: 'content', type: 'Edm.String', searchable: true, retrievable: true,
      analyzer: 'standard.lucene' },
    { name: 'url', type: 'Edm.String', retrievable: true },
    { name: 'touchedAt', type: 'Edm.DateTimeOffset', sortable: true, retrievable: true, filterable: true },
  ],
};

export async function ensureDocsIndex(): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const svc = searchServiceName();
  if (!svc) return { ok: false, created: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  try {
    const tok = await searchToken();
    const get = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (get.status === 200) return { ok: true, created: false };
    const put = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: INDEX, ...INDEX_DEFINITION }),
    });
    if (!put.ok) {
      const t = await put.text();
      return { ok: false, created: false, error: `PUT index ${put.status}: ${t.slice(0, 200)}` };
    }
    return { ok: true, created: true };
  } catch (e: any) {
    return { ok: false, created: false, error: e?.message || String(e) };
  }
}

/**
 * Outcome of ONE `POST /docs/index` batch, read from the response BODY rather
 * than from the HTTP status alone.
 *
 * WHY THE BODY (issue #2964) — `r.ok` is NOT a success signal for this API.
 * When some actions in a batch fail, AI Search answers **HTTP 207 Multi-Status**,
 * which is a 2xx: `response.ok === true`. The real verdict is per document, in
 * `value[i].status` / `value[i].errorMessage`. A caller that only checks `r.ok`
 * therefore reports a write that the service REJECTED as a success — which is
 * exactly how the corpus manifest silently failed to persist for the whole life
 * of the incremental-index feature. Confirmed against a live search service:
 *
 *   content = 32,766 bytes → HTTP 200, status:true
 *   content = 32,770 bytes → HTTP 207, status:false,
 *     "Field 'content' contains a term that is too large to process.
 *      The max length for UTF-8 encoded terms is 32766 bytes."
 */
interface IndexBatchOutcome {
  /** Every action in the batch was accepted by the service. */
  ok: boolean;
  /** Actions the service reported `status:true` for. */
  succeeded: number;
  failed: number;
  error?: string;
}

/**
 * POST one `docs/index` batch and decide the outcome from the per-document
 * results. An unparseable answer is a FAILURE, never a pass — a body we cannot
 * read cannot be read as success.
 */
async function indexBatch(
  svc: string,
  tok: string,
  actions: Array<Record<string, unknown>>,
): Promise<IndexBatchOutcome> {
  const r = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value: actions }),
  });
  const raw = await r.text();
  if (!r.ok) {
    return { ok: false, succeeded: 0, failed: actions.length, error: `HTTP ${r.status}: ${raw.slice(0, 200)}` };
  }
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* handled below */ }
  const results = Array.isArray(parsed?.value) ? parsed.value : null;
  if (!results) {
    return {
      ok: false, succeeded: 0, failed: actions.length,
      error: `HTTP ${r.status} with an unreadable body (no per-document results): ${raw.slice(0, 200)}`,
    };
  }
  const bad = results.filter((d: any) => d?.status !== true);
  const succeeded = results.length - bad.length;
  if (bad.length === 0) return { ok: true, succeeded, failed: 0 };
  const first = bad[0];
  return {
    ok: false,
    succeeded,
    failed: bad.length,
    error: `${bad.length}/${results.length} document(s) rejected (HTTP ${r.status}); first: ` +
      `${first?.key ?? '?'} — ${String(first?.errorMessage ?? 'no errorMessage').slice(0, 240)}`,
  };
}

async function pushChunksToSearch(chunks: DocChunk[]): Promise<{ ok: boolean; uploaded: number; error?: string }> {
  const svc = searchServiceName();
  if (!svc) return { ok: false, uploaded: 0, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  if (chunks.length === 0) return { ok: true, uploaded: 0 };
  try {
    const tok = await searchToken();
    let uploaded = 0;
    let rejected = 0;
    let firstError: string | undefined;
    // AI Search caps batches at 1000 docs / 16MB
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const out = await indexBatch(svc, tok, batch.map((c) => ({ '@search.action': 'mergeOrUpload', ...c })));
      // `uploaded` counts what the SERVICE accepted, not what we sent — the
      // reindex result is compared against the manifest's chunk count, so an
      // optimistic count would make that comparison meaningless.
      uploaded += out.succeeded;
      if (!out.ok) {
        // A batch where nothing landed is a broken backend (auth, index gone,
        // throttling): stop and let the caller fall back to Cosmos. A batch with
        // SOME rejections is real, partial data loss — surfaced, not swallowed.
        if (out.succeeded === 0) {
          return { ok: false, uploaded, error: `Upload batch ${i / BATCH}: ${out.error}` };
        }
        rejected += out.failed;
        firstError = firstError ?? out.error;
      }
    }
    if (rejected > 0) {
      return { ok: true, uploaded, error: `${rejected} chunk document(s) rejected by AI Search; first: ${firstError}` };
    }
    return { ok: true, uploaded };
  } catch (e: any) {
    return { ok: false, uploaded: 0, error: e?.message || String(e) };
  }
}

/** Delete chunk documents by key from the AI Search index (incremental removal
 *  of chunks whose source doc was removed or shrank). */
async function deleteChunksFromSearch(ids: string[]): Promise<{ ok: boolean; deleted: number; error?: string }> {
  const svc = searchServiceName();
  if (!svc) return { ok: false, deleted: 0, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  if (ids.length === 0) return { ok: true, deleted: 0 };
  try {
    const tok = await searchToken();
    let deleted = 0;
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const out = await indexBatch(svc, tok, batch.map((id) => ({ '@search.action': 'delete', id })));
      deleted += out.succeeded;
      if (!out.ok) return { ok: false, deleted, error: `Delete batch ${i / BATCH}: ${out.error}` };
    }
    return { ok: true, deleted };
  } catch (e: any) {
    return { ok: false, deleted: 0, error: e?.message || String(e) };
  }
}

async function searchSearch(query: string, top: number, kind?: DocChunk['kind']): Promise<DocHit[]> {
  const svc = searchServiceName();
  if (!svc) return [];
  const tok = await searchToken();
  // Exclude the bookkeeping manifest doc (kind === META_KIND) from results; a
  // kind filter naturally excludes it, so only the no-kind path needs the guard.
  const filter = kind ? `kind eq '${kind}'` : `kind ne '${META_KIND}'`;
  const body: Record<string, unknown> = {
    search: query,
    queryType: 'simple',
    searchMode: 'any',
    top,
    select: 'id,kind,path,heading,content,url,touchedAt',
  };
  if (filter) body.filter = filter;
  const r = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/search?api-version=${SEARCH_API}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // 404 = index doesn't exist yet → return empty so the orchestrator can fall back
    if (r.status === 404) return [];
    const t = await r.text();
    throw new Error(`AI Search query failed ${r.status}: ${t.slice(0, 240)}`);
  }
  const j: any = await r.json();
  const hits = (j.value || []) as Array<DocChunk & { '@search.score'?: number }>;
  const max = hits.reduce((m, h) => Math.max(m, h['@search.score'] || 0), 0) || 1;
  return hits.map((h) => ({
    id: h.id, kind: h.kind, path: h.path, heading: h.heading,
    content: h.content, url: h.url, touchedAt: h.touchedAt,
    score: (h['@search.score'] || 0) / max,
  }));
}

// ---------- Cosmos fallback backend ----------

async function helpCorpusContainer(): Promise<Container> {
  // Re-use the cosmos-client singleton via copilotSessionsContainer's `ensure()`
  // by piggy-backing on the same database. We could expose a generic builder
  // but inlining keeps the diff small and reuses connection + auth.
  const cs = await copilotSessionsContainer();
  const db = (cs as any).database; // @azure/cosmos exposes database off Container
  const { container } = await db.containers.createIfNotExists({
    id: COSMOS_CONTAINER_ID,
    partitionKey: { paths: ['/kind'] },
  });
  return container;
}

async function pushChunksToCosmos(chunks: DocChunk[]): Promise<{ ok: boolean; uploaded: number; error?: string }> {
  try {
    const c = await helpCorpusContainer();
    let uploaded = 0;
    for (const chunk of chunks) {
      try {
        await c.items.upsert(chunk);
        uploaded += 1;
      } catch (e: any) {
        // continue; one bad doc shouldn't fail the whole reindex
        console.warn('[loom-docs-index] cosmos upsert failed', chunk.id, e?.message);
      }
    }
    return { ok: true, uploaded };
  } catch (e: any) {
    return { ok: false, uploaded: 0, error: e?.message || String(e) };
  }
}

/** Delete chunk documents by id from the Cosmos corpus container. Ids carry the
 *  kind (partition key) via the manifest; we look each up by (id, kind). */
async function deleteChunksFromCosmos(
  entries: Array<{ id: string; kind: DocChunk['kind'] }>,
): Promise<{ ok: boolean; deleted: number; error?: string }> {
  if (entries.length === 0) return { ok: true, deleted: 0 };
  try {
    const c = await helpCorpusContainer();
    let deleted = 0;
    for (const { id, kind } of entries) {
      try {
        await c.item(id, kind).delete();
        deleted += 1;
      } catch (e: any) {
        // 404 (already gone) is benign; anything else is logged but non-fatal.
        if (!/404|NotFound|does not exist/i.test(e?.message || '')) {
          console.warn('[loom-docs-index] cosmos delete failed', id, e?.message);
        }
      }
    }
    return { ok: true, deleted };
  } catch (e: any) {
    return { ok: false, deleted: 0, error: e?.message || String(e) };
  }
}

// ---------- Cosmos-fallback ranking (issue #2585 P0) ----------

/**
 * BM25 needs corpus-wide statistics (document frequency, mean chunk length), so
 * unlike the per-chunk `rankSubstring` it cannot be evaluated one row at a time.
 * The index is therefore built once per corpus SNAPSHOT and reused across
 * queries: building it over the ~50k-chunk corpus costs ~850 ms, ranking against
 * it costs microseconds because the postings walk touches only the query's own
 * terms instead of scanning every chunk.
 *
 * Cache key = chunk count + an order-independent hash of the chunk ids, so a
 * reindex (new/removed/renamed chunks) invalidates it automatically without a
 * process restart, and Cosmos returning rows in a different order does not.
 * Content-only edits that keep every id stable are picked up on the next
 * `resetDocsRankerCache()` (called by `reindex`) or process roll.
 */
let bm25Cache: { signature: string; index: Bm25Index } | null = null;

/** FNV-1a over one id — cheap, and combined order-independently below. */
function idHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function corpusSignature(chunks: DocChunk[]): string {
  let sum = 0;
  let xor = 0;
  for (const c of chunks) {
    const h = idHash(c.id || c.path);
    sum = (sum + h) >>> 0;
    xor ^= h;
  }
  return `${chunks.length}:${sum}:${xor >>> 0}`;
}

/** Drop the memoised BM25 index (called after a reindex; exported for tests). */
export function resetDocsRankerCache(): void {
  bm25Cache = null;
  corpusStatsCache = undefined;
}

// ---------- Corpus-wide BM25 statistics for the AI Search path (#2970) -------
//
// The AI Search branch re-ranks a per-query CANDIDATE WINDOW. Building BM25
// statistics from that window is wrong in a specific, measurable way — every
// candidate matches the query, so `df/size` approaches 1 for the query's terms
// and IDF collapses for all of them together. See `docs-ranker.Bm25CorpusStats`
// for the numbers (0.797 → 0.889 over the golden sets at a 100-candidate
// window, i.e. the entire gap to full-corpus ranking).
//
// The statistics come from the corpus BUNDLED IN THE IMAGE (the same
// `copilot-corpus/` tree `collectSources()` walks) rather than from the search
// index, because they must describe the whole corpus and a query can only ever
// see a slice of it. They are accumulated STREAMING — one file chunked, counted
// and dropped — so the ~75 MB of corpus text is never resident.
//
// `undefined` = not attempted yet; `null` = attempted and unavailable (no
// bundled corpus — a dev checkout without docs, or an image built without the
// staging step). Null is an HONEST degradation to the previous window-local
// behaviour, never a crash and never a silent wrong answer: the ranking is
// simply the one that shipped before this fix.
let corpusStatsCache: Bm25CorpusStats | null | undefined;

/**
 * Test-only override for the corpus-statistics source.
 *
 * The production invariant is that BOTH retrieval backends score against the
 * SAME corpus statistics — the Cosmos path because its index IS the corpus, the
 * AI Search path because `localCorpusStats()` reads the same bundled corpus the
 * reindex built Cosmos from. A unit test that stands up a synthetic Cosmos
 * corpus has no way to satisfy that without pointing this at the same synthetic
 * corpus; without the hook the AI Search path would silently score against the
 * repo's REAL docs and the backend-symmetry assertion would fail for a reason
 * that has nothing to do with the behaviour under test.
 */
let corpusStatsOverride: Bm25CorpusStats | null | undefined;

/**
 * Corpus-wide `size` / `avgdl` / `df`, built once per process from the bundled
 * corpus. Returns null when no corpus is reachable.
 */
function localCorpusStats(): Bm25CorpusStats | null {
  if (corpusStatsOverride !== undefined) return corpusStatsOverride;
  if (corpusStatsCache !== undefined) return corpusStatsCache;
  try {
    const refs = enumerateSourceFiles(detectRoots());
    if (refs.length === 0) {
      corpusStatsCache = null;
      return null;
    }
    const acc = createCorpusStatsAccumulator();
    for (const ref of refs) {
      let raw = '';
      try { raw = fs.readFileSync(ref.abs, 'utf-8'); } catch { continue; }
      if (ref.kind === 'repo') {
        const summary = summarizeSource(ref.abs, raw);
        if (summary) acc.add({ content: summary });
        continue;
      }
      for (const b of chunkMarkdown(raw)) acc.add({ heading: b.heading, content: b.content });
    }
    const stats = acc.finish();
    // A corpus that produced no chunks is not statistics — it is an empty
    // corpus, and scoring against `size: 0` would make every IDF identical.
    corpusStatsCache = stats.size > 0 ? stats : null;
    return corpusStatsCache;
  } catch (e: any) {
    console.warn('[loom-docs-index] corpus statistics build failed, falling back to window-local BM25', e?.message);
    corpusStatsCache = null;
    return null;
  }
}


function bm25IndexFor(chunks: DocChunk[]): Bm25Index {
  const signature = corpusSignature(chunks);
  if (bm25Cache && bm25Cache.signature === signature) return bm25Cache.index;
  const index = buildBm25Index(chunks);
  bm25Cache = { signature, index };
  return index;
}

/**
 * How many candidates to pull before per-document diversification trims back to
 * `top`. Without an over-fetch the diversifier has nothing to backfill from and
 * is a no-op.
 */
const RETRIEVAL_OVERFETCH = 4;

/**
 * How wide a candidate window to pull from AI Search before the shared ranker
 * re-orders it (#2929). AI Search's `simple`/`any` scoring decides only which
 * documents are CANDIDATES here — NOT their final order — so this must be wide
 * enough that a specific gold document (buried by AI Search under same-named
 * siblings) is still inside the window for `rankChunks` to surface. 100 covers
 * the observed miss (`parity/lakehouse.md` sat well below AI Search's top ~32,
 * giving hit-rate ~0.07); it is never smaller than the diversification
 * over-fetch. AI Search caps `top` at 1000, so this is comfortably in range.
 */
export const AI_SEARCH_CANDIDATE_WINDOW = 100;

/**
 * The ONE ranking pipeline both retrieval backends run (issue #2585 ranker,
 * wired to the AI Search path for #2929). Given a set of candidate chunks it
 * returns the top `top` as DocHits under BM25 (IDF · TF-saturation · length
 * normalisation) + the surface boost + source-class weighting — identical
 * knobs, identical code — normalised to the documented 0..1 `DocHit.score`.
 *
 * Extracted from `searchCosmos` so the AI Search path can REUSE it verbatim
 * rather than re-sorting AI Search's short returned window by a multiplier: for
 * the SAME candidate documents the two backends now produce the SAME ordering,
 * so the offline-measured Cosmos numbers (measure-retrieval.mjs, ~0.83) carry
 * to the live AI Search path.
 *
 * `buildIndex` is injectable ONLY so the Cosmos path can keep its
 * corpus-signature memoiser (`bm25IndexFor`): it always ranks the SAME full
 * ~50k-chunk corpus, so the ~850 ms index build must be amortised across
 * queries. The AI Search path ranks a small, per-query candidate window, so it
 * uses the default fresh `buildBm25Index` — there is nothing stable to cache
 * and a per-window build is microseconds.
 */
function rankChunks(
  resources: DocChunk[],
  query: string,
  top: number,
  opts: {
    bm25: boolean;
    surfaceTerms?: readonly string[];
    sourceWeights: boolean;
    /**
     * #2970 — corpus-wide BM25 statistics. MUST be supplied when `resources` is
     * a query-selected subset (the AI Search candidate window); omitted on the
     * Cosmos path, whose index already covers the whole corpus.
     */
    corpusStats?: Bm25CorpusStats | null;
  },
  buildIndex: (chunks: DocChunk[]) => Bm25Index = buildBm25Index,
): DocHit[] {
  if (opts.bm25 === false) {
    // Kill-switch path — byte-identical to the pre-#2585 ranker.
    return resources
      .map((r) => ({ ...r, score: rankSubstring(query, r.content, r.heading) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
  }
  const index = buildIndex(resources);
  const ranked = bm25Rank(index, query, top, {
    surfaceTerms: opts.surfaceTerms,
    surfaceBoost: opts.surfaceTerms?.length ? DEFAULT_SURFACE_BOOST : 0,
    // #2585 P2 — rank published product docs above the engineering ledger.
    sourceWeights: opts.sourceWeights ? DEFAULT_SOURCE_WEIGHTS : null,
    corpusStats: opts.corpusStats ?? null,
  });
  // Normalise to the 0..1 `DocHit.score` contract (BM25 is unbounded above and
  // only comparable within one result set) — citations and the Copilot tool
  // render this number.
  const max = ranked.length > 0 ? ranked[0].score : 1;
  return ranked.map((r) => ({ ...resources[r.index], score: max > 0 ? r.score / max : 0 }));
}

async function searchCosmos(
  query: string,
  top: number,
  kind?: DocChunk['kind'],
  opts?: { bm25?: boolean; surfaceTerms?: readonly string[]; sourceWeights?: boolean },
): Promise<DocHit[]> {
  try {
    const c = await helpCorpusContainer();
    // Pull ALL chunks for the kind (or all kinds) and rank in-memory.
    // For 10K-page-scale corpora this is fine; if it grows past ~50MB,
    // switch to AI Search.
    const q = kind
      ? { query: 'SELECT * FROM c WHERE c.kind = @k', parameters: [{ name: '@k', value: kind }] }
      : { query: 'SELECT * FROM c WHERE c.kind != @meta', parameters: [{ name: '@meta', value: META_KIND }] };
    const { resources } = await c.items.query<DocChunk>(q).fetchAll();
    // Ranking lives in the shared `rankChunks` (also used by the AI Search
    // path, #2929); the memoiser is passed so the full-corpus index is built
    // once and reused. `bm25 !== false` preserves the original default (a
    // missing flag ranks with BM25).
    return rankChunks(resources, query, top, {
      bm25: opts?.bm25 !== false,
      surfaceTerms: opts?.surfaceTerms,
      sourceWeights: !!opts?.sourceWeights,
    }, bm25IndexFor);
  } catch (e: any) {
    console.warn('[loom-docs-index] cosmos search failed', e?.message);
    return [];
  }
}

// ---------- Public search API ----------

/**
 * Default retrieval window. Raised 5 → 8 for #2585 (P1): measured over the
 * golden sets at a fixed ranker, doc-level hit-rate@8 is 0.760 vs 0.712 at
 * top-5, with ZERO surfaces regressing. The cost is real (three more ≤1500-char
 * excerpts in the answer prompt), which is why it carries its own kill-switch —
 * `copilot-retrieval-window-8`, OFF reverts to 5 without a roll.
 */
export const DEFAULT_DOC_RETRIEVAL_TOP = 8;
/** Pre-#2585 window, restored when the widening flag is OFF. */
export const LEGACY_DOC_RETRIEVAL_TOP = 5;

/** Optional retrieval scoping. */
export interface SearchDocsOptions {
  /**
   * The Copilot surface the question was asked from (an item type such as
   * `lakehouse`, or an eval-set name). Applied as a topical BOOST, never a
   * filter — see `docs-ranker.surfaceBoostFactor`.
   */
  surface?: string | null;
}

/**
 * Hybrid: try AI Search first; fall back to Cosmos substring if Search
 * isn't configured or returns nothing.
 *
 * Pipeline (#2585 P0/P1): over-fetch candidates → rank via BM25 + surface boost
 * + source weighting (`rankChunks`) → cap chunks-per-document → slice to `top`.
 *
 * Backend symmetry (#2929, completed by #2970): BOTH paths decide the final
 * order with the SAME ranker (`rankChunks`). AI Search is used for RECALL only —
 * it returns a WIDE candidate window (`AI_SEARCH_CANDIDATE_WINDOW`) which is then
 * re-ranked by the identical BM25 + surface-boost + source-weight pipeline the
 * Cosmos path uses, so the two backends produce the same ordering for the same
 * candidate documents.
 *
 * #2929 left ONE asymmetry — BM25 corpus statistics were computed over the full
 * corpus on the Cosmos path but over the AI-Search candidate window on the AI
 * Search path — and recorded it as residual. It was not residual: it was the
 * entire remaining gap. Every candidate in the window matches the query, so
 * `df/size` approaches 1 for the query's terms and IDF collapses for all of them
 * at once. Measured over the golden sets at top-8 with a 100-candidate window,
 * window-local statistics score 0.797 and corpus-wide statistics score 0.889 —
 * exactly the full-corpus number. `localCorpusStats()` now supplies the
 * corpus-wide half, so the paths agree on the ranking as well as on the ranker.
 *
 * The offline harness (`scripts/csa-loom/measure-retrieval.mjs`) models BOTH
 * stages under `--stage1`; its full-corpus columns are an UPPER BOUND, not a
 * live prediction. Per G1 the AI Search path's live numbers confirm only after a
 * `loom-docs` reindex + a real `copilot-quality-evals` run.
 */
export async function searchDocs(
  query: string,
  top = DEFAULT_DOC_RETRIEVAL_TOP,
  kind?: DocChunk['kind'],
  opts?: SearchDocsOptions,
): Promise<{
  hits: DocHit[];
  backend: 'ai-search' | 'cosmos' | 'none';
}> {
  if (!query.trim()) return { hits: [], backend: 'none' };
  const started = Date.now();
  let fellBack = false;

  // Kill-switches (default-ON per loom_default_on_opt_out; a flag-store outage
  // fails open to the new path, which is the measured-better one).
  const [bm25Enabled, surfaceEnabled, wideWindow, sourceWeighted] = await Promise.all([
    runtimeFlag('copilot-bm25-retrieval'),
    runtimeFlag('copilot-surface-scoped-retrieval'),
    runtimeFlag('copilot-retrieval-window-8'),
    runtimeFlag('copilot-corpus-source-weighting'),
  ]);
  const want = wideWindow ? top : Math.min(top, LEGACY_DOC_RETRIEVAL_TOP);
  const surfaceTerms = surfaceEnabled && bm25Enabled ? surfaceTopicTerms(opts?.surface) : [];
  const overfetch = bm25Enabled ? Math.max(want * RETRIEVAL_OVERFETCH, want) : want;
  const weightSources = sourceWeighted && bm25Enabled;

  const finish = (hits: DocHit[]): DocHit[] => {
    if (!bm25Enabled) return hits.slice(0, want);
    return diversifyByDocument(hits, want, DEFAULT_MAX_CHUNKS_PER_DOC);
  };

  if (isSearchConfigured()) {
    try {
      // #2929 — retrieve-then-rerank. AI Search does RECALL: pull a WIDE
      // candidate window (not the short top-N the old path merely re-sorted).
      // The final ORDER is decided by `rankChunks` — the SAME BM25 + surface
      // boost + source-weight pipeline the Cosmos path proves offline
      // (measure-retrieval.mjs, ~0.83) — so the live AI Search path inherits
      // that ordering instead of AI Search's un-weighted `simple` scoring,
      // which buried specific gold docs (e.g. parity/lakehouse.md, hit-rate
      // ~0.07) under same-named siblings. When the BM25 kill-switch is OFF we
      // preserve AI Search's native order (pre-#2929 behaviour).
      const candidateWindow = bm25Enabled
        ? Math.max(AI_SEARCH_CANDIDATE_WINDOW, overfetch)
        : overfetch;
      const candidates = await searchSearch(query, candidateWindow, kind);
      if (candidates.length > 0) {
        // Re-rank to `overfetch`, then diversify to `want` in finish() — the
        // same two-step the Cosmos path runs, so both backends agree for the
        // same candidate set.
        const ordered = bm25Enabled
          ? rankChunks(candidates, query, overfetch, {
              bm25: true,
              surfaceTerms,
              sourceWeights: weightSources,
              // #2970 — the candidate window is a query-selected subset, so its
              // own df/size/avgdl are distorted (every candidate matches the
              // query). Score with corpus-wide statistics instead; null when no
              // bundled corpus is reachable, which degrades to the previous
              // window-local behaviour rather than failing.
              corpusStats: localCorpusStats(),
            })
          : candidates;
        const hits = finish(ordered);
        recordRetrieval({ backend: 'ai-search', latencyMs: Date.now() - started, resultCount: hits.length, fallback: false });
        return { hits, backend: 'ai-search' };
      }
      // Configured but returned nothing → fall through to the Cosmos substring
      // backend; count it as a fallback for the telemetry.
      fellBack = true;
    } catch (e: any) {
      console.warn('[loom-docs-index] ai-search failed, falling back', e?.message);
      fellBack = true;
    }
  }
  const raw = await searchCosmos(query, overfetch, kind, {
    bm25: bm25Enabled, surfaceTerms, sourceWeights: weightSources,
  });
  const hits = finish(raw);
  const backend = hits.length > 0 || !isSearchConfigured() ? 'cosmos' : 'ai-search';
  recordRetrieval({ backend, latencyMs: Date.now() - started, resultCount: hits.length, fallback: fellBack });
  return { hits, backend };
}

// ---------- Corpus walker ----------

/**
 * Key-safe document id. Azure AI Search document KEYS and Cosmos document IDS
 * both reject '/', '.', '#', ':' (Cosmos also '\\' and '?') — but the natural
 * `${kind}:${relpath}#${idx}` form is full of them, so every AI Search upload
 * batch 400'd ("Invalid document key") and every Cosmos upsert silently failed,
 * leaving the corpus index empty. base64url of the source id is valid for both
 * backends and stays deterministic; the human-readable path lives in `path`.
 */
function docKey(kind: string, rel: string, idx: number): string {
  return `${Buffer.from(`${kind}:${rel}`, 'utf-8').toString('base64url')}_${idx}`;
}

interface RepoRoots {
  /** Repo root (parent of `apps/`). */
  repoRoot: string;
  /** `docs/` */
  docsRoot: string;
  /** `apps/fiab-console/lib/` */
  consoleLibRoot: string;
  /** `PRPs/completed/csa-loom-pillar/` */
  prpRoot: string;
  /** `PRPs/active/` — in-flight PRP folders (AUDIT.md receipts, PRP.md, OPEN-REGISTER) */
  prpActiveRoot: string;
  /** `docs/fiab/adr/` */
  adrRoot: string;
}

function detectRoots(): RepoRoots {
  // 1) Production image: the corpus is staged into ./copilot-corpus at build
  //    time (scripts/csa-loom/stage-copilot-corpus.sh) because the repo-root
  //    docs/ + PRPs/ are OUTSIDE the apps/fiab-console Docker build context and
  //    would otherwise never be packaged — leaving the RAG index empty. The
  //    Dockerfile COPYs this dir next to server.js, so it sits at cwd here.
  const bundled = path.join(process.cwd(), 'copilot-corpus');
  if (fs.existsSync(path.join(bundled, 'docs'))) {
    return {
      repoRoot: bundled,
      docsRoot: path.join(bundled, 'docs'),
      consoleLibRoot: path.join(bundled, 'lib'),
      prpRoot: path.join(bundled, 'PRPs', 'completed', 'csa-loom-pillar'),
      prpActiveRoot: path.join(bundled, 'PRPs', 'active'),
      adrRoot: path.join(bundled, 'docs', 'fiab', 'adr'),
    };
  }
  // 2) Dev / repo checkout: walk up from cwd until we find `mkdocs.yml`.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'mkdocs.yml'))) break;
    dir = path.dirname(dir);
  }
  return {
    repoRoot: dir,
    docsRoot: path.join(dir, 'docs'),
    consoleLibRoot: path.join(dir, 'apps', 'fiab-console', 'lib'),
    prpRoot: path.join(dir, 'PRPs', 'completed', 'csa-loom-pillar'),
    prpActiveRoot: path.join(dir, 'PRPs', 'active'),
    adrRoot: path.join(dir, 'docs', 'fiab', 'adr'),
  };
}

function walkMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  }
  return out;
}

function walkSource(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__tests__') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full);
    }
  }
  return out;
}

const MAX_CHUNK = CHUNKER_MAX_CHUNK;

function summarizeSource(filePath: string, text: string): string {
  // Grab the leading JSDoc / banner comment and exported names — keeps
  // size sane and high-signal for "where does X live in code?" answers.
  const lines = text.split(/\r?\n/);
  let banner = '';
  if (lines[0]?.startsWith('/**')) {
    const end = lines.findIndex((l, i) => i > 0 && l.includes('*/'));
    if (end > 0) {
      banner = lines.slice(0, end + 1)
        .map((l) => l.replace(/^\s*\*\s?/, '').replace(/^\/\*\*\s?/, '').replace(/\s*\*\/$/, ''))
        .join('\n')
        .trim();
    }
  }
  const exports = lines
    .map((l) => l.match(/^export\s+(async\s+)?(function|class|interface|type|const)\s+([A-Za-z_][\w]*)/))
    .filter(Boolean)
    .map((m) => `${m![2]} ${m![3]}`);
  const apiRoutes = filePath.includes('/api/')
    ? lines.filter((l) => /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)/.test(l))
        .map((l) => l.replace(/.*function\s+/, '').replace(/\s*\(.*$/, ''))
    : [];
  const summary = [
    banner ? `Module: ${banner}` : '',
    exports.length ? `Exports: ${exports.join(', ')}` : '',
    apiRoutes.length ? `HTTP: ${apiRoutes.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
  // Cap source summaries at MAX_CHUNK so the chunk-size invariant holds
  // across both markdown and code paths.
  return summary.length > MAX_CHUNK ? summary.slice(0, MAX_CHUNK) : summary;
}

function docsUrlForPath(relPath: string): string | undefined {
  // docs/fiab/foo/bar.md → https://docs.../fiab/foo/bar/
  if (!relPath.startsWith('docs/')) return undefined;
  const slug = relPath.replace(/^docs\//, '').replace(/\.md$/, '');
  const base = process.env.LOOM_DOCS_BASE_URL || 'https://docs.csa-loom.local';
  return `${base.replace(/\/$/, '')}/${slug}/`;
}

// ---------- Content hashing + source enumeration (WS-G / G1) ----------

/** Stable content hash for a source doc (sha256 hex, 16 bytes → 32 chars). */
function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 32);
}

/** A source file the corpus draws from, with its kind + repo-relative path. */
interface SourceFileRef {
  abs: string;
  rel: string;
  kind: DocChunk['kind'];
}

/**
 * Enumerate every source file the corpus indexes — markdown docs + repo source
 * summaries — deduped by absolute path, in a deterministic order. Shared by
 * `collectSources` (the builder) and `statFingerprint` (the cheap freshness
 * probe) so both agree on the exact file set.
 */
function enumerateSourceFiles(roots: RepoRoots): SourceFileRef[] {
  const refs: SourceFileRef[] = [];
  const seen = new Set<string>();
  const rel = (file: string) => path.relative(roots.repoRoot, file).replace(/\\/g, '/');
  const mdSources: Array<{ root: string; kind: DocChunk['kind'] }> = [
    { root: path.join(roots.docsRoot, 'fiab'), kind: 'docs' },
    { root: roots.docsRoot, kind: 'docs' },
    { root: roots.prpRoot, kind: 'prp' },
    { root: roots.prpActiveRoot, kind: 'prp' },
    { root: roots.adrRoot, kind: 'adr' },
  ];
  for (const src of mdSources) {
    for (const file of walkMarkdown(src.root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      refs.push({ abs: file, rel: rel(file), kind: src.kind });
    }
  }
  const repoFiles = [
    ...walkSource(path.join(roots.consoleLibRoot, 'azure')),
    ...walkSource(path.join(roots.consoleLibRoot, 'editors')),
    ...walkSource(path.join(roots.consoleLibRoot, 'components')),
  ];
  for (const file of repoFiles) {
    if (seen.has(file)) continue;
    seen.add(file);
    refs.push({ abs: file, rel: rel(file), kind: 'repo' });
  }
  return refs;
}

/** Fast, read-free fingerprint (path:size:mtime) over the enumerated files —
 *  the cheap staleness signal the freshness probe compares to the manifest. */
function statFingerprint(refs: SourceFileRef[]): string {
  const parts = refs.map((r) => {
    try { const s = fs.statSync(r.abs); return `${r.rel}:${s.size}:${Math.floor(s.mtimeMs)}`; }
    catch { return `${r.rel}:missing`; }
  }).sort();
  return hashContent(parts.join('\n'));
}

interface CollectedCorpus {
  chunks: DocChunk[];
  /** path → { kind, content-hash, chunk count } for every indexed file. */
  files: Record<string, ManifestFileEntry>;
  statFingerprint: string;
  contentFingerprint: string;
}

/**
 * Walk the corpus once, producing the chunk list AND the per-file content-hash
 * map + fingerprints the incremental index (G1) and freshness guard (G2) need.
 * The chunk content is IDENTICAL to what the previous single-purpose walker
 * produced — the hashing is purely additive metadata.
 */
function collectSources(): CollectedCorpus {
  const roots = detectRoots();
  const refs = enumerateSourceFiles(roots);
  const chunks: DocChunk[] = [];
  const files: Record<string, ManifestFileEntry> = {};

  for (const ref of refs) {
    let raw = '';
    try { raw = fs.readFileSync(ref.abs, 'utf-8'); } catch { continue; }
    let stat: fs.Stats;
    try { stat = fs.statSync(ref.abs); } catch { continue; }
    const touchedAt = stat.mtime.toISOString();

    if (ref.kind === 'repo') {
      const summary = summarizeSource(ref.abs, raw);
      if (!summary) continue; // empty summary → nothing to index
      chunks.push({ id: docKey('repo', ref.rel, 0), kind: 'repo', path: ref.rel, content: summary, touchedAt });
      files[ref.rel] = { kind: 'repo', hash: hashContent(raw), chunks: 1 };
      continue;
    }

    const blocks = chunkMarkdown(raw);
    if (blocks.length === 0) continue;
    blocks.forEach((b, idx) => {
      chunks.push({
        id: docKey(ref.kind, ref.rel, idx),
        kind: ref.kind,
        path: ref.rel,
        heading: b.heading,
        content: b.content,
        url: docsUrlForPath(ref.rel),
        touchedAt,
      });
    });
    files[ref.rel] = { kind: ref.kind, hash: hashContent(raw), chunks: blocks.length };
  }

  const contentFingerprint = hashContent(
    Object.keys(files).sort().map((p) => `${p}:${files[p].hash}`).join('\n'),
  );
  return { chunks, files, statFingerprint: statFingerprint(refs), contentFingerprint };
}

// ---------- Manifest persistence (WS-G / G1 + G2) ----------
//
// #2964 — WHY THE AI SEARCH MANIFEST IS SPLIT ACROSS DOCUMENTS
// -----------------------------------------------------------
// The manifest carries a per-source-file map (`files`) that is ~480 KB for the
// live corpus (2,604 files). It used to be written as ONE AI Search document
// with the whole JSON in `content`, and AI Search rejected it every single time:
//
//   HTTP 207, value[0].status = false,
//   "Field 'content' contains a term that is too large to process.
//    The max length for UTF-8 encoded terms is 32766 bytes."
//
// 207 is a 2xx, so `response.ok` was true, the rejection lived only in the
// response BODY (which nothing read), and the write silently no-op'd. The
// manifest therefore never existed, `corpusFreshness()` answered
// `never-indexed` forever, and the incremental path could never engage — every
// reindex was a full rebuild. Verified against a live search service: 32,766
// bytes is accepted, 32,770 is not.
//
// So the manifest is now persisted as:
//   `corpus-manifest`      — the HEAD: everything EXCEPT `files`, ~250 bytes.
//                            This is all `corpusFreshness()` needs, so the
//                            completion signal CI gates on is one small read.
//   `corpus-manifest_f<i>` — gzip+base64 shards of the `files` map, each well
//                            under the term ceiling. base64 is ASCII, so a
//                            character budget IS a byte budget (no multi-byte
//                            slicing hazard).
// Shards are written BEFORE the head, so an interrupted write leaves no head at
// all → `never-indexed` → a safe full rebuild, never a half-manifest that reads
// as complete.
//
// Cosmos keeps the single-document form: its 2 MB document ceiling accommodates
// the whole manifest and that round-trip is covered by the existing tests.

/** Empirically confirmed AI Search ceiling for a single indexed term. */
const SEARCH_MAX_TERM_BYTES = 32_766;
/** base64 chars per shard — ASCII, so this is also the byte count. */
const MANIFEST_SHARD_CHARS = 24_000;
const manifestShardKey = (i: number): string => `${MANIFEST_KEY}_f${i}`;

/** The manifest minus its bulky `files` map, plus how many shards carry it. */
type CorpusManifestHead = Omit<CorpusManifest, 'files'> & {
  /** Number of `corpus-manifest_f<i>` shards holding the gzip+base64 `files` map. */
  fileShards?: number;
  /** Present on the LEGACY single-document form (Cosmos). */
  files?: Record<string, ManifestFileEntry>;
};

function encodeFiles(files: Record<string, ManifestFileEntry>): string[] {
  const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(files), 'utf-8')).toString('base64');
  const shards: string[] = [];
  for (let i = 0; i < b64.length; i += MANIFEST_SHARD_CHARS) {
    shards.push(b64.slice(i, i + MANIFEST_SHARD_CHARS));
  }
  return shards;
}

function decodeFiles(b64: string): Record<string, ManifestFileEntry> {
  return JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf-8'));
}

/** One AI Search document lookup by key. Returns null on 404/transient. */
async function lookupSearchDoc(svc: string, tok: string, key: string): Promise<any | null> {
  const r = await fetchWithTimeout(
    `https://${svc}.search.windows.net/indexes/${INDEX}/docs/${encodeURIComponent(key)}?api-version=${SEARCH_API}`,
    { headers: { authorization: `Bearer ${tok}` } },
  );
  if (!r.ok) return null; // 404 (never indexed) or transient → full rebuild
  return r.json();
}

/**
 * Read ONLY the manifest head — the cheap, single-read path used by
 * `corpusFreshness()` (and therefore by the health probe and the CI reindex
 * poller). Never pulls the `files` shards.
 */
async function loadManifestHead(backend: 'ai-search' | 'cosmos'): Promise<CorpusManifestHead | null> {
  try {
    if (backend === 'ai-search') {
      const svc = searchServiceName();
      if (!svc) return null;
      const tok = await searchToken();
      const j = await lookupSearchDoc(svc, tok, MANIFEST_KEY);
      if (!j?.content) return null;
      return JSON.parse(j.content) as CorpusManifestHead;
    }
    const c = await helpCorpusContainer();
    const r = await c.item(MANIFEST_KEY, META_KIND).read<any>().catch(() => ({ resource: null }));
    const doc = r.resource;
    if (!doc?.content) return null;
    return JSON.parse(doc.content) as CorpusManifestHead;
  } catch (e: any) {
    console.warn('[loom-docs-index] manifest head load failed', e?.message);
    return null;
  }
}

/** Read the corpus manifest from the store the chunks live in (AI Search index
 *  doc or the Cosmos corpus container). Returns null when absent/unreadable —
 *  which safely forces a full rebuild. */
async function loadManifest(backend: 'ai-search' | 'cosmos'): Promise<CorpusManifest | null> {
  const head = await loadManifestHead(backend);
  if (!head) return null;
  // Cosmos (and any legacy doc) still carries `files` inline.
  if (head.files) return head as CorpusManifest;
  const shardCount = head.fileShards ?? 0;
  if (shardCount <= 0) return null; // no file map → nothing to diff against
  try {
    const svc = searchServiceName();
    if (backend !== 'ai-search' || !svc) return null;
    const tok = await searchToken();
    let b64 = '';
    for (let i = 0; i < shardCount; i++) {
      const j = await lookupSearchDoc(svc, tok, manifestShardKey(i));
      if (typeof j?.content !== 'string') {
        console.warn(`[loom-docs-index] manifest shard ${i}/${shardCount} missing — forcing a full rebuild`);
        return null;
      }
      b64 += j.content;
    }
    const { fileShards: _shards, ...rest } = head;
    return { ...(rest as Omit<CorpusManifest, 'files'>), files: decodeFiles(b64) };
  } catch (e: any) {
    console.warn('[loom-docs-index] manifest files load failed', e?.message);
    return null;
  }
}

/**
 * Persist the corpus manifest into the same store as the chunks.
 *
 * Returns a VERIFIED outcome. The freshness signal the whole reindex gate
 * depends on is this write, so a failure here must never be swallowed — before
 * #2964 it was, and the gate reported success while measuring nothing.
 */
async function saveManifest(
  backend: 'ai-search' | 'cosmos',
  manifest: CorpusManifest,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (backend === 'ai-search') {
      const svc = searchServiceName();
      if (!svc) return { ok: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
      const tok = await searchToken();
      const shards = encodeFiles(manifest.files);
      const { files: _files, ...headFields } = manifest;
      const head: CorpusManifestHead = { ...headFields, fileShards: shards.length };
      const headContent = JSON.stringify(head);
      if (Buffer.byteLength(headContent, 'utf-8') > SEARCH_MAX_TERM_BYTES) {
        return { ok: false, error: `manifest head is ${Buffer.byteLength(headContent, 'utf-8')} bytes, over the ${SEARCH_MAX_TERM_BYTES}-byte AI Search term ceiling` };
      }

      // Shards FIRST — the head is the completion marker.
      for (let i = 0; i < shards.length; i++) {
        const out = await indexBatch(svc, tok, [{
          '@search.action': 'mergeOrUpload',
          id: manifestShardKey(i), kind: META_KIND, path: '__corpus_manifest__',
          content: shards[i], touchedAt: manifest.builtAt,
        }]);
        if (!out.ok) return { ok: false, error: `manifest shard ${i}/${shards.length}: ${out.error}` };
      }
      const headOut = await indexBatch(svc, tok, [{
        '@search.action': 'mergeOrUpload',
        id: MANIFEST_KEY, kind: META_KIND, path: '__corpus_manifest__',
        content: headContent, touchedAt: manifest.builtAt,
      }]);
      if (!headOut.ok) return { ok: false, error: `manifest head: ${headOut.error}` };

      // Drop shards left over from a LARGER previous manifest. Harmless if they
      // linger (readers only walk 0..fileShards-1 and `kind:'__meta__'` is
      // filtered out of every query), but they would otherwise accumulate.
      await pruneManifestShards(svc, tok, shards.length);
      return { ok: true };
    }
    const c = await helpCorpusContainer();
    await c.items.upsert({
      id: MANIFEST_KEY, kind: META_KIND, path: '__corpus_manifest__',
      content: JSON.stringify(manifest), touchedAt: manifest.builtAt,
    });
    return { ok: true };
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.warn('[loom-docs-index] manifest save failed', msg);
    return { ok: false, error: msg };
  }
}

/** Best-effort removal of `corpus-manifest_f<i>` docs at or beyond `keep`. */
async function pruneManifestShards(svc: string, tok: string, keep: number): Promise<void> {
  const stale: string[] = [];
  // Walk forward until the first gap; shard keys are dense by construction.
  for (let i = keep; i < keep + 64; i++) {
    const j = await lookupSearchDoc(svc, tok, manifestShardKey(i));
    if (!j) break;
    stale.push(manifestShardKey(i));
  }
  if (stale.length === 0) return;
  const out = await indexBatch(svc, tok, stale.map((id) => ({ '@search.action': 'delete', id })));
  if (!out.ok) console.warn('[loom-docs-index] stale manifest shard prune incomplete', out.error);
}

/** Persist the corpus manifest into the same store as the chunks. */
interface ManifestDiff {
  /** Paths that are new or content-changed → re-upload their chunks. */
  changedPaths: Set<string>;
  /** Orphaned chunk keys to delete (removed docs + shrunk docs' tail chunks). */
  deleteIds: string[];
  /** Same, carrying the kind (Cosmos partition key) for the Cosmos delete path. */
  deleteEntries: Array<{ id: string; kind: DocChunk['kind'] }>;
  removed: number;
  changed: number;
  unchanged: number;
}

/**
 * Pure diff of a previous manifest's file map vs the freshly-collected one.
 * Correctness vs a full rebuild: a full rebuild `mergeOrUpload`s every chunk and
 * (implicitly) leaves removed docs' chunks behind; the incremental path uploads
 * exactly the new/changed docs' chunks (byte-identical to what a full build
 * would upload for those docs) AND additionally deletes removed/shrunk docs'
 * orphaned chunks — so the resulting index is a strict improvement, never a
 * divergence, on the changed set while unchanged docs keep their existing chunks.
 */
function diffManifest(
  prev: Record<string, ManifestFileEntry>,
  next: Record<string, ManifestFileEntry>,
): ManifestDiff {
  const changedPaths = new Set<string>();
  const deleteEntries: Array<{ id: string; kind: DocChunk['kind'] }> = [];
  let removed = 0, changed = 0, unchanged = 0;

  for (const [p, entry] of Object.entries(next)) {
    const before = prev[p];
    if (!before) { changedPaths.add(p); changed++; continue; }
    if (before.hash !== entry.hash) {
      changedPaths.add(p); changed++;
      // Shrink: old high-index chunks are no longer produced → delete them.
      for (let i = entry.chunks; i < before.chunks; i++) {
        deleteEntries.push({ id: docKey(before.kind, p, i), kind: before.kind });
      }
    } else {
      unchanged++;
    }
  }
  for (const [p, before] of Object.entries(prev)) {
    if (next[p]) continue;
    removed++;
    for (let i = 0; i < before.chunks; i++) {
      deleteEntries.push({ id: docKey(before.kind, p, i), kind: before.kind });
    }
  }
  return { changedPaths, deleteIds: deleteEntries.map((e) => e.id), deleteEntries, removed, changed, unchanged };
}

// ---------- Corpus freshness guard (WS-G / G2) ----------

export type CorpusFreshnessState = 'fresh' | 'stale' | 'never-indexed';

export interface CorpusFreshness {
  state: CorpusFreshnessState;
  reason: string;
  backend: 'ai-search' | 'cosmos';
  indexedAt: string | null;
  indexedChunkCount: number | null;
  currentStatFingerprint: string;
  indexedStatFingerprint: string | null;
  sourceCommit: string | null;
  indexedCommit: string | null;
}

/** The staged source commit / build SHA, when the image stamps it. */
function currentSourceCommit(): string | null {
  return (process.env.LOOM_BUILD_SHA || '').trim() || null;
}

/** Pure freshness evaluation from the current stat fingerprint + the manifest. */
export function evaluateFreshness(
  currentStat: string,
  manifest: Pick<CorpusManifest, 'statFingerprint'> | null,
): { state: CorpusFreshnessState; reason: string } {
  if (!manifest) return { state: 'never-indexed', reason: 'The Help Copilot corpus has never been indexed in this backend.' };
  if (manifest.statFingerprint !== currentStat) {
    return { state: 'stale', reason: 'Staged docs have changed since the last index build (source fingerprint differs).' };
  }
  return { state: 'fresh', reason: 'The indexed corpus matches the staged docs.' };
}

/**
 * How many source files the corpus walker can currently SEE — a stat-only
 * enumeration, no file reads, no network. Milliseconds.
 *
 * This is the reindex PREFLIGHT (#2929). `reindex()` returns
 * `ok:false … 'No corpus chunks discovered'` when the walker finds nothing,
 * which is exactly what the live console did on 2026-08-04: the image that
 * routine builds produce ships `copilot-corpus/` holding only `.gitkeep`
 * (only full-app-deploy-commercial.yml ran stage-copilot-corpus.sh), so
 * `detectRoots()` found no bundled corpus, fell through to the dev walk-up for
 * `mkdocs.yml`, found no repo either, and enumerated ZERO files. Checking that
 * BEFORE going async keeps the failure loud and IMMEDIATE (a 502 in ~160ms)
 * instead of burying it behind a poll that can only time out.
 */
export function corpusSourceCount(): number {
  return enumerateSourceFiles(detectRoots()).length;
}

/**
 * Compare the staged/source corpus against what was last indexed. Cheap: a
 * stat-only walk + a SINGLE manifest-head read (no file contents re-hashed, no
 * `files` shards pulled). Used by the copilot-corpus health probe so a stale
 * corpus is detectable at runtime, and by the CI reindex poller as the durable
 * cross-replica completion signal.
 */
export async function corpusFreshness(): Promise<CorpusFreshness> {
  const backend: 'ai-search' | 'cosmos' = isSearchConfigured() ? 'ai-search' : 'cosmos';
  const currentStat = statFingerprint(enumerateSourceFiles(detectRoots()));
  const manifest = await loadManifestHead(backend);
  const { state, reason } = evaluateFreshness(currentStat, manifest);
  return {
    state, reason, backend,
    indexedAt: manifest?.builtAt ?? null,
    indexedChunkCount: manifest?.chunkCount ?? null,
    currentStatFingerprint: currentStat,
    indexedStatFingerprint: manifest?.statFingerprint ?? null,
    sourceCommit: currentSourceCommit(),
    indexedCommit: manifest?.sourceCommit ?? null,
  };
}

export interface ReindexResult {
  ok: boolean;
  backend: 'ai-search' | 'cosmos' | 'none';
  totalChunks: number;
  uploaded: number;
  byKind: Record<string, number>;
  error?: string;
  warnings: string[];
  /** WS-G incremental metadata (optional — legacy readers ignore these). */
  mode?: 'full' | 'incremental';
  /** Chunks skipped because their source doc was unchanged (incremental only). */
  skipped?: number;
  /** Source docs re-indexed (new or content-changed). */
  changed?: number;
  /** Source docs removed since the last index. */
  removed?: number;
  /** Orphaned chunks deleted from the backend. */
  deleted?: number;
}

export async function buildCorpus(): Promise<DocChunk[]> {
  return collectSources().chunks;
}

export async function reindex(opts?: { full?: boolean }): Promise<ReindexResult> {
  const warnings: string[] = [];
  // The BM25 index is keyed on chunk IDS, which are stable across a pure content
  // edit — so a reindex must drop it explicitly or this replica would keep
  // ranking against the pre-reindex text.
  resetDocsRankerCache();
  const { chunks, files, statFingerprint: statFp, contentFingerprint } = collectSources();
  const byKind: Record<string, number> = {};
  for (const c of chunks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

  if (chunks.length === 0) {
    return {
      ok: false, backend: 'none', totalChunks: 0, uploaded: 0, byKind,
      warnings, error: 'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
    };
  }

  // Resolve the backend (AI Search preferred). ensureDocsIndex tells us whether
  // the index was just CREATED — a brand-new/empty index means we MUST do a full
  // build even if a stale manifest somehow survives.
  let backend: 'ai-search' | 'cosmos';
  let freshIndex = false;
  if (isSearchConfigured()) {
    const ensure = await ensureDocsIndex();
    if (ensure.ok) {
      backend = 'ai-search';
      freshIndex = ensure.created;
    } else {
      warnings.push(`AI Search index ensure failed: ${ensure.error}. Falling back to Cosmos.`);
      backend = 'cosmos';
    }
  } else {
    warnings.push('LOOM_AI_SEARCH_SERVICE not set — using Cosmos substring fallback. ' +
      'Set the env var and re-run /api/help-copilot/reindex to enable hybrid search.');
    backend = 'cosmos';
  }

  const buildManifest = (be: 'ai-search' | 'cosmos'): CorpusManifest => ({
    version: MANIFEST_VERSION,
    backend: be,
    indexName: be === 'ai-search' ? INDEX : COSMOS_CONTAINER_ID,
    builtAt: new Date().toISOString(),
    sourceCommit: currentSourceCommit(),
    statFingerprint: statFp,
    contentFingerprint,
    files,
    chunkCount: chunks.length,
  });
  const changedCount = Object.keys(files).length;

  /**
   * Persist the manifest and FOLD the verified outcome into the result.
   *
   * #2964 — the manifest IS the completion signal (`corpusFreshness()` →
   * `state:'fresh'`), which the CI poller and `console-bluegreen-roll` gate on.
   * A run that uploaded every chunk but could not persist the manifest has NOT
   * completed as far as any caller can observe, so it must report `ok:false`.
   * Before this, the write was fire-and-forget: the job went `succeeded`,
   * freshness stayed `never-indexed`, and the poller could only time out after
   * 900s with no reason. Now the failure is immediate and names the cause.
   */
  const persist = async (be: 'ai-search' | 'cosmos', result: ReindexResult): Promise<ReindexResult> => {
    const saved = await saveManifest(be, buildManifest(be));
    if (saved.ok) return result;
    return {
      ...result,
      ok: false,
      error: `Corpus indexed, but the freshness manifest could not be persisted to ${be}: ${saved.error}. ` +
        'Callers gate on corpusFreshness() === "fresh", which reads that manifest, so this run is NOT complete.',
    };
  };

  /** A push that partially succeeded still returns ok — surface the loss. */
  const noteChunkLoss = (r: { ok: boolean; error?: string }) => {
    if (r.ok && r.error) warnings.push(r.error);
  };

  // Full-rebuild path (also the AI-Search→Cosmos fallback), preserving the
  // original resilience: if AI Search upload fails, fall back to a full Cosmos push.
  const runFull = async (): Promise<ReindexResult> => {
    if (backend === 'ai-search') {
      const r = await pushChunksToSearch(chunks);
      if (!r.ok) {
        warnings.push(`AI Search upload failed: ${r.error}. Falling back to Cosmos.`);
        const c = await pushChunksToCosmos(chunks);
        return persist('cosmos', { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 });
      }
      noteChunkLoss(r);
      return persist('ai-search', { ok: true, backend: 'ai-search', totalChunks: chunks.length, uploaded: r.uploaded, byKind, warnings, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 });
    }
    const c = await pushChunksToCosmos(chunks);
    return persist('cosmos', { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 });
  };

  // Decide full vs incremental. Incremental requires a same-backend manifest and
  // a non-fresh index (and not an explicit full request).
  const prev = opts?.full ? null : await loadManifest(backend);
  const canIncremental = !!prev && prev.backend === backend && !freshIndex && !opts?.full;
  if (!canIncremental || !prev) return runFull();

  const diff = diffManifest(prev.files, files);
  const toUpsert = chunks.filter((c) => diff.changedPaths.has(c.path));
  const skipped = chunks.length - toUpsert.length;

  if (backend === 'ai-search') {
    const up = await pushChunksToSearch(toUpsert);
    if (!up.ok) {
      warnings.push(`AI Search incremental upload failed: ${up.error}. Falling back to a full Cosmos rebuild.`);
      backend = 'cosmos';
      const c = await pushChunksToCosmos(chunks);
      return persist('cosmos', { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 });
    }
    noteChunkLoss(up);
    const del = await deleteChunksFromSearch(diff.deleteIds);
    if (!del.ok) warnings.push(`AI Search stale-chunk delete incomplete: ${del.error}`);
    return persist('ai-search', { ok: true, backend: 'ai-search', totalChunks: chunks.length, uploaded: up.uploaded, byKind, warnings, mode: 'incremental', skipped, changed: diff.changed, removed: diff.removed, deleted: del.deleted });
  }

  const up = await pushChunksToCosmos(toUpsert);
  const del = await deleteChunksFromCosmos(diff.deleteEntries);
  return persist('cosmos', { ok: up.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: up.uploaded, byKind, warnings, error: up.error, mode: 'incremental', skipped, changed: diff.changed, removed: diff.removed, deleted: del.deleted });
}

// ---------- Test-only internals (WS-G) ----------
// Exposed for unit tests of the pure hash / manifest-diff / collect logic. Not
// part of the public API; do not import from app code.
export const __testInternals = {
  hashContent,
  docKey,
  diffManifest,
  collectSources,
  enumerateSourceFiles,
  statFingerprint,
  detectRoots,
  // #2929 — the shared candidate re-rank both backends run. Exposed so a unit
  // test can prove the AI Search path and the Cosmos path produce the same
  // ordering for the same candidate documents.
  rankChunks,
  // #2964 — the manifest shard codec + the AI Search ceiling it exists to stay
  // under, so a test can prove no single manifest document can exceed it.
  encodeFiles,
  decodeFiles,
  SEARCH_MAX_TERM_BYTES,
  MANIFEST_SHARD_CHARS,
  MANIFEST_KEY,
  manifestShardKey,
  // #2970 — point the AI Search path's corpus statistics at a synthetic corpus
  // so a backend-symmetry test can hold BOTH paths to the same corpus. Pass
  // `undefined` to restore the real bundled-corpus source.
  setCorpusStatsForTests: (stats: Bm25CorpusStats | null | undefined): void => {
    corpusStatsOverride = stats;
  },
  localCorpusStats,
};
