/**
 * POST /api/items/report/[id]/paginated-embed-token
 *
 * Body: { workspaceId: string, datasetIds?: string[] }
 * Returns: { ok, token, tokenId, expiration, embedUrl, reportId, hostname }
 *
 * Mints a short-lived embed token for a Power BI **paginated report** (RDL)
 * using the MULTI-RESOURCE GenerateToken (POST /v1.0/myorg/GenerateToken) with
 * `reports[{ id, allowEdit:false }]` + any referenced semantic models under
 * `datasets[{ id, xmlaPermissions:'ReadOnly' }]`. This is required because a
 * paginated report can bind to one or more Power BI semantic models — the
 * per-report GenerateToken cannot grant the dataset scope the SDK needs.
 *
 * Sovereign-cloud aware: `assertFabricFamilyAvailable('powerbi')` throws an
 * honest remediation in GCC-High / DoD unless `LOOM_POWERBI_BASE` is wired to
 * the Government Power BI host. The 401/403 from Power BI (UAMI not a workspace
 * Member, tenant "Service principals can use Fabric APIs" disabled) surfaces
 * verbatim — no fake token, no mock.
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler MINTED A POWER BI EMBED
 * TOKEN for a caller-named report, and additionally granted `xmlaPermissions:
 * 'ReadOnly'` over every semantic model the caller listed in `datasetIds`, with
 * no item-level check. It was excused by check-route-guards'
 * SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos ownership to scope";
 * nineteen sibling routes under `report/[id]/**` resolve the SAME `[id]` as an
 * owned Loom item, so that premise was provably false for this item type.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: `[id]` is legitimately a
 * RAW Power BI report GUID on the opt-in path and `loadOwnedItem` renders "no
 * item" as 404, which would have broken embedding for every caller there.
 * `allowReadRoles` because the token is minted with `allowEdit:false`.
 *
 * SCOPE NOTE, stated rather than implied: this closes the REPORT boundary. The
 * `datasetIds` the caller supplies are still passed through unscoped, so a
 * caller authorized on the report can still name a semantic model they do not
 * own. Scoping that list is a second boundary with its own behaviour question
 * (a paginated report may legitimately bind models across workspaces) and is
 * reported, not folded in here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import {
  generatePaginatedReportEmbedToken,
  getReport,
  getPbiEmbedHostname,
  PowerBiError,
} from '@/lib/azure/powerbi-client';
import { assertFabricFamilyAvailable } from '@/lib/azure/cloud-endpoints';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {

  const { id: reportId } = params;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: reportId,
    itemType: 'report',
    allowReadRoles: true,
    notFound: 'report not found',
  });
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const datasetIds: string[] = Array.isArray(body?.datasetIds)
    ? body.datasetIds.map((d: unknown) => String(d)).filter(Boolean)
    : [];

  try {
    // Honest sovereign gate: throws a precise remediation in GCC-High / DoD
    // unless the operator has wired LOOM_POWERBI_BASE to the Gov Power BI host.
    assertFabricFamilyAvailable('powerbi');

    const [tokenResp, report] = await Promise.all([
      generatePaginatedReportEmbedToken(reportId, datasetIds),
      getReport(workspaceId, reportId),
    ]);

    if (!report.embedUrl) {
      return NextResponse.json(
        { ok: false, error: 'Power BI returned no embedUrl for this paginated report.' },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      ...tokenResp,
      embedUrl: report.embedUrl,
      reportId: report.id,
      hostname: getPbiEmbedHostname(),
    });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
