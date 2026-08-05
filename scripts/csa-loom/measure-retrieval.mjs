#!/usr/bin/env node
/**
 * measure-retrieval.mjs — OFFLINE before/after measurement for the Copilot
 * docs-retrieval ranker (issue #2585, P0/P1).
 *
 * Sibling of `diagnose-retrieval.mjs`, with one deliberate difference: that
 * script measured a faithful PORT of the production ranker (the real one was
 * module-private TypeScript). This one imports the REAL shipping module —
 * `apps/fiab-console/lib/azure/docs-ranker.ts` — via Node's native type
 * stripping (Node >= 22.18). So the "after" column is the code that actually
 * runs in the console, not a re-implementation of it that could agree with
 * itself while both disagree with production.
 *
 * Still ported here (unavoidably — they remain module-private):
 *   loom-docs-index.ts  walkMarkdown
 *                       + the searchDocs over-fetch → diversify → slice order
 *   evaluator-core.ts   chunkPath / scoreRetrieval  -> docHit() (doc-level)
 *
 * NOT ported any more (#2929): `chunkMarkdown` / MAX_CHUNK. Those used to be a
 * hand-maintained copy, which is the "fixture that models the code" failure —
 * the harness agrees with its own copy while both drift from production. They
 * now come from the REAL `lib/azure/docs-chunker.ts`, the same module
 * `loom-docs-index.ts` imports.
 *
 * Usage (from the repo root):
 *   node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs
 *   node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs --top 10
 *   node --max-old-space-size=6144 scripts/csa-loom/measure-retrieval.mjs --explain lakehouse
 *
 * Read-only, no network, no Azure credentials, zero judge-token spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const EVALS_DIR = path.join(REPO, 'content', 'evals');

// The REAL ranker — same file the console imports.
const ranker = await import(
  pathToFileURL(path.join(REPO, 'apps', 'fiab-console', 'lib', 'azure', 'docs-ranker.ts')).href
);
const {
  buildBm25Index, bm25Rank, diversifyByDocument, rankSubstring,
  surfaceTopicTerms, DEFAULT_SURFACE_BOOST, DEFAULT_MAX_CHUNKS_PER_DOC,
  DEFAULT_SOURCE_WEIGHTS, corpusSourceClass,
} = ranker;

// The REAL chunker — the same module loom-docs-index.ts imports, so the
// corpus this harness scores is chunked exactly as the shipped one is.
const chunker = await import(
  pathToFileURL(path.join(REPO, 'apps', 'fiab-console', 'lib', 'azure', 'docs-chunker.ts')).href
);
const { chunkMarkdown, MAX_CHUNK } = chunker;

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TOP = Number(flag('--top', 5)) || 5;
const EXPLAIN = flag('--explain', null);
/** Override the surface-boost strength to sweep its sensitivity. */
const SFC = flag('--surface-boost', null);
/**
 * Source-class weight override for the sweep, as `reference:ledger:archive`
 * (product is always 1) — e.g. `--source-weights 0.85:0.6:0.5`.
 */
const SW = flag('--source-weights', null);
const sourceWeights = SW
  ? (() => {
    const [reference, ledger, archive] = SW.split(':').map(Number);
    return { product: 1, reference, ledger, archive };
  })()
  : DEFAULT_SOURCE_WEIGHTS;

/** loom-docs-index.ts RETRIEVAL_OVERFETCH — candidates pulled before diversifying. */
const OVERFETCH = 4;

// ── port: loom-docs-index.walkMarkdown ───────────────────────────────────────
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

// ── port: evaluator-core.chunkPath / scoreRetrieval (doc-level hit) ──────────
const chunkPath = (id) => (id || '').split('#')[0].trim().toLowerCase().replace(/\\/g, '/');
function docHit(expectedChunks, retrievedPaths) {
  const retrieved = retrievedPaths.map(chunkPath);
  const expected = expectedChunks.map(chunkPath).filter(Boolean);
  return expected.length > 0 && expected.some((e) => retrieved.includes(e));
}

// ── corpus (production image layout: markdown only; no lib/** summaries) ─────
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

// ── search variants ──────────────────────────────────────────────────────────

/** BEFORE — the shipped-until-#2585 Cosmos ranker, imported from docs-ranker.ts. */
const substringSearch = (corpus) => (query, top) => corpus
  .map((r, i) => ({ i, score: rankSubstring(query, r.content, r.heading) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, top)
  .map((r) => corpus[r.i]);

/**
 * AFTER — the shipped searchDocs shape: BM25 over-fetch → per-document
 * diversification → slice. `opts` mirrors the production knobs so each one can
 * be isolated.
 */
function bm25Search(corpus, index, opts = {}) {
  const maxPerDoc = opts.maxPerDoc ?? DEFAULT_MAX_CHUNKS_PER_DOC;
  return (query, top, surface) => {
    const surfaceTerms = opts.surface ? surfaceTopicTerms(surface) : [];
    const wide = bm25Rank(index, query, Math.max(top * OVERFETCH, top), {
      titleBoost: opts.titleBoost ?? 0,
      surfaceTerms,
      surfaceBoost: opts.surface === 'boost' ? (opts.surfaceBoost ?? DEFAULT_SURFACE_BOOST) : 0,
      sourceWeights: opts.sourceWeights ?? null,
    }).map((h) => corpus[h.index]);
    if (opts.surface === 'filter' && surfaceTerms.length > 0) {
      const onTopic = wide.filter((c) => surfaceTerms.some((t) => c.path.toLowerCase().includes(t)));
      const rest = wide.filter((c) => !onTopic.includes(c));
      const merged = [...onTopic, ...rest];
      return opts.diversify === false ? merged.slice(0, top) : diversifyByDocument(merged, top, maxPerDoc);
    }
    return opts.diversify === false ? wide.slice(0, top) : diversifyByDocument(wide, top, maxPerDoc);
  };
}

// ── golden sets ──────────────────────────────────────────────────────────────
function loadSets() {
  return fs.readdirSync(EVALS_DIR)
    .filter((f) => f.endsWith('.jsonl') && !f.startsWith('_')).sort()
    .map((f) => ({
      surface: f.slice(0, -6),
      rows: fs.readFileSync(path.join(EVALS_DIR, f), 'utf-8')
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l)),
    }));
}

// ── run ──────────────────────────────────────────────────────────────────────
const corpus = buildCorpus();
const docCount = new Set(corpus.map((c) => c.path)).size;
const t0 = Date.now();
const index = buildBm25Index(corpus);
const buildMs = Date.now() - t0;
console.log(`corpus       : ${corpus.length} chunks / ${docCount} markdown docs`);
console.log(`bm25 index   : built in ${buildMs} ms (avgdl ${index.avgdl.toFixed(1)}, ${index.postings.size} terms)`);
console.log(`window       : top-${TOP}   over-fetch x${OVERFETCH}   max ${DEFAULT_MAX_CHUNKS_PER_DOC} chunks/doc\n`);

const sets = loadSets();

if (EXPLAIN) {
  const set = sets.find((s) => s.surface === EXPLAIN);
  if (!set) {
    console.error(`unknown surface '${EXPLAIN}' — have: ${sets.map((s) => s.surface).join(', ')}`);
    process.exit(2);
  }
  // "before" = the configuration shipped by #2585 P0/P1 (BM25 + diversification
  // + surface boost). "after" = that plus the P2 corpus source weighting. The
  // substring-vs-BM25 comparison is historical and lives in the remediation doc.
  const before = bm25Search(corpus, index, { surface: 'boost' });
  const after = bm25Search(corpus, index, { surface: 'boost', sourceWeights });
  for (const row of set.rows) {
    const b = before(row.question, TOP, set.surface);
    const a = after(row.question, TOP, set.surface);
    console.log(`\n[${row.id}] before=${docHit(row.expectedChunks, b.map((g) => g.path)) ? 'HIT ' : 'MISS'}`
      + `  after=${docHit(row.expectedChunks, a.map((g) => g.path)) ? 'HIT ' : 'MISS'}  ${row.question}`);
    console.log(`   expected: ${row.expectedChunks.join(', ')}`);
    for (const g of a) console.log(`   ->  [${corpusSourceClass(g.path).padEnd(9)}] ${g.path}  [${g.heading || ''}]`);
    console.log(`   distinct docs in window: before ${new Set(b.map((g) => g.path)).size} · after ${new Set(a.map((g) => g.path)).size}`);
  }
  process.exit(0);
}

/** Each measured cell: name → (question, top, surface) => chunks. */
const cells = {
  'substring (before)': substringSearch(corpus),
  'bm25+div': bm25Search(corpus, index, {}),
  'bm25+div+title2': bm25Search(corpus, index, { titleBoost: 2.0 }),
  'bm25+div+sfc (shipped)': bm25Search(corpus, index, { surface: 'boost', surfaceBoost: SFC ? Number(SFC) : undefined }),
  'bm25+div+sfc-filter': bm25Search(corpus, index, { surface: 'filter' }),
  '+src-weight (P2)': bm25Search(corpus, index, { surface: 'boost', surfaceBoost: SFC ? Number(SFC) : undefined, sourceWeights }),
};
const names = Object.keys(cells);
const W = 21;

console.log(`Doc-level hit-rate@${TOP} (evaluator scoreRetrieval semantics)\n`);
console.log('surface'.padEnd(17) + names.map((n) => n.padStart(W)).join(''));
console.log('-'.repeat(17 + W * names.length));
const totals = names.map(() => 0);
const distinct = names.map(() => 0);
/** Per-cell count of returned chunks by corpus source class (the D5 "stop
 *  masking user-doc gaps with engineering-ledger hits" metric). */
const bySource = names.map(() => ({ product: 0, reference: 0, ledger: 0, archive: 0 }));
let rowsTotal = 0;
let chunksTotal = 0;
for (const set of sets) {
  const vals = names.map((n) => {
    let hits = 0;
    for (const row of set.rows) {
      const got = cells[n](row.question, TOP, set.surface);
      if (docHit(row.expectedChunks, got.map((g) => g.path))) hits += 1;
      distinct[names.indexOf(n)] += new Set(got.map((g) => g.path)).size;
      for (const g of got) bySource[names.indexOf(n)][corpusSourceClass(g.path)] += 1;
    }
    return hits;
  });
  vals.forEach((v, i) => { totals[i] += v; });
  rowsTotal += set.rows.length;
  console.log(set.surface.padEnd(17) + vals.map((v) => (v / set.rows.length).toFixed(3).padStart(W)).join(''));
}
console.log('-'.repeat(17 + W * names.length));
console.log('OVERALL'.padEnd(17) + totals.map((t) => (t / rowsTotal).toFixed(3).padStart(W)).join(''));
console.log('distinct docs'.padEnd(17) + distinct.map((d) => (d / rowsTotal).toFixed(2).padStart(W)).join(''));
chunksTotal = bySource[0].product + bySource[0].reference + bySource[0].ledger + bySource[0].archive;
console.log();
console.log('Returned-evidence composition — share of retrieved chunks by corpus source class\n');
for (const cls of ['product', 'reference', 'ledger', 'archive']) {
  console.log(`  ${cls}`.padEnd(17)
    + bySource.map((b) => {
      const tot = b.product + b.reference + b.ledger + b.archive;
      return `${((b[cls] / tot) * 100).toFixed(1)}%`.padStart(W);
    }).join(''));
}
console.log(`\n(${rowsTotal} golden rows across ${sets.length} surfaces; "distinct docs" = mean unique documents inside the top-${TOP} window;`);
console.log(` ~${chunksTotal} retrieved chunks per cell. source weights: ${JSON.stringify(sourceWeights)})`);
