/**
 * GET    /api/items/azure-sql-database/[id]/firewall?server=<name>
 *        — list firewall rules on the server scope.
 * POST   /api/items/azure-sql-database/[id]/firewall
 *        body: { server, name, startIpAddress, endIpAddress }
 *        — PUT (idempotent upsert) one firewall rule.
 * DELETE /api/items/azure-sql-database/[id]/firewall?server=<name>&rule=<name>
 *        — delete a rule by name.
 *
 * Firewall rules live at the SQL server scope (Microsoft.Sql/servers/firewallRules);
 * the [id] path segment is the originating database for UX continuity only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFirewallRules,
  upsertFirewallRule,
  deleteFirewallRule,
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
    const rules = await listFirewallRules(server);
    return NextResponse.json({ ok: true, rules });
  } catch (e: any) { return handleErr(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { server, name, startIpAddress, endIpAddress } = body || {};
  if (!server || !name || !startIpAddress || !endIpAddress) {
    return NextResponse.json({ ok: false, error: 'server, name, startIpAddress, endIpAddress required' }, { status: 400 });
  }
  try {
    const rule = await upsertFirewallRule(server, { name, startIpAddress, endIpAddress });
    return NextResponse.json({ ok: true, rule });
  } catch (e: any) { return handleErr(e); }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const server = req.nextUrl.searchParams.get('server');
  const rule = req.nextUrl.searchParams.get('rule');
  if (!server || !rule) return NextResponse.json({ ok: false, error: 'server and rule query params required' }, { status: 400 });
  try {
    await deleteFirewallRule(server, rule);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return handleErr(e); }
}
