/**
 * POST /api/items/azure-sql-database/[id]/performance
 *   body { server, database, action, ...opts }
 *
 *   Azure-native Query Performance Insight over the real Query Store
 *   (`sys.query_store_*`) — no Microsoft Fabric / Power BI dependency.
 *   The [id] path segment scopes the originating item for UX continuity;
 *   connection target comes from the body { server, database }.
 *
 *   Actions:
 *     'status'      — read sys.database_query_store_options
 *     'top-queries' — top-N queries by metric over a trailing window (hours)
 *     'time-series' — per-interval runtime stats for one query_id
 *     'query-plan'  — latest showplan XML for one query_id
 *     'enable'      — ALTER DATABASE CURRENT SET QUERY_STORE = ON
 *                     (requires confirm:true in the body — explicit consent)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  queryStoreStatus,
  enableQueryStore,
  topQueriesByMetric,
  queryTimeSeries,
  queryStorePlan,
  type PerfMetric,
} from '@/lib/azure/sql-objects-client';
import { AzureSqlError } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_METRICS = new Set<PerfMetric>(['cpu', 'duration', 'logical-reads', 'executions']);
const VALID_ACTIONS = new Set(['status', 'top-queries', 'time-series', 'query-plan', 'enable']);

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const action = String(body?.action || '').trim();

  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { ok: false, error: `action must be one of: ${[...VALID_ACTIONS].join(' | ')}` },
      { status: 400 },
    );
  }

  try {
    if (action === 'status') {
      const status = await queryStoreStatus(server, database);
      return NextResponse.json({ ok: true, status });
    }

    if (action === 'enable') {
      if (!body?.confirm) {
        return NextResponse.json(
          {
            ok: false,
            gate: true,
            message:
              'Query Store is not collecting on this database. To enable it, re-POST with confirm:true. ' +
              'This runs ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE). ' +
              'The console identity must hold ALTER on this database (db_owner or ALTER DATABASE).',
          },
          { status: 200 },
        );
      }
      const status = await enableQueryStore(server, database);
      return NextResponse.json({ ok: true, status });
    }

    // Shared validation for the metric/window-based actions.
    const metric: PerfMetric = VALID_METRICS.has(body?.metric) ? (body.metric as PerfMetric) : 'cpu';
    const windowHours = Math.min(720, Math.max(1, Math.trunc(Number(body?.windowHours) || 24)));
    const topN = Math.min(50, Math.max(1, Math.trunc(Number(body?.topN) || 10)));

    if (action === 'top-queries') {
      const rows = await topQueriesByMetric(server, database, metric, windowHours, topN);
      return NextResponse.json({ ok: true, rows, metric, windowHours, topN });
    }

    const queryId = Math.trunc(Number(body?.queryId) || 0);
    if (!queryId || queryId < 1) {
      return NextResponse.json(
        { ok: false, error: 'queryId (positive integer) required for time-series and query-plan' },
        { status: 400 },
      );
    }

    if (action === 'time-series') {
      const points = await queryTimeSeries(server, database, queryId, windowHours);
      return NextResponse.json({ ok: true, points, queryId, windowHours });
    }

    if (action === 'query-plan') {
      const plan = await queryStorePlan(server, database, queryId);
      return NextResponse.json({ ok: true, plan, queryId });
    }

    return NextResponse.json({ ok: false, error: 'unhandled action' }, { status: 400 });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }
}
