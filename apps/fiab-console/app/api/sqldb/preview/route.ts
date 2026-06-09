/**
 * GET /api/sqldb/preview?workspaceId&id&objectId[&top]
 *   — top-N rows of a table/view (real `SELECT TOP <n> *`, catalog-resolved
 *     name; no string injection). Returns the QueryResult columns/rows so the
 *     navigator can render a Data Preview grid.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { previewObject } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  const topRaw = Number(req.nextUrl.searchParams.get('top'));
  const top = Number.isFinite(topRaw) && topRaw > 0 ? topRaw : 1000;
  try {
    const r = await previewObject(g.ctx.server, g.ctx.database, objectId, top);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
    return NextResponse.json({
      ok: true,
      objectId,
      objectName: r.objectName,
      columns: r.result.columns,
      rows: r.result.rows,
      rowCount: r.result.rowCount,
      executionMs: r.result.executionMs,
      truncated: r.result.truncated,
    });
  } catch (e: any) { return sqlDbError(e); }
}
