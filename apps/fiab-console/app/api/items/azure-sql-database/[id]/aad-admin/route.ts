/**
 * GET  /api/items/azure-sql-database/[id]/aad-admin?server=<name>
 *      — read the current AAD admin on the server scope.
 * PUT  /api/items/azure-sql-database/[id]/aad-admin
 *      body: { server, login, sid, tenantId? }
 *      — set the AAD admin via ARM Microsoft.Sql/servers/administrators.
 *
 * AAD admin is configured at the SQL server scope; the [id] path
 * segment is the originating database for UX continuity only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getAadAdmin,
  setAadAdmin,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: (e as any)?.body, status }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const server = req.nextUrl.searchParams.get('server');
  if (!server) return NextResponse.json({ ok: false, error: 'server query param required' }, { status: 400 });
  try {
    const admin = await getAadAdmin(server);
    return NextResponse.json({ ok: true, admin });
  } catch (e: any) { return handleErr(e); }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { server, login, sid, tenantId } = body || {};
  if (!server || !login || !sid) {
    return NextResponse.json({ ok: false, error: 'server, login (UPN/group), sid (object id) required' }, { status: 400 });
  }
  try {
    const admin = await setAadAdmin(server, { login, sid, tenantId });
    return NextResponse.json({ ok: true, admin });
  } catch (e: any) { return handleErr(e); }
}
