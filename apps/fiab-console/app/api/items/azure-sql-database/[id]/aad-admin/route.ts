/**
 * GET  /api/items/azure-sql-database/[id]/aad-admin
 *      — read the current Entra (AAD) admin on THIS item's bound server.
 * PUT  /api/items/azure-sql-database/[id]/aad-admin
 *      body: { login, sid, tenantId? }
 *      — set the Entra admin via ARM Microsoft.Sql/servers/administrators.
 *
 * The Entra admin is configured at the SQL SERVER scope; the `[id]` item is the
 * originating database, and its bound connection is what names the server.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2): both handlers USED TO be session-only with
 * `server` taken from the query string / body and `[id]` never read. PUT is a
 * PRIVILEGE GRANT — the Entra admin of a logical server is a sysadmin-equivalent
 * principal on every database on it — so the pre-fix shape let any signed-in
 * caller make themselves administrator of any SQL server the Console UAMI could
 * reach, in any subscription. That ranks it with `share` rather than with the
 * availability/cost routes.
 *
 * NOW: the caller must own the `[id]` item, and the server is resolved from that
 * item's bound connection and admitted against the governed subscription scope.
 * A body/query `server` that names a different server is refused.
 */

import { NextResponse } from 'next/server';
import {
  getAadAdmin,
  setAadAdmin,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: (e as any)?.body, status }, { status });
}

export const GET = withBoundSqlServer(
  { provider: 'sql', allowReadRoles: true },
  async (_req, { server }) => {
    try {
      const admin = await getAadAdmin(server);
      return NextResponse.json({ ok: true, admin });
    } catch (e: any) { return handleErr(e); }
  },
);

export const PUT = withBoundSqlServer(
  { provider: 'sql' },
  async (_req, { server, body }) => {
    const { login, sid, tenantId } = body || {};
    if (!login || !sid) {
      return NextResponse.json({ ok: false, error: 'login (UPN/group), sid (object id) required' }, { status: 400 });
    }
    try {
      const admin = await setAadAdmin(server, {
        login: String(login),
        sid: String(sid),
        tenantId: tenantId ? String(tenantId) : undefined,
      });
      return NextResponse.json({ ok: true, admin });
    } catch (e: any) { return handleErr(e); }
  },
);
