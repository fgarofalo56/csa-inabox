/**
 * GET    /api/sqldb/table-types?workspaceId&id — list user-defined table types
 *        (sys.table_types).
 * DELETE /api/sqldb/table-types?objectId=<id>  — DROP TYPE (catalog-verified).
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listTableTypes, dropObject } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  try {
    const tableTypes = await listTableTypes(g.ctx.server, g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, tableTypes });
  } catch (e: any) { return sqlDbError(e); }
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  const r = await dropObject(g.ctx.server, g.ctx.database, 'table-type', objectId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}
