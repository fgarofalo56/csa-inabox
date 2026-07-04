/**
 * GET /api/dab/sources/[kind]/columns?server=&database=&objectId=
 *   → list a table/view's columns (name, dataType, primary-key flag) to seed an
 *     entity's fields[] / key designation. Real sys.columns introspection.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { sqlConfigGate, listColumns } from '@/lib/azure/sql-objects-client';
import { isSqlLoginFailure, sqlLoginGateBody } from '@/lib/azure/sql-login-gate';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { kind } = await ctx.params;
  const server = req.nextUrl.searchParams.get('server') || '';
  const database = req.nextUrl.searchParams.get('database') || '';
  const objectId = Number(req.nextUrl.searchParams.get('objectId'));

  // mssql + dwsql (Synapse) share the sys.columns introspection path.
  if (kind !== 'mssql' && kind !== 'dwsql') {
    return NextResponse.json({ ok: false, gate: { missing: 'mssql-only' }, error: `Column introspection is only available for mssql / dwsql (Synapse) sources.` }, { status: 503 });
  }
  if (!server || !database || !Number.isInteger(objectId)) {
    return jerr('server, database, and a numeric objectId are required', 400);
  }
  const gate = sqlConfigGate(server);
  if (gate) {
    return NextResponse.json({ ok: false, gate, error: `SQL source not configured: set ${gate.missing}.` }, { status: 503 });
  }

  try {
    const cols = await listColumns(server, database, objectId);
    return NextResponse.json({
      ok: true,
      columns: cols.map((c) => ({
        name: c.name,
        dataType: c.dataType,
        isNullable: c.isNullable,
        isPrimaryKey: c.isPrimaryKey,
        isIdentity: c.isIdentity,
        isComputed: c.isComputed,
      })),
    });
  } catch (e: any) {
    // Honest SQL-login gate (audit B3).
    if (isSqlLoginFailure(e)) {
      return NextResponse.json(sqlLoginGateBody({ target: `${server} / ${database}`, detail: e?.message }), { status: 503 });
    }
    return apiServerError(e);
  }
}
