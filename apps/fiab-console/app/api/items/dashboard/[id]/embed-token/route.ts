/**
 * POST /api/items/dashboard/[id]/embed-token
 *
 * Body: { workspaceId: string }
 * Returns: { ok, token, tokenId, expiration, embedUrl }
 *
 * Proxies POST /v1.0/myorg/groups/{ws}/dashboards/{id}/GenerateToken using
 * the Console UAMI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateDashboardEmbedToken, getDashboard, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [tokenResp, dashboard] = await Promise.all([
      generateDashboardEmbedToken(workspaceId, ctx.params.id, 'View'),
      getDashboard(workspaceId, ctx.params.id),
    ]);
    return NextResponse.json({
      ok: true,
      ...tokenResp,
      embedUrl: dashboard.embedUrl,
      dashboardId: dashboard.id,
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
