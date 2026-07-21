/**
 * Vector store — similarity (k-NN) search + hybrid + rerank across backends.
 *
 *   POST /api/items/vector-store/[id]/search
 *     body { indexName, vector?: number[], queryText?: string, k?, text?,
 *            metric?, vectorField?, select?, backend?, rerank?, semantic? }
 *       → k-NN (and optional hybrid BM25 text) against the store, with optional
 *         reranking of the candidate set.
 *
 * Query shaping (WS-2.2):
 *   - `queryText` (or `text`) with no `vector` → the text is embedded with the
 *     real Azure OpenAI embeddings data-plane (aoaiEmbed) and used as the k-NN
 *     query vector. So a caller can search by text alone.
 *   - `rerank: true` → retrieve a WIDER candidate set, then apply the portable
 *     fusion reranker (normalized retrieval score ⊕ lexical overlap of the query
 *     text) and trim to `k`. Works on every backend.
 *   - `semantic: true` (ai-search only) → additionally asks AI Search for its L2
 *     semantic reranker score (queryType=semantic), which the fusion reranker
 *     then consumes as the retrieval signal. This is Databricks Vector Search
 *     "hybrid + rerank" parity, Azure-native.
 *
 * Backends (all REAL k-NN, no mock): ai-search, pgvector, cosmos-vcore, and the
 * honest cosmos-nosql gate. Honest 503 + hint when a backend isn't wired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { vectorSearch, FoundryError, NotDeployedError, LOOM_SEMANTIC_CONFIG } from '@/lib/azure/foundry-client';
import { pgVectorGate, pgVectorSearch, type VectorMetric } from '@/lib/azure/pgvector-client';
import {
  cosmosVcoreGate, vcoreVectorSearch, CosmosVcoreDriverError, CosmosVcoreError,
} from '@/lib/azure/cosmos-vcore-vector-client';
import { aoaiEmbed } from '@/lib/azure/aoai-chat-client';
import { rerankByFusion } from '@/lib/azure/vector-rerank';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'ai-search' | 'cosmos-nosql' | 'cosmos-vcore' | 'pgvector';
function backendOf(v: unknown): Backend {
  return v === 'pgvector' || v === 'cosmos-vcore' || v === 'cosmos-nosql' ? v : 'ai-search';
}

function gateResponse(g: { missing: string; hint: string }) {
  return NextResponse.json({ ok: false, deferred: true, error: `${g.missing} not set.`, hint: g.hint }, { status: 503 });
}

/** Candidate breadth for the rerank stage — retrieve more than k, rerank, trim. */
function candidateTop(k: number, rerank: boolean): number {
  return rerank ? Math.max(k * 5, 30) : k;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const started = Date.now();
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  let vector = Array.isArray(body?.vector) ? body.vector.map(Number) : null;
  const metric = (body?.metric || 'cosine') as VectorMetric;
  const k = body?.k || 5;
  const backend = backendOf(body?.backend);
  const rerank = body?.rerank === true;
  const semantic = body?.semantic === true;
  const queryText = String(body?.queryText || body?.text || '').trim();
  const bm25Text = String(body?.text || '').trim() || (queryText || undefined);

  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });

  // Embed the query text when no explicit vector is supplied (text-only search).
  if ((!vector || vector.length === 0) && queryText) {
    try {
      const emb = await aoaiEmbed({ input: queryText, deployment: body?.embedDeployment });
      vector = emb.vectors?.[0] || null;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/NoAoaiDeployment|embeddings deployment|not configured|not found/i.test(msg)) {
        return NextResponse.json({
          ok: false, deferred: true,
          error: 'Azure OpenAI embeddings are not configured, so the query text cannot be embedded.',
          hint: 'Provide a numeric query vector, or deploy a text-embedding model and set LOOM_AOAI_EMBED_DEPLOYMENT.',
        }, { status: 503 });
      }
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }
  }

  if (!vector || vector.length === 0 || vector.some((n: number) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, error: 'provide a non-empty numeric vector, or a queryText to embed' }, { status: 400 });
  }

  const top = candidateTop(k, rerank);
  try {
    let value: any[];
    if (backend === 'pgvector') {
      const g = pgVectorGate(); if (g) return gateResponse(g);
      const result = await pgVectorSearch({ table: indexName, vector, k: top, metric });
      value = result.value;
    } else if (backend === 'cosmos-vcore') {
      const g = cosmosVcoreGate(); if (g) return gateResponse(g);
      const result = await vcoreVectorSearch({ collection: indexName, vector, k: top });
      value = result.value;
    } else if (backend === 'cosmos-nosql') {
      return NextResponse.json({
        ok: false, deferred: true,
        error: 'Cosmos DB for NoSQL (DiskANN) vector backend is config-only in this build.',
        hint: 'Switch the backend to ai-search, cosmos-vcore, or pgvector to run a live k-NN search here.',
      }, { status: 503 });
    } else {
      const result = await vectorSearch(indexName, {
        vector, field: body?.vectorField || 'embedding',
        k, top, text: bm25Text, select: body?.select || undefined,
        semanticConfiguration: semantic ? LOOM_SEMANTIC_CONFIG : undefined,
      });
      value = result?.value || [];
    }

    // Rerank (fusion) when requested — reorders the candidate set by a blend of
    // the normalized retrieval score and the query-text lexical overlap, then
    // trims to k. Without rerank the raw candidate order is preserved.
    let reranked = false;
    if (rerank) {
      const ranked = rerankByFusion(value, queryText, k);
      value = ranked.map((r) => ({ ...r.doc, '@loom.rerankScore': r.rerankScore }));
      reranked = true;
    }

    return NextResponse.json({
      ok: true,
      count: value.length,
      reranked,
      semanticApplied: backend === 'ai-search' && semantic,
      tookMs: Date.now() - started,
      result: { value },
    });
  } catch (e: any) {
    if (e instanceof NotDeployedError || e instanceof CosmosVcoreDriverError) {
      return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: (e as any).hint }, { status: 503 });
    }
    if (e instanceof CosmosVcoreError && e.status === 503) {
      return NextResponse.json({ ok: false, deferred: true, error: e.message }, { status: 503 });
    }
    const status = (e instanceof FoundryError || e instanceof CosmosVcoreError) ? e.status : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
