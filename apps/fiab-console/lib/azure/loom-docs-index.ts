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
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import type { Container } from '@azure/cosmos';

import { copilotSessionsContainer } from './cosmos-client';
import { recordRetrieval } from '@/lib/perf/retrieval-metrics';

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

async function pushChunksToSearch(chunks: DocChunk[]): Promise<{ ok: boolean; uploaded: number; error?: string }> {
  const svc = searchServiceName();
  if (!svc) return { ok: false, uploaded: 0, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  if (chunks.length === 0) return { ok: true, uploaded: 0 };
  try {
    const tok = await searchToken();
    let uploaded = 0;
    // AI Search caps batches at 1000 docs / 16MB
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const body = {
        value: batch.map((c) => ({ '@search.action': 'mergeOrUpload', ...c })),
      };
      const r = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, uploaded, error: `Upload batch ${i / BATCH}: ${r.status} ${t.slice(0, 200)}` };
      }
      uploaded += batch.length;
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
      const body = { value: batch.map((id) => ({ '@search.action': 'delete', id })) };
      const r = await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, deleted, error: `Delete batch ${i / BATCH}: ${r.status} ${t.slice(0, 200)}` };
      }
      deleted += batch.length;
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

function rankSubstring(query: string, content: string, heading?: string): number {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const text = `${heading || ''}\n${content}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) score += 1;
    // Boost matches in headings
    if (heading && heading.toLowerCase().includes(term)) score += 1;
  }
  return score / (terms.length * 2);
}

async function searchCosmos(query: string, top: number, kind?: DocChunk['kind']): Promise<DocHit[]> {
  try {
    const c = await helpCorpusContainer();
    // Pull ALL chunks for the kind (or all kinds) and rank in-memory.
    // For 10K-page-scale corpora this is fine; if it grows past ~50MB,
    // switch to AI Search.
    const q = kind
      ? { query: 'SELECT * FROM c WHERE c.kind = @k', parameters: [{ name: '@k', value: kind }] }
      : { query: 'SELECT * FROM c WHERE c.kind != @meta', parameters: [{ name: '@meta', value: META_KIND }] };
    const { resources } = await c.items.query<DocChunk>(q).fetchAll();
    const ranked = resources
      .map((r) => ({ ...r, score: rankSubstring(query, r.content, r.heading) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, top);
    return ranked;
  } catch (e: any) {
    console.warn('[loom-docs-index] cosmos search failed', e?.message);
    return [];
  }
}

// ---------- Public search API ----------

/**
 * Hybrid: try AI Search first; fall back to Cosmos substring if Search
 * isn't configured or returns nothing.
 */
export async function searchDocs(query: string, top = 5, kind?: DocChunk['kind']): Promise<{
  hits: DocHit[];
  backend: 'ai-search' | 'cosmos' | 'none';
}> {
  if (!query.trim()) return { hits: [], backend: 'none' };
  const started = Date.now();
  let fellBack = false;
  if (isSearchConfigured()) {
    try {
      const hits = await searchSearch(query, top, kind);
      if (hits.length > 0) {
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
  const hits = await searchCosmos(query, top, kind);
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

const MAX_CHUNK = 1500;

function chunkMarkdown(text: string): Array<{ heading?: string; content: string }> {
  // Split on H2 boundaries (and H1), keep heading as label.
  const lines = text.split(/\r?\n/);
  const blocks: Array<{ heading?: string; content: string }> = [];
  let curHeading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const content = buf.join('\n').trim();
    if (content.length > 0) blocks.push({ heading: curHeading, content });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      flush();
      curHeading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  // Further split any block bigger than MAX_CHUNK.
  const out: Array<{ heading?: string; content: string }> = [];
  for (const b of blocks) {
    if (b.content.length <= MAX_CHUNK) { out.push(b); continue; }
    let i = 0;
    while (i < b.content.length) {
      out.push({ heading: b.heading, content: b.content.slice(i, i + MAX_CHUNK) });
      i += MAX_CHUNK;
    }
  }
  return out;
}

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

/** Read the corpus manifest from the store the chunks live in (AI Search index
 *  doc or the Cosmos corpus container). Returns null when absent/unreadable —
 *  which safely forces a full rebuild. */
async function loadManifest(backend: 'ai-search' | 'cosmos'): Promise<CorpusManifest | null> {
  try {
    if (backend === 'ai-search') {
      const svc = searchServiceName();
      if (!svc) return null;
      const tok = await searchToken();
      const r = await fetchWithTimeout(
        `https://${svc}.search.windows.net/indexes/${INDEX}/docs/${MANIFEST_KEY}?api-version=${SEARCH_API}`,
        { headers: { authorization: `Bearer ${tok}` } },
      );
      if (!r.ok) return null; // 404 (never indexed) or transient → full rebuild
      const j: any = await r.json();
      if (!j?.content) return null;
      return JSON.parse(j.content) as CorpusManifest;
    }
    const c = await helpCorpusContainer();
    const r = await c.item(MANIFEST_KEY, META_KIND).read<any>().catch(() => ({ resource: null }));
    const doc = r.resource;
    if (!doc?.content) return null;
    return JSON.parse(doc.content) as CorpusManifest;
  } catch (e: any) {
    console.warn('[loom-docs-index] manifest load failed', e?.message);
    return null;
  }
}

/** Persist the corpus manifest into the same store as the chunks. */
async function saveManifest(backend: 'ai-search' | 'cosmos', manifest: CorpusManifest): Promise<void> {
  const content = JSON.stringify(manifest);
  try {
    if (backend === 'ai-search') {
      const svc = searchServiceName();
      if (!svc) return;
      const tok = await searchToken();
      const body = {
        value: [{
          '@search.action': 'mergeOrUpload',
          id: MANIFEST_KEY, kind: META_KIND, path: '__corpus_manifest__',
          content, touchedAt: manifest.builtAt,
        }],
      };
      await fetchWithTimeout(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return;
    }
    const c = await helpCorpusContainer();
    await c.items.upsert({ id: MANIFEST_KEY, kind: META_KIND, path: '__corpus_manifest__', content, touchedAt: manifest.builtAt });
  } catch (e: any) {
    console.warn('[loom-docs-index] manifest save failed', e?.message);
  }
}

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
 * Compare the staged/source corpus against what was last indexed. Cheap: a
 * stat-only walk + a single manifest read (no file contents re-hashed). Used by
 * the copilot-corpus health probe so a stale corpus is detectable at runtime.
 */
export async function corpusFreshness(): Promise<CorpusFreshness> {
  const backend: 'ai-search' | 'cosmos' = isSearchConfigured() ? 'ai-search' : 'cosmos';
  const currentStat = statFingerprint(enumerateSourceFiles(detectRoots()));
  const manifest = await loadManifest(backend);
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

  // Full-rebuild path (also the AI-Search→Cosmos fallback), preserving the
  // original resilience: if AI Search upload fails, fall back to a full Cosmos push.
  const runFull = async (): Promise<ReindexResult> => {
    if (backend === 'ai-search') {
      const r = await pushChunksToSearch(chunks);
      if (!r.ok) {
        warnings.push(`AI Search upload failed: ${r.error}. Falling back to Cosmos.`);
        const c = await pushChunksToCosmos(chunks);
        await saveManifest('cosmos', buildManifest('cosmos'));
        return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 };
      }
      await saveManifest('ai-search', buildManifest('ai-search'));
      return { ok: true, backend: 'ai-search', totalChunks: chunks.length, uploaded: r.uploaded, byKind, warnings, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 };
    }
    const c = await pushChunksToCosmos(chunks);
    await saveManifest('cosmos', buildManifest('cosmos'));
    return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 };
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
      await saveManifest('cosmos', buildManifest('cosmos'));
      return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error, mode: 'full', skipped: 0, changed: changedCount, removed: 0, deleted: 0 };
    }
    const del = await deleteChunksFromSearch(diff.deleteIds);
    if (!del.ok) warnings.push(`AI Search stale-chunk delete incomplete: ${del.error}`);
    await saveManifest('ai-search', buildManifest('ai-search'));
    return { ok: true, backend: 'ai-search', totalChunks: chunks.length, uploaded: up.uploaded, byKind, warnings, mode: 'incremental', skipped, changed: diff.changed, removed: diff.removed, deleted: del.deleted };
  }

  const up = await pushChunksToCosmos(toUpsert);
  const del = await deleteChunksFromCosmos(diff.deleteEntries);
  await saveManifest('cosmos', buildManifest('cosmos'));
  return { ok: up.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: up.uploaded, byKind, warnings, error: up.error, mode: 'incremental', skipped, changed: diff.changed, removed: diff.removed, deleted: del.deleted };
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
};
