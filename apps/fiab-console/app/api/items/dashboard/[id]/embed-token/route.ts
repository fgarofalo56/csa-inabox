/**
 * POST /api/items/dashboard/[id]/embed-token
 *
 * Body: { workspaceId: string }
 * Returns: { ok, token, tokenId, expiration, embedUrl }
 *
 * Proxies POST /v1.0/myorg/groups/{ws}/dashboards/{id}/GenerateToken using
 * the Console UAMI.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler MINTED A POWER BI EMBED
 * TOKEN for a caller-named dashboard with no item-level check. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on the premise "no per-tenant
 * Cosmos ownership to scope", which its own sibling `dashboard/[id]` disproves by
 * authorizing the SAME `[id]` through the canonical ladder.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: on this family `[id]` is
 * legitimately a RAW Power BI dashboard GUID on the opt-in Power BI path (the
 * ids `GET /api/items/dashboard?workspaceId=` enumerates have no Loom item), and
 * `loadOwnedItem` renders "no item" as 404 — which would have broken that path
 * for every caller. An id naming a real `dashboard` item is still resolved
 * cross-partition and a non-owner is still refused. Same call `dashboard/[id]`
 * already made.
 *
 * The body `workspaceId` is a POWER BI group id, not a Loom Cosmos workspace, so
 * it is NOT used as the authorization scope — the workspace is resolved from the
 * item. `allowReadRoles` because a 'View' token is a read surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { generateDashboardEmbedToken, getDashboard, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const dashboardId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: dashboardId,
    itemType: 'dashboard',
    allowReadRoles: true,
    notFound: 'dashboard not found',
  });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [tokenResp, dashboard] = await Promise.all([
      generateDashboardEmbedToken(workspaceId, dashboardId, 'View'),
      getDashboard(workspaceId, dashboardId),
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
});
