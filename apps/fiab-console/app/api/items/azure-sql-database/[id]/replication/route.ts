/**
 * POST /api/items/azure-sql-database/[id]/replication
 *   body { server, database, replicaServer, replicaDatabaseName?, location, skuName? }
 *   Provisions a geo-secondary database on `replicaServer`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enableReplication } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { server, database, replicaServer, replicaDatabaseName, location, skuName } = body || {};
  if (!server || !database || !replicaServer || !location) {
    return NextResponse.json({ ok: false, error: 'server, database, replicaServer, location are required' }, { status: 400 });
  }
  const r = await enableReplication(server, database, { replicaServer, replicaDatabaseName, location, skuName });
  if (!r.ok) return NextResponse.json(r, { status: 502 });
  return NextResponse.json({ ok: true });
}
