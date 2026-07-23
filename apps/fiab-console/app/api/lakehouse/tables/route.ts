/**
 * GET /api/lakehouse/tables?lakehouseId=<id>&workspaceId=<ws>&rowCounts=true
 *
 * Returns the REAL Delta (and ad-hoc Parquet) tables discovered under ONE
 * lakehouse item's own ADLS Gen2 root `Tables/` directory — Azure-native, via an
 * ADLS Gen2 directory scan + `_delta_log` transaction-log read
 * (synapse-catalog-client). NO Fabric / OneLake dependency; the Console UAMI's
 * Storage Blob Data Reader grant on the container is all that's required.
 *
 * SCOPING (the leak this closes): the scan is bounded to the caller's OWN
 * lakehouse item. The route (a) authorizes the caller against the lakehouse via
 * the workspace ACL / item-grant resolver, and (b) resolves that lakehouse's
 * exact ADLS root (container + rootPath) and scans ONLY `<root>/Tables/`. It no
 * longer enumerates every medallion container's root — so a lakehouse in one
 * workspace can never surface another lakehouse's (or another workspace's)
 * tables.
 *
 * Query params:
 *   - lakehouseId : REQUIRED — the lakehouse item to browse.
 *   - workspaceId : REQUIRED — the lakehouse's workspace (partition key).
 *   - rowCounts   : 'true' to run a Synapse Serverless OPENROWSET COUNT(*) per
 *                   Delta table (slower, cold-start). Row counts are null — never
 *                   a fabricated 0 — when Serverless is offline.
 *
 * Honest-empty: when the lakehouse resolves to no configured storage, returns
 * { ok: true, tables: [], gate: '...' } (200, not 500). When storage exists but
 * has no tables yet, returns { ok: true, tables: [] }. No mock data ever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { runWithWorkspaceContext } from '@/lib/azure/workspace-credential-factory';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const lakehouseId = req.nextUrl.searchParams.get('lakehouseId')?.trim() || '';
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim() || '';
  const rowCounts = req.nextUrl.searchParams.get('rowCounts') === 'true';
  if (!lakehouseId || !workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'lakehouseId and workspaceId query params are required' },
      { status: 400 },
    );
  }

  // Authorize the caller against THIS lakehouse item (workspace ACL → item
  // grant). 404 (not 403) so we never leak the existence of a lakehouse the
  // caller can't see.
  const access = await resolveItemAccessByOid(s, lakehouseId, 'lakehouse');
  if (!access) {
    return NextResponse.json({ ok: false, error: 'lakehouse not found' }, { status: 404 });
  }

  // Resolve the lakehouse's REAL ADLS root (container + rootPath). Use the
  // item's own authoritative workspaceId (not the query param) for the read.
  const root = await resolveLakehouseAbfss(lakehouseId, access.item.workspaceId);
  if (!root) {
    return NextResponse.json({
      ok: true,
      tables: [],
      gate:
        'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL (deployed by the DLZ Bicep) and grant the Console UAMI Storage Blob Data Reader on the container.',
    });
  }

  try {
    // I3 pilot: establish the ambient workspace identity context so the
    // credential factory's shadow-mode divergence audit (identity.shadow rows)
    // observes this workspace-scoped scan — zero behavior change (the scan
    // still runs as the shared Console UAMI; mode off skips everything).
    const tables = await runWithWorkspaceContext(access.item.workspaceId, () =>
      scanLakehouseTables({
        containers: [root.container],
        rootPrefix: root.root,
        rowCounts,
      }));
    return NextResponse.json({ ok: true, tables, scannedAt: new Date().toISOString() });
  } catch (e: any) {
    return apiServerError(e);
  }
}
