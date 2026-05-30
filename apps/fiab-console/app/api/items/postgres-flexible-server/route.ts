/**
 * GET  /api/items/postgres-flexible-server          — list all PostgreSQL flexible servers in the subscription (ARM REST)
 * POST /api/items/postgres-flexible-server          — provision a new flexible server (ARM PUT, long-running)
 *      body { name, resourceGroup, location, administratorLogin, administratorLoginPassword, skuName, tier, version?, storageGb? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listServers, createServer, PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const servers = await listServers();
    return NextResponse.json({ ok: true, servers });
  } catch (e: any) {
    const status = e instanceof PostgresError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = String(body?.name || '').trim();
  const resourceGroup = String(body?.resourceGroup || '').trim();
  const location = String(body?.location || '').trim();
  const administratorLogin = String(body?.administratorLogin || '').trim();
  const administratorLoginPassword = String(body?.administratorLoginPassword || '');
  const skuName = String(body?.skuName || '').trim();
  const tier = String(body?.tier || '').trim();
  if (!name || !resourceGroup || !location || !administratorLogin || !administratorLoginPassword || !skuName || !tier) {
    return NextResponse.json(
      { ok: false, error: 'name, resourceGroup, location, administratorLogin, administratorLoginPassword, skuName, tier are required' },
      { status: 400 },
    );
  }
  const result = await createServer({
    name, resourceGroup, location, administratorLogin, administratorLoginPassword,
    skuName, tier: tier as any,
    version: body?.version ? String(body.version).trim() : undefined,
    storageGb: typeof body?.storageGb === 'number' ? body.storageGb : undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, provisioningState: result.provisioningState, provisionedBy: session.claims.upn }, { status: 201 });
}
