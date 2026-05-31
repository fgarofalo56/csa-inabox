/**
 * GET    /api/sqldb/functions?workspaceId&id  — list functions
 *        (sys.objects type IN FN/IF/TF/FS/FT/AF)
 * DELETE /api/sqldb/functions?objectId=<id>   — DROP FUNCTION (catalog-verified)
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listFunctions, dropObject } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  try {
    const functions = await listFunctions(g.ctx.server, g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, functions });
  } catch (e: any) { return sqlDbError(e); }
}

export async function DELETE(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  const r = await dropObject(g.ctx.server, g.ctx.database, 'function', objectId);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, dropped: r.dropped });
}
