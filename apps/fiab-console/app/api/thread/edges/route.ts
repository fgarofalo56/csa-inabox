/**
 * GET /api/thread/edges — the caller's Loom Thread edge graph.
 *
 * Returns every "Weave" integration the caller has created (from → to), most
 * recent first, for the lineage / mesh view. Real Cosmos read (no mocks); an
 * empty graph is an honest empty state (nothing woven yet), not an error.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listThreadEdges } from '@/lib/thread/thread-edges';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const edges = await listThreadEdges(session);
    return NextResponse.json({ ok: true, edges });
  } catch (e: any) {
    return apiServerError(e);
  }
}
