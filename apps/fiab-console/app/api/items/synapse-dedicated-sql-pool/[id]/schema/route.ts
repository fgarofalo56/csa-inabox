/**
 * GET /api/items/synapse-dedicated-sql-pool/[id]/schema
 * Returns the Dedicated pool's schema tree. If pool is Paused, returns
 * 409 — UI shows the "paused, click Resume" state.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { dedicatedTarget, executeQuery } from '@/lib/azure/synapse-sql-client';
import { getPoolState } from '@/lib/azure/synapse-pool-arm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

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

  try {
    const tables = await executeQuery(
      dedicatedTarget(),
      `SELECT TOP 200 s.name + '.' + t.name AS qualified, t.name AS table_name, s.name AS schema_name,
              CAST(p.rows AS bigint) AS row_count
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
       ORDER BY s.name, t.name`,
    );
    const schemas: Record<string, { table: string; rows: number }[]> = {};
    for (const row of tables.rows) {
      const [qualified, tableName, schemaName, rowCount] = row as [string, string, string, number];
      void qualified;
      (schemas[schemaName] ||= []).push({ table: tableName, rows: Number(rowCount || 0) });
    }
    return NextResponse.json({
      ok: true,
      state: 'Online',
      sku: state.sku,
      pool: process.env.LOOM_SYNAPSE_DEDICATED_POOL,
      schemas,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, state: 'Online', error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
