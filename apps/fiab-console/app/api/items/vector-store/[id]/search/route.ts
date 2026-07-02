/**
 * Vector store — similarity (kNN) search across the three live backends.
 *
 *   POST /api/items/vector-store/[id]/search
 *     body { indexName, vector: number[], k?, text?, metric?, vectorField?, select?, backend? }
 *       → k-NN (and optional hybrid text on AI Search) against the store.
 *
 * Backends (all REAL kNN, no mock):
 *   - ai-search    → AI Search vector (+ optional BM25 hybrid) — foundry-client.
 *   - pgvector     → ORDER BY embedding <op> $1::vector LIMIT k — pgvector-client.
 *   - cosmos-vcore → $search/cosmosSearch aggregation — cosmos-vcore-vector-client.
 *   - cosmos-nosql → honest config-only gate (503).
 *
 * Honest gate: 503 + hint when a backend's connection isn't wired (env var named).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { vectorSearch, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { pgVectorGate, pgVectorSearch, type VectorMetric } from '@/lib/azure/pgvector-client';
import {
  cosmosVcoreGate, vcoreVectorSearch, CosmosVcoreDriverError, CosmosVcoreError,
} from '@/lib/azure/cosmos-vcore-vector-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'ai-search' | 'cosmos-nosql' | 'cosmos-vcore' | 'pgvector';
function backendOf(v: unknown): Backend {
  return v === 'pgvector' || v === 'cosmos-vcore' || v === 'cosmos-nosql' ? v : 'ai-search';
}

function gateResponse(g: { missing: string; hint: string }) {
  return NextResponse.json({ ok: false, deferred: true, error: `${g.missing} not set.`, hint: g.hint }, { status: 503 });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  const vector = Array.isArray(body?.vector) ? body.vector.map(Number) : null;
  const metric = (body?.metric || 'cosine') as VectorMetric;
  const k = body?.k || 5;
  const backend = backendOf(body?.backend);
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!vector || vector.length === 0 || vector.some((n: number) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, error: 'vector must be a non-empty numeric array' }, { status: 400 });
  }
  try {
    if (backend === 'pgvector') {
      const g = pgVectorGate(); if (g) return gateResponse(g);
      const result = await pgVectorSearch({ table: indexName, vector, k, metric });
      return NextResponse.json({ ok: true, count: result.value.length, result });
    }
    if (backend === 'cosmos-vcore') {
      const g = cosmosVcoreGate(); if (g) return gateResponse(g);
      const result = await vcoreVectorSearch({ collection: indexName, vector, k });
      return NextResponse.json({ ok: true, count: result.value.length, result });
    }
    if (backend === 'cosmos-nosql') {
      return NextResponse.json({
        ok: false, deferred: true,
        error: 'Cosmos DB for NoSQL (DiskANN) vector backend is config-only in this build.',
        hint: 'Switch the backend to ai-search, cosmos-vcore, or pgvector to run a live k-NN search here.',
      }, { status: 503 });
    }
    const result = await vectorSearch(indexName, {
      vector, field: body?.vectorField || 'embedding',
      k, text: body?.text || undefined, select: body?.select || undefined,
    });
    return NextResponse.json({ ok: true, count: (result?.value || []).length, result });
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
