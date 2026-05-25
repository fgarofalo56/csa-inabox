/**
 * POST /api/items/dataflow/[id]/refresh?workspaceId=...
 *   Triggers a Refresh job on the dataflow item.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { refreshDataflow, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const res = await refreshDataflow(workspaceId, ctx.params.id);
    return NextResponse.json({ ok: true, ...res });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint }, { status });
  }
}
