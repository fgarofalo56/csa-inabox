/**
 * Loom docs index — RAG corpus for the Help Copilot widget.
 *
 * Indexes:
 *   - docs/fiab/**\/*.md      (published CSA Loom pages)
 *   - docs/**\/*.md           (broader csa-inabox docs)
 *   - apps/fiab-console/lib/**\/*.{ts,tsx} summaries
 *   - PRPs/active/csa-loom/*.md
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

import fs from 'node:fs';
import path from 'node:path';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type { Container } from '@azure/cosmos';

import { copilotSessionsContainer } from './cosmos-client';

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
  ...(process.env.LOOM_UAMI_CLIENT_ID
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

const SEARCH_API = '2024-07-01';
const INDEX = 'loom-docs';
const COSMOS_CONTAINER_ID = 'help-copilot-corpus';

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
    const get = await fetch(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (get.status === 200) return { ok: true, created: false };
    const put = await fetch(`https://${svc}.search.windows.net/indexes/${INDEX}?api-version=${SEARCH_API}`, {
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
      const r = await fetch(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/index?api-version=${SEARCH_API}`, {
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

async function searchSearch(query: string, top: number, kind?: DocChunk['kind']): Promise<DocHit[]> {
  const svc = searchServiceName();
  if (!svc) return [];
  const tok = await searchToken();
  const filter = kind ? `kind eq '${kind}'` : undefined;
  const body: Record<string, unknown> = {
    search: query,
    queryType: 'simple',
    searchMode: 'any',
    top,
    select: 'id,kind,path,heading,content,url,touchedAt',
  };
  if (filter) body.filter = filter;
  const r = await fetch(`https://${svc}.search.windows.net/indexes/${INDEX}/docs/search?api-version=${SEARCH_API}`, {
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
      : { query: 'SELECT * FROM c' };
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
  if (isSearchConfigured()) {
    try {
      const hits = await searchSearch(query, top, kind);
      if (hits.length > 0) return { hits, backend: 'ai-search' };
    } catch (e: any) {
      console.warn('[loom-docs-index] ai-search failed, falling back', e?.message);
    }
  }
  const hits = await searchCosmos(query, top, kind);
  return { hits, backend: hits.length > 0 || !isSearchConfigured() ? 'cosmos' : 'ai-search' };
}

// ---------- Corpus walker ----------

interface RepoRoots {
  /** Repo root (parent of `apps/`). */
  repoRoot: string;
  /** `docs/` */
  docsRoot: string;
  /** `apps/fiab-console/lib/` */
  consoleLibRoot: string;
  /** `PRPs/active/csa-loom/` */
  prpRoot: string;
  /** `docs/fiab/adr/` */
  adrRoot: string;
}

function detectRoots(): RepoRoots {
  // Resolve from cwd. In ACA `cwd` is the next standalone server dir;
  // in dev it's `apps/fiab-console`. Walk up until we find `mkdocs.yml`.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'mkdocs.yml'))) break;
    dir = path.dirname(dir);
  }
  return {
    repoRoot: dir,
    docsRoot: path.join(dir, 'docs'),
    consoleLibRoot: path.join(dir, 'apps', 'fiab-console', 'lib'),
    prpRoot: path.join(dir, 'PRPs', 'active', 'csa-loom'),
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

export interface ReindexResult {
  ok: boolean;
  backend: 'ai-search' | 'cosmos' | 'none';
  totalChunks: number;
  uploaded: number;
  byKind: Record<string, number>;
  error?: string;
  warnings: string[];
}

export async function buildCorpus(): Promise<DocChunk[]> {
  const roots = detectRoots();
  const chunks: DocChunk[] = [];

  // Markdown sources
  const sources: Array<{ root: string; kind: DocChunk['kind']; prefix: string }> = [
    { root: path.join(roots.docsRoot, 'fiab'), kind: 'docs', prefix: path.join(roots.repoRoot) },
    { root: roots.docsRoot, kind: 'docs', prefix: path.join(roots.repoRoot) },
    { root: roots.prpRoot, kind: 'prp', prefix: path.join(roots.repoRoot) },
    { root: roots.adrRoot, kind: 'adr', prefix: path.join(roots.repoRoot) },
  ];

  const seen = new Set<string>();
  for (const src of sources) {
    const files = walkMarkdown(src.root);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      let raw = '';
      try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const stat = fs.statSync(file);
      const rel = path.relative(src.prefix, file).replace(/\\/g, '/');
      const blocks = chunkMarkdown(raw);
      blocks.forEach((b, idx) => {
        const id = `${src.kind}:${rel}#${idx}`;
        chunks.push({
          id,
          kind: src.kind,
          path: rel,
          heading: b.heading,
          content: b.content,
          url: docsUrlForPath(rel),
          touchedAt: stat.mtime.toISOString(),
        });
      });
    }
  }

  // Repo source summaries (lib/azure + lib/editors + lib/components)
  const repoFiles = [
    ...walkSource(path.join(roots.consoleLibRoot, 'azure')),
    ...walkSource(path.join(roots.consoleLibRoot, 'editors')),
    ...walkSource(path.join(roots.consoleLibRoot, 'components')),
  ];
  for (const file of repoFiles) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    const summary = summarizeSource(file, raw);
    if (!summary) continue;
    const stat = fs.statSync(file);
    const rel = path.relative(roots.repoRoot, file).replace(/\\/g, '/');
    chunks.push({
      id: `repo:${rel}#0`,
      kind: 'repo',
      path: rel,
      content: summary,
      touchedAt: stat.mtime.toISOString(),
    });
  }

  return chunks;
}

export async function reindex(): Promise<ReindexResult> {
  const warnings: string[] = [];
  const chunks = await buildCorpus();
  const byKind: Record<string, number> = {};
  for (const c of chunks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;

  if (chunks.length === 0) {
    return {
      ok: false, backend: 'none', totalChunks: 0, uploaded: 0, byKind,
      warnings, error: 'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd',
    };
  }

  if (isSearchConfigured()) {
    const ensure = await ensureDocsIndex();
    if (!ensure.ok) {
      warnings.push(`AI Search index ensure failed: ${ensure.error}. Falling back to Cosmos.`);
      const c = await pushChunksToCosmos(chunks);
      return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error };
    }
    const r = await pushChunksToSearch(chunks);
    if (!r.ok) {
      warnings.push(`AI Search upload failed: ${r.error}. Falling back to Cosmos.`);
      const c = await pushChunksToCosmos(chunks);
      return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error };
    }
    return { ok: true, backend: 'ai-search', totalChunks: chunks.length, uploaded: r.uploaded, byKind, warnings };
  }

  warnings.push('LOOM_AI_SEARCH_SERVICE not set — using Cosmos substring fallback. ' +
    'Set the env var and re-run /api/help-copilot/reindex to enable hybrid search.');
  const c = await pushChunksToCosmos(chunks);
  return { ok: c.ok, backend: 'cosmos', totalChunks: chunks.length, uploaded: c.uploaded, byKind, warnings, error: c.error };
}
