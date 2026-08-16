/**
 * POST /api/items/postgres-flexible-server/[id]/query
 *   body { sql, server?, database? }
 *
 * Executes SQL against a PostgreSQL flexible server over the real `pg` wire
 * protocol, authenticating with a Microsoft Entra access token (no stored
 * password). Resolves the server FQDN from the ARM record. When the console
 * identity hasn't been registered as a PG Entra principal
 * (LOOM_POSTGRES_AAD_USER unset) it returns a structured honest gate naming the
 * one-time setup — never fabricated rows (no-vaporware.md).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2): this route USED TO be `POST(req)` +
 * `getSession()` with `server`, `database` AND the statement all read from the
 * REQUEST BODY, and `[id]` never read at all. `server` accepted a bare name or a
 * full ARM id, so any signed-in caller could run arbitrary SQL as the Console
 * managed identity against any flexible server the UAMI could reach in any
 * subscription — arguably the worst route in that advisory.
 *
 * NOW: {@link withBoundSqlServer} authorizes the caller against the `[id]` item
 * (the unified SQL editor addresses BOTH families through one item — see
 * `unified-sql-database-editor.tsx` — and the `[id]` may be ANY of the three
 * slugs registered to that editor, which is why the wrapper's default
 * `SQL_EDITOR_ITEM_TYPES` is used rather than a single type), resolves the
 * server from that item's bound connection, and admits it against the
 * authorized subscription set. A body server that names a different server is
 * refused; the body can never CHOOSE the target.
 *
 * DATABASE, stated plainly: when the item's binding names a database the body
 * must match it. When it does not — the editor lets a PostgreSQL user pick a
 * database per query on a bound server — the body database is used, scoped to
 * the bound server. That is a narrowing, not a closure, and it is the same
 * residual `_lib/sql-server-scope.ts` records for the family.
 */

import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  getServer, executePostgresQuery, postgresQueryGate, PostgresError,
} from '@/lib/azure/postgres-flex-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withBoundSqlServer(
  { provider: 'postgres' },
  async (_req, { session, server, database, body }) => {
    const limited = await enforceRateLimit(session, 'query');
    if (limited) return limited;

    // The item's bound database wins; the body is only consulted when the item
    // binds no database (withBoundSqlServer has already refused a body database
    // that CONTRADICTS a bound one).
    const targetDatabase = database || String(body?.database || '').trim();
    const sqlText = String(body?.sql || '').trim();
    if (!targetDatabase) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
    if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });

    // Honest config gate: the UAMI must be a registered PG Entra principal.
    const gate = postgresQueryGate();
    if (gate) {
      return NextResponse.json(
        { ok: false, error: gate.detail, missing: gate.missing, code: 'PG_QUERY_GATED', gated: true },
        { status: 503 },
      );
    }

    try {
      // Resolve the real FQDN from ARM. `server` is the ITEM's bound, governed
      // reference — a bare name (resolved inside LOOM_SUBSCRIPTION_ID) or an ARM
      // id already admitted against loomSubscriptionScope().
      const srv = await getServer(server);
      const result = await executePostgresQuery(srv.fqdn, targetDatabase, sqlText);
      return NextResponse.json({ ok: true, server: srv.fqdn, database: targetDatabase, ...result });
    } catch (e: any) {
      const status = e instanceof PostgresError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.body }, { status });
    }
  },
);
