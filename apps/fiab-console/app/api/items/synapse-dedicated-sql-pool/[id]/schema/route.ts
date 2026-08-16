/**
 * GET /api/items/synapse-dedicated-sql-pool/[id]/schema
 * Returns the Dedicated pool's schema tree. If pool is Paused, returns
 * 409 — UI shows the "paused, click Resume" state.
 *
 * Query params:
 *   ?table=<schema.table>  → { ok, columns } from INFORMATION_SCHEMA.COLUMNS
 *                            (drives editor IntelliSense column completions)
 * Otherwise returns { schemas, databases } (databases = sys.databases for the
 * cross-database picker).
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. Sibling of `warehouse/[id]/schema` over the
 * SAME shared pool: `GET(req)` took no `ctx`, `getSession()` was the only check,
 * and the response enumerated the whole pool plus every database on the Synapse
 * SQL server. Layer 1 authorizes against the pool item (read-scoped); the
 * `databases` picker is narrowed to `workspaceSynapseScope` so it admits exactly
 * what `[id]/query` will accept. The in-database schema/table enumeration is NOT
 * narrowed — no item→schema ownership exists to narrow it with. See the ledger.
 *
 * The narrowing is LARGE, not marginal: for an item with no recorded second
 * database — which is every item the platform provisions today — the scope is a
 * single entry and this dropdown collapses to one option. It does not become an
 * error state (the list is never empty, so the editor's `disabled` never trips),
 * but that is read from `lib/editors/synapse-sql-editors.tsx` and NOT verified in
 * a browser. See the sibling `warehouse/[id]/schema` header and the PR ledger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { enumerateSqlObjects } from '@/lib/azure/sql-object-scripting';
import { escapeSqlLiteral } from '@/lib/sql/quoting';
import { guardSynapseItemRequest, workspaceSynapseScope } from '../../../_lib/synapse-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POOL_NOT_FOUND = 'dedicated SQL pool not found';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardSynapseItemRequest({
    itemId: id,
    itemType: 'synapse-dedicated-sql-pool',
    notFound: POOL_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  const state = await getPoolState().catch(() => null);
  if (!state || state.state !== 'Online') {
    return NextResponse.json(
      {
        ok: false,
        state: state?.state || 'Unknown',
        sku: state?.sku || 'unknown',
        pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
        message: 'Pool not Online — schema unavailable until resumed.',
      },
      { status: 409 },
    );
  }

  const tableParam = req.nextUrl.searchParams.get('table') || '';

  try {
    // Column-completion request: ?table=schema.table → INFORMATION_SCHEMA.COLUMNS.
    if (tableParam) {
      const [schemaName, tableName] = tableParam.includes('.')
        ? tableParam.split('.', 2)
        : ['dbo', tableParam];
      const cols = await executeQuery(
        dedicatedTarget(),
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${escapeSqlLiteral(schemaName)}'
           AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
         ORDER BY ORDINAL_POSITION`,
      );
      return NextResponse.json({ ok: true, state: 'Online', columns: cols.rows.map((r) => String(r[0])) });
    }

    const tablesP = executeQuery(
      dedicatedTarget(),
      `SELECT TOP 200 s.name + '.' + t.name AS qualified, t.name AS table_name, s.name AS schema_name,
              CAST(p.rows AS bigint) AS row_count
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
       ORDER BY s.name, t.name`,
    );
    // Views / stored procedures / functions enumerate in parallel with tables.
    const objectsP = enumerateSqlObjects(dedicatedTarget());
    const [tables, objects] = await Promise.all([tablesP, objectsP]);

    const schemas: Record<string, { table: string; rows: number }[]> = {};
    for (const row of tables.rows) {
      const [qualified, tableName, schemaName, rowCount] = row as [string, string, string, number];
      void qualified;
      (schemas[schemaName] ||= []).push({ table: tableName, rows: Number(rowCount || 0) });
    }

    // Database list for the cross-database picker (sys.databases, online only).
    let databases: string[] = [];
    try {
      const scope = await workspaceSynapseScope(item);
      const dbs = await executeQuery(dedicatedTarget(), `SELECT name FROM sys.databases WHERE state = 0 ORDER BY name`);
      // LAYER 2 — the picker offers exactly what `[id]/query` will admit.
      databases = dbs.rows.map((r) => String(r[0])).filter((n) => scope.has(n));
    } catch { databases = []; }

    return NextResponse.json({
      ok: true,
      state: 'Online',
      sku: state.sku,
      pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      schemas,
      databases,
      views: objects.views,
      procedures: objects.procedures,
      functions: objects.functions,
      ...(objects.warnings.length ? { warnings: objects.warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'Online', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
