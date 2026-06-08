/**
 * POST /api/items/azure-sql-database/[id]/create-db
 *   body { server, name, location?, skuName?, tier?, sampleName?, zoneRedundant?,
 *          collation?, requestedBackupStorageRedundancy?, maintenanceConfigurationId? }
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

  // Collation validation — reject anything that isn't a plausible SQL Server
  // collation name before issuing the ARM PUT (defense-in-depth alongside the
  // UI's enumerated dropdown). Collation is immutable after create.
  const collation = body?.collation ? String(body.collation).trim() : undefined;
  if (collation && !/^[A-Za-z0-9_]+$/.test(collation)) {
    return NextResponse.json(
      { ok: false, error: `Invalid collation '${collation}' — must contain only letters, digits, and underscores.` },
      { status: 400 },
    );
  }
  // Backup redundancy — allow-list to the four ARM-accepted values; silently
  // drop anything else so a malformed client can't smuggle an arbitrary string.
  const backupRedundancy = ['Geo', 'GeoZone', 'Local', 'Zone'].includes(body?.requestedBackupStorageRedundancy)
    ? (body.requestedBackupStorageRedundancy as 'Geo' | 'GeoZone' | 'Local' | 'Zone')
    : undefined;

  const result = await createDatabase({
    server,
    name,
    location: body?.location ? String(body.location).trim() : undefined,
    skuName: body?.skuName ? String(body.skuName).trim() : undefined,
    tier: body?.tier ? String(body.tier).trim() : undefined,
    sampleName: body?.sampleName ? String(body.sampleName).trim() : undefined,
    zoneRedundant: typeof body?.zoneRedundant === 'boolean' ? body.zoneRedundant : undefined,
    collation,
    requestedBackupStorageRedundancy: backupRedundancy,
    maintenanceConfigurationId: body?.maintenanceConfigurationId
      ? String(body.maintenanceConfigurationId).trim()
      : undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, id: result.id, status: result.status, provisionedBy: session.claims.upn }, { status: 201 });
}
