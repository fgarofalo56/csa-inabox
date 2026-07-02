/**
 * GET /api/monitor/spark
 *   (default)        → recent Spark applications/runs + native-diag links + telemetry status
 *   ?appId=<id>      → per-app metric summary + tuning recommendations
 *   ?days=7  (1..30) ?limit=100 (1..500)
 *
 * Monitor → Spark: analytics + performance-tuning + troubleshooting for Spark
 * applications and runs, read live from Log Analytics (Synapse Spark → LA
 * SparkListenerEvent_CL / SparkMetrics_CL + Databricks DatabricksJobs, all
 * `union isfuzzy=true` so a missing table contributes 0 rows). No mock data.
 *
 * Honest gate: returns { ok:false, gate:{missing,message} } (HTTP 200) when
 * LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset, so the pane renders a MessageBar.
 * When configured-but-empty it returns ok:true with an empty list + the
 * telemetry-not-flowing hint (LOOM_SPARK_LA_* not wired) — the pane still shows
 * the native-diag links and the tuning-recommendation reference.
 *
 * Azure-native by default — no Fabric / Power BI dependency. Auth: cookie
 * session (getSession). The Console UAMI needs Log Analytics Reader on the LAW.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { MonitorError } from '@/lib/azure/monitor-client';
import {
  listSparkApplications, getSparkAppMetrics, recommendTuning,
  sparkNativeDiagLinks, sparkTelemetryConfigured, MonitorNotConfiguredError,
} from '@/lib/azure/spark-monitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GATE_MESSAGE =
  'Monitor → Spark reads Spark application telemetry from Log Analytics. '
  + 'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID on the Console container app, and enable Spark→LA '
  + 'diagnostics (LOOM_SPARK_LA_WORKSPACE_ID + LOOM_SPARK_LA_KEY or the Key-Vault refs) so every '
  + 'Loom Spark session emits SparkListenerEvent / SparkMetrics to that workspace. For '
  + 'GCC-High / IL5 / DoD also set LOOM_LOG_ANALYTICS_ENDPOINT to https://api.loganalytics.us.';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const days = Math.min(30, Math.max(1, Number(sp.get('days')) || 7));
  const limit = Math.min(500, Math.max(1, Number(sp.get('limit')) || 100));
  const appId = sp.get('appId')?.trim();

  try {
    if (appId) {
      const metrics = await getSparkAppMetrics(appId, days);
      return NextResponse.json({ ok: true, appId, metrics, recommendations: recommendTuning(metrics) });
    }
    const applications = await listSparkApplications({ days, limit });
    return NextResponse.json({
      ok: true,
      days,
      total: applications.length,
      applications,
      telemetryConfigured: sparkTelemetryConfigured(),
      nativeLinks: sparkNativeDiagLinks(),
    });
  } catch (e) {
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: GATE_MESSAGE } });
    }
    const st = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: st });
  }
}
