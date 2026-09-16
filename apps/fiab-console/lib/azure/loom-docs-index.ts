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
 *
 * SCOPE (2026-08-06, #2970): this module owns STORAGE + RETRIEVAL — the two
 * backends, the shared BM25 re-rank, `searchDocs`, the freshness manifest and
 * `reindex`. Turning source files into chunks, hashes and fingerprints is a
 * separate bounded context and lives in `./loom-docs-corpus` (filesystem + text
 * only, no Azure surface at all). `DocChunk` is re-exported from here so
 * existing consumers are unaffected by that split.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import zlib from 'node:zlib';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Container } from '@azure/cosmos';

import { copilotSessionsContainer } from './cosmos-client';
import { recordRetrieval } from '@/lib/perf/retrieval-metrics';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import {
  diversifyByDocument,
  surfaceTopicTerms,
  DEFAULT_MAX_CHUNKS_PER_DOC,
} from './docs-ranker';
import {
  collectSources,
  corpusSourceCount,
  detectRoots,
  docKey,
  enumerateSourceFiles,
  hashContent,
  localCorpusStats,
  setCorpusStatsForTests,
  statFingerprint,
  type DocChunk,
  type ManifestFileEntry,
} from './loom-docs-corpus';
import {
  AI_SEARCH_CANDIDATE_WINDOW,
  RETRIEVAL_OVERFETCH,
  bm25IndexFor,
  rankChunks,
  resetDocsRankerCache,
  type DocHit,
} from './docs-corpus-ranker';
import { currentSourceCommit, isBuildCommit, sameCommit } from './build-stamp';

// ---------- Types ----------

// `DocChunk` is produced by the corpus walker, so it is DECLARED in
// ./loom-docs-corpus and re-exported here — every existing importer of
// `DocChunk` from this module keeps working unchanged.
export type { DocChunk };

// `DocHit` is produced by the corpus ranker, so it is DECLARED in
// ./docs-corpus-ranker and re-exported here — same treatment as `DocChunk`
// above, and every existing importer keeps working unchanged.
export type { DocHit };
export { AI_SEARCH_CANDIDATE_WINDOW, resetDocsRankerCache } from './docs-corpus-ranker';


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

/**
 * The corpus container handle, memoised for the life of the process.
 *
 * WHY MEMOISE (#4498 round 4) — `createIfNotExists` is a CONTROL-PLANE call,
 * and without this memo every `helpCorpusContainer()` issued one. That lands on
 * a POLL: `corpusFreshness` is what the roll's reindex step waits on, looping
 * for up to ~15 minutes, and it also backs `/admin/readiness` and
 * `/api/admin/performance/retrieval-stats` per request.
 *
 * It was not even once per poll on the Cosmos backend only. `loadLastRun` reads
 * BOTH stores unconditionally — deliberately, and for a reason argued at its
 * own doc comment — so a deployment running the AI Search backend, which never
 * stores a corpus chunk in Cosmos, still took a Cosmos control-plane round trip
 * on every poll. That is the cost this PR would otherwise have added to the very
 * path it exists to make reliable.
 *
 * The precedent is `ensure()` in `cosmos-client.ts`, memoised by `_ensured` for
 * exactly this reason. This memo holds the PROMISE rather than the resolved
 * handle, so concurrent callers share one in-flight call instead of racing two;
 * `COSMOS_CONTAINER_ID` is a module constant, so there is no key to vary on. A
 * rejection CLEARS the memo — caching a failure would convert one transient
 * Cosmos error into a permanently corpus-less process.
 *
 * THE TRADE-OFF, stated rather than discovered later: `auto-bind-by-default.md`
 * §3 wants a binding to re-heal when its backing object is deleted out of band,
 * and before this memo every call re-ran `createIfNotExists` and would have
 * re-created a deleted `help-corpus`. Now the process holds a stale handle until
 * it rolls. Accepted for two reasons — `saveManifest` throws on the dead handle
 * and `persist` folds that to `ok:false`, so a reindex fails LOUDLY rather than
 * silently indexing nowhere; and `cosmos-client.ts`'s `_ensured` already sets
 * this precedent for 60+ containers, so this is the existing bargain, not a new
 * one.
 */
let _corpusContainer: Promise<Container> | null = null;

/** Drop the memoised handle. Tests only — see `__testInternals`. */
function __resetCorpusContainerForTests(): void {
  _corpusContainer = null;
}

async function helpCorpusContainer(): Promise<Container> {
  // DELIBERATELY ABOVE THE MEMO CHECK (#4498 round 5, reviewer finding).
  // `copilotSessionsContainer()` is the only production path into `ensure()` in
  // `cosmos-client.ts`, and `ensure()` opens with `await injectCosmosFault()`
  // under a comment saying that placement exists so an armed fault injects on
  // EVERY container accessor and not just the first. Round 4 put this memo in
  // FRONT of that chokepoint, which re-opened the hole: a chaos run over the
  // corpus/last-run path would have injected on poll one and served every later
  // poll from the memo, reporting resilience it never measured. Inert in
  // production — `injectCosmosFault` is a no-op unless the harness is armed and
  // `LOOM_DEPENDENCY_CHAOS_ENABLED` is set — and it costs nothing to keep,
  // because `ensure()` short-circuits on `_ensured` and issues no control-plane
  // call after the first. The saving the memo exists for is `createIfNotExists`,
  // which is still memoised below.
  //
  // The await here does not re-open a double-create race. Two concurrent first
  // callers both suspend on this line, but whichever resumes first runs from the
  // check to `_corpusContainer = pending` with no await in between, so the
  // install is atomic and the second caller observes it.
  const cs = await copilotSessionsContainer();
  if (_corpusContainer) return _corpusContainer;
  // Re-use the cosmos-client singleton via copilotSessionsContainer's `ensure()`
  // by piggy-backing on the same database. We could expose a generic builder
  // but inlining keeps the diff small and reuses connection + auth.
  const pending = (async () => {
    const db = (cs as any).database; // @azure/cosmos exposes database off Container
    const { container } = await db.containers.createIfNotExists({
      id: COSMOS_CONTAINER_ID,
      partitionKey: { paths: ['/kind'] },
    });
    return container as Container;
  })();
  _corpusContainer = pending;
  // Only clear if THIS attempt is still the memoised one — a retry may already
  // have replaced it by the time this rejection settles. The identity check is a
  // NO-OP in production and is not claimed otherwise: installing a replacement
  // requires the memo to be falsy, which only this catch produces, so no
  // production ordering reaches it holding a different promise. It is
  // load-bearing only for `__resetCorpusContainerForTests()`, which can null the
  // memo mid-flight. A reviewer mutated the guard away and the suite stayed
  // green; that is a weak mutation, not a blind test, and the honest fix is to
  // say so here rather than add a test that would only exercise the test hook.
  pending.catch(() => {
    if (_corpusContainer === pending) _corpusContainer = null;
  });
  return pending;
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
/** A manifest-head read, with ABSENT and UNREADABLE kept apart.
 *
 * `head: null, error: null` means the store answered and there is no manifest.
 * `head: null, error: '...'` means the store did not answer. Collapsing the
 * second into the first is what let `corpusFreshness()` assert "never indexed"
 * about a corpus it had simply failed to look at (R7). */
interface ManifestHeadRead {
  head: CorpusManifestHead | null;
  error: string | null;
}

async function loadManifestHead(backend: 'ai-search' | 'cosmos'): Promise<ManifestHeadRead> {
  try {
    if (backend === 'ai-search') {
      const svc = searchServiceName();
      // NOT "absent": this replica cannot look at all. A replica with the env
      // var unset would otherwise report a corpus it cannot see as unbuilt.
      if (!svc) return { head: null, error: 'AI Search is not configured on this replica (LOOM_AI_SEARCH_SERVICE is unset)' };
      const tok = await searchToken();
      const j = await lookupSearchDoc(svc, tok, MANIFEST_KEY);
      if (!j?.content) return { head: null, error: null };
      return { head: JSON.parse(j.content) as CorpusManifestHead, error: null };
    }
    const c = await helpCorpusContainer();
    const r = await c.item(MANIFEST_KEY, META_KIND).read<any>().catch(() => ({ resource: null }));
    const doc = r.resource;
    if (!doc?.content) return { head: null, error: null };
    return { head: JSON.parse(doc.content) as CorpusManifestHead, error: null };
  } catch (e: any) {
    const message = e?.message || String(e);
    console.warn('[loom-docs-index] manifest head load failed', message);
    return { head: null, error: message };
  }
}

/** Read the corpus manifest from the store the chunks live in (AI Search index
 *  doc or the Cosmos corpus container). Returns null when absent/unreadable —
 *  which safely forces a full rebuild. */
async function loadManifest(backend: 'ai-search' | 'cosmos'): Promise<CorpusManifest | null> {
  // Absent and unreadable are both `null` HERE, and that is correct for THIS
  // caller: the incremental path only needs "is there a file map to diff
  // against", and both answers are no. The distinction matters to
  // `corpusFreshness`, which REPORTS a state, not to a builder that falls back
  // to a full rebuild either way.
  const { head } = await loadManifestHead(backend);
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
const LAST_RUN_KEY = 'corpus-last-run';

/**
 * Record the outcome of a rebuild attempt where EVERY replica can read it.
 *
 * Best-effort by design, and it must stay that way: this is diagnosis, so a
 * failure to write it must never turn a successful rebuild into a failure. But
 * it is attempted on the FAILURE path too, which is the whole point — the case
 * that defeated the roll is the manifest write itself failing, and a record
 * that only exists when the manifest succeeded could never describe it.
 *
 * IT FALLS BACK TO THE OTHER STORE, because the honest scope of the original
 * claim was narrower than the claim. A reviewer measured three failure classes:
 * a rejected manifest DOCUMENT writes the record fine, but an AI Search 503
 * from the manifest write onward, and a write-403 that fell back to Cosmos,
 * both left `lastRun` null — the record died of the same cause as the thing it
 * was meant to explain. Trying the other backend does not make this
 * bulletproof and is not claimed to: a total outage of both stores still
 * leaves nothing to read, and the poller's timeout is still the backstop for
 * that. It removes the single-store correlation, which is the common case.
 */
async function saveLastRun(
  backend: 'ai-search' | 'cosmos',
  run: CorpusLastRun,
): Promise<void> {
  const order: ('ai-search' | 'cosmos')[] =
    backend === 'ai-search' ? ['ai-search', 'cosmos'] : ['cosmos', 'ai-search'];
  const failures: string[] = [];
  for (const store of order) {
    try {
      const content = JSON.stringify(run);
      if (store === 'ai-search') {
        const svc = searchServiceName();
        if (!svc) { failures.push('ai-search: not configured'); continue; }
        const tok = await searchToken();
        const out = await indexBatch(svc, tok, [{
          '@search.action': 'mergeOrUpload',
          id: LAST_RUN_KEY, kind: META_KIND, path: '__corpus_last_run__',
          content, touchedAt: run.finishedAt,
        }]);
        // `indexBatch` REPORTS failure rather than throwing, so an unchecked
        // call here would have looked like a successful write.
        if (!out.ok) { failures.push(`ai-search: ${out.error}`); continue; }
        return;
      }
      const c = await helpCorpusContainer();
      await c.items.upsert({
        id: LAST_RUN_KEY, kind: META_KIND, path: '__corpus_last_run__',
        content, touchedAt: run.finishedAt,
      });
      return;
    } catch (e: any) {
      failures.push(`${store}: ${e?.message || String(e)}`);
    }
  }
  console.warn('[loom-docs-index] last-run record could not be persisted to any store:',
    failures.join('; '));
}

/** Read the last-run record out of ONE store. Null when absent or unreadable —
 *  this is corroborating detail beside a freshness state that has already been
 *  decided, so it never needs to distinguish the two. */
async function readLastRunFrom(store: 'ai-search' | 'cosmos'): Promise<CorpusLastRun | null> {
  try {
    if (store === 'ai-search') {
      const svc = searchServiceName();
      if (!svc) return null;
      const tok = await searchToken();
      const j = await lookupSearchDoc(svc, tok, LAST_RUN_KEY);
      if (!j?.content) return null;
      return JSON.parse(j.content) as CorpusLastRun;
    }
    const c = await helpCorpusContainer();
    const r = await c.item(LAST_RUN_KEY, META_KIND).read<any>().catch(() => ({ resource: null }));
    if (!r.resource?.content) return null;
    return JSON.parse(r.resource.content) as CorpusLastRun;
  } catch {
    return null;
  }
}

/**
 * Read the last rebuild attempt any replica recorded, from EITHER store.
 *
 * It must walk the same two stores `saveLastRun` writes to, or the fallback it
 * performs is unreadable and buys nothing. That was the shape of the original
 * defect in miniature: the write survived a single-store outage and the read
 * did not, so the record existed and the poller still saw `lastRun: null` —
 * indistinguishable from never having been written, which is the one thing the
 * durable record exists to tell apart.
 *
 * Both stores can legitimately hold a record: the fallback writes to the other
 * backend while a stale copy from an earlier, healthier run sits in the primary.
 * So this is NOT first-answer-wins — it takes the one with the newer
 * `finishedAt`. An unparseable or absent timestamp loses to a comparable one,
 * and when neither is comparable the primary backend wins, matching the store
 * `saveLastRun` tries first.
 *
 * Both reads are issued unconditionally and concurrently rather than consulting
 * the second store only when the first comes back empty: a primary that answers
 * can still be answering with an OLDER record than the fallback wrote, and a
 * short-circuit would return it as "the last run". What the extra round trip
 * costs is stated as a SHAPE, not a measurement — an earlier revision of this
 * paragraph said it was "small beside the source-tree stat walk `corpusFreshness`
 * performs", which reads as measured and was only reasoned, and comparing the two
 * would need a live estate. Established: it is a single point read by document
 * id, on a memoised container handle (see `helpCorpusContainer`), so it carries
 * no control-plane call; and an unconfigured or unreachable store costs one
 * caught rejection, not a retry loop.
 */
async function loadLastRun(backend: 'ai-search' | 'cosmos'): Promise<CorpusLastRun | null> {
  const other: 'ai-search' | 'cosmos' = backend === 'ai-search' ? 'cosmos' : 'ai-search';
  const [primary, secondary] = await Promise.all([
    readLastRunFrom(backend),
    readLastRunFrom(other),
  ]);
  if (!primary) return secondary;
  if (!secondary) return primary;
  const at = (r: CorpusLastRun): number => {
    const t = Date.parse(String((r as any)?.finishedAt ?? ''));
    return Number.isFinite(t) ? t : -Infinity;
  };
  return at(secondary) > at(primary) ? secondary : primary;
}

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

export type CorpusFreshnessState = 'fresh' | 'stale' | 'never-indexed' | 'unknown';

/**
 * The outcome of the LAST rebuild attempt, persisted where every replica can
 * read it.
 *
 * WHY THIS EXISTS (roll 34648534467, 2026-09-11). `reindex()` records its
 * outcome — succeeded, failed, or thrown — ONLY in `startReindexJob()`'s
 * in-memory job state, which is scoped to the replica that ran it. Front Door
 * session affinity is Disabled and the console runs 2-6 replicas, so a poll
 * almost never lands on that replica: every other one answers `job=idle` with
 * whatever manifest it can read. The roll's reindex step polled for 912
 * seconds, read `stale`/`idle` 55 times, and failed with "NOTHING WAS OBSERVED
 * RUNNING" — which is true about what it saw and says nothing about what
 * happened.
 *
 * Note what that leaves unresolved: whether that rebuild failed is still
 * unknown, and it is unknowable from the outside, because the only place an
 * outcome was written was a field no other replica can read. The defect is the
 * unknowability, not a failure we can point at.
 *
 * So the attempt's outcome goes in the SAME durable store as the manifest, and
 * is written on the failure path too -- including when the manifest write is
 * itself what failed, which is the case the manifest alone can never report.
 */
export interface CorpusLastRun {
  outcome: 'succeeded' | 'failed';
  /** ISO timestamp the attempt finished. */
  finishedAt: string;
  /** The error, when it failed. Never empty on a `failed` record. */
  error: string | null;
  /** Build SHA of the image that ran it, so a reader can tell WHICH revision. */
  sourceCommit: string | null;
  backend: 'ai-search' | 'cosmos' | 'none';
  chunkCount: number;
  /**
   * The `jobId` the POST returned to whoever triggered this attempt.
   *
   * IDENTITY, NOT TIME, is what a poller must correlate on. An earlier
   * revision of the poller compared `finishedAt` against a mark it took at
   * startup, and a reviewer demonstrated two defects in that: the mark is
   * `date -u +%Y-%m-%dT%H:%M:%SZ` (second precision) while this field is
   * `toISOString()` (milliseconds), and `.` sorts BELOW `Z`, so a record at
   * `…:46.999Z` compared against a mark of `…:46Z` reads as OLDER and is
   * ignored — a blind window covering exactly the fast failures, which is the
   * class a manifest-write 403 falls into. And two runs overlapping meant an
   * unrelated failure could red a healthy rebuild, including one started by
   * this script's own documented POST retry. Matching the jobId removes both:
   * a record is about YOUR attempt or it is not.
   */
  jobId: string | null;
}

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
  /** The last rebuild attempt any replica recorded, or null if none ever did. */
  lastRun: CorpusLastRun | null;
}

/** Pure freshness evaluation from the current fingerprints + the manifest.
 *
 * `manifestError` is the READ failing, which is not the same fact as there
 * being nothing to read, and must not be reported as one. `loadManifestHead`
 * catches every exception and returns null, so an AI Search blip, an expired
 * token, or an unconfigured service all arrived here indistinguishable from a
 * corpus that has genuinely never been built -- and this function then asserted
 * "has never been indexed in this backend", a claim it had not established.
 * That is `deploy-integrity.md` R7's recorded incident exactly: a `2>/dev/null`
 * turned a permission denial into an empty string and the empty string into a
 * false statement of cause. It is also why the roll's poll log alternated
 * between `never-indexed` and `stale` while nothing changed -- reads were
 * intermittently failing, and each failure printed as a different fact about
 * the corpus.
 *
 * COMMITS BEAT MTIMES when both are known. `statFingerprint` hashes
 * `path:size:mtime` from the ANSWERING REPLICA's local filesystem, while the
 * manifest is shared -- so the comparison is replica-local against durable, and
 * two replicas on different revisions disagree by construction. The build SHA
 * is stamped into the image, so every replica of a revision reports the same
 * one; when the manifest also carries a commit, comparing those is both
 * cheaper and stable across replicas. The stat comparison stays as the fallback
 * for dev and for manifests written before commits were recorded.
 */
export function evaluateFreshness(
  currentStat: string,
  manifest: (Pick<CorpusManifest, 'statFingerprint'> & Partial<Pick<CorpusManifest, 'sourceCommit'>>) | null,
  opts?: { currentCommit?: string | null; manifestError?: string | null },
): { state: CorpusFreshnessState; reason: string } {
  const manifestError = opts?.manifestError ?? null;
  if (manifestError) {
    return {
      state: 'unknown',
      reason: `The corpus manifest could not be READ (${manifestError}). This says nothing about whether the corpus is indexed — it says the check could not run.`,
    };
  }
  if (!manifest) return { state: 'never-indexed', reason: 'The Help Copilot corpus has never been indexed in this backend.' };

  // BOTH sides are filtered, not just the live one. `manifest.sourceCommit` is
  // PERSISTED DATA -- a manifest written by an image built without
  // `--build-arg LOOM_BUILD_SHA` carries the literal `unknown` forever, and it
  // outlives the image that wrote it.
  //
  // Be precise about what the indexed-side filter buys, because an earlier
  // revision of this comment had it backwards. It does NOT stop a false green:
  // filtering only the live side already does that, since `unknown` on both
  // sides blanks `currentCommit` and short-circuits to the stat path before the
  // commit comparison can engage. What the indexed-side filter changes is the
  // MIXED case -- a real sha live, `unknown` in the manifest -- and it changes
  // it toward `fresh`: unfiltered, that pair compares unequal and reports
  // `stale`; filtered, it falls through to the stat comparison, which reports
  // `fresh` when the fingerprints match. Measured, not argued: the case is
  // `the MIXED case — a real sha live, a placeholder in the manifest — falls to
  // stat, and that is a WEAKENING`, in
  // `__tests__/loom-docs-index-incremental.test.ts`.
  //
  // That is deliberate, and it is the same rule the live side follows. `unknown`
  // is not a revision, so diffing it against one asserts a comparison the code
  // cannot make -- it would report "built from unknown, serving abc12345" as if
  // that were a revision gap, when the only thing established is that one image
  // did not stamp. Falling back to the stat fingerprint is the designed
  // no-commits-available path, and it is real evidence: the manifest's
  // `path:size:mtime` hash matching this replica's is what the guard used before
  // commits were recorded at all.
  const live = (opts?.currentCommit ?? '').trim();
  const indexed = (manifest.sourceCommit ?? '').trim();
  const currentCommit = isBuildCommit(live) ? live : '';
  const indexedCommit = isBuildCommit(indexed) ? indexed : '';
  if (currentCommit && indexedCommit) {
    if (!sameCommit(currentCommit, indexedCommit)) {
      return {
        state: 'stale',
        reason: `The index was built from ${indexedCommit.slice(0, 12)} and this revision serves ${currentCommit.slice(0, 12)}.`,
      };
    }
    return { state: 'fresh', reason: `The indexed corpus was built from this revision (${currentCommit.slice(0, 12)}).` };
  }

  if (manifest.statFingerprint !== currentStat) {
    return { state: 'stale', reason: 'Staged docs have changed since the last index build (source fingerprint differs).' };
  }
  return { state: 'fresh', reason: 'The indexed corpus matches the staged docs.' };
}

/**
 * The reindex PREFLIGHT (#2929) — how many source files the corpus walker can
 * currently SEE. Re-exported from ./loom-docs-corpus so the health probe and the
 * reindex route keep importing it from here; the walk itself lives with the rest
 * of the filesystem concern.
 */
export { corpusSourceCount };

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
  const { head: manifest, error: manifestError } = await loadManifestHead(backend);
  const currentCommit = currentSourceCommit();
  const { state, reason } = evaluateFreshness(currentStat, manifest, { currentCommit, manifestError });
  // Best-effort and deliberately not fatal: the last-run record is DIAGNOSIS,
  // so a failure to read it must never change the freshness verdict itself.
  const lastRun = await loadLastRun(backend).catch(() => null);
  return {
    state, reason, backend,
    indexedAt: manifest?.builtAt ?? null,
    indexedChunkCount: manifest?.chunkCount ?? null,
    currentStatFingerprint: currentStat,
    indexedStatFingerprint: manifest?.statFingerprint ?? null,
    sourceCommit: currentCommit,
    indexedCommit: manifest?.sourceCommit ?? null,
    lastRun,
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

/**
 * Rebuild the corpus index, recording the outcome where every replica can read
 * it.
 *
 * The recording is a WRAPPER rather than an edit to each `return`, on purpose:
 * `reindexInner` has several exit paths and the one that matters most is the
 * one added last, so a scheme that needs every future author to remember a call
 * is a scheme that will miss one. The roll this fixes failed because an outcome
 * was visible on exactly one replica.
 */
export async function reindex(opts?: { full?: boolean; jobId?: string }): Promise<ReindexResult> {
  const jobId = opts?.jobId ?? null;
  let result: ReindexResult;
  try {
    result = await reindexInner(opts);
  } catch (e: any) {
    // A THROW is an outcome too, and previously the least visible one of all:
    // the job went `failed` in this replica's memory and every other replica
    // kept answering `idle` with an unchanged manifest.
    const message = e?.message || String(e);
    await saveLastRun(isSearchConfigured() ? 'ai-search' : 'cosmos', {
      outcome: 'failed',
      finishedAt: new Date().toISOString(),
      error: `reindex threw: ${message}`,
      sourceCommit: currentSourceCommit(),
      backend: isSearchConfigured() ? 'ai-search' : 'cosmos',
      chunkCount: 0,
      jobId,
    });
    throw e;
  }
  const store: 'ai-search' | 'cosmos' =
    result.backend === 'none' ? (isSearchConfigured() ? 'ai-search' : 'cosmos') : result.backend;
  await saveLastRun(store, {
    outcome: result.ok ? 'succeeded' : 'failed',
    finishedAt: new Date().toISOString(),
    error: result.ok ? null : (result.error || 'reindex reported ok:false with no error string'),
    sourceCommit: currentSourceCommit(),
    backend: result.backend,
    chunkCount: result.totalChunks,
    jobId,
  });
  return result;
}

async function reindexInner(opts?: { full?: boolean }): Promise<ReindexResult> {
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
//
// The corpus-walker half now lives in ./loom-docs-corpus, but it is re-surfaced
// here UNCHANGED: this object is the test seam every existing suite imports, and
// moving the implementation is not a reason to make those suites chase it.
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
  // #4497 — the durable last-run document id. Exposed so the producer test
  // asserts on the SHARED-STORE bytes rather than on `reindex`'s return value:
  // the return value is this replica's view, and this replica's view is exactly
  // what the roll already had and could not act on.
  LAST_RUN_KEY,
  // #2970 — point the AI Search path's corpus statistics at a synthetic corpus
  // so a backend-symmetry test can hold BOTH paths to the same corpus. Pass
  // `undefined` to restore the real bundled-corpus source.
  setCorpusStatsForTests,
  localCorpusStats,
  // #4498 round 4 — drop the memoised corpus-container handle. A memo that
  // survives between cases would let one case's Cosmos stub answer the next.
  __resetCorpusContainerForTests,
};
