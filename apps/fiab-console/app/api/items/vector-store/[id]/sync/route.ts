/**
 * Vector store — Delta→index incremental sync (WS-2.2).
 *
 *   POST /api/items/vector-store/[id]/sync
 *     body { indexName, deltaUri, keyColumn, contentColumns[], maxRows?,
 *            embedDeployment?, backend?, contentField?, vectorField? }
 *       → reads the source Delta table (Synapse Serverless OPENROWSET), diffs
 *         against the last sync, re-embeds + upserts changed rows, deletes
 *         removed rows, and returns { synced, skipped, removed, sourceRows }.
 *
 *   GET  /api/items/vector-store/[id]/sync?name=<indexName>
 *       → the persisted binding + last-sync status for the editor's status panel.
 *
 * Backend: the Delta auto-sync indexes into Azure AI Search (the default vector
 * backend — it carries hybrid BM25 + vector + the L2 semantic reranker, i.e.
 * Databricks Vector Search "Delta Sync Index" parity). Other backends return an
 * honest gate directing the user to AI Search. No Fabric dependency: ADLS Gen2
 * Delta + Synapse Serverless + Azure OpenAI embeddings, all Gov-safe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  syncDeltaToVectorIndex, getSyncStatus, SyncGateError,
} from '@/lib/azure/vector-delta-sync';
import { FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate(missing: string, hint: string) {
  return NextResponse.json({ ok: false, deferred: true, error: missing, hint }, { status: 503 });
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
    const status = await getSyncStatus(id, name);
    return NextResponse.json({ ok: true, status });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await props.params;
  const body = await req.json().catch(() => ({}));

  const indexName = String(body?.indexName || '').trim();
  const deltaUri = String(body?.deltaUri || '').trim();
  const keyColumn = String(body?.keyColumn || '').trim();
  const contentColumns = Array.isArray(body?.contentColumns)
    ? body.contentColumns.map((c: unknown) => String(c).trim()).filter(Boolean)
    : [];
  const backend = body?.backend || 'ai-search';

  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!deltaUri) return NextResponse.json({ ok: false, error: 'deltaUri required' }, { status: 400 });
  if (!keyColumn) return NextResponse.json({ ok: false, error: 'keyColumn required' }, { status: 400 });
  if (contentColumns.length === 0) return NextResponse.json({ ok: false, error: 'contentColumns[] required' }, { status: 400 });

  if (backend !== 'ai-search') {
    return gate(
      `Delta auto-sync indexes into the AI Search backend; "${backend}" is not supported for auto-sync.`,
      'Switch the vector-store backend to ai-search to bind a Delta table and auto-index it incrementally. ' +
      'pgvector / Cosmos vCore support manual document upload today.',
    );
  }

  try {
    const result = await syncDeltaToVectorIndex(id, indexName, {
      deltaUri, keyColumn, contentColumns,
      maxRows: Number(body?.maxRows) || undefined,
      embedDeployment: body?.embedDeployment ? String(body.embedDeployment) : undefined,
    }, {
      contentField: body?.contentField ? String(body.contentField) : undefined,
      vectorField: body?.vectorField ? String(body.vectorField) : undefined,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e instanceof SyncGateError) return gate(e.message, e.hint);
    if (e instanceof NotDeployedError) return gate(e.message, (e as any).hint || 'Set LOOM_AI_SEARCH_SERVICE.');
    const status = e instanceof FoundryError ? e.status : (e?.status || 502);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
