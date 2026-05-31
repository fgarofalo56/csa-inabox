/**
 * GET    /api/sqldb/views?workspaceId&id  — list views (sys.views)
 * DELETE /api/sqldb/views?objectId=<id>   — DROP VIEW (catalog-verified)
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listViews, dropObject } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  try {
    const views = await listViews(g.ctx.server, g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, views });
  } catch (e: any) { return sqlDbError(e); }
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  const r = await dropObject(g.ctx.server, g.ctx.database, 'view', objectId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}
