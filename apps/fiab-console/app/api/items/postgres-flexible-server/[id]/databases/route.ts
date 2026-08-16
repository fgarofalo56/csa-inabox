/**
 * GET /api/items/postgres-flexible-server/[id]/databases?server=<name>
 *   List databases on a PostgreSQL flexible server via ARM REST
 *   (Microsoft.DBforPostgreSQL/flexibleServers/databases).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). This was `GET(req)` + `getSession()` with
 * `[id]` never read and `server` taken from the query string;
 * `postgres-flex-client.resolveScope` branches `serverName.startsWith('/')`, so
 * a full ARM id skipped the subscription pin and enumerated the database names
 * on any flexible server the Console UAMI held a role on, in any subscription —
 * including a brownfield-adopted customer server (`deploy-integrity.md` R5).
 *
 * LAYER 1 + LAYER 3, DELIBERATELY NOT LAYER 2 — see `sql-server-scope.ts`
 * §{@link admitPickedServer}. This is the DISCOVERY call that populates the
 * database picker, i.e. it runs so the user can decide what to bind. Requiring a
 * binding first inverts the flow: `unified-sql-database-editor.pickServer` calls
 * it in the same tick it sets the selection, racing that editor's own
 * bind-on-selection effect, so Layer 2 would have made picking a server fail
 * intermittently. Per `auto-bind-by-default.md` a 409 telling you to bind
 * something, on the surface whose job is to help you choose what to bind, is a
 * dead end rather than a boundary.
 *
 * So the caller must own the `[id]` item, and the picked server must be in
 * `sqlAuthorizedSubscriptions()`. Listing is a read, so `allowReadRoles`.
 */

import { NextResponse } from 'next/server';
import { listDatabases, PostgresError } from '@/lib/azure/postgres-flex-client';
import { withOwnedSqlItem, admitPickedServer, scopeRefused } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withOwnedSqlItem({ allowReadRoles: true }, async (req) => {
  const admitted = admitPickedServer(
    new URL(req.url).searchParams.get('server'),
    'postgres',
    { code: 'server_required', error: 'server query param required' },
  );
  if (!admitted.ok) return scopeRefused(admitted);
  const server = admitted.server;
  try {
    const databases = await listDatabases(server);
    return NextResponse.json({ ok: true, server, databases });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
});
