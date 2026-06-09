/**
 * Statistics manager — BFF route. Azure-native, NO Microsoft Fabric.
 *
 *   GET  /api/items/[type]/[id]/statistics?schema=dbo&table=Orders
 *        → Synapse Dedicated: live list of user-created statistics (sys.stats)
 *          plus the table's columns (for the create picker).
 *        → Databricks: the columns + an honest note (Databricks column stats are
 *          query-optimizer-managed; refresh them with the ANALYZE action).
 *
 *   POST /api/items/[type]/[id]/statistics
 *        body { action:'create'|'update'|'drop'|'analyze', schema, table,
 *               statsName?, columns?, mode?, catalog?, warehouseId? }
 *        → create / update / drop STATISTICS (Synapse Dedicated, T-SQL)
 *        → analyze (Databricks ANALYZE TABLE … COMPUTE STATISTICS)
 *
 * Engine dispatch by [type] (Azure-native default — never gated on Fabric):
 *   - synapse-dedicated-sql-pool / warehouse → Synapse Dedicated SQL pool (TDS)
 *   - databricks-sql-warehouse               → Databricks SQL Warehouse (Statement API)
 *
 * The client NEVER sends raw SQL — it sends a structured action + identifiers,
 * and the SQL is built server-side by lib/azure/statistics-client.ts
 * (IDENT_RE-validated + bracket/backtick-quoted), so there is no injection path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery as synapseExecute } from '@/lib/azure/synapse-sql-client';
import { databricksConfigGate, executeStatement, getWarehouse } from '@/lib/azure/databricks-client';
import {
  buildSynapseListStatisticsSQL,
  buildSynapseListColumnsSQL,
  buildSynapseCreateStatisticsSQL,
  buildSynapseUpdateStatisticsSQL,
  buildSynapseDropStatisticsSQL,
  buildDatabricksAnalyzeSQL,
  type ScanMode,
  type Built,
} from '@/lib/azure/statistics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYNAPSE_TYPES = new Set(['synapse-dedicated-sql-pool', 'warehouse']);
const DATABRICKS_TYPES = new Set(['databricks-sql-warehouse']);

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

function synapseGate(): { error: string } | null {
  if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
    return {
      error:
        'Synapse Dedicated SQL pool is not configured. Set LOOM_SYNAPSE_WORKSPACE and ' +
        'LOOM_SYNAPSE_DEDICATED_POOL (admin-plane bicep deploys the Synapse workspace + pool).',
    };
  }
  return null;
}

/** Unwrap a builder result or throw a 400-carrying error. */
function unwrap(b: Built): string {
  if (!b.ok) {
    const e = new Error(b.error) as Error & { httpStatus?: number };
    e.httpStatus = 400;
    throw e;
  }
  return b.sql;
}

// ============================================================
// GET — list statistics (+ columns) for one table
// ============================================================

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctx.params;
  const schema = (req.nextUrl.searchParams.get('schema') || 'dbo').trim();
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  if (!table) return NextResponse.json({ ok: false, error: 'table query parameter is required' }, { status: 400 });

  if (SYNAPSE_TYPES.has(type)) {
    const gate = synapseGate();
    if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

    let listSql: string;
    let colsSql: string;
    try {
      listSql = unwrap(buildSynapseListStatisticsSQL(schema, table));
      colsSql = unwrap(buildSynapseListColumnsSQL(schema, table));
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.httpStatus || 400 });
    }
    try {
      const target = dedicatedTarget();
      const [statsRes, colsRes] = await Promise.all([
        synapseExecute(target, listSql),
        synapseExecute(target, colsSql),
      ]);
      return NextResponse.json({
        ok: true,
        engine: 'synapse-dedicated',
        statistics: rowsToObjects(statsRes.columns, statsRes.rows),
        columns: rowsToObjects(colsRes.columns, colsRes.rows),
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  if (DATABRICKS_TYPES.has(type)) {
    const gate = databricksConfigGate();
    if (gate) {
      return NextResponse.json({
        ok: false,
        gated: true,
        error: `Databricks SQL Warehouse is not configured. Set ${gate.missing} on the Console Container App (admin-plane bicep apps[].env).`,
      }, { status: 200 });
    }
    // Databricks column statistics are managed by the query optimizer and are
    // not exposed as a stand-alone catalog list the way Synapse sys.stats is.
    // The column list still comes from real metadata (the editor passes it from
    // DESCRIBE). The primary action is ANALYZE (POST). This note is honest, not
    // fabricated data.
    return NextResponse.json({
      ok: true,
      engine: 'databricks',
      statistics: [],
      note: 'Databricks column statistics are managed automatically by the cost-based optimizer. Use the Analyze action (ANALYZE TABLE … COMPUTE STATISTICS) to refresh them.',
    });
  }

  return NextResponse.json(
    { ok: false, error: `Statistics management is not available for item type "${type}".` },
    { status: 404 },
  );
}

// ============================================================
// POST — create / update / drop (Synapse) or analyze (Databricks)
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '').trim();
  const schema = String(body?.schema || 'dbo').trim();
  const table = String(body?.table || '').trim();

  if (SYNAPSE_TYPES.has(type)) {
    const gate = synapseGate();
    if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

    let sql: string;
    try {
      if (action === 'create') {
        sql = unwrap(buildSynapseCreateStatisticsSQL(
          schema, table, body?.statsName,
          Array.isArray(body?.columns) ? body.columns : [],
          (body?.mode as ScanMode) || 'default',
        ));
      } else if (action === 'update') {
        sql = unwrap(buildSynapseUpdateStatisticsSQL(schema, table, body?.statsName));
      } else if (action === 'drop') {
        sql = unwrap(buildSynapseDropStatisticsSQL(schema, table, body?.statsName));
      } else {
        return NextResponse.json(
          { ok: false, error: `action "${action}" is not valid for a Synapse Dedicated SQL pool (use create | update | drop)` },
          { status: 400 },
        );
      }
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.httpStatus || 400 });
    }

    try {
      const res = await synapseExecute(dedicatedTarget(), sql);
      return NextResponse.json({
        ok: true,
        engine: 'synapse-dedicated',
        action,
        sql,
        recordsAffected: res.recordsAffected,
        executionMs: res.executionMs,
        messages: res.messages,
        executedBy: session.claims.upn,
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  if (DATABRICKS_TYPES.has(type)) {
    const gate = databricksConfigGate();
    if (gate) {
      return NextResponse.json({
        ok: false,
        gated: true,
        error: `Databricks SQL Warehouse is not configured. Set ${gate.missing} on the Console Container App.`,
      }, { status: 200 });
    }
    if (action !== 'analyze') {
      return NextResponse.json(
        { ok: false, error: `action "${action}" is not valid for a Databricks SQL Warehouse (use analyze)` },
        { status: 400 },
      );
    }
    const warehouseId = String(body?.warehouseId || '').trim();
    const catalog = String(body?.catalog || '').trim();
    if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });

    let sql: string;
    try {
      sql = unwrap(buildDatabricksAnalyzeSQL(
        catalog, schema, table,
        Array.isArray(body?.columns) ? body.columns : [],
      ));
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.httpStatus || 400 });
    }

    // State pre-check — bail fast with 409 so the UI can prompt Start.
    const w = await getWarehouse(warehouseId).catch(() => null);
    if (w && w.state !== 'RUNNING') {
      return NextResponse.json(
        { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
        { status: 409 },
      );
    }

    try {
      const res = await executeStatement(warehouseId, sql, catalog || undefined, schema);
      return NextResponse.json({
        ok: true,
        engine: 'databricks',
        action: 'analyze',
        sql,
        executionMs: res.executionMs,
        warehouseId,
        executedBy: session.claims.upn,
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e), code: e?.code }, { status: 502 });
    }
  }

  return NextResponse.json(
    { ok: false, error: `Statistics management is not available for item type "${type}".` },
    { status: 404 },
  );
}
