/**
 * loom-docs-corpus — how source files on disk become RAG corpus chunks.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * Extracted from `loom-docs-index.ts` (2026-08-06, #2970) when that file crossed
 * the 1500-LOC monolith-creep guard (`scripts/ci/check-file-size.mjs`). The
 * split is by BOUNDED CONTEXT, not by line count, and the seam was already there
 * — this is the one half of the module that touches no Azure surface at all:
 *
 *   THIS module  — filesystem + text ONLY. Walk the roots, chunk the markdown,
 *                  summarize the source, hash the content, fingerprint the tree.
 *                  No Azure SDK, no network, no Cosmos, no AI Search, no
 *                  credentials. Synchronous and pure enough to unit-test with a
 *                  temp directory and nothing else.
 *
 *   loom-docs-index — STORAGE + RETRIEVAL. The AI Search and Cosmos backends,
 *                  the shared BM25 re-rank, `searchDocs`, the freshness
 *                  manifest, and `reindex`. Those genuinely cannot separate
 *                  further: they share the module-private `credential` /
 *                  `SEARCH_API` / `INDEX` / `indexBatch` plumbing, and threading
 *                  that through a boundary would buy lines and cost cohesion.
 *
 * The direction of the dependency is the giveaway that this is the right cut:
 * the index imports the corpus walker, the walker imports nothing from the
 * index. `DocChunk` lives here because this is what PRODUCES one;
 * `loom-docs-index` re-exports it so no existing consumer had to change.
 *
 * Per `docs/fiab/decomposition-plan.md` §"Shared method" step 4 — pure helpers
 * to their own `.ts` module first, being the lowest-risk extraction.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createCorpusStatsAccumulator,
  type Bm25CorpusStats,
} from './docs-ranker';
import { chunkMarkdown, MAX_CHUNK as CHUNKER_MAX_CHUNK } from './docs-chunker';

// ---------- Types ----------

/** One chunk of the retrieval corpus, as produced by {@link collectSources}. */
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

/**
 * Per-source-doc index state: the content hash + how many chunks it produced.
 *
 * Declared here rather than beside the manifest that stores it because this is
 * where it is PRODUCED — `collectSources` computes both fields, and the manifest
 * is one consumer of them.
 *
 * (Chunk ids are deterministic via {@link docKey}, so the id list is not stored
 * — it is regenerated to delete orphaned/removed chunks.)
 */
export interface ManifestFileEntry {
  kind: DocChunk['kind'];
  hash: string;
  chunks: number;
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
export function docKey(kind: string, rel: string, idx: number): string {
  return `${Buffer.from(`${kind}:${rel}`, 'utf-8').toString('base64url')}_${idx}`;
}

export interface RepoRoots {
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

export function detectRoots(): RepoRoots {
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

export function walkMarkdown(dir: string): string[] {
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

export function walkSource(dir: string): string[] {
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

export function summarizeSource(filePath: string, text: string): string {
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

export function docsUrlForPath(relPath: string): string | undefined {
  // docs/fiab/foo/bar.md → https://docs.../fiab/foo/bar/
  if (!relPath.startsWith('docs/')) return undefined;
  const slug = relPath.replace(/^docs\//, '').replace(/\.md$/, '');
  const base = process.env.LOOM_DOCS_BASE_URL || 'https://docs.csa-loom.local';
  return `${base.replace(/\/$/, '')}/${slug}/`;
}

// ---------- Content hashing + source enumeration (WS-G / G1) ----------

/** Stable content hash for a source doc (sha256 hex, 16 bytes → 32 chars). */
export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 32);
}

/** A source file the corpus draws from, with its kind + repo-relative path. */
export interface SourceFileRef {
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
export function enumerateSourceFiles(roots: RepoRoots): SourceFileRef[] {
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
export function statFingerprint(refs: SourceFileRef[]): string {
  const parts = refs.map((r) => {
    try { const s = fs.statSync(r.abs); return `${r.rel}:${s.size}:${Math.floor(s.mtimeMs)}`; }
    catch { return `${r.rel}:missing`; }
  }).sort();
  return hashContent(parts.join('\n'));
}

export interface CollectedCorpus {
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
export function collectSources(): CollectedCorpus {
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

// ---------- Corpus-wide BM25 statistics (#2970) ------------------------------
//
// The AI Search branch of `searchDocs` re-ranks a per-query CANDIDATE WINDOW.
// Building BM25 statistics from that window is wrong in a specific, measurable
// way — every candidate matches the query, so `df/size` approaches 1 for the
// query's terms and IDF collapses for all of them together. See
// `docs-ranker.Bm25CorpusStats` for the numbers (0.797 → 0.889 over the golden
// sets at a 100-candidate window, i.e. the entire gap to full-corpus ranking).
//
// The statistics come from the corpus BUNDLED IN THE IMAGE (the same tree
// `collectSources()` walks) rather than from the search index, because they must
// describe the whole corpus and a query can only ever see a slice of it. They
// are accumulated STREAMING — one file chunked, counted and dropped — so the
// ~75 MB of corpus text is never resident.
//
// This lives beside the walker rather than beside the ranker because it IS a
// walk: same roots, same chunker, same per-file read. Only the reduction differs.

/** `undefined` = not attempted yet; `null` = attempted and unavailable. */
let corpusStatsCache: Bm25CorpusStats | null | undefined;

/**
 * Test-only override for the corpus-statistics source.
 *
 * The production invariant is that BOTH retrieval backends score against the
 * SAME corpus statistics — the Cosmos path because its index IS the corpus, the
 * AI Search path because these statistics are built from the same bundled corpus
 * the reindex populated Cosmos from. A unit test that stands up a synthetic
 * Cosmos corpus has no way to satisfy that without pointing this at the same
 * synthetic corpus; without the hook the AI Search path would silently score
 * against the repo's REAL docs and the backend-symmetry assertion would fail for
 * a reason that has nothing to do with the behaviour under test.
 */
let corpusStatsOverride: Bm25CorpusStats | null | undefined;

/** Point the corpus statistics at a synthetic corpus; `undefined` restores. */
export function setCorpusStatsForTests(stats: Bm25CorpusStats | null | undefined): void {
  corpusStatsOverride = stats;
}

/** Drop the memoised corpus statistics (called after a reindex). */
export function resetCorpusStatsCache(): void {
  corpusStatsCache = undefined;
}

/**
 * Corpus-wide `size` / `avgdl` / `df`, built once per process from the bundled
 * corpus. Returns null when no corpus is reachable — an HONEST degradation to
 * window-local ranking, never a crash and never a zero-sized corpus.
 */
export function localCorpusStats(): Bm25CorpusStats | null {
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
    console.warn('[loom-docs-corpus] corpus statistics build failed, falling back to window-local BM25', e?.message);
    corpusStatsCache = null;
    return null;
  }
}
