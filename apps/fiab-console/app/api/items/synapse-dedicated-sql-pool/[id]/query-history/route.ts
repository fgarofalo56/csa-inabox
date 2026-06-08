/**
 * GET /api/items/synapse-dedicated-sql-pool/[id]/query-history
 *     ?pool=dedicated|serverless   (default: dedicated)
 *
 * Dedicated: queries sys.dm_pdw_exec_requests — the MPP-specific DMV that
 *   surfaces distributed query history (retains ~10,000 recent requests):
 *   status, command (SQL text), submit_time, total_elapsed_time (ms),
 *   resource_class, label.
 *   https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-pdw-exec-requests-transact-sql
 *
 * Serverless: queries sys.dm_exec_requests (active requests, with SQL text via
 *   sys.dm_exec_sql_text) and sys.dm_external_data_processed (bytes-cost
 *   telemetry). Standard SQL Server DMVs supported on the serverless endpoint.
 *   https://learn.microsoft.com/azure/synapse-analytics/sql/data-processed
 *
 * Returns: { ok, entries: [{ request_id, status, query_text, submit_time,
 *             start_time, end_time, total_elapsed_time_ms, resource_class,
 *             label }], dataProcessed? }
 *
 * Real TDS via the wired service identity (executeQuery / dedicatedTarget /
 * serverlessTarget) — no new auth primitives, no mocks. Azure-native; no
 * Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
} from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEDICATED_HISTORY_SQL = /* sql */ `
SELECT TOP 50
  request_id,
  status,
  command                   AS query_text,
  submit_time,
  start_time,
  end_time,
  total_elapsed_time        AS total_elapsed_time_ms,
  ISNULL(resource_class,'') AS resource_class,
  ISNULL([label],'')        AS [label]
FROM sys.dm_pdw_exec_requests
WHERE command IS NULL OR command NOT LIKE '%dm_pdw_exec_requests%'
ORDER BY submit_time DESC;
`;

const SERVERLESS_ACTIVE_SQL = /* sql */ `
SELECT TOP 50
  CAST(r.session_id AS varchar(20))      AS request_id,
  r.status,
  ISNULL(SUBSTRING(t.text, 1, 4000), '') AS query_text,
  r.start_time                           AS submit_time,
  r.start_time,
  CAST(NULL AS datetime2)                AS end_time,
  r.total_elapsed_time                   AS total_elapsed_time_ms,
  ''                                     AS resource_class,
  ''                                     AS [label]
FROM sys.dm_exec_requests r
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id <> @@SPID
ORDER BY r.start_time DESC;
`;

const SERVERLESS_BYTES_SQL = /* sql */ `
SELECT type, data_processed_mb
FROM sys.dm_external_data_processed;
`;

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const pool = req.nextUrl.searchParams.get('pool') || 'dedicated';

  try {
    if (pool === 'serverless') {
      const target = serverlessTarget('master');
      const [activeResult, bytesResult] = await Promise.allSettled([
        executeQuery(target, SERVERLESS_ACTIVE_SQL),
        executeQuery(target, SERVERLESS_BYTES_SQL),
      ]);
      if (activeResult.status === 'rejected' && bytesResult.status === 'rejected') {
        throw activeResult.reason;
      }
      const entries =
        activeResult.status === 'fulfilled'
          ? rowsToObjects(activeResult.value.columns, activeResult.value.rows)
          : [];
      const dataProcessed =
        bytesResult.status === 'fulfilled'
          ? rowsToObjects(bytesResult.value.columns, bytesResult.value.rows)
          : [];
      return NextResponse.json({ ok: true, entries, dataProcessed });
    }

    // Dedicated — DMV history requires the pool to be Online.
    const state = await getPoolState().catch(() => null);
    if (state && state.state !== 'Online') {
      return NextResponse.json(
        { ok: false, error: `Pool is ${state.state}. Resume it to read query history.`, state: state.state },
        { status: 409 },
      );
    }
    const result = await executeQuery(dedicatedTarget(), DEDICATED_HISTORY_SQL);
    const entries = rowsToObjects(result.columns, result.rows);
    return NextResponse.json({ ok: true, entries });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
