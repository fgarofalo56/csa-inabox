#!/usr/bin/env node
/**
 * simulate-live-retrieval.mjs — offline model of the SHIPPED two-stage
 * retrieval pipeline, so a corpus/chunking change can be measured without a
 * ~25-minute deploy + reindex + eval cycle (#2929).
 *
 * WHY THIS EXISTS, AND WHY `measure-retrieval.mjs` IS NOT ENOUGH
 * -------------------------------------------------------------
 * `measure-retrieval.mjs` runs BM25 over the WHOLE corpus. Production does not:
 * `searchDocs()` in `apps/fiab-console/lib/azure/loom-docs-index.ts` is
 * retrieve-then-rerank —
 *
 *   1. RECALL   Azure AI Search `queryType:'simple'`, `searchMode:'any'` over
 *               the searchable fields (path, heading, content), returning at
 *               most AI_SEARCH_CANDIDATE_WINDOW (100) candidates out of ~50k.
 *   2. RERANK   `rankChunks(candidates, …)` — BM25 + surface boost + source
 *               weights — over ONLY those candidates.
 *   3. WINDOW   `diversifyByDocument(hits, want, DEFAULT_MAX_CHUNKS_PER_DOC)`.
 *
 * So the full-corpus harness measures the ranker under PERFECT recall. If the
 * gold document never enters the 100-candidate window, no reranking can save
 * it, and the harness will happily report a hit that production cannot get.
 * That difference is not hypothetical: for `lakehouse` the full-corpus harness
 * reported 0.667 while live run 30969867157 measured 0.333.
 *
 * WHAT IS MODELLED, AND HOW FAITHFULLY
 * ------------------------------------
 *   - Stage 2 and 3 are the REAL production modules (`docs-ranker.ts`), and the
 *     corpus is chunked by the REAL `docs-chunker.ts`. No re-implementation.
 *   - Stage 1 is a MODEL: BM25 over `path + heading + content` (the three
 *     fields the index marks `searchable`, per INDEX_DEFINITION), top-100.
 *     Azure AI Search also scores BM25, but its exact per-field combination is
 *     not reproducible offline, so treat this stage as an approximation.
 *
 * Because stage 1 is a model, this script is CALIBRATED rather than trusted:
 * `--chunker legacy` reproduces the pre-#2929 blind character slicer so the
 * simulated baseline can be compared against the measured live baseline. Read
 * the deltas, not the absolute numbers.
 *
 * Usage (from the repo root):
 *   node --max-old-space-size=6144 scripts/csa-loom/simulate-live-retrieval.mjs
 *   node --max-old-space-size=6144 scripts/csa-loom/simulate-live-retrieval.mjs --chunker legacy
 *   node --max-old-space-size=6144 scripts/csa-loom/simulate-live-retrieval.mjs --explain lakehouse
 *
 * Read-only, no network, no Azure credentials, zero judge-token spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const EVALS_DIR = path.join(REPO, 'content', 'evals');

const ranker = await import(
  pathToFileURL(path.join(REPO, 'apps', 'fiab-console', 'lib', 'azure', 'docs-ranker.ts')).href
);
const {
  buildBm25Index, bm25Rank, diversifyByDocument, surfaceTopicTerms,
  DEFAULT_SURFACE_BOOST, DEFAULT_MAX_CHUNKS_PER_DOC, DEFAULT_SOURCE_WEIGHTS,
} = ranker;

const chunker = await import(
  pathToFileURL(path.join(REPO, 'apps', 'fiab-console', 'lib', 'azure', 'docs-chunker.ts')).href
);
const { chunkMarkdown: chunkCurrent, MAX_CHUNK } = chunker;

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const CHUNKER = flag('--chunker', 'current');
const EXPLAIN = flag('--explain', null);

// Production constants — loom-docs-index.ts.
const AI_SEARCH_CANDIDATE_WINDOW = Number(flag('--window', '100')) || 100;
const RETRIEVAL_OVERFETCH = 4;
const DEFAULT_DOC_RETRIEVAL_TOP = 8;

/**
 * The PRE-#2929 chunker, reproduced verbatim for calibration ONLY.
 *
 * This is deliberately a copy of code this repo no longer runs: its whole job
 * is to regenerate the corpus that produced the measured live baseline so the
 * before/after delta is like-for-like. It must NOT be used to describe current
 * behaviour — for that, import `docs-chunker.ts`, as the `current` path does.
 */
function chunkLegacy(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let curHeading;
  let buf = [];
  const flush = () => {
    const content = buf.join('\n').trim();
    if (content.length > 0) blocks.push({ heading: curHeading, content });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) { flush(); curHeading = m[2].trim(); } else buf.push(line);
  }
  flush();
  const out = [];
  for (const b of blocks) {
    if (b.content.length <= MAX_CHUNK) { out.push(b); continue; }
    for (let i = 0; i < b.content.length; i += MAX_CHUNK) {
      out.push({ heading: b.heading, content: b.content.slice(i, i + MAX_CHUNK) });
    }
  }
  return out;
}

const chunkMarkdown = CHUNKER === 'legacy' ? chunkLegacy : chunkCurrent;

function walkMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.endsWith('.md')) out.push(full);
    }
  }
  return out;
}

const chunkPath = (id) => (id || '').split('#')[0].trim().toLowerCase().replace(/\\/g, '/');
function docHit(expectedChunks, retrievedPaths) {
  const retrieved = retrievedPaths.map(chunkPath);
  const expected = expectedChunks.map(chunkPath).filter(Boolean);
  return expected.length > 0 && expected.some((e) => retrieved.includes(e));
}

const DOCS = path.join(REPO, 'docs');
const ROOTS = [
  path.join(DOCS, 'fiab'),
  DOCS,
  path.join(REPO, 'PRPs', 'completed', 'csa-loom-pillar'),
  path.join(REPO, 'PRPs', 'active'),
  path.join(DOCS, 'fiab', 'adr'),
];

function buildCorpus() {
  const chunks = [];
  const seen = new Set();
  for (const root of ROOTS) {
    for (const file of walkMarkdown(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const rel = path.relative(REPO, file).replace(/\\/g, '/');
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      for (const b of chunkMarkdown(raw)) chunks.push({ path: rel, heading: b.heading, content: b.content });
    }
  }
  return chunks;
}

const corpus = buildCorpus();
const docCount = new Set(corpus.map((c) => c.path)).size;

/**
 * STAGE 1 MODEL — Azure AI Search recall.
 *
 * AI Search marks `path`, `heading` and `content` searchable with
 * standard.lucene; the ranker's own index covers only `heading + content`. So
 * the recall index is built over a chunk view whose `content` is prefixed with
 * the path, approximating a field-combined match.
 */
const recallView = corpus.map((c) => ({
  path: c.path,
  heading: c.heading,
  content: `${c.path.replace(/[\/.\-_]/g, ' ')}\n${c.content}`,
}));
const recallIndex = buildBm25Index(recallView);
/** STAGE 2 index — the ranker's real view (heading + content). */
const rankIndex = buildBm25Index(corpus);

/** The shipped searchDocs() shape, with stage 1 served by the model above. */
function livePipeline(query, want, surface) {
  const overfetch = Math.max(want * RETRIEVAL_OVERFETCH, want);
  const candidateWindow = Math.max(AI_SEARCH_CANDIDATE_WINDOW, overfetch);
  // 1. RECALL — AI Search returns at most `candidateWindow` of ~50k chunks.
  const candidateIdx = bm25Rank(recallIndex, query, candidateWindow, {})
    .map((h) => h.index);
  if (candidateIdx.length === 0) return [];
  // 2. RERANK — production ranker, restricted to the recalled candidates.
  const allow = new Set(candidateIdx);
  const surfaceTerms = surfaceTopicTerms(surface);
  const ordered = bm25Rank(rankIndex, query, rankIndex.size, {
    surfaceTerms,
    surfaceBoost: DEFAULT_SURFACE_BOOST,
    sourceWeights: DEFAULT_SOURCE_WEIGHTS,
  }).filter((h) => allow.has(h.index)).slice(0, overfetch).map((h) => corpus[h.index]);
  // 3. WINDOW — diversify to the answer window.
  return diversifyByDocument(ordered, want, DEFAULT_MAX_CHUNKS_PER_DOC);
}

/** Did the gold document survive STAGE 1 at all? Separates recall from rank. */
function recalled(query, expectedChunks) {
  const candidateWindow = Math.max(AI_SEARCH_CANDIDATE_WINDOW, DEFAULT_DOC_RETRIEVAL_TOP * RETRIEVAL_OVERFETCH);
  const paths = bm25Rank(recallIndex, query, candidateWindow, {}).map((h) => corpus[h.index].path);
  return docHit(expectedChunks, paths);
}

function loadSets() {
  return fs.readdirSync(EVALS_DIR)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('_')).sort()
    .map((f) => ({
      surface: f.slice(0, -6),
      rows: fs.readFileSync(path.join(EVALS_DIR, f), 'utf-8')
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)),
    }));
}

const sets = loadSets();
console.log(`chunker      : ${CHUNKER}${CHUNKER === 'legacy' ? '  (pre-#2929 blind character slicer — calibration only)' : '  (lib/azure/docs-chunker.ts)'}`);
console.log(`corpus       : ${corpus.length} chunks / ${docCount} markdown docs`);
console.log(`pipeline     : AI-Search-recall(${AI_SEARCH_CANDIDATE_WINDOW}) -> rankChunks -> diversify(top-${DEFAULT_DOC_RETRIEVAL_TOP}, max ${DEFAULT_MAX_CHUNKS_PER_DOC}/doc)\n`);

if (EXPLAIN) {
  const set = sets.find((s) => s.surface === EXPLAIN);
  if (!set) { console.error(`unknown surface '${EXPLAIN}'`); process.exit(2); }
  for (const row of set.rows) {
    const got = livePipeline(row.question, DEFAULT_DOC_RETRIEVAL_TOP, set.surface);
    const hit = docHit(row.expectedChunks, got.map((g) => g.path));
    const rec = recalled(row.question, row.expectedChunks);
    console.log(`\n[${row.id}] ${hit ? 'HIT ' : 'MISS'}  recall(stage1)=${rec ? 'in-window' : 'LOST'}  ${row.question}`);
    console.log(`   expected: ${row.expectedChunks.join(', ')}`);
    for (const g of got) console.log(`   ->  ${g.path}  [${g.heading || ''}]`);
  }
  process.exit(0);
}

console.log('surface'.padEnd(17) + 'hit-rate@8'.padStart(12) + 'stage-1 recall'.padStart(17) + '  lost-in-rank');
console.log('-'.repeat(60));
let hitsTotal = 0; let recTotal = 0; let rowsTotal = 0;
for (const set of sets) {
  let hits = 0; let recs = 0;
  for (const row of set.rows) {
    if (docHit(row.expectedChunks, livePipeline(row.question, DEFAULT_DOC_RETRIEVAL_TOP, set.surface).map((g) => g.path))) hits += 1;
    if (recalled(row.question, row.expectedChunks)) recs += 1;
  }
  hitsTotal += hits; recTotal += recs; rowsTotal += set.rows.length;
  const n = set.rows.length;
  console.log(set.surface.padEnd(17)
    + (hits / n).toFixed(3).padStart(12)
    + (recs / n).toFixed(3).padStart(17)
    + `${String(recs - hits).padStart(14)}`);
}
console.log('-'.repeat(60));
console.log('OVERALL'.padEnd(17)
  + (hitsTotal / rowsTotal).toFixed(3).padStart(12)
  + (recTotal / rowsTotal).toFixed(3).padStart(17)
  + `${String(recTotal - hitsTotal).padStart(14)}`);
console.log(`\n(${rowsTotal} golden rows across ${sets.length} surfaces.`);
console.log(` "stage-1 recall" = the gold doc entered the ${AI_SEARCH_CANDIDATE_WINDOW}-candidate window at all;`);
console.log(` "lost-in-rank"   = rows the recall stage found and the rerank+diversify window then dropped.)`);
