/**
 * POST /api/items/[type]/[id]/visual-query
 *
 * Server-side compile + execute for the no-code Visual Query editor
 * (visual-query-canvas.tsx). `[type]` is the SQL engine the editor opened for:
 *
 *   warehouse                    → Synapse Dedicated SQL pool (T-SQL / TDS)
 *   synapse-dedicated-sql-pool   → Synapse Dedicated SQL pool (T-SQL / TDS)
 *   synapse-serverless-sql-pool  → Synapse Serverless SQL endpoint (T-SQL / TDS)
 *   databricks-sql-warehouse     → Databricks SQL Warehouse (Spark SQL / REST)
 *
 * Two request shapes:
 *
 *  1. Describe columns (canvas resolves a dropped table's columns for its
 *     Choose-columns / Group-by / Join pickers):
 *       { describe: { schema?, table }, dialect, database?, warehouseId?, catalog?, schema? }
 *     → { ok, columns }
 *
 *  2. Compile + execute the canvas graph:
 *       { graph: VqGraph, dialect, database?, warehouseId?, catalog?, schema? }
 *     The graph is compiled with the SAME pure compiler the canvas uses (so the
 *     UI's read-only SQL preview matches), then executed against the real Azure
 *     backend. The generated SQL is returned so the preview stays in sync.
 *     → { ok, generatedSql, columns, rows, rowCount, executionMs, truncated, engine, executedBy }
 *
 * No mocks, no placeholder rows (no-vaporware.md). Azure-native by default —
 * never touches Fabric/OneLake/Power BI hosts (no-fabric-dependency.md). The
 * Synapse path needs LOOM_SYNAPSE_WORKSPACE; if unset, the underlying client
 * throws a precise "Missing env var: LOOM_SYNAPSE_WORKSPACE" surfaced to the UI
 * MessageBar — never a "bind a Fabric workspace" gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
  executeQueryAsUser,
  type QueryResult,
} from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { resolveAccessMode } from '@/lib/azure/sql-access-mode';
import { getUserSqlToken } from '@/lib/azure/sql-user-token-store';
import { executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import { compileGraph, type VqGraph, type SqlDialect } from '@/lib/editors/visual-query-compiler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYNAPSE_TSQL_ENGINES = new Set([
  'warehouse',
  'synapse-dedicated-sql-pool',
  'synapse-serverless-sql-pool',
]);
const DEDICATED_ENGINES = new Set(['warehouse', 'synapse-dedicated-sql-pool']);

function quoteIdent(name: string, dialect: SqlDialect): string {
  const clean = (name || '').trim();
  if (dialect === 'tsql') return `[${clean.replace(/[[\]]/g, '')}]`;
  return `\`${clean.replace(/`/g, '')}\``;
}

/** Build a zero-row "describe" query so the canvas can enumerate a table's columns. */
function describeSql(schema: string | undefined, table: string, dialect: SqlDialect): string {
  const ref = schema && schema.trim()
    ? `${quoteIdent(schema, dialect)}.${quoteIdent(table, dialect)}`
    : quoteIdent(table, dialect);
  return dialect === 'tsql' ? `SELECT TOP 0 * FROM ${ref}` : `SELECT * FROM ${ref} LIMIT 0`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type, id } = await ctx.params;
  if (!SYNAPSE_TSQL_ENGINES.has(type) && type !== 'databricks-sql-warehouse') {
    return NextResponse.json(
      { ok: false, error: `Visual query is not supported for item type '${type}'.` },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({} as any));
  const dialect: SqlDialect = type === 'databricks-sql-warehouse' ? 'sparksql' : 'tsql';
  const database = (body?.database || 'master').toString();
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const catalog = body?.catalog ? String(body.catalog) : undefined;
  const ucSchema = body?.schema ? String(body.schema) : undefined;

  // Resolve the SQL to run: either a describe (column discovery) or the
  // compiled canvas graph.
  let sql: string;
  const isDescribe = body?.describe && typeof body.describe === 'object';
  if (isDescribe) {
    const tbl = (body.describe.table || '').toString().trim();
    if (!tbl) return NextResponse.json({ ok: false, error: 'describe.table is required' }, { status: 400 });
    sql = describeSql(body.describe.schema?.toString(), tbl, dialect);
  } else {
    const graph = body?.graph as VqGraph | undefined;
    if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      return NextResponse.json({ ok: false, error: 'graph with at least one node is required' }, { status: 400 });
    }
    sql = compileGraph(graph, dialect);
  }

  if (sql.length > 65_536) {
    return NextResponse.json({ ok: false, error: 'generated SQL too large (>64KB)' }, { status: 413 });
  }

  const generatedSql = sql;

  try {
    let result: QueryResult;

    if (type === 'databricks-sql-warehouse') {
      if (!warehouseId) {
        return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
      }
      const w = await getWarehouse(warehouseId).catch(() => null);
      if (w && w.state !== 'RUNNING') {
        return NextResponse.json(
          { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
          { status: 409 },
        );
      }
      const dbx = await executeStatement(warehouseId, sql, catalog, ucSchema);
      // Databricks QueryResult has no messages/recordsAffected — normalize.
      result = { ...dbx, messages: [], recordsAffected: 0 } as QueryResult;
    } else if (DEDICATED_ENGINES.has(type)) {
      const state = await getPoolState().catch(() => null);
      if (state && state.state !== 'Online') {
        return NextResponse.json(
          { ok: false, error: `Warehouse compute is ${state.state}. Resume the Dedicated SQL pool.`, state: state.state },
          { status: 409 },
        );
      }
      result = await executeQuery(dedicatedTarget(), sql);
    } else {
      // synapse-serverless-sql-pool — honor the F10 data-access mode.
      const accessMode = await resolveAccessMode(id, type);
      if (accessMode === 'user') {
        const userToken = await getUserSqlToken(session.claims.oid);
        if (!userToken) {
          return NextResponse.json(
            {
              ok: false,
              error:
                "User's identity mode is on, but no valid SQL token is cached. Sign out and back in, then retry.",
              code: 'NO_USER_SQL_TOKEN',
            },
            { status: 403 },
          );
        }
        result = await executeQueryAsUser(serverlessTarget(database), sql, userToken, session.claims.oid);
      } else {
        result = await executeQuery(serverlessTarget(database), sql);
      }
    }

    return NextResponse.json({
      ok: true,
      generatedSql,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
      engine: type,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code, generatedSql },
      { status: 502 },
    );
  }
}
