/**
 * POST /api/items/postgres-flexible-server/[id]/query
 *   body { server, database, sql }
 *
 * PostgreSQL speaks the PG wire protocol, not TDS. The `pg` driver is not
 * bundled with the console, so unless LOOM_POSTGRES_QUERY_LIVE=true this
 * route returns a structured 501 honest-gate (per no-vaporware.md) naming
 * the exact dependency + env var to wire. It never fabricates rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isPostgresQueryLive, queryGateReason } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const sqlText = String(body?.sql || '').trim();
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });
  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });

  if (!isPostgresQueryLive()) {
    return NextResponse.json(
      { ok: false, error: queryGateReason(), code: 'PG_QUERY_GATED', gated: true },
      { status: 501 },
    );
  }

  // Live path is intentionally not reachable until the `pg` driver is added —
  // returning a clear 501 rather than importing a dependency that is not in
  // package.json (which would break the build). When wiring live, import `pg`
  // here and execute via an Entra access token for the PG scope.
  return NextResponse.json(
    { ok: false, error: 'PostgreSQL live query path not yet wired (add the `pg` driver). ' + queryGateReason(), code: 'PG_QUERY_NOT_WIRED', gated: true },
    { status: 501 },
  );
}
