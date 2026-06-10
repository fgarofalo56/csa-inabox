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
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  generatePaginatedReportEmbedToken,
  getReport,
  getPbiEmbedHostname,
  PowerBiError,
} from '@/lib/azure/powerbi-client';
import { assertFabricFamilyAvailable } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id: reportId } = await ctx.params;
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
}
