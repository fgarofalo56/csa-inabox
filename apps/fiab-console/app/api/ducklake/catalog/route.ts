/**
 * GET /api/ducklake/catalog — list the tables the DuckLake catalog exposes (N8 lab 1).
 *
 * When LOOM_DUCKLAKE_CATALOG_URL (and the N2 DuckDB tier) are wired, this reads
 * the REAL catalog by ATTACHing the DuckLake Postgres store on the DuckDB tier
 * and querying information_schema — never a fabricated list. When either is
 * unset it returns the honest gate envelope so the editor renders a guided empty
 * state with a Fix-it. Every successful/failed read is audited.
 *
 * 200 → { ok:true, configured, catalog?, tables?, note?, gate? }
 * 401 → unauthenticated
 */
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import {
  DUCKLAKE_GATE_ID,
  isDucklakeConfigured,
  listDucklakeTables,
  logDucklakeAccess,
  DucklakeError,
} from '@/lib/azure/ducklake-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session }) => {
  if (!isDucklakeConfigured()) {
    return apiOk({
      configured: false,
      gate: buildGateEnvelope(DUCKLAKE_GATE_ID, { missing: ['LOOM_DUCKLAKE_CATALOG_URL'] }).gate,
      note:
        'DuckLake is a Preview lab alongside the N1 Iceberg REST Catalog. Set LOOM_DUCKLAKE_CATALOG_URL to a Postgres '
        + 'store to browse a DuckLake catalog; N1 and every other surface are unaffected.',
    });
  }

  const tenantId = session.claims.tid || session.claims.oid;
  try {
    const listing = await listDucklakeTables();
    await logDucklakeAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'catalog.list',
      outcome: 'success',
      resultCount: listing.tables.length,
    });
    return apiOk({ configured: true, ...listing });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const status = e instanceof DucklakeError ? e.status : 502;
    await logDucklakeAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'catalog.list',
      outcome: 'failure',
      detail,
    });
    // Honest: a wired-but-unreachable catalog reports the upstream reason; a
    // missing DuckDB tier (503) surfaces its own Fix-it var.
    if (status === 503) {
      return apiOk({
        configured: true,
        gate: buildGateEnvelope(DUCKLAKE_GATE_ID, { missing: ['LOOM_DUCKDB_URL'] }).gate,
        error: detail.slice(0, 400),
      });
    }
    return apiOk({ configured: true, unreachable: detail.slice(0, 400) });
  }
});
