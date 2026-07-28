#!/usr/bin/env node
/**
 * diagnose-retrieval.mjs — OFFLINE diagnosis of Copilot retrieval hit-rate.
 *
 * Triage tool for issue #2585 (`copilot-quality-evals` reported 9/10 surfaces
 * below floor on its first real run; `lakehouse` at exactly 0.000). It answers
 * "is retrieval genuinely weak, or is the eval harness mis-matching document
 * ids?" WITHOUT Azure credentials, Cosmos, AI Search, or judge-token spend.
 *
 * It rebuilds the production corpus from the repo tree using faithful ports of
 * the real chunker + the real Cosmos-fallback ranker, then scores the golden
 * sets with the evaluator's OWN scoring semantics:
 *
 *   apps/fiab-console/lib/azure/loom-docs-index.ts
 *     walkMarkdown            -> walkMarkdown()
 *     chunkMarkdown  (MAX_CHUNK=1500)
 *     rankSubstring           -> rankSubstring()      (Cosmos fallback ranker)
 *     searchCosmos            -> substringSearch()    (rank, filter>0, slice top)
 *     enumerateSourceFiles    -> ROOTS                (markdown roots; the image
 *                                                      carries no lib/** source)
 *   azure-functions/copilot-evaluator/src/evaluator-core.ts
 *     chunkPath / scoreRetrieval -> docHit()          (doc-level, anchors advisory)
 *
 * It also scores a textbook BM25 baseline over the identical chunks. BM25 is a
 * DIAGNOSTIC CONTROL, not a proposed implementation: if a standard ranker lifts
 * hit-rate substantially on the same corpus and the same golden sets, then the
 * gap is retrieval ranking — not a harness id-format bug and not an unreachable
 * golden set.
 *
 * Because it is a port, treat the absolute numbers as a faithful *model* of the
 * Cosmos-fallback path, not as a replay of the live run (which may have served
 * from Azure AI Search — the eval-run receipt does not record which backend
 * answered). The RELATIVE deltas between cells are the signal.
 *
 * Usage:
 *   node scripts/csa-loom/diagnose-retrieval.mjs                 # 2x2 lever matrix
 *   node scripts/csa-loom/diagnose-retrieval.mjs --top 10        # widen the window
 *   node scripts/csa-loom/diagnose-retrieval.mjs --no-title-boost # isolate the boost
 *   node scripts/csa-loom/diagnose-retrieval.mjs --explain lakehouse
 *        # per-question trace: what was retrieved, and where the GOLD doc ranked
 *
 * Dependency-free (Node >= 18), read-only, no network. Run from the repo root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const EVALS_DIR = path.join(REPO, 'content', 'evals');

/** loom-docs-index.ts MAX_CHUNK. */
const MAX_CHUNK = 1500;

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const TOP = Number(flag('--top', 5)) || 5;
const EXPLAIN = flag('--explain', null);
/** BM25 filename/heading boost. `--no-title-boost` isolates its contribution —
 *  it is NOT uniformly positive (it hurts surfaces whose gold doc does not carry
 *  the question's vocabulary in its filename, e.g. health -> parity/monitor.md). */
const TITLE_BOOST = argv.includes('--no-title-boost') ? 0 : Number(flag('--title-boost', 2.0));

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

// ── port: loom-docs-index.chunkMarkdown ──────────────────────────────────────
function chunkMarkdown(text) {
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

// ── port: loom-docs-index.rankSubstring (the Cosmos fallback ranker) ─────────
function rankSubstring(query, content, heading) {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const text = `${heading || ''}\n${content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
    if (heading && heading.toLowerCase().includes(term)) score += 1;
  }
  return score / (terms.length * 2);
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

/** Non-product sources: in-flight planning, audit sweeps, gap reports, backlogs. */
const NON_PRODUCT = [/^PRPs\//, /^docs\/fiab\/audit\//, /^docs\/fiab\/prp\//, /^docs\/fiab\/parity-gap\//];
const isNonProduct = (p) => NON_PRODUCT.some((r) => r.test(p));

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

// ── port: loom-docs-index.searchCosmos ranking ───────────────────────────────
const substringSearch = (corpus) => (query, top) => corpus
  .map((r) => ({ ...r, score: rankSubstring(query, r.content, r.heading) }))
  .filter((r) => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, top);

// ── diagnostic control: textbook BM25 + a filename/heading boost ─────────────
const STOP = new Set(('a an the and or but if then else for of to in on at by with from as is are was '
  + 'were be been being do does did how what when where which who why can could should would will shall '
  + 'may might must i you it its this that these those not no yes about into over under more most some '
  + 'any all my your our their there here also using use used').split(/\s+/));
const tokenize = (s) => (s || '').toLowerCase().match(/[a-z0-9_]+/g)?.filter((t) => t.length > 2 && !STOP.has(t)) ?? [];

function buildBm25(corpus, titleBoost = 2.0) {
  const k1 = 1.2, b = 0.75, N = corpus.length;
  const inverted = new Map();       // term -> flat [chunkIdx, tf, ...]
  const lens = new Float64Array(N);
  const titles = corpus.map((c) =>
    new Set(tokenize(`${path.basename(c.path, '.md').replace(/[-_]/g, ' ')} ${c.heading || ''}`)));
  for (let i = 0; i < N; i++) {
    const toks = tokenize(`${corpus[i].heading || ''} ${corpus[i].content}`);
    lens[i] = toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let arr = inverted.get(t);
      if (!arr) { arr = []; inverted.set(t, arr); }
      arr.push(i, f);
    }
  }
  const avgdl = lens.reduce((a, x) => a + x, 0) / N;
  return (query, top) => {
    const qt = [...new Set(tokenize(query))];
    const scores = new Map();
    for (const t of qt) {
      const post = inverted.get(t);
      if (!post) continue;
      const df = post.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = 0; j < post.length; j += 2) {
        const i = post[j], f = post[j + 1];
        scores.set(i, (scores.get(i) || 0)
          + idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (lens[i] / avgdl)))));
      }
    }
    if (titleBoost) {
      for (const [i, s] of scores) {
        let m = 0;
        for (const t of qt) if (titles[i].has(t)) m += 1;
        if (m) scores.set(i, s * (1 + titleBoost * (m / qt.length)));
      }
    }
    return [...scores.entries()].sort((a, c) => c[1] - a[1]).slice(0, top)
      .map(([i, s]) => ({ ...corpus[i], score: s }));
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
const full = buildCorpus();
const product = full.filter((c) => !isNonProduct(c.path));
const docCount = (cs) => new Set(cs.map((c) => c.path)).size;
console.log(`full corpus  : ${full.length} chunks / ${docCount(full)} markdown docs`);
console.log(`product-only : ${product.length} chunks / ${docCount(product)} docs `
  + `(drops PRPs/**, docs/fiab/{audit,prp,parity-gap}/**)`);
console.log(`window       : top-${TOP}   BM25 title/heading boost: ${TITLE_BOOST}\n`);

const sets = loadSets();

if (EXPLAIN) {
  const set = sets.find((s) => s.surface === EXPLAIN);
  if (!set) {
    console.error(`unknown surface '${EXPLAIN}' — have: ${sets.map((s) => s.surface).join(', ')}`);
    process.exit(2);
  }
  const search = substringSearch(full);
  for (const row of set.rows) {
    const got = search(row.question, TOP);
    const hit = docHit(row.expectedChunks, got.map((g) => g.path));
    console.log(`\n[${row.id}] ${hit ? 'HIT ' : 'MISS'}  ${row.question}`);
    console.log(`   expected: ${row.expectedChunks.join(', ')}`);
    for (const g of got) console.log(`   ->  ${g.score.toFixed(3)}  ${g.path}  [${g.heading || ''}]`);
    const scored = full.map((r) => ({ r, s: rankSubstring(row.question, r.content, r.heading) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const expPaths = new Set(row.expectedChunks.map(chunkPath));
    const rank = scored.findIndex((x) => expPaths.has(x.r.path.toLowerCase()));
    console.log(`   gold-doc best rank: ${rank >= 0 ? rank + 1 : 'ABSENT'} of ${scored.length} chunks scoring > 0`);
  }
  process.exit(0);
}

const cells = {
  'substring/full': substringSearch(full),
  'substring/product': substringSearch(product),
  'BM25/full': buildBm25(full, TITLE_BOOST),
  'BM25/product': buildBm25(product, TITLE_BOOST),
};
const names = Object.keys(cells);
const W = 19;

console.log('Doc-level hit-rate@' + TOP + ' (evaluator scoreRetrieval semantics)\n');
console.log('surface'.padEnd(17) + names.map((n) => n.padStart(W)).join(''));
console.log('-'.repeat(17 + W * names.length));
const totals = names.map(() => 0);
let rowsTotal = 0;
for (const set of sets) {
  const vals = names.map((n) => set.rows.reduce((acc, row) =>
    acc + (docHit(row.expectedChunks, cells[n](row.question, TOP).map((g) => g.path)) ? 1 : 0), 0));
  vals.forEach((v, i) => { totals[i] += v; });
  rowsTotal += set.rows.length;
  console.log(set.surface.padEnd(17)
    + vals.map((v) => (v / set.rows.length).toFixed(3).padStart(W)).join(''));
}
console.log('-'.repeat(17 + W * names.length));
console.log('OVERALL'.padEnd(17) + totals.map((t) => (t / rowsTotal).toFixed(3).padStart(W)).join(''));
console.log(`\n(${rowsTotal} golden rows across ${sets.length} surfaces)`);
