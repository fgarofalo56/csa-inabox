/**
 * GET    /api/items/azure-sql-database/[id]/firewall — list firewall rules.
 * POST   /api/items/azure-sql-database/[id]/firewall
 *        body: { name, startIpAddress, endIpAddress } — idempotent PUT of a rule.
 * DELETE /api/items/azure-sql-database/[id]/firewall?rule=<name>
 *
 * Firewall rules live at the SQL SERVER scope
 * (`Microsoft.Sql/servers/firewallRules`), which is why `requireDatabase` is
 * false: an `azure-sql-server` item binds a server and no database at all.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). All three verbs took `server` from the
 * request under a bare `getSession()` and handed it to `azure-sql-client`
 * verbatim; that client branches `serverName.startsWith('/') ? serverName :
 * defaultServerScope(serverName)`, so a full ARM id skipped the subscription pin
 * entirely and reached any SQL server the Console UAMI held a role on, in any
 * subscription — including a brownfield-adopted customer server
 * (`deploy-integrity.md` R5).
 *
 * A firewall route is a NETWORK EXPOSURE primitive: POST is an idempotent PUT,
 * so `{ name:'x', startIpAddress:'0.0.0.0', endIpAddress:'255.255.255.255' }`
 * opened such a server to the entire internet, and DELETE removed the rules an
 * operator relies on. Its PostgreSQL twin was closed in #3623; this is the same
 * fix on the Azure SQL half.
 *
 * WHY IT WAS TABLED THEN AND IS NOT NOW. #3638 left this route allowlisted with
 * a stated reason: `AzureSqlServerEditor` drives it with an `azure-sql-server`
 * item id, and that editor picked its server from live ARM discovery and
 * persisted NOTHING — so Layer 2 would have resolved no binding and 409'd every
 * legitimate click, pointing at a Connect tab that editor does not have. That
 * reason is now VOID: #3639 gave the editor `useSqlItemBinding`, so the pick IS
 * the binding (`auto-bind-by-default.md` §1/§4) and it awaits `ensureBound()`
 * before each of the three calls below. `unified-sql-database-editor` already
 * bound on selection. The tabling was a real blocker, and it was removed by
 * fixing the editor rather than by weakening the route.
 *
 * The rule NAME and IP range stay caller-chosen — which rule on YOUR server is
 * the feature; whose server is not.
 */

import { NextResponse } from 'next/server';
import {
  listFirewallRules,
  upsertFirewallRule,
  deleteFirewallRule,
  AzureSqlError,
} from '@/lib/azure/azure-sql-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof AzureSqlError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: (e as any)?.body, status }, { status });
}

// Reading your own server's network posture is a read — a workspace reader may
// see it without being able to change it.
export const GET = withBoundSqlServer(
  { provider: 'sql', allowReadRoles: true },
  async (_req, { server }) => {
    try {
      const rules = await listFirewallRules(server);
      return NextResponse.json({ ok: true, rules });
    } catch (e: any) { return handleErr(e); }
  },
);

export const POST = withBoundSqlServer(
  { provider: 'sql' },
  async (_req, { server, body }) => {
    const { name, startIpAddress, endIpAddress } = (body || {}) as Record<string, string>;
    if (!name || !startIpAddress || !endIpAddress) {
      return NextResponse.json({ ok: false, error: 'name, startIpAddress, endIpAddress required' }, { status: 400 });
    }
    try {
      const rule = await upsertFirewallRule(server, { name, startIpAddress, endIpAddress });
      return NextResponse.json({ ok: true, rule });
    } catch (e: any) { return handleErr(e); }
  },
);

export const DELETE = withBoundSqlServer(
  { provider: 'sql' },
  async (req, { server }) => {
    const rule = new URL(req.url).searchParams.get('rule');
    if (!rule) return NextResponse.json({ ok: false, error: 'rule query param required' }, { status: 400 });
    try {
      await deleteFirewallRule(server, rule);
      return NextResponse.json({ ok: true });
    } catch (e: any) { return handleErr(e); }
  },
);
