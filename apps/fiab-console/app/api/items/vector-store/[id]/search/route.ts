/**
 * Vector store — similarity search against Azure AI Search.
 *
 *   POST /api/items/vector-store/[id]/search
 *     body { indexName, vector: number[], k?, text?, vectorField?, select? }
 *       → k-NN (and optional hybrid text) search against the index.
 *
 * Honest gate: 503 + NotDeployedError hint when LOOM_AI_SEARCH_SERVICE unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { vectorSearch, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const indexName = String(body?.indexName || '').trim();
  const vector = Array.isArray(body?.vector) ? body.vector.map(Number) : null;
  if (!indexName) return NextResponse.json({ ok: false, error: 'indexName required' }, { status: 400 });
  if (!vector || vector.length === 0 || vector.some((n: number) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, error: 'vector must be a non-empty numeric array' }, { status: 400 });
  }
  try {
    const result = await vectorSearch(indexName, {
      vector, field: body?.vectorField || 'embedding',
      k: body?.k || 5, text: body?.text || undefined, select: body?.select || undefined,
    });
    return NextResponse.json({ ok: true, count: (result?.value || []).length, result });
  } catch (e: any) {
    if (e instanceof NotDeployedError) {
      return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: (e as any).hint }, { status: 503 });
    }
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
