/**
 * GET /api/sqldb/schemas?workspaceId&id — list user schemas (sys.schemas).
 * Read-only: schema authoring (CREATE/DROP SCHEMA) runs from the SQL query tab.
 */
import { NextRequest, NextResponse } from 'next/server';
import { guardSqlDbRequest, sqlDbError } from '../_shared';
import { listSchemas } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardSqlDbRequest(req);
  if (g.res) return g.res;
  try {
    const schemas = await listSchemas(g.ctx.server, g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, schemas });
  } catch (e: any) { return sqlDbError(e); }
}
