/**
 * GET /api/governance/govern/embed — "View more" embedded report.
 *
 * LOOM_REPORT_KIND drives the per-cloud backend:
 *   - 'powerbi' (Commercial / GCC) → mint a Power BI Embedded report token via
 *     the Power BI REST GenerateToken, returns { kind, embedUrl, accessToken,
 *     reportId, expiry }. This is an OPT-IN, env-gated alternative (per
 *     .claude/rules/no-fabric-dependency.md) — never on the default path.
 *   - 'grafana' (GCC-High / IL5) → Azure Managed Grafana kiosk iframe URL.
 *   - unset → 503 `report_not_configured` with the exact env var to set.
 *
 * Admin-gated (F2). Real backend only — no fabricated embed payloads.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { getReport, generateReportEmbedToken, PowerBiError } from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 });
  }

  const kind = (process.env.LOOM_REPORT_KIND || '').toLowerCase();

  if (kind === 'powerbi') {
    const workspaceId = process.env.LOOM_GOVERN_PBI_WORKSPACE_ID;
    const reportId = process.env.LOOM_GOVERN_PBI_REPORT_ID;
    if (!workspaceId || !reportId) {
      return NextResponse.json(
        {
          ok: false, code: 'powerbi_not_configured', error: 'Power BI Embedded report not configured',
          hint: {
            missingEnvVar: !workspaceId ? 'LOOM_GOVERN_PBI_WORKSPACE_ID' : 'LOOM_GOVERN_PBI_REPORT_ID',
            bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
            bicepStatus: 'Set pbiEmbeddedEnabled=true to deploy the Power BI Embedded (A1) capacity, then publish a governance report and set LOOM_GOVERN_PBI_WORKSPACE_ID + LOOM_GOVERN_PBI_REPORT_ID.',
            rolesRequired: [{
              name: 'Power BI workspace Member',
              scope: 'The governance report workspace',
              reason: 'The Console UAMI must be a workspace member to mint an embed token.',
            }],
            followUp: 'Add the Console UAMI to the Power BI workspace, set LOOM_GOVERN_PBI_WORKSPACE_ID + LOOM_GOVERN_PBI_REPORT_ID, and ensure "Service principals can use Power BI APIs" is enabled.',
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
      return NextResponse.json({ ok: false, code: 'unexpected', error: (e as any)?.message || String(e) }, { status: 500 });
    }
  }

  if (kind === 'grafana') {
    const endpoint = process.env.LOOM_GRAFANA_ENDPOINT;
    const uid = process.env.LOOM_GRAFANA_DASHBOARD_UID;
    if (!endpoint || !uid) {
      return NextResponse.json(
        {
          ok: false, code: 'grafana_not_configured', error: 'Managed Grafana dashboard not configured',
          hint: {
            missingEnvVar: !endpoint ? 'LOOM_GRAFANA_ENDPOINT' : 'LOOM_GRAFANA_DASHBOARD_UID',
            bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
            bicepStatus: 'Set managedGrafanaEnabled=true to deploy Azure Managed Grafana (the Gov-cloud "View more" backend), then create a governance dashboard and set LOOM_GRAFANA_ENDPOINT + LOOM_GRAFANA_DASHBOARD_UID.',
            rolesRequired: [{
              name: 'Grafana Viewer',
              scope: 'The Managed Grafana instance',
              reason: 'The Console UAMI must be a Grafana Viewer to embed the dashboard.',
            }],
            followUp: 'Set LOOM_GRAFANA_ENDPOINT (https://<name>-<hash>.<region>.grafana.azure[.us]) + LOOM_GRAFANA_DASHBOARD_UID.',
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
      ok: false, code: 'report_not_configured', error: 'No embedded report backend configured',
      hint: {
        missingEnvVar: 'LOOM_REPORT_KIND',
        bicepModule: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
        bicepStatus: 'Choose the embed backend per cloud: pbiEmbeddedEnabled=true (Commercial/GCC) or managedGrafanaEnabled=true (GCC-High/IL5).',
        followUp: 'Set LOOM_REPORT_KIND=powerbi (Commercial/GCC) or LOOM_REPORT_KIND=grafana (GCC-High/IL5), then set the matching report/dashboard env vars.',
      },
    },
    { status: 503 },
  );
}
