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
 *
 * AUTHORIZATION — `authorizeItemWorkspace('dashboard', … , allowReadRoles)`.
 *   This handler MINTED A POWER BI EMBED TOKEN with no item-level authorization
 *   at all: `workspaceId` came from the request BODY and the dashboard id from
 *   the URL, so any signed-in caller could name any workspace + dashboard the
 *   Console UAMI can reach and receive a live credential for it. It did not even
 *   require guessing a Loom item id.
 *
 *   It passed CI because it sat in check-route-guards' SHARED_BACKEND_ITEM_ROUTES
 *   under "specific-per-item-TYPE route over a SHARED Azure backend … no
 *   per-tenant Cosmos ownership to scope". Its own sibling `dashboard/[id]`
 *   (GET/PUT/DELETE) authorizes the same `[id]` through the canonical ladder, so
 *   the second half of that premise was provably false for this item type.
 *
 * WHY `authorizeItemWorkspace` AND NOT `withWorkspaceOwner` — deliberate.
 *   `loadOwnedItem` (and therefore `withWorkspaceOwner`) returns null when NO
 *   Cosmos item carries the id, which the wrapper renders as 404. On this family
 *   the `[id]` is legitimately a RAW POWER BI dashboard GUID for the opt-in
 *   Power BI path — the ids `GET /api/items/dashboard?workspaceId=` enumerates
 *   have no Loom item behind them — so wrapping would have 404'd every caller on
 *   that path. `dashboard/[id]` already made and documented exactly this call.
 *   An id naming a REAL `dashboard` item is still found (the resolver's lookup is
 *   cross-partition) and a non-owner is still refused.
 *
 * THE CALLER'S `workspaceId` IS NOT TRUSTED AS THE AUTHORIZATION SCOPE.
 *   It is a POWER BI group id, not a Loom Cosmos workspace id, so feeding it to
 *   the workspace ladder would authorize the wrong thing. The workspace is
 *   resolved FROM THE ITEM instead; the body value is still what the Power BI
 *   call uses, unchanged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { generateTileEmbedToken, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const dashboardId = params.id;
  // A 'View' tile token is a READ surface, so any workspace role admits the
  // caller — but only a caller with SOME role on the owning workspace.
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: dashboardId,
    itemType: 'dashboard',
    allowReadRoles: true,
    notFound: 'dashboard not found',
  });
  if (denied) return denied;
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
});
