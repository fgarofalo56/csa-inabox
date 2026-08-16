/**
 * GET    /api/items/postgres-flexible-server/[id]/firewall
 * POST   /api/items/postgres-flexible-server/[id]/firewall   body { name, startIpAddress, endIpAddress }
 * DELETE /api/items/postgres-flexible-server/[id]/firewall?rule=<name>
 *
 * Manages Microsoft.DBforPostgreSQL/flexibleServers/firewallRules via ARM REST
 * on THIS item's bound server.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). All three verbs took `server` from the
 * request under a bare `getSession()` and passed it to the ARM client verbatim
 * (`postgres-flex-client` branches `startsWith('/')`, so a full resource id
 * skipped the subscription pin entirely).
 *
 * A firewall route is a NETWORK EXPOSURE primitive, which is why it outranks the
 * read-only members of this family: POST is an idempotent PUT, so
 * `{ name:'x', startIpAddress:'0.0.0.0', endIpAddress:'255.255.255.255' }`
 * opened a PostgreSQL flexible server to the entire internet, and DELETE removed
 * the rules an operator relies on — both on ANY server the Console UAMI held a
 * role on, in ANY subscription, including a brownfield-adopted customer server
 * (`deploy-integrity.md` R5).
 *
 * NOW the server is the `[id]` item's bound connection, admitted against the
 * governed subscription set. `requireDatabase` is deliberately false: firewall
 * rules live at the SERVER scope, and a PostgreSQL item legitimately binds a
 * server before any database is chosen. The rule NAME and the IP range stay
 * caller-chosen — which rule on YOUR server is the feature; whose server is not.
 */

import { NextResponse } from 'next/server';
import { listFirewallRules, upsertFirewallRule, deleteFirewallRule, PostgresError } from '@/lib/azure/postgres-flex-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handleErr(e: any) {
  const status = e instanceof PostgresError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
}

// Listing the rules on your own bound server is a read — a workspace reader may
// see the network posture without being able to change it.
export const GET = withBoundSqlServer(
  { provider: 'postgres', allowReadRoles: true },
  async (_req, { server }) => {
    try {
      const rules = await listFirewallRules(server);
      return NextResponse.json({ ok: true, rules });
    } catch (e: any) { return handleErr(e); }
  },
);

export const POST = withBoundSqlServer(
  { provider: 'postgres' },
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
  { provider: 'postgres' },
  async (req, { server }) => {
    const rule = new URL(req.url).searchParams.get('rule');
    if (!rule) return NextResponse.json({ ok: false, error: 'rule query param required' }, { status: 400 });
    try {
      await deleteFirewallRule(server, rule);
      return NextResponse.json({ ok: true });
    } catch (e: any) { return handleErr(e); }
  },
);
