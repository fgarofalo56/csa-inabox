/**
 * GET /api/items/dashboard/[id]?workspaceId=...
 * Returns dashboard metadata + tile list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDashboard, listDashboardTiles, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [dashboard, tiles] = await Promise.all([
      getDashboard(workspaceId, ctx.params.id),
      listDashboardTiles(workspaceId, ctx.params.id).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, workspaceId, dashboard, tiles });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
