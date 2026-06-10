/**
 * POST /api/items/mirrored-database/verify
 *   body: { sourceType, server, database }
 *   → { ok, verified, detail }  — pre-create reachability check for the mirror
 *     wizard's Verify step.
 *
 * For the SQL family (Azure SQL DB / MI / SQL Server) we do a REAL reachability
 * probe via sql-objects-client (listSchemas over the AAD-token TDS connection) —
 * if it returns, the server+database are reachable + the identity can read the
 * catalog. Sources that need their own credential (Postgres/Cosmos/Snowflake/
 * open-mirroring) return an honest 'validated on first sync' note rather than a
 * fake success (no-vaporware).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listSchemas, sqlConfigGate } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SQL_FAMILY = new Set(['AzureSqlDatabase', 'AzureSqlMI', 'SqlServer2025', 'MSSQL']);

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const sourceType = String(body?.sourceType || '');
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();

  // BigQuery's "server" is the GCP project id and its dataset is optional pre-load;
  // Oracle's server can carry the service in its connect string. Require the
  // project/server, not necessarily a database, for these two.
  const projectOnly = sourceType === 'BigQuery';
  if (!server || (!database && !projectOnly)) {
    return NextResponse.json(
      { ok: false, error: projectOnly ? 'project id is required to verify' : 'server and database are required to verify' },
      { status: 400 },
    );
  }

  // Cross-cloud sources (BigQuery service key / Oracle over a gateway) can't be
  // reached from the BFF here — they authenticate with their own credential at
  // mirror time. Return an honest, source-specific disclosure (no fake success).
  if (sourceType === 'BigQuery') {
    return NextResponse.json({
      ok: true, verified: false,
      detail: `BigQuery project ${server} uses a GCP service-account key. The connection is validated when the mirror first syncs: the Azure-native path stages the project's tables to ADLS Bronze Delta via the Data Factory Google BigQuery connector. Ensure the service account has bigquery.tables.getData + bigquery.jobs.create on the project.`,
    });
  }
  if (sourceType === 'Oracle') {
    return NextResponse.json({
      ok: true, verified: false,
      detail: `Oracle source ${server} is reached over a self-hosted integration runtime / data gateway and read with LogMiner. The connection is validated when the mirror first syncs (ADF Oracle connector → ADLS Bronze Delta). Ensure ARCHIVELOG mode + supplemental logging are enabled and the user has CREATE SESSION, SELECT_CATALOG_ROLE, and LOGMINING.`,
    });
  }

  if (SQL_FAMILY.has(sourceType)) {
    const gate = sqlConfigGate(server);
    if (gate) return NextResponse.json({ ok: false, verified: false, error: `Not configured: ${gate.missing}` }, { status: 200 });
    try {
      const schemas = await listSchemas(server, database);
      return NextResponse.json({
        ok: true, verified: true,
        detail: `Reachable — ${schemas.length} schema(s) visible on ${server}/${database}. The Console identity can read the catalog; mirroring can enumerate tables.`,
      });
    } catch (e: any) {
      return NextResponse.json({
        ok: false, verified: false,
        error: e?.message || String(e),
        hint: 'Confirm the server FQDN + database name, that the source allows the Console identity (Entra) to connect, and that the firewall/private-endpoint permits it.',
      }, { status: 200 });
    }
  }

  // Non-SQL sources authenticate with their own credential at mirror time.
  return NextResponse.json({
    ok: true, verified: false,
    detail: `${sourceType || 'This source'} authenticates with its own credential — the connection is validated when the mirror first syncs. Ensure the server/database are correct and the credential (or managed identity) is granted read access.`,
  });
}
