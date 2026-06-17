/**
 * GET /api/items/warehouse/[id]/schema
 *
 * Mirrors the Dedicated SQL pool schema endpoint — Warehouse is backed by
 * the same compute. Returns 409 with state info when Paused.
 *
 * ?table=<schema.table> → { ok, columns } (INFORMATION_SCHEMA.COLUMNS) for
 * editor IntelliSense. Otherwise returns { schemas, databases }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';
import { enumerateSqlObjects } from '@/lib/azure/sql-object-scripting';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Distinguish a genuine non-Online pool (Paused/Resuming → 409, honest gate)
  // from a probe failure (ARM unreachable / scope wrong → 502, surfaced as an
  // error, NOT a false "paused" banner that discourages running queries).
  let state: Awaited<ReturnType<typeof getPoolState>> | null = null;
  let probeError: string | null = null;
  try {
    state = await getPoolState();
  } catch (e: any) {
    probeError = e?.message || String(e);
  }

  if (probeError) {
    return NextResponse.json(
      {
        ok: false,
        state: 'Unknown',
        sku: 'unknown',
        warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
        error: `Could not read the Synapse Dedicated SQL pool state from ARM: ${probeError}`,
        message: 'Warehouse compute status is unavailable — the pool-state probe failed. Verify the Console identity has Reader on the Synapse workspace and that LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL are correct.',
      },
      { status: 502 },
    );
  }

  if (!state || state.state !== 'Online') {
    return NextResponse.json(
      {
        ok: false,
        state: state?.state || 'Unknown',
        sku: state?.sku || 'unknown',
        warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
        message: 'Warehouse compute not Online — resume on the Dedicated SQL pool editor.',
      },
      { status: 409 },
    );
  }

  const tableParam = req.nextUrl.searchParams.get('table') || '';

  try {
    if (tableParam) {
      const [schemaName, tableName] = tableParam.includes('.')
        ? tableParam.split('.', 2)
        : ['dbo', tableParam];
      const cols = await executeQuery(
        dedicatedTarget(),
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = '${schemaName.replace(/'/g, "''")}'
           AND TABLE_NAME = '${tableName.replace(/'/g, "''")}'
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
    const objectsP = enumerateSqlObjects(dedicatedTarget());
    const [tables, objects] = await Promise.all([tablesP, objectsP]);

    const schemas: Record<string, { table: string; rows: number }[]> = {};
    for (const row of tables.rows) {
      const [, tableName, schemaName, rowCount] = row as [string, string, string, number];
      (schemas[schemaName] ||= []).push({ table: tableName, rows: Number(rowCount || 0) });
    }

    let databases: string[] = [];
    try {
      const dbs = await executeQuery(dedicatedTarget(), `SELECT name FROM sys.databases WHERE state = 0 ORDER BY name`);
      databases = dbs.rows.map((r) => String(r[0]));
    } catch { databases = []; }

    return NextResponse.json({
      ok: true,
      state: 'Online',
      sku: state.sku,
      warehouse: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      schemas,
      databases,
      views: objects.views,
      procedures: objects.procedures,
      functions: objects.functions,
      ...(objects.warnings.length ? { warnings: objects.warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, state: 'Online', error: e?.message || String(e) }, { status: 502 });
  }
}
