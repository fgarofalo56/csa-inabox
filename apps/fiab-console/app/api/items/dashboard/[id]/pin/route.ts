/**
 * POST /api/items/dashboard/[id]/pin
 *
 * Pins (clones) an existing tile from a source Power BI dashboard onto this
 * dashboard via the Power BI REST Clone Tile API
 * (POST /groups/{ws}/dashboards/{src}/tiles/{tile}/Clone with targetDashboardId).
 *
 * Body: { workspaceId, sourceDashboardId, tileId, targetWorkspaceId?, targetReportId?, targetModelId? }
 *
 * This is the opt-in Fabric-family "pin a visual" path. Authoring a brand-new
 * pin from a report visual happens in Power BI Web (the REST API has no
 * "pin arbitrary visual" verb); the editor surfaces that honestly and offers
 * this Clone path to copy an already-pinned tile. The Azure-native default
 * dashboard surface (Loom-native ADX/AAS tiles) needs none of this.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cloneDashboardTile, PowerBiError, powerbiConfigGate } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const targetDashboardId = (await ctx.params).id;

  const gate = powerbiConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, code: 'pbi_gate', error: gate.detail, hint: `Set ${gate.missing}.` }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '').trim();
  const sourceDashboardId = String(body?.sourceDashboardId || '').trim();
  const tileId = String(body?.tileId || '').trim();
  if (!workspaceId || !sourceDashboardId || !tileId) {
    return NextResponse.json({ ok: false, error: 'workspaceId, sourceDashboardId and tileId are required' }, { status: 400 });
  }

  try {
    const result = await cloneDashboardTile(workspaceId, sourceDashboardId, tileId, {
      targetDashboardId,
      targetWorkspaceId: body?.targetWorkspaceId ? String(body.targetWorkspaceId) : undefined,
      targetReportId: body?.targetReportId ? String(body.targetReportId) : undefined,
      targetModelId: body?.targetModelId ? String(body.targetModelId) : undefined,
    });
    return NextResponse.json({ ok: true, tile: result });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
