/**
 * GET /api/items/databricks-sql-warehouse/[id]/warehouses
 * Lists the SQL Warehouses available as the Azure-native warehouse backend.
 *
 *   - Commercial / GCC  → Databricks SQL Warehouses (listWarehouses).
 *   - GCC-High / DoD     → Synapse Dedicated SQL pools (listDedicatedSqlPools),
 *                          mapped into the same { id, name, state, cluster_size }
 *                          shape the W1 list consumes. Databricks SQL Warehouses
 *                          are not a Gov-boundary offering, so the dedicated pool
 *                          is the parity backend there (no Fabric dependency).
 *
 * `gov` tells the editor which Create dialog to render (Databricks advanced
 * options vs. Synapse DWU SKU picker).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listWarehouses } from '@/lib/azure/databricks-client';
import { listDedicatedSqlPools } from '@/lib/azure/synapse-dev-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  if (isGovCloud()) {
    try {
      const pools = await listDedicatedSqlPools();
      // Dedicated pools are addressed by name — name IS the warehouse id. Map the
      // ARM status ('Online'|'Paused'|'Scaling'…) onto the W1 state vocabulary.
      const warehouses = pools.map((p) => ({
        id: p.name,
        name: p.name,
        state: p.status === 'Online' ? 'RUNNING' : p.status === 'Paused' ? 'STOPPED' : (p.status || 'UNKNOWN'),
        cluster_size: p.sku?.name,
      }));
      return NextResponse.json({ ok: true, warehouses, gov: true });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e), gov: true }, { status: 502 });
    }
  }

  try {
    const warehouses = await listWarehouses();
    return NextResponse.json({ ok: true, warehouses, gov: false });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e), gov: false }, { status: 502 });
  }
}
