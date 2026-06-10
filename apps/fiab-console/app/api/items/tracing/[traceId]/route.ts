/**
 * GET /api/items/tracing/[traceId] — the full span tree for one trace
 * (operation_Id), reconstructed from App Insights dependencies + requests.
 *
 * Returns the flat span list ordered by timestamp; the editor builds the
 * parent→child tree client-side via each span's parentId.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryTraceDetail, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: { traceId: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const traceId = decodeURIComponent(params.traceId || '');
  if (!traceId) return NextResponse.json({ ok: false, error: 'traceId required' }, { status: 400 });
  try {
    const { spans } = await queryTraceDetail(traceId);
    return NextResponse.json({ ok: true, traceId, spans });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
