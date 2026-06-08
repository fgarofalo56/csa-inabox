/**
 * POST /api/items/databricks-sql-warehouse/[id]/clone
 * body { warehouseId, source, target, cloneType: 'SHALLOW'|'DEEP', replace?: boolean }
 *
 * Delta CLONE on the Databricks SQL Warehouse path:
 *
 *   CREATE [OR REPLACE] TABLE <target> [SHALLOW|DEEP] CLONE <source>
 *
 * SHALLOW: zero-copy — clones metadata only; the clone references the source's
 *   existing Delta data files (NO data files duplicated). Requires Databricks
 *   Runtime 13.3 LTS+ for Unity Catalog managed tables. Running VACUUM on the
 *   source can orphan a shallow clone if it removes files the clone references.
 * DEEP: full copy — data files are duplicated; the clone is independent of the
 *   source and survives source VACUUM.
 *
 * CLONE returns a single metrics row (source_table_size, source_num_of_files,
 * num_copied_files, …). We surface numCopiedFiles + sourceSizeBytes so the UI
 * can prove SHALLOW is zero-copy (num_copied_files == 0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured: ${gate.missing}`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const source = (body?.source || '').toString().trim();
  const target = (body?.target || '').toString().trim();
  const cloneType = body?.cloneType === 'DEEP' ? 'DEEP' : 'SHALLOW';
  const replace = !!body?.replace;

  if (!warehouseId) return NextResponse.json({ error: 'warehouseId is required' }, { status: 400 });
  if (!source) return NextResponse.json({ error: 'source is required' }, { status: 400 });
  if (!target) return NextResponse.json({ error: 'target is required' }, { status: 400 });

  // Bail fast with 409 if the warehouse isn't RUNNING so the UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
      { status: 409 },
    );
  }

  const createClause = replace ? 'CREATE OR REPLACE TABLE' : 'CREATE TABLE IF NOT EXISTS';
  const cloneSql = `${createClause} ${target} ${cloneType} CLONE ${source}`;

  try {
    const result = await executeStatement(warehouseId, cloneSql);
    // CLONE returns a single metrics row keyed by column name.
    const idx = (name: string) => result.columns.findIndex((c) => c === name);
    const row = result.rows?.[0] ?? [];
    const num = (name: string) => {
      const i = idx(name);
      return i >= 0 ? Number(row[i] ?? 0) : 0;
    };
    return NextResponse.json({
      ok: true,
      source,
      target,
      cloneType,
      numCopiedFiles: num('num_copied_files'),
      sourceNumFiles: num('source_num_of_files'),
      sourceSizeBytes: num('source_table_size'),
      executionMs: result.executionMs,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
}
