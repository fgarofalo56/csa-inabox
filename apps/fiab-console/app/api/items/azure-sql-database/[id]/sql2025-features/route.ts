/**
 * POST /api/items/azure-sql-database/[id]/sql2025-features
 *   body { server, database } — probes the engine, returns version + a
 *   note for the UI MessageBar if older than SQL 2025 (major <17).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enableSqlServer2025Features } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.server || !body?.database) {
    return NextResponse.json({ ok: false, error: 'server + database required' }, { status: 400 });
  }
  const r = await enableSqlServer2025Features(body.server, body.database);
  return NextResponse.json(r);
}
