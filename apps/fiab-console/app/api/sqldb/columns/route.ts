/**
 * GET /api/sqldb/columns?workspaceId&id&objectId — read-only column detail
 * for a table/view (sys.columns + sys.types), resolved by object_id.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listColumns } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));
  if (!Number.isInteger(objectId)) return NextResponse.json({ ok: false, error: 'objectId is required' }, { status: 400 });
  try {
    const columns = await listColumns(g.ctx.server, g.ctx.database, objectId);
    return NextResponse.json({ ok: true, objectId, columns });
  } catch (e: any) { return sqlDbError(e); }
}
