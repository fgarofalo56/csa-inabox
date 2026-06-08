/**
 * GET /api/items/[type]/[id]/monitoring?warehouseId=<id>&window=<seconds>
 *
 * Powers the warehouse Monitoring tab — a running-clusters / query-load line
 * chart plus a recent-query table — with REAL backend data:
 *
 *   - databricks-sql-warehouse → GET /api/2.0/sql/warehouses/{warehouseId}/events
 *     (running clusters over time) + /api/2.0/sql/history/queries (recent
 *     statements). Azure Databricks REST, AAD token, no Fabric.
 *   - synapse-dedicated-sql-pool / warehouse (Fabric "Warehouse" Azure-native
 *     default) → sys.dm_pdw_exec_requests via TDS — bucketed query load + the
 *     most recent requests. No Fabric, no Power BI.
 *
 * Honest gates: a missing LOOM_DATABRICKS_HOSTNAME / LOOM_SYNAPSE_WORKSPACE
 * returns 503 { code: 'not_configured', missing } so the UI shows a precise
 * MessageBar; a Paused Synapse pool returns 409 { code: 'pool_paused' }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listWarehouseEvents,
  listQueryHistory,
} from '@/lib/azure/databricks-client';
import { synapseConfigGate } from '@/lib/azure/synapse-artifacts-client';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import {
  DEFAULT_WINDOW_SECS,
  buildClusterTimeline,
  mapDbxQueries,
  buildSynapseTimeline,
  mapSynapseQueries,
  synapseTimelineSql,
  synapseRecentRequestsSql,
  type MonitoringPayload,
} from '@/lib/azure/warehouse-monitoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DBX_TYPE = 'databricks-sql-warehouse';
const SYNAPSE_TYPES = new Set(['synapse-dedicated-sql-pool', 'warehouse']);

/** Turn an executeQuery() column/row-array result into keyed records. */
function toRecords(result: { columns: string[]; rows: unknown[][] }): Array<Record<string, unknown>> {
  return result.rows.map((row) => {
    const rec: Record<string, unknown> = {};
    result.columns.forEach((c, i) => { rec[c] = row[i]; });
    return rec;
  });
}

export async function GET(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const { type } = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const windowSecs = (() => {
    const n = Number(req.nextUrl.searchParams.get('window'));
    return Number.isFinite(n) && n > 0 ? Math.min(86_400, Math.floor(n)) : DEFAULT_WINDOW_SECS;
  })();

  // ── Databricks SQL Warehouse ──────────────────────────────────────────────
  if (type === DBX_TYPE) {
    const gate = databricksConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', missing: gate.missing, error: `Databricks is not configured — set ${gate.missing}.` },
        { status: 503 },
      );
    }
    const warehouseId = req.nextUrl.searchParams.get('warehouseId') || undefined;
    if (!warehouseId) {
      return NextResponse.json({ ok: false, code: 'missing_warehouse', error: 'warehouseId query param is required.' }, { status: 400 });
    }
    try {
      const [events, history] = await Promise.all([
        listWarehouseEvents(warehouseId, 200),
        listQueryHistory({ warehouseId, maxResults: 50 }),
      ]);
      const payload: MonitoringPayload = {
        ok: true,
        engine: type,
        seriesLabel: 'Running clusters',
        windowSecs,
        clusterTimeline: buildClusterTimeline(events, windowSecs),
        queries: mapDbxQueries(history.entries),
        rawEvents: events.slice(0, 5),
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
  }

  // ── Synapse Dedicated SQL pool (Fabric "Warehouse" Azure-native default) ────
  if (SYNAPSE_TYPES.has(type)) {
    const gate = synapseConfigGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', missing: gate.missing, error: `Synapse is not configured — set ${gate.missing}.` },
        { status: 503 },
      );
    }
    // A paused pool cannot serve DMV queries — surface the precise resume gate.
    const state = await getPoolState().catch(() => null);
    if (state && state.state !== 'Online') {
      return NextResponse.json(
        { ok: false, code: 'pool_paused', state: state.state, sku: state.sku, error: `Dedicated SQL pool is ${state.state}. Resume it to view live monitoring.` },
        { status: 409 },
      );
    }
    try {
      const target = dedicatedTarget();
      const [timelineRes, recentRes] = await Promise.all([
        executeQuery(target, synapseTimelineSql(windowSecs)),
        executeQuery(target, synapseRecentRequestsSql(windowSecs)),
      ]);
      const timelineRecords = toRecords(timelineRes) as Array<{ bucket: unknown; query_count: unknown }>;
      const recentRecords = toRecords(recentRes);
      const payload: MonitoringPayload = {
        ok: true,
        engine: type,
        seriesLabel: 'Queries started (5-min buckets)',
        windowSecs,
        clusterTimeline: buildSynapseTimeline(timelineRecords),
        queries: mapSynapseQueries(recentRecords),
        rawEvents: recentRecords.slice(0, 5),
      };
      return NextResponse.json(payload);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  return NextResponse.json(
    { ok: false, code: 'unsupported_item_type', error: `Monitoring is available for SQL warehouses and dedicated pools, not '${type}'.` },
    { status: 400 },
  );
}
