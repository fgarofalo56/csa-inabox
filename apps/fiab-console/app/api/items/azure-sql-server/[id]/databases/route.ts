/**
 * GET /api/items/azure-sql-server/[id]/databases?server=<name>
 *   List the databases on a given Azure SQL server (ARM REST).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). The exact twin of
 * `postgres-flexible-server/[id]/databases`, and it was NOT in the advisory's
 * 19 — it sat in `SHARED_BACKEND_ITEM_ROUTES` beside `create-db` and
 * `[id]/firewall` and was carried along with them. Found by enumerating the
 * whole tabled block rather than the list that was handed over: the advisory's
 * own lesson is that a control which cannot see a shape reports zero for it, and
 * the same applies to a triage list assembled by hand.
 *
 * It was `GET(req)` + `getSession()` with `[id]` never read and `server` from
 * the query string; `azure-sql-client.listDatabases` branches
 * `serverIdOrName.startsWith('/')`, so a full ARM id skipped the subscription
 * pin and enumerated database names on any SQL server the Console UAMI held a
 * role on, in any subscription — including a brownfield-adopted customer server
 * (`deploy-integrity.md` R5).
 *
 * LAYER 1 + LAYER 3, DELIBERATELY NOT LAYER 2 — see `sql-server-scope.ts`
 * §{@link admitPickedServer}. This is the DISCOVERY call behind the database
 * picker, so it necessarily runs before anything is bound. Listing is a read, so
 * `allowReadRoles`.
 *
 * CALLER NOTE. `azure-sql-editors.useSqlDatabases` used to send the literal id
 * `current` here, with a comment saying the route reads only `?server=` — true
 * then, and precisely the property this fix removes. It now threads the real
 * item id (#3639 put `azure-sql-server` and `sql-server-2025-vector-index` in
 * `SQL_EDITOR_ITEM_TYPES`, so both resolve).
 */

import { NextResponse } from 'next/server';
import { listDatabases, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { withOwnedSqlItem, admitPickedServer, scopeRefused } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withOwnedSqlItem({ allowReadRoles: true }, async (req) => {
  const admitted = admitPickedServer(
    new URL(req.url).searchParams.get('server'),
    'sql',
    { code: 'server_required', error: 'server query param required' },
  );
  if (!admitted.ok) return scopeRefused(admitted);
  const server = admitted.server;
  try {
    const databases = await listDatabases(server);
    return NextResponse.json({ ok: true, server, databases });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
