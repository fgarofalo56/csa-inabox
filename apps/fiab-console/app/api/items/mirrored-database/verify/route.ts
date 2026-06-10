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

  if (!server || !database) {
    return NextResponse.json({ ok: false, error: 'server and database are required to verify' }, { status: 400 });
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

  // Cross-cloud sources authenticate with their own credential (+ a gateway) at
  // mirror time — give precise, source-specific guidance instead of a generic note.
  if (sourceType === 'GoogleBigQuery') {
    return NextResponse.json({
      ok: true, verified: false,
      detail: `BigQuery authenticates with a Google service-account JSON key — validated when the mirror first reads the project. Confirm the project id (${server}) and dataset (${database}) are correct, the service account has the BigQuery dataset/table + Storage permissions, and (for private projects) a data gateway is set via LOOM_MIRROR_GATEWAY.`,
    });
  }
  if (sourceType === 'Oracle') {
    return NextResponse.json({
      ok: true, verified: false,
      detail: `Oracle authenticates with basic auth (username/password) through an On-Premises Data Gateway — validated when the mirror first connects. Confirm the server/connect-descriptor (${server}) and service (${database}), that the DB runs ARCHIVELOG + supplemental logging, and that LOOM_MIRROR_GATEWAY names the gateway reaching it.`,
    });
  }
  return NextResponse.json({
    ok: true, verified: false,
    detail: `${sourceType || 'This source'} authenticates with its own credential — the connection is validated when the mirror first syncs. Ensure the server/database are correct and the credential (or managed identity) is granted read access.`,
  });
}
