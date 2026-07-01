/**
 * Vector store — index management across the three live data-plane backends.
 *
 *   GET    /api/items/vector-store/[id]/index?name=<indexName>&backend=<b>
 *            → returns the live index/table/collection schema or { exists:false }.
 *   POST   /api/items/vector-store/[id]/index
 *            body { indexName, dim, metric, algorithm, backend }
 *            → creates/updates the vector index. Real backend per `backend`.
 *   PUT    /api/items/vector-store/[id]/index
 *            body { indexName, documents:[], backend } → bulk upsert.
 *
 * Backends (all REAL create/query paths, no mock):
 *   - ai-search    → Azure AI Search data plane (foundry-client).
 *   - pgvector     → PostgreSQL `vector` extension (pgvector-client).
 *   - cosmos-vcore → Cosmos DB for MongoDB vCore `cosmosSearch` index
 *                    (cosmos-vcore-vector-client).
 *   - cosmos-nosql → honest config-only gate (503) — DiskANN vector policy on a
 *                    Cosmos NoSQL container isn't wired in this build; use one of
 *                    the three backends above.
 *
 * Each backend surfaces an HONEST 503 gate (per no-vaporware.md) naming the exact
 * env var / role / one-time setup when its connection isn't wired — the full UI
 * still renders. Real errors from a wired backend are surfaced verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getIndex, upsertIndex, uploadDocuments, buildVectorIndexDefinition,
  FoundryError, NotDeployedError,
} from '@/lib/azure/foundry-client';
import {
  pgVectorGate, getPgVectorSchema, createPgVectorIndex, upsertPgVectorDocs,
  type VectorMetric, type VectorAlgorithm,
} from '@/lib/azure/pgvector-client';
import {
  cosmosVcoreGate, getVcoreVectorIndex, createVcoreVectorIndex, upsertVcoreDocs,
  CosmosVcoreDriverError, CosmosVcoreError,
} from '@/lib/azure/cosmos-vcore-vector-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'ai-search' | 'cosmos-nosql' | 'cosmos-vcore' | 'pgvector';

function backendOf(v: unknown): Backend {
  return v === 'pgvector' || v === 'cosmos-vcore' || v === 'cosmos-nosql' ? v : 'ai-search';
}

/** Honest 503 for cosmos-nosql (DiskANN vector policy not wired in this build). */
function cosmosNosqlGate() {
  return NextResponse.json({
    ok: false, deferred: true,
    error: 'Cosmos DB for NoSQL (DiskANN) vector backend is config-only in this build.',
    hint: 'Switch the backend to ai-search, cosmos-vcore, or pgvector to create/query a live index here, or provision a Cosmos NoSQL container with a vector-embedding policy and wire its data plane.',
  }, { status: 503 });
}

/** Map any backend error to a structured JSON gate/error response. */
function gate(e: any) {
  if (e instanceof NotDeployedError || e instanceof CosmosVcoreDriverError) {
    return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: (e as any).hint }, { status: 503 });
  }
  if (e instanceof CosmosVcoreError && e.status === 503) {
    return NextResponse.json({ ok: false, deferred: true, error: e.message }, { status: 503 });
  }
  const status = (e instanceof FoundryError || e instanceof CosmosVcoreError) ? e.status : (e?.status || 502);
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
}

function gateResponse(g: { missing: string; hint: string }) {
  return NextResponse.json({ ok: false, deferred: true, error: `${g.missing} not set.`, hint: g.hint }, { status: 503 });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  const backend = backendOf(req.nextUrl.searchParams.get('backend'));
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
    if (backend === 'pgvector') {
      const g = pgVectorGate(); if (g) return gateResponse(g);
      const schema = await getPgVectorSchema(name);
      return NextResponse.json({ ok: true, exists: !!schema, index: schema });
    }
    if (backend === 'cosmos-vcore') {
      const g = cosmosVcoreGate(); if (g) return gateResponse(g);
      const schema = await getVcoreVectorIndex(name);
      return NextResponse.json({ ok: true, exists: !!schema, index: schema });
    }
    if (backend === 'cosmos-nosql') return cosmosNosqlGate();
    const def = await getIndex(name);
    if (!def) return NextResponse.json({ ok: true, exists: false, index: null });
    return NextResponse.json({ ok: true, exists: true, index: def });
  } catch (e: any) { return gate(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  const dim = Number(body?.dim || 0);
  const metric = (body?.metric || 'cosine') as VectorMetric;
  const algorithm = (body?.algorithm === 'exhaustiveKnn' ? 'exhaustiveKnn' : 'hnsw') as VectorAlgorithm;
  const backend = backendOf(body?.backend);
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!dim || dim < 1) return NextResponse.json({ ok: false, error: 'dim must be a positive integer' }, { status: 400 });
  try {
    if (backend === 'pgvector') {
      const g = pgVectorGate(); if (g) return gateResponse(g);
      const schema = await createPgVectorIndex({ table: indexName, dim, metric, algorithm });
      return NextResponse.json({ ok: true, index: { name: indexName, fields: schema?.fields } });
    }
    if (backend === 'cosmos-vcore') {
      const g = cosmosVcoreGate(); if (g) return gateResponse(g);
      const schema = await createVcoreVectorIndex({ collection: indexName, dim, metric, algorithm });
      return NextResponse.json({ ok: true, index: { name: indexName, fields: schema.fields } });
    }
    if (backend === 'cosmos-nosql') return cosmosNosqlGate();
    const def = buildVectorIndexDefinition({
      indexName, dim, metric,
      vectorField: body?.vectorField, contentField: body?.contentField, algorithm,
    });
    const created = await upsertIndex(indexName, def);
    return NextResponse.json({ ok: true, index: { name: created?.name || indexName, fields: created?.fields }, definition: def });
  } catch (e: any) { return gate(e); }
}

/** PUT = bulk document upload (mergeOrUpload / upsert). body { indexName, documents:[], backend } */
export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  const documents = Array.isArray(body?.documents) ? body.documents : null;
  const backend = backendOf(body?.backend);
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!documents || documents.length === 0) return NextResponse.json({ ok: false, error: 'documents[] required' }, { status: 400 });
  try {
    if (backend === 'pgvector') {
      const g = pgVectorGate(); if (g) return gateResponse(g);
      const r = await upsertPgVectorDocs({ table: indexName, documents });
      return NextResponse.json({ ok: true, uploaded: r.uploaded, results: r.results });
    }
    if (backend === 'cosmos-vcore') {
      const g = cosmosVcoreGate(); if (g) return gateResponse(g);
      const r = await upsertVcoreDocs({ collection: indexName, documents });
      return NextResponse.json({ ok: true, uploaded: r.uploaded, results: r.results });
    }
    if (backend === 'cosmos-nosql') return cosmosNosqlGate();
    const r = await uploadDocuments(indexName, documents);
    return NextResponse.json({ ok: true, uploaded: r.uploaded, results: r.results });
  } catch (e: any) { return gate(e); }
}
