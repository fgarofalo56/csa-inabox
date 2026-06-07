/**
 * GET /api/lakehouse/tables?containers=bronze,silver&rowCounts=true
 *
 * Returns the REAL Delta (and ad-hoc Parquet) tables discovered under each
 * lakehouse container's `Tables/` directory — Azure-native, via an ADLS Gen2
 * directory scan + `_delta_log` transaction-log read (synapse-catalog-client).
 * NO Fabric / OneLake dependency; the Console UAMI's Storage Blob Data Reader
 * grant on the container is all that's required.
 *
 * Query params:
 *   - containers : comma list (bronze|silver|gold|landing). Defaults to all
 *                  containers that have a LOOM_*_URL configured.
 *   - rowCounts  : 'true' to run a Synapse Serverless OPENROWSET COUNT(*) per
 *                  Delta table (slower, cold-start). Row counts are null — never
 *                  a fabricated 0 — when Serverless is offline.
 *
 * Honest-empty: when no storage is configured, returns
 * { ok: true, tables: [], gate: '...' } (200, not 500). When storage exists but
 * has no tables yet, returns { ok: true, tables: [] }. No mock data ever.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { KNOWN_CONTAINERS } from '@/lib/azure/adls-client';
import { scanLakehouseTables } from '@/lib/azure/synapse-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawContainers = req.nextUrl.searchParams.get('containers');
  const containers = rawContainers
    ? rawContainers
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter((c) => (KNOWN_CONTAINERS as readonly string[]).includes(c))
    : undefined;
  const rowCounts = req.nextUrl.searchParams.get('rowCounts') === 'true';

  // Honest infra-gate: no lakehouse storage configured → empty, not a crash.
  const anyStorage = (KNOWN_CONTAINERS as readonly string[]).some(
    (c) => !!process.env[`LOOM_${c.toUpperCase()}_URL`],
  );
  if (!anyStorage) {
    return NextResponse.json({
      ok: true,
      tables: [],
      gate: 'No lakehouse storage configured — set LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL (deployed by the DLZ Bicep) and grant the Console UAMI Storage Blob Data Reader on the container.',
    });
  }

  try {
    const tables = await scanLakehouseTables({ containers, rowCounts });
    return NextResponse.json({ ok: true, tables, scannedAt: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
