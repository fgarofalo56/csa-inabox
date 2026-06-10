/**
 * GET /api/monitor/activities
 *   ?days=30    (1..90, default 30)
 *   ?limit=200  (1..500, default 200)
 *   ?status=Succeeded|Failed|InProgress|Cancelled   (exact, case-insensitive)
 *   ?name=substring                                  (case-insensitive contains)
 *   ?synapse=0  (opt out of the SynapseIntegrationPipelineRuns union)
 *   ?arm=1      (also fold in ARM control-plane Activity Log events)
 *
 * Activity feed for the Monitor hub: pipeline / job run history read live from
 * Log Analytics (ADFPipelineRun + optionally SynapseIntegrationPipelineRuns,
 * with `union isfuzzy=true` so a missing table contributes 0 rows). No mock
 * data — real KQL against the configured workspace.
 *
 * Honest gate: returns { ok:false, gate:{missing,message} } (HTTP 200, no error
 * status) when LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset, so the pane renders a
 * Fluent MessageBar instead of crashing.
 *
 * Azure-native by default: works with LOOM_DEFAULT_FABRIC_WORKSPACE unset and
 * with no Synapse deployment (isfuzzy). No Fabric / Power BI dependency.
 *
 * Auth: cookie session (getSession). The Console UAMI needs Log Analytics
 * Reader on the LAW (granted by monitoring.bicep) — no new RBAC, no new env var.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  queryActivityFeed, MonitorNotConfiguredError, MonitorError,
} from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const days = Math.min(90, Math.max(1, Number(sp.get('days')) || 30));
  const limit = Math.min(500, Math.max(1, Number(sp.get('limit')) || 200));
  const status = sp.get('status')?.trim() || undefined;
  const name = sp.get('name')?.trim() || undefined;
  const includeSynapse = sp.get('synapse') !== '0';
  const includeArmLog = sp.get('arm') === '1';

  try {
    let rows = await queryActivityFeed({ days, limit, includeSynapse, includeArmLog });
    if (status) {
      const want = status.toLowerCase();
      rows = rows.filter((r) => (r.status || '').toLowerCase() === want);
    }
    if (name) {
      const want = name.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(want));
    }
    return NextResponse.json({
      ok: true,
      days,
      synapseIncluded: includeSynapse,
      armIncluded: includeArmLog,
      total: rows.length,
      rows,
    });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: e.missing,
          message:
            'The Monitor hub activity feed reads pipeline run history from Log Analytics. '
            + 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID on the Console container app and ensure ADF '
            + 'diagnostic settings route PipelineRuns to that workspace (already wired in '
            + 'landing-zone/adf.bicep with logAnalyticsDestinationType: Dedicated). For '
            + 'GCC-High / IL5 / DoD also set LOOM_LOG_ANALYTICS_ENDPOINT to https://api.loganalytics.us.',
        },
      });
    }
    const st = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: st });
  }
}
