/**
 * GET    /api/sqldb/indexes?workspaceId&id&objectId   — list a table's indexes (sys.indexes)
 * DELETE /api/sqldb/indexes?objectId=&indexId=         — DROP INDEX (catalog-verified)
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listIndexes, dropIndex } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  try {
    const indexes = await listIndexes(g.ctx.server, g.ctx.database, objectId);
    return NextResponse.json({ ok: true, objectId, indexes });
  } catch (e: any) { return sqlDbError(e); }
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  const indexId = Number(req.nextUrl.searchParams.get('indexId'));
  if (!Number.isInteger(objectId) || !Number.isInteger(indexId)) {
    return NextResponse.json({ ok: false, error: 'objectId and indexId are required' }, { status: 400 });
  }
  const r = await dropIndex(g.ctx.server, g.ctx.database, objectId, indexId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}
