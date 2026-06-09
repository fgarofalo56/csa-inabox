/**
 * GET /api/items/azure-sql-database/[id]/maintenance-configs?location={region}
 *   Lists the available SQLDB maintenance-window configurations published for
 *   a given Azure region (ARM Maintenance API, scope=SQLDB). The returned
 *   `id` values are used as `maintenanceConfigurationId` on create-db.
 *   Returns { ok: true, configs: MaintenanceConfig[] } — an empty list means
 *   the region has no published windows (the DB then uses the System default
 *   policy), which is an honest gate, not an error.
 *
 * Resolves to the sovereign ARM host automatically (Commercial / Gov / DoD).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDbMaintenanceConfigs } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const location = req.nextUrl.searchParams.get('location')?.trim();
  if (!location) {
    return NextResponse.json({ ok: false, error: 'location query param is required' }, { status: 400 });
  }
  try {
    const configs = await listDbMaintenanceConfigs(location);
    return NextResponse.json({ ok: true, configs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
