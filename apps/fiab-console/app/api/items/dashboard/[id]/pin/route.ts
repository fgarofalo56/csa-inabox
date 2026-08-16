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
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler CLONED A TILE ONTO the
 * `[id]` dashboard with no item-level check, so any signed-in caller could write
 * a tile onto a dashboard they do not own. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on the premise "no per-tenant Cosmos ownership to
 * scope", which its own sibling `dashboard/[id]` disproves by authorizing the
 * SAME `[id]` through the canonical ladder.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI dashboard GUID on the opt-in path (no Loom item behind it), and
 * `loadOwnedItem` renders "no item" as 404 — which would have broken that path.
 * The body `workspaceId` is a Power BI group id, not a Loom Cosmos workspace, so
 * the scope is resolved from the item instead.
 *
 * NO `allowReadRoles`: this MUTATES the target dashboard, so a read-only Viewer
 * must not pass (item-crud.ts:289 — the resolver is write-scoped by default and
 * read roles are an explicit opt-in reserved for read-only surfaces).
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { cloneDashboardTile, PowerBiError, powerbiConfigGate } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const targetDashboardId = params.id;

  // Authorization runs BEFORE the honest config gate so an unreachable id gets
  // 404 rather than learning which env var this deployment is missing.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: targetDashboardId,
    itemType: 'dashboard',
    notFound: 'dashboard not found',
  });
  if (denied) return denied;

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
});
