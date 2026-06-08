/**
 * GET /api/items/databricks-sql-warehouse/[id]/query-profile?queryId=<statement_id>
 *
 * Fetches a single query's execution profile from Databricks via
 * GET /api/2.0/sql/history/queries/{statement_id}?include_metrics=true
 *
 * Returns:
 *   { ok, query_id, status, query_text, duration, user_name, warehouse_id,
 *     rows_produced, error_message, spark_ui_url, statement_type,
 *     photon_coverage_pct, metrics: { compilation_time_ms, execution_time_ms,
 *       photon_total_time_ms, total_time_ms, read_bytes, read_remote_bytes,
 *       write_remote_bytes, read_cache_bytes, rows_read_count,
 *       rows_produced_count, result_fetch_time_ms, ... },
 *     plans_state, plans }
 *
 * `metrics` are the real IO/Photon numbers the Databricks Query Profile UI
 * renders. `spark_ui_url` is the authoritative deep-link to the full physical
 * plan DAG; `plans`/`plans_state` carry the inline plan tree when the
 * workspace returns it.
 *
 * Auth: the BFF MI must own the query or hold CAN MONITOR on the warehouse.
 * No mock data — real Databricks REST. Azure-native (no Fabric dependency).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getQueryProfile, databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: `Databricks not configured: set ${gate.missing}. Deploy the Azure Databricks workspace (platform/fiab/bicep/modules/analytics/databricks.bicep) and wire LOOM_DATABRICKS_HOSTNAME.`,
      },
      { status: 503 },
    );
  }

  const queryId = req.nextUrl.searchParams.get('queryId');
  if (!queryId) {
    return NextResponse.json({ ok: false, error: 'queryId is required' }, { status: 400 });
  }

  try {
    const profile = await getQueryProfile(queryId);
    const metrics = profile.metrics || {};
    const photonPct =
      metrics.execution_time_ms && metrics.photon_total_time_ms != null
        ? Math.round((metrics.photon_total_time_ms / metrics.execution_time_ms) * 100)
        : null;
    return NextResponse.json({
      ok: true,
      query_id: profile.query_id,
      status: profile.status,
      query_text: profile.query_text,
      query_start_time_ms: profile.query_start_time_ms,
      query_end_time_ms: profile.query_end_time_ms,
      duration: profile.duration,
      user_name: profile.user_name,
      warehouse_id: profile.warehouse_id,
      rows_produced: profile.rows_produced,
      error_message: profile.error_message,
      spark_ui_url: profile.spark_ui_url,
      statement_type: profile.statement_type,
      metrics,
      photon_coverage_pct: photonPct,
      plans_state: profile.plans_state,
      plans: profile.plans,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
