/**
 * GET /api/admin/usage/embed — F21 "Open analytics" embedded usage report.
 *
 * LOOM_USAGE_REPORT_KIND drives the per-cloud backend (opt-in, env-gated — the
 * native Fluent charts on /admin/usage are always the default surface):
 *   - 'powerbi' (Commercial / GCC) → mint a Power BI Embedded report token via
 *     Power BI REST GenerateToken; returns { kind, embedUrl, accessToken,
 *     reportId, expiry }.
 *   - 'grafana' (GCC-High / IL5) → Azure Managed Grafana kiosk iframe URL over
 *     LOOM_GRAFANA_ENDPOINT + the usage dashboard UID. Gov admins get a real
 *     dashboard here — NEVER a promotional EmptyState.
 *   - unset → 503 `usage_report_not_configured` naming the exact env var.
 *
 * Admin-gated (F21). Real backend only — no fabricated embed payloads. Power BI
 * is Fabric-family and therefore strictly opt-in per
 * .claude/rules/no-fabric-dependency.md; the page works fully without it.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { getReport, generateReportEmbedToken, PowerBiError } from '@/lib/azure/powerbi-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 });
  }

  const kind = (process.env.LOOM_USAGE_REPORT_KIND || '').toLowerCase();

  if (kind === 'powerbi') {
    const workspaceId = process.env.LOOM_USAGE_PBI_WORKSPACE_ID;
    const reportId = process.env.LOOM_USAGE_PBI_REPORT_ID;
    if (!workspaceId || !reportId) {
      return NextResponse.json(
        {
          ok: false, code: 'powerbi_not_configured', error: 'Power BI Embedded usage report not configured',
          hint: {
            missingEnvVar: !workspaceId ? 'LOOM_USAGE_PBI_WORKSPACE_ID' : 'LOOM_USAGE_PBI_REPORT_ID',
            bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
            bicepStatus: 'Set pbiEmbeddedEnabled=true to deploy the Power BI Embedded (A1) capacity, then publish a usage report and set loomUsageReportKind=powerbi + LOOM_USAGE_PBI_WORKSPACE_ID + LOOM_USAGE_PBI_REPORT_ID.',
            rolesRequired: [{
              name: 'Power BI workspace Member',
              scope: 'The usage report workspace',
              reason: 'The Console UAMI must be a workspace member to mint an embed token.',
            }],
            followUp: 'Add the Console UAMI to the Power BI workspace, set LOOM_USAGE_PBI_WORKSPACE_ID + LOOM_USAGE_PBI_REPORT_ID, and ensure "Service principals can use Power BI APIs" is enabled.',
          },
        },
        { status: 503 },
      );
    }
    try {
      const [report, tok] = await Promise.all([
        getReport(workspaceId, reportId),
        generateReportEmbedToken(workspaceId, reportId, 'View'),
      ]);
      return NextResponse.json({
        ok: true,
        kind: 'powerbi',
        reportId,
        embedUrl: report.embedUrl || `https://app.powerbi.com/reportEmbed?reportId=${reportId}&groupId=${workspaceId}`,
        accessToken: tok.token,
        expiry: tok.expiration,
      });
    } catch (e) {
      if (e instanceof PowerBiError) {
        return NextResponse.json(
          { ok: false, code: 'powerbi_upstream', error: e.message, status: e.status, body: e.body },
          { status: e.status >= 400 && e.status < 500 ? e.status : 502 },
        );
      }
      return apiServerError(e, 'internal error', 'unexpected');
    }
  }

  if (kind === 'grafana') {
    const endpoint = process.env.LOOM_GRAFANA_ENDPOINT;
    // Usage-specific dashboard UID; fall back to the shared dashboard UID when a
    // dedicated usage dashboard hasn't been split out yet.
    const uid = process.env.LOOM_GRAFANA_USAGE_DASHBOARD_UID || process.env.LOOM_GRAFANA_DASHBOARD_UID;
    if (!endpoint || !uid) {
      return NextResponse.json(
        {
          ok: false, code: 'grafana_not_configured', error: 'Managed Grafana usage dashboard not configured',
          hint: {
            missingEnvVar: !endpoint ? 'LOOM_GRAFANA_ENDPOINT' : 'LOOM_GRAFANA_USAGE_DASHBOARD_UID',
            bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
            bicepStatus: 'Set managedGrafanaEnabled=true to deploy Azure Managed Grafana (the Gov-cloud usage analytics backend), then create a usage dashboard and set loomUsageReportKind=grafana + loomGrafanaUsageDashboardUid.',
            rolesRequired: [{
              name: 'Grafana Viewer',
              scope: 'The Managed Grafana instance',
              reason: 'The Console UAMI must be a Grafana Viewer to embed the dashboard.',
            }],
            followUp: 'Set LOOM_GRAFANA_ENDPOINT (https://<name>-<hash>.<region>.grafana.azure[.us]) + LOOM_GRAFANA_USAGE_DASHBOARD_UID.',
          },
        },
        { status: 503 },
      );
    }
    const base = endpoint.replace(/\/+$/, '');
    return NextResponse.json({
      ok: true,
      kind: 'grafana',
      iframeUrl: `${base}/d/${encodeURIComponent(uid)}?kiosk`,
    });
  }

  return NextResponse.json(
    {
      ok: false, code: 'usage_report_not_configured', error: 'No embedded usage report backend configured',
      hint: {
        missingEnvVar: 'LOOM_USAGE_REPORT_KIND',
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
        bicepStatus: 'Choose the embed backend per cloud: pbiEmbeddedEnabled=true (Commercial/GCC) or managedGrafanaEnabled=true (GCC-High/IL5).',
        followUp: 'Set loomUsageReportKind=powerbi (Commercial/GCC) or loomUsageReportKind=grafana (GCC-High/IL5), then set the matching report/dashboard env vars. The /admin/usage native charts work without this.',
      },
    },
    { status: 503 },
  );
}
