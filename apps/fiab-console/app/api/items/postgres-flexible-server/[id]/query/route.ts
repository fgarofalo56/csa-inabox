/**
 * POST /api/items/postgres-flexible-server/[id]/query
 *   body { server, database, sql }
 *
 * Executes SQL against a PostgreSQL flexible server over the real `pg` wire
 * protocol, authenticating with a Microsoft Entra access token (no stored
 * password). Resolves the server FQDN from the ARM record. When the console
 * identity hasn't been registered as a PG Entra principal
 * (LOOM_POSTGRES_AAD_USER unset) it returns a structured honest gate naming the
 * one-time setup — never fabricated rows (no-vaporware.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getServer, executePostgresQuery, postgresQueryGate, PostgresError,
} from '@/lib/azure/postgres-flex-client';

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

  // Honest config gate: the UAMI must be a registered PG Entra principal.
  const gate = postgresQueryGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: gate.detail, missing: gate.missing, code: 'PG_QUERY_GATED', gated: true },
      { status: 503 },
    );
  }

  try {
    // Resolve the real FQDN from ARM (server may be a bare name or resource id).
    const srv = await getServer(server);
    const result = await executePostgresQuery(srv.fqdn, database, sqlText);
    return NextResponse.json({ ok: true, server: srv.fqdn, database, ...result });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), code: e?.body }, { status });
  }
}
