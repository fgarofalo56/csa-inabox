/**
 * POST /api/items/dashboard/[id]/tile-embed-token
 *
 * Body: { workspaceId: string, tileId: string }
 * Returns: { ok, token, tokenId, expiration }
 *
 * Mints a per-TILE embed token (Tiles - Generate Token) so a single pinned
 * Power BI tile can embed on the Loom canvas independently of the full
 * dashboard. Opt-in Fabric-family path — the Azure-native Loom tiles need no
 * Power BI token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { generateTileEmbedToken, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const dashboardId = (await ctx.params).id;
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '').trim();
  const tileId = String(body?.tileId || '').trim();
  if (!workspaceId || !tileId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and tileId are required' }, { status: 400 });
  }
  try {
    const tokenResp = await generateTileEmbedToken(workspaceId, dashboardId, tileId, 'View');
    return NextResponse.json({ ok: true, ...tokenResp });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
