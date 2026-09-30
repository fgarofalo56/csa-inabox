/**
 * GET /api/thread/lakehouse-delta-tables?fromId=<lakehouse id>
 *
 * Discovery route for the Weave "Materialize to KQL (ADX)" and "Promote
 * (medallion)" edges — lists the REAL Delta tables under a lakehouse item's own
 * ADLS Gen2 `Tables/` directory (via an ADLS scan + `_delta_log` read,
 * synapse-catalog-client) so the wizard's table picker is a real dropdown
 * (loom-no-freeform-config.md). Azure-native, no Fabric / OneLake.
 *
 * The picker value encodes `name|adlsPath` so the edge route can build the
 * exact abfss Delta location without re-scanning. Owner-scoped: the lakehouse
 * is loaded against the caller's tenant and only its own root is scanned.
 *
 * Returns { ok, options:[{value,label}] } or an honest { ok:false, error/gate }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadOwnedItem } from '../../items/_lib/item-crud';
import { lakehouseStorageWithheldFields, resolveLakehouseStorage } from '@/lib/azure/lakehouse-abfss';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (req: NextRequest, { session }) => {
  const fromId = req.nextUrl.searchParams.get('fromId')?.trim() || '';
  if (!fromId) return NextResponse.json({ ok: false, error: 'fromId is required' }, { status: 400 });

  const lake = await loadOwnedItem(fromId, 'lakehouse', session.claims.oid, { allowReadRoles: true });
  if (!lake) return NextResponse.json({ ok: false, error: 'lakehouse not found' }, { status: 404 });

  const resolved = await resolveLakehouseStorage(fromId, lake.workspaceId);
  if (!resolved.ok) {
    if (resolved.reason === 'not-found') return NextResponse.json({ ok: false, error: 'lakehouse not found' }, { status: 404 });
    // A withheld location carries the resolver's one wording (and the page that
    // resolves it); only `no-storage` is the storage-configuration gate.
    const withheld = lakehouseStorageWithheldFields(resolved.reason);
    if (withheld) return NextResponse.json({ ok: false, ...withheld });
    return NextResponse.json({
      ok: false,
      gate: { missing: 'LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL' },
      error:
        'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL (deployed by the ' +
        'DLZ Bicep) and grant the Console UAMI Storage Blob Data Reader on the container.',
    });
  }
  const root = resolved.bound;

  try {
    const tables = await scanLakehouseTables({ containers: [root.container], rootPrefix: root.root });
    const options = tables
      .filter((t) => t.format === 'delta')
      .map((t) => ({
        value: `${t.name}|${t.adlsPath}`,
        label: t.rowCount != null ? `${t.name} · ${t.rowCount.toLocaleString()} rows` : t.name,
      }));
    if (!options.length) {
      return NextResponse.json({
        ok: false,
        error:
          'This lakehouse has no Delta tables yet. Load data into it (e.g. run a notebook that writes a ' +
          'Delta table under Tables/), then weave again.',
      });
    }
    return NextResponse.json({ ok: true, options });
  } catch (e: any) {
    return apiServerError(e);
  }
});
