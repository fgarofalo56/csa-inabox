/**
 * Ontology object-type DATASOURCE introspection — lists the real tables and
 * columns of a backing Lakehouse (ADLS Gen2 Delta via Synapse Serverless) or
 * Warehouse (Synapse Dedicated SQL pool), so the editor can map source columns
 * onto an object type's typed properties (column → property mapping + PK column).
 *
 * GET /api/items/ontology/[id]/datasource?sourceKind=warehouse|lakehouse[&table=dbo.Customer]
 *   - no `table` → { ok, tables: [{ qualified, schema, name }] }
 *   - with `table` → { ok, columns: [{ name, dataType }] }
 *
 * Real Synapse SQL (INFORMATION_SCHEMA / sys.tables) — no mock data. When the
 * Synapse backend isn't provisioned, returns an honest 503 naming the env var to
 * set (per .claude/rules/no-vaporware.md); the editor still lets the operator
 * type the table/column names manually and persists the binding to Cosmos. The
 * per-object-type datasource binding itself is persisted on the ontology item's
 * `state.objectTypes[].datasource` via the generic item PATCH route.
 *
 * Azure-native; never touches a Microsoft Fabric workspace.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { serverlessTarget, dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

function sanitize(e: unknown): string {
  return String((e as { message?: string })?.message || e).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');

  const sourceKind = req.nextUrl.searchParams.get('sourceKind') === 'warehouse' ? 'warehouse' : 'lakehouse';
  const table = (req.nextUrl.searchParams.get('table') || '').trim();

  // ── Warehouse (Synapse Dedicated SQL pool) ──
  if (sourceKind === 'warehouse') {
    if (!process.env.LOOM_SYNAPSE_DEDICATED_POOL || !process.env.LOOM_SYNAPSE_WORKSPACE) {
      return err(
        'Warehouse schema introspection requires a Synapse Dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE + ' +
        'LOOM_SYNAPSE_DEDICATED_POOL and grant the Console UAMI db_datareader. You can still type the table/' +
        'column names manually below — the binding persists to Cosmos.',
        503, 'warehouse_not_configured',
      );
    }
    try {
      const state = await getPoolState().catch(() => null);
      if (state && state.state !== 'Online') {
        return err(`Warehouse compute not Online (${state.state}). Resume the Dedicated SQL pool, then retry.`, 409, 'pool_paused');
      }
      if (table) {
        const [schemaName, tableName] = table.includes('.') ? table.split('.', 2) : ['dbo', table];
        const cols = await executeQuery(
          dedicatedTarget(),
          `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = '${escapeSqlLiteral(schemaName)}'
             AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
           ORDER BY ORDINAL_POSITION`,
        );
        return NextResponse.json({ ok: true, columns: cols.rows.map((r) => ({ name: String(r[0]), dataType: String(r[1] || '') })) });
      }
      const tables = await executeQuery(
        dedicatedTarget(),
        `SELECT TOP 500 s.name AS schema_name, t.name AS table_name
         FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
         ORDER BY s.name, t.name`,
      );
      return NextResponse.json({
        ok: true,
        tables: tables.rows.map((r) => ({ schema: String(r[0]), name: String(r[1]), qualified: `${r[0]}.${r[1]}` })),
      });
    } catch (e) {
      return err(`Warehouse introspection failed: ${sanitize(e)}`, 502, 'introspection_failed');
    }
  }

  // ── Lakehouse (ADLS Gen2 Delta via Synapse Serverless) ──
  if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
    return err(
      'Lakehouse schema introspection requires the Synapse Serverless SQL endpoint. Set LOOM_SYNAPSE_WORKSPACE ' +
      '(its -ondemand endpoint serves the Delta tables) and grant the Console UAMI Storage Blob Data Reader. ' +
      'You can still type the table/column names manually below — the binding persists to Cosmos.',
      503, 'serverless_not_configured',
    );
  }
  try {
    if (table) {
      const [schemaName, tableName] = table.includes('.') ? table.split('.', 2) : ['dbo', table];
      const cols = await executeQuery(
        serverlessTarget('master'),
        `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${escapeSqlLiteral(schemaName)}'
           AND TABLE_NAME = '${escapeSqlLiteral(tableName)}'
         ORDER BY ORDINAL_POSITION`,
      );
      return NextResponse.json({ ok: true, columns: cols.rows.map((r) => ({ name: String(r[0]), dataType: String(r[1] || '') })) });
    }
    const tables = await executeQuery(
      serverlessTarget('master'),
      `SELECT TOP 500 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME`,
    );
    return NextResponse.json({
      ok: true,
      tables: tables.rows.map((r) => ({ schema: String(r[0]), name: String(r[1]), qualified: `${r[0]}.${r[1]}` })),
      ...(tables.rows.length === 0
        ? { note: 'No registered Delta tables/views found on the serverless endpoint. Type the table name manually, or register the Delta table first.' }
        : {}),
    });
  } catch (e) {
    return err(`Lakehouse introspection failed: ${sanitize(e)}`, 502, 'introspection_failed');
  }
}
