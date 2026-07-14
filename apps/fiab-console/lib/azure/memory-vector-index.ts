/**
 * CTS-08 — Azure AI Search vector mirror for the Copilot memory brain.
 *
 * Cosmos `copilot-memory` is the system of record; this module maintains the ANN
 * mirror index `copilot-memory-vec` so recall is a real vector search, not a
 * substring scan. It dual-writes on create/update (app-side embedding via the
 * unified AOAI embeddings client) and vector-searches on recall, filtered to the
 * caller's scope keys so a query can never surface a foreign scope's memory.
 *
 * HONEST GATE (no-vaporware.md): when `LOOM_AI_SEARCH_SERVICE` is unset the mirror
 * is a silent no-op — `isMemoryVectorConfigured()` is false and the caller
 * (memory-recall.ts) degrades to the Cosmos keyword/tag fallback. A vector-mirror
 * hiccup NEVER breaks a memory write or a chat turn (every path fails open).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { embedText } from '@/lib/azure/embeddings-client';
import { escapeSqlLiteral } from '@/lib/sql/quoting';
import { embeddingModelDimensions } from '@/lib/azure/vectorizer-consistency';
import type { MemoryRecord } from '@/lib/copilot/memory-types';

const SEARCH_API = '2024-07-01';

const credential = new ChainedTokenCredential(
  new AcaManagedIdentityCredential(),
  ...((process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID)
    ? [new ManagedIdentityCredential({ clientId: process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID })]
    : []),
  new DefaultAzureCredential(),
);

function searchServiceName(): string | null {
  return process.env.LOOM_AI_SEARCH_SERVICE || null;
}

export function isMemoryVectorConfigured(): boolean {
  return !!searchServiceName();
}

function indexName(): string {
  return process.env.LOOM_COPILOT_MEMORY_VEC_INDEX || 'copilot-memory-vec';
}

function embedDim(): number {
  const dep = process.env.LOOM_AOAI_EMBED_DEPLOYMENT || 'text-embedding-3-large';
  return embeddingModelDimensions(dep) || 3072;
}

async function searchToken(): Promise<string> {
  const t = await credential.getToken('https://search.azure.com/.default');
  if (!t?.token) throw new Error('Failed to acquire token for AI Search');
  return t.token;
}

function indexUrl(path: string): string {
  const svc = searchServiceName();
  return `https://${svc}.search.windows.net/indexes/${indexName()}${path}?api-version=${SEARCH_API}`;
}

/** Idempotently create the vector index. Best-effort — returns a structured
 *  result; callers treat a failure as "mirror unavailable" and fall back. */
export async function ensureMemoryVectorIndex(): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const svc = searchServiceName();
  if (!svc) return { ok: false, created: false, error: 'LOOM_AI_SEARCH_SERVICE not set' };
  try {
    const tok = await searchToken();
    const get = await fetchWithTimeout(indexUrl(''), { headers: { authorization: `Bearer ${tok}` } });
    if (get.status === 200) return { ok: true, created: false };
    const definition = {
      name: indexName(),
      fields: [
        { name: 'id', type: 'Edm.String', key: true, filterable: true, retrievable: true },
        { name: 'scopeKey', type: 'Edm.String', filterable: true, retrievable: true },
        { name: 'scope', type: 'Edm.String', filterable: true, retrievable: true },
        { name: 'tenantId', type: 'Edm.String', filterable: true, retrievable: true },
        { name: 'category', type: 'Edm.String', filterable: true, retrievable: true },
        { name: 'content', type: 'Edm.String', searchable: true, retrievable: true, analyzer: 'standard.lucene' },
        {
          name: 'contentVector', type: 'Collection(Edm.Single)', searchable: true, retrievable: false,
          dimensions: embedDim(), vectorSearchProfile: 'mem-vec-profile',
        },
      ],
      vectorSearch: {
        algorithms: [{ name: 'mem-hnsw', kind: 'hnsw' }],
        profiles: [{ name: 'mem-vec-profile', algorithm: 'mem-hnsw' }],
      },
    };
    const put = await fetchWithTimeout(indexUrl(''), {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(definition),
    });
    if (!put.ok) return { ok: false, created: false, error: `PUT index ${put.status}: ${(await put.text()).slice(0, 200)}` };
    return { ok: true, created: true };
  } catch (e: any) {
    return { ok: false, created: false, error: e?.message || String(e) };
  }
}

/** Dual-write one memory into the vector mirror. Returns the embedding doc key on
 *  success (stored back on the Cosmos record as `embeddingId`), or null on any
 *  failure/gate — the write to Cosmos still stands. */
export async function upsertMemoryVector(rec: MemoryRecord): Promise<string | null> {
  if (!isMemoryVectorConfigured()) return null;
  try {
    await ensureMemoryVectorIndex();
    const vector = await embedText(rec.content);
    if (!vector.length) return null;
    const tok = await searchToken();
    const doc = {
      '@search.action': 'mergeOrUpload',
      id: rec.id,
      scopeKey: rec.scopeKey,
      scope: rec.scope,
      tenantId: rec.tenantId || '',
      category: rec.category,
      content: rec.content,
      contentVector: vector,
    };
    const r = await fetchWithTimeout(indexUrl('/docs/index'), {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [doc] }),
    });
    if (!r.ok) return null;
    return rec.id;
  } catch {
    return null;
  }
}

/** Remove one memory from the mirror (best-effort, on delete/purge). */
export async function deleteMemoryVector(id: string): Promise<void> {
  if (!isMemoryVectorConfigured()) return;
  try {
    const tok = await searchToken();
    await fetchWithTimeout(indexUrl('/docs/index'), {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: [{ '@search.action': 'delete', id }] }),
    });
  } catch {
    /* best-effort */
  }
}

/** Vector-search the mirror for `query`, restricted to `scopeKeys`. Returns the
 *  matching memory ids in relevance order, or null when the mirror is
 *  unconfigured/unavailable (caller falls back to the Cosmos keyword scan). */
export async function searchMemoryVector(
  query: string,
  scopeKeys: string[],
  topK: number,
): Promise<Array<{ id: string; score: number }> | null> {
  if (!isMemoryVectorConfigured() || !query.trim() || scopeKeys.length === 0) return null;
  try {
    const vector = await embedText(query);
    if (!vector.length) return null;
    const tok = await searchToken();
    // OData string literals use the same ''-doubling as SQL — centralised helper
    // (guardrails sql-quoting arm).
    const filter = scopeKeys.map((k) => `scopeKey eq '${escapeSqlLiteral(k)}'`).join(' or ');
    const body = {
      count: false,
      select: 'id,scopeKey',
      filter,
      vectorQueries: [{ kind: 'vector', vector, fields: 'contentVector', k: topK }],
      top: topK,
    };
    const r = await fetchWithTimeout(indexUrl('/docs/search'), {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return r.status === 404 ? null : null;
    const j: any = await r.json();
    const hits = (j.value || []) as Array<{ id: string; '@search.score'?: number }>;
    return hits.map((h) => ({ id: h.id, score: h['@search.score'] || 0 }));
  } catch {
    return null;
  }
}
