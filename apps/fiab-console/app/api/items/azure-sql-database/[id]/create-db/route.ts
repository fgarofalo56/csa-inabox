/**
 * POST /api/items/azure-sql-database/[id]/create-db
 *   body { server, name, location?, skuName?, tier?, sampleName?, zoneRedundant? }
 *   Provisions a new Azure SQL database on an existing logical server via
 *   ARM PUT (Microsoft.Sql/servers/databases). Returns the ARM id + status.
 *
 * Requires the console UAMI to hold Contributor (or SQL DB Contributor) on
 * the target server's resource group. Errors surface verbatim so the editor
 * can render an honest gate naming the missing role.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createDatabase } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const server = String(body?.server || '').trim();
  const name = String(body?.name || '').trim();
  if (!server) return NextResponse.json({ ok: false, error: 'server is required' }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  const result = await createDatabase({
    server,
    name,
    location: body?.location ? String(body.location).trim() : undefined,
    skuName: body?.skuName ? String(body.skuName).trim() : undefined,
    tier: body?.tier ? String(body.tier).trim() : undefined,
    sampleName: body?.sampleName ? String(body.sampleName).trim() : undefined,
    zoneRedundant: typeof body?.zoneRedundant === 'boolean' ? body.zoneRedundant : undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, status: result.status, provisionedBy: session.claims.upn }, { status: 201 });
}
