/**
 * GET /api/items/postgres-flexible-server/[id]/databases?server=<name>
 *   List databases on a PostgreSQL flexible server via ARM REST
 *   (Microsoft.DBforPostgreSQL/flexibleServers/databases).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDatabases, PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const server = new URL(req.url).searchParams.get('server');
  if (!server) return NextResponse.json({ ok: false, error: 'server query param required' }, { status: 400 });
  try {
    const databases = await listDatabases(server);
    return NextResponse.json({ ok: true, server, databases });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
