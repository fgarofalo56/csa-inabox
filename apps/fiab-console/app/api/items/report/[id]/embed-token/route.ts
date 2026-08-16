/**
 * POST /api/items/report/[id]/embed-token
 *
 * Body: { workspaceId: string, accessLevel?: 'View' | 'Edit' }
 * Returns: { ok, token, tokenId, expiration, embedUrl }
 *
 * Proxies the Power BI REST GenerateToken call using the Console UAMI.
 * The 401/403 from Power BI surfaces verbatim — no fake token, no mock.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler MINTED A POWER BI EMBED
 * TOKEN, up to and including an **Edit**-scope one, for a caller-named report
 * with no item-level check. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope";
 * nineteen sibling routes under `report/[id]/**` resolve the SAME `[id]` as an
 * owned Loom item, so that premise was provably false for this item type.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: on this family `[id]` is
 * legitimately a RAW Power BI report GUID on the opt-in Power BI path, and
 * `loadOwnedItem` renders "no item" as 404 — which would have broken embedding
 * for every caller on that path. An id naming a real `report` item is still
 * resolved cross-partition and a non-owner is still refused.
 *
 * READ ROLES TRACK THE TOKEN'S SCOPE. A 'View' token is a read surface, so any
 * workspace role admits the caller; an 'Edit' token confers write on the report
 * and is therefore write-scoped (Owner/Admin/Member only). Granting read roles
 * unconditionally would have handed a Viewer an editing credential.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { generateReportEmbedToken, getReport, PowerBiError } from '@/lib/azure/powerbi-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const reportId = params.id;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const accessLevel = body?.accessLevel === 'Edit' ? 'Edit' : 'View';
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: reportId,
    itemType: 'report',
    ...(accessLevel === 'Edit' ? {} : { allowReadRoles: true }),
    notFound: 'report not found',
  });
  if (denied) return denied;
  try {
    const [tokenResp, report] = await Promise.all([
      generateReportEmbedToken(workspaceId, reportId, accessLevel),
      getReport(workspaceId, reportId),
    ]);
    return NextResponse.json({
      ok: true,
      ...tokenResp,
      embedUrl: report.embedUrl,
      reportId: report.id,
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
