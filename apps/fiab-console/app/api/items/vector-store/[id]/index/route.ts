/**
 * Vector store — index management against Azure AI Search (data-plane).
 *
 *   GET    /api/items/vector-store/[id]/index?name=<indexName>
 *            → returns the live index definition (fields + vectorSearch) or
 *              404 when it doesn't exist yet. Used by the editor to show the
 *              real index schema next to the persisted spec.
 *   POST   /api/items/vector-store/[id]/index
 *            body { indexName, dim, metric, vectorField?, contentField? }
 *            → creates/updates the vector index (PUT /indexes). Real backend.
 *   PUT    /api/items/vector-store/[id]/index/docs   (handled below via ?action=docs)
 *
 * When LOOM_AI_SEARCH_SERVICE is unset the AI Search backend throws
 * NotDeployedError → 503 with the exact env var to set (honest gate).
 *
 * Note: only the `ai-search` backend has a live data-plane here. The other
 * backends (cosmos-nosql / cosmos-vcore / pgvector) persist their spec via
 * the Cosmos item route and surface an honest gate in the editor — they are
 * not reachable from this Loom build's network yet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getIndex, upsertIndex, uploadDocuments, buildVectorIndexDefinition,
  FoundryError, NotDeployedError,
} from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate(e: any) {
  if (e instanceof NotDeployedError) {
    return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: (e as any).hint }, { status: 503 });
  }
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
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
  const metric = (body?.metric || 'cosine') as 'cosine' | 'euclidean' | 'dotProduct';
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!dim || dim < 1) return NextResponse.json({ ok: false, error: 'dim must be a positive integer' }, { status: 400 });
  try {
    const def = buildVectorIndexDefinition({
      indexName, dim, metric,
      vectorField: body?.vectorField, contentField: body?.contentField,
      algorithm: body?.algorithm === 'exhaustiveKnn' ? 'exhaustiveKnn' : 'hnsw',
    });
    const created = await upsertIndex(indexName, def);
    return NextResponse.json({ ok: true, index: { name: created?.name || indexName, fields: created?.fields }, definition: def });
  } catch (e: any) { return gate(e); }
}

/** PUT = bulk document upload (mergeOrUpload). body { indexName, documents:[] } */
export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  const documents = Array.isArray(body?.documents) ? body.documents : null;
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!documents || documents.length === 0) return NextResponse.json({ ok: false, error: 'documents[] required' }, { status: 400 });
  try {
    const r = await uploadDocuments(indexName, documents);
    return NextResponse.json({ ok: true, uploaded: r.uploaded, results: r.results });
  } catch (e: any) { return gate(e); }
}
