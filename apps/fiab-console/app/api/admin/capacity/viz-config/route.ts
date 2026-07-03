/**
 * GET /api/admin/capacity/viz-config
 *
 * Read-only config for the /admin/capacity detail pane's rich-visualization
 * deep-links. Returns whichever embedded-report backend the deployment wired:
 *   - Azure Managed Grafana (the Gov-cloud primary — Power BI Embedded is not
 *     available in Azure Government), via LOOM_GRAFANA_ENDPOINT (+ dashboard UID)
 *   - Power BI (Commercial optional) via LOOM_GOVERN_PBI_WORKSPACE_ID/REPORT_ID
 *
 * Both are OPTIONAL. The detail pane ALWAYS renders inline Azure Monitor charts
 * (which work in every cloud) — these links are additive "open in <tool>"
 * affordances. When neither is configured the pane is still never blank.
 *
 * Server-only env (no secrets) surfaced to the client so it can build the link
 * without a NEXT_PUBLIC duplicate; these vars are already wired by Bicep
 * (admin-plane/main.bicep). Shape: { ok:true, grafana?, powerbi?, isGov }.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isGovCloud, getPbiGovHost } from '@/lib/azure/cloud-endpoints';
import { canAccessDlzPanes, TENANT_ADMIN_TIER_REMEDIATION, TENANT_ADMIN_BOOTSTRAP_ENV } from '@/lib/auth/domain-role';
import { loadTenantDomains } from '@/lib/auth/load-domains';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // D2: DLZ visualization config is tenant-admin or domain-admin only.
  const domains = await loadTenantDomains(s.claims.oid);
  if (!(await canAccessDlzPanes(s, domains))) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason: 'The Data Landing Zone panes are available to tenant admins and domain admins only.',
        remediation: TENANT_ADMIN_TIER_REMEDIATION,
        bootstrapEnv: TENANT_ADMIN_BOOTSTRAP_ENV,
      },
      { status: 403 },
    );
  }

  const grafanaEndpoint = (process.env.LOOM_GRAFANA_ENDPOINT || '').trim();
  const grafanaUid = (process.env.LOOM_GRAFANA_DASHBOARD_UID || '').trim();
  const pbiWorkspaceId = (process.env.LOOM_GOVERN_PBI_WORKSPACE_ID || '').trim();
  const pbiReportId = (process.env.LOOM_GOVERN_PBI_REPORT_ID || '').trim();

  return NextResponse.json({
    ok: true,
    isGov: isGovCloud(),
    grafana: grafanaEndpoint ? { endpoint: grafanaEndpoint.replace(/\/+$/, ''), dashboardUid: grafanaUid || null } : null,
    powerbi: pbiWorkspaceId && pbiReportId ? { host: getPbiGovHost(), workspaceId: pbiWorkspaceId, reportId: pbiReportId } : null,
  });
}
