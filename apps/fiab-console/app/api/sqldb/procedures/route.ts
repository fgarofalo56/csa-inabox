/**
 * GET    /api/sqldb/procedures?workspaceId&id  — list procs (sys.procedures)
 * DELETE /api/sqldb/procedures?objectId=<id>   — DROP PROCEDURE (catalog-verified)
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listProcedures, dropObject } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  try {
    const procedures = await listProcedures(g.ctx.server, g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, procedures });
  } catch (e: any) { return sqlDbError(e); }
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  const r = await dropObject(g.ctx.server, g.ctx.database, 'procedure', objectId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}
