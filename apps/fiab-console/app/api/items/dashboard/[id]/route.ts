/**
 * GET    /api/items/dashboard/[id]?workspaceId=...   → overlay + (optional) PBI tiles
 * PUT    /api/items/dashboard/[id]                    → upsert the Loom overlay (Cosmos)
 * DELETE /api/items/dashboard/[id]                    → drop the Loom overlay
 *
 * The Loom overlay (pinned-DAX tiles, Q&A tiles, streaming ADX tiles, grid
 * layout) is the Azure-native dashboard surface — it persists to Cosmos and
 * works with NO Power BI / Fabric workspace bound (no-fabric-dependency.md).
 * When a Power BI workspace IS supplied (`workspaceId`), the GET also merges
 * the read-only Power BI REST tile list so pinned PBI visuals embed alongside
 * the Loom-native tiles. Power BI is the opt-in path; ADX/AAS is the default.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDashboard, listDashboardTiles, PowerBiError } from '@/lib/azure/powerbi-client';
import { pbiDashboardOverlaysContainer } from '@/lib/azure/cosmos-client';
import { sanitizeOverlay, type DashboardOverlay } from '@/lib/azure/dashboard-overlay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readOverlay(id: string): Promise<DashboardOverlay | null> {
  const container = await pbiDashboardOverlaysContainer();
  try {
    const { resource } = await container.item(id, id).read<DashboardOverlay>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';

  // Loom overlay (always available — Azure-native, no PBI workspace required).
  let overlay: DashboardOverlay | null = null;
  try {
    overlay = await readOverlay(id);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Power BI REST merge — only when a PBI workspace is explicitly supplied AND
  // the dashboard id is a real PBI dashboard. Soft-fail so the overlay still
  // returns when there is no PBI dashboard (a pure Loom-native dashboard).
  let dashboard: unknown = null;
  let tiles: unknown[] = [];
  if (workspaceId) {
    try {
      [dashboard, tiles] = await Promise.all([
        getDashboard(workspaceId, id).catch(() => null),
        listDashboardTiles(workspaceId, id).catch(() => []),
      ]);
    } catch (e: any) {
      // Non-fatal: the Loom overlay is the source of truth.
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json(
        { ok: true, workspaceId, dashboard: null, tiles: [], overlay, pbiError: e?.message || String(e), pbiStatus: status },
      );
    }
  }

  return NextResponse.json({ ok: true, workspaceId, dashboard, tiles, overlay });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'body required' }, { status: 400 });
  }
  const doc = sanitizeOverlay(id, body, session.claims.upn || session.claims.oid);
  try {
    const container = await pbiDashboardOverlaysContainer();
    const { resource } = await container.items.upsert<DashboardOverlay>(doc);
    return NextResponse.json({ ok: true, overlay: resource ?? doc });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  try {
    const container = await pbiDashboardOverlaysContainer();
    await container.item(id, id).delete().catch((e: any) => { if (e?.code !== 404) throw e; });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
