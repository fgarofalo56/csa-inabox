/**
 * GET /api/items/paginated-report/[id]?workspaceId=...
 * Returns paginated report metadata.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler returned a caller-named
 * paginated report's metadata with no item-level check. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope", which its own sibling `paginated-report/[id]/rdl`
 * disproves: that route resolves the SAME `[id]` through `loadOwnedItem` /
 * `updateOwnedItem`.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI report GUID on the opt-in Power BI path (the ids
 * `GET /api/items/paginated-report?workspaceId=` enumerates have no Loom item),
 * and `loadOwnedItem` renders "no item" as 404 — which would have broken that
 * path for every caller. An id naming a real item is still resolved
 * cross-partition and a non-owner is still refused.
 *
 * The `?workspaceId=` here is a POWER BI group id, not a Loom Cosmos workspace,
 * so it is NOT the authorization scope — that is resolved from the item. This is
 * a read, so `allowReadRoles`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { getReport, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const reportId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: reportId,
    itemType: 'paginated-report',
    allowReadRoles: true,
    notFound: 'paginated report not found',
  });
  if (denied) return denied;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const report = await getReport(workspaceId, reportId);
    return NextResponse.json({ ok: true, workspaceId, report });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
