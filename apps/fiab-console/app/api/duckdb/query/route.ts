/**
 * POST /api/duckdb/query — the SQL Lab execution edge (N2b).
 *
 * Runs a READ-ONLY statement on the loom-duckdb serving tier (embedded DuckDB
 * reading Delta / Iceberg / Parquet in place on the deployment's own ADLS Gen2
 * through a managed identity), and falls back to **Synapse Serverless** with the
 * SAME statement when `LOOM_DUCKDB_URL` is unset — so the surface is never
 * blocked, only faster once the tier is deployed. The response always names the
 * engine that actually answered.
 *
 * `?format=arrow` returns the RAW Arrow IPC stream from the serving tier (the
 * body is a pure Arrow stream any reader consumes unmodified, stats in
 * `x-loom-*` headers). That is the transport Loom's own grids take past the
 * Arrow threshold (lib/arrow/transport-policy.ts) and the identical batches an
 * ADBC/Flight client receives.
 *
 * AUDIT (round-3 extension): every execution — success or failure — writes an
 * `_auditLog` data-access row (principal, statement scope, engine, rows,
 * outcome, ts) and fans out through the audit stream BEFORE the response is
 * sent. There is no unaudited path to the serving tier.
 *
 * 200 → { ok:true, engine, columns, rows, rowCount, elapsedMs, totalMs, … }
 * 200 → Arrow IPC stream (with ?format=arrow)
 * 400 → bad request / statement refused by the read-only guard
 * 401 → unauthenticated
 * 502 → serving tier unreachable / engine error
 */
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import {
  ARROW_STREAM_MIME,
  DuckDbError,
  buildLakeScanSql,
  duckdbQueryArrow,
  isDuckDbConfigured,
  logDuckDbAccess,
  runSqlLabQuery,
  type LakeSourceFormat,
} from '@/lib/azure/duckdb-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  sql?: unknown;
  /** Loom-coordinate lake object; the BFF resolves the account and builds the SQL. */
  source?: { container?: unknown; path?: unknown; format?: unknown; limit?: unknown };
  maxRows?: unknown;
  itemId?: unknown;
  workspaceId?: unknown;
}

export const POST = withSession(async (req, { session }) => {
  const body = (await req.json().catch(() => ({}))) as Body;
  let sql = typeof body.sql === 'string' ? body.sql.trim() : '';

  // A caller may hand Loom-coordinate lake COORDINATES instead of SQL; the
  // storage account is resolved server-side so a browser never invents a URL.
  if (!sql && body.source && typeof body.source === 'object') {
    try {
      const { getAccountName } = await import('@/lib/azure/adls-client');
      sql = buildLakeScanSql(getAccountName(), {
        container: String(body.source.container ?? ''),
        path: String(body.source.path ?? ''),
        format: body.source.format as LakeSourceFormat | undefined,
        limit: typeof body.source.limit === 'number' ? body.source.limit : undefined,
      });
    } catch (e) {
      if (e instanceof DuckDbError) return apiError(e.message, e.status, { code: e.code });
      return apiError('That lake source could not be resolved.', 400, { code: 'invalid_source' });
    }
  }

  if (!sql) {
    return apiError(
      'A SQL statement is required. SQL Lab runs read-only queries — try '
      + "SELECT * FROM delta_scan('abfss://gold@<account>.dfs.core.windows.net/<table>') LIMIT 100.",
      400,
    );
  }
  const maxRows = typeof body.maxRows === 'number' && Number.isFinite(body.maxRows)
    ? Math.floor(body.maxRows)
    : undefined;
  const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined;

  const tenantId = session.claims.tid || session.claims.oid;
  const audit = {
    actorOid: session.claims.oid,
    actorUpn: session.claims.upn,
    tenantId,
    sql,
    itemId,
    workspaceId,
  };

  const wantsArrow = (req.nextUrl.searchParams.get('format') || '').toLowerCase() === 'arrow';

  // ── Arrow transport: only the DuckDB tier emits Arrow IPC. Without it the
  //    caller gets an honest 400 telling it to use the JSON path (which still
  //    works on Synapse Serverless) rather than a fabricated empty stream.
  if (wantsArrow) {
    if (!isDuckDbConfigured()) {
      return apiError(
        'Arrow transport needs the loom-duckdb serving tier (LOOM_DUCKDB_URL). Re-run without '
        + '?format=arrow — the same statement executes on Synapse Serverless and returns JSON.',
        400,
        { code: 'arrow_unavailable' },
      );
    }
    const started = Date.now();
    try {
      const res = await duckdbQueryArrow(sql, maxRows);
      await logDuckDbAccess({
        ...audit,
        operation: 'sql.query',
        engine: 'duckdb',
        outcome: 'success',
        rowCount: res.rowCount,
        elapsedMs: res.elapsedMs,
      });
      return new Response(res.arrow, {
        status: 200,
        headers: {
          'content-type': ARROW_STREAM_MIME,
          'cache-control': 'no-store',
          'x-loom-row-count': String(res.rowCount),
          'x-loom-elapsed-ms': String(res.elapsedMs),
          'x-loom-total-ms': String(Date.now() - started),
          'x-loom-truncated': res.truncated ? 'true' : 'false',
          'x-loom-bytes': String(res.bytes),
          'x-loom-engine': 'duckdb',
        },
      });
    } catch (e) {
      await logDuckDbAccess({
        ...audit,
        operation: 'sql.query',
        engine: 'duckdb',
        outcome: 'failure',
        detail: e instanceof Error ? e.message : String(e),
      });
      if (e instanceof DuckDbError) return apiError(e.message, e.status, { code: e.code });
      return apiServerError(e, 'The Arrow query could not be completed.', 'arrow_query_failed');
    }
  }

  // ── JSON transport (DuckDB when wired, Synapse Serverless otherwise) ────
  try {
    const result = await runSqlLabQuery(sql, { maxRows, tenantId });
    await logDuckDbAccess({
      ...audit,
      operation: 'sql.query',
      engine: result.engine,
      outcome: 'success',
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
    });
    return apiOk({
      engine: result.engine,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      elapsedMs: result.elapsedMs,
      totalMs: result.totalMs,
      truncated: result.truncated,
      maxRows: result.maxRows,
      extensions: result.extensions,
      note: result.note,
    });
  } catch (e) {
    await logDuckDbAccess({
      ...audit,
      operation: 'sql.query',
      engine: isDuckDbConfigured() ? 'duckdb' : 'synapse-serverless',
      outcome: 'failure',
      detail: e instanceof Error ? e.message : String(e),
    });
    if (e instanceof DuckDbError) return apiError(e.message, e.status, { code: e.code });
    // A refused statement / SQL error from either engine is user-actionable and
    // must be surfaced verbatim — it is the query the user typed, not internals.
    const message = e instanceof Error ? e.message : String(e);
    return apiError(message.slice(0, 600), 400, { code: 'query_failed' });
  }
});
