/**
 * GET /api/duckdb/capabilities — what the SQL Lab tier can actually do (N2b).
 *
 * Returns the REAL engine capabilities read off the loom-duckdb serving tier
 * (DuckDB version, the extensions it has loaded, the lake account it is bound
 * to, its row cap, and whether the Flight wire is up with signed tickets), or —
 * when `LOOM_DUCKDB_URL` is unset — the honest description of the Synapse
 * Serverless fallback the surface will use instead. Either way the SQL Lab
 * editor renders fully; this endpoint only decides which badges it shows.
 *
 * Never fabricates a capability list: an unreachable tier is reported as
 * unreachable with the upstream reason.
 *
 * 200 → { ok:true, configured, engine, capabilities?, fallback?, gate? }
 * 401 → unauthenticated
 */
import { apiOk } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import {
  DUCKDB_GATE_ID,
  duckdbCapabilities,
  isDuckDbConfigured,
  logDuckDbAccess,
} from '@/lib/azure/duckdb-client';
import { isFlightSqlConfigured, resolveFlightEndpoint } from '@/lib/azure/flight-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session }) => {
  const flight = resolveFlightEndpoint();

  if (!isDuckDbConfigured()) {
    return apiOk({
      configured: false,
      engine: 'synapse-serverless' as const,
      gate: buildGateEnvelope(DUCKDB_GATE_ID, { missing: ['LOOM_DUCKDB_URL'] }).gate,
      fallback: {
        engine: 'synapse-serverless',
        note:
          'SQL Lab runs every statement on Synapse Serverless in this environment. Deploying the '
          + 'loom-duckdb serving tier (platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep) swaps in '
          + 'an embedded DuckDB with sub-second cold start — same SQL, same results, less waiting.',
      },
      flight: { configured: isFlightSqlConfigured(), exposure: flight.exposure, note: flight.note },
    });
  }

  const tenantId = session.claims.tid || session.claims.oid;
  try {
    const capabilities = await duckdbCapabilities();
    await logDuckDbAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'sql.capabilities',
      engine: 'duckdb',
      sql: '',
      outcome: 'success',
    });
    return apiOk({
      configured: true,
      engine: 'duckdb' as const,
      capabilities,
      flight: { configured: isFlightSqlConfigured(), exposure: flight.exposure, note: flight.note },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await logDuckDbAccess({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId,
      operation: 'sql.capabilities',
      engine: 'duckdb',
      sql: '',
      outcome: 'failure',
      detail,
    });
    return apiOk({
      configured: true,
      engine: 'duckdb' as const,
      unreachable: detail.slice(0, 400),
      flight: { configured: isFlightSqlConfigured(), exposure: flight.exposure, note: flight.note },
    });
  }
});
