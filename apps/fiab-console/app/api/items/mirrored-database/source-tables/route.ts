/**
 * POST /api/items/mirrored-database/source-tables
 *   body: { sourceType, server, database }
 *   → { ok, tables: [{schema, table}] }   — enumerate the mirror source's
 *     tables/containers so the create/edit wizard can offer a real multi-select
 *     (pick a subset to mirror) instead of always mirroring everything.
 *
 * Uses the same per-family enumerators the mirror engine uses (SQL catalog /
 * PostgreSQL information_schema / Cosmos containers). Honest gate when the
 * source family isn't directly enumerable.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listTables } from '@/lib/azure/sql-objects-client';
import { listPostgresTables } from '@/lib/azure/postgres-flex-client';
import { listContainers } from '@/lib/azure/cosmos-account-client';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY, MIRROR_COSMOS_FAMILY, MIRROR_ADF_COPY_FAMILY } from '@/lib/azure/mirror-engine';
import { listSnowflakeTables } from '@/lib/azure/snowflake-adf';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest, { session: s }) => {
  const body = await req.json().catch(() => ({}));
  const sourceType = String(body?.sourceType || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  const connectionId = body?.connectionId ? String(body.connectionId).trim() : undefined;

  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });

  try {
    let tables: Array<{ schema: string; table: string; isIceberg?: boolean }> = [];
    if (MIRROR_SQL_FAMILY.has(sourceType)) {
      if (!server) return NextResponse.json({ ok: false, error: 'server is required for SQL sources' }, { status: 400 });
      tables = (await listTables(server, database)).map((t) => ({ schema: t.schema, table: t.name }));
    } else if (MIRROR_PG_FAMILY.has(sourceType)) {
      if (!server) return NextResponse.json({ ok: false, error: 'server is required for PostgreSQL' }, { status: 400 });
      tables = await listPostgresTables(server, database);
    } else if (MIRROR_COSMOS_FAMILY.has(sourceType)) {
      tables = (await listContainers(database)).map((c: any) => ({ schema: 'cosmos', table: c.name || c.id }));
    } else if (MIRROR_ADF_COPY_FAMILY.has(sourceType)) {
      // Snowflake. Enumerated through the SAME ADF runtime that will replicate
      // it, using the auto-bound linked service, so "Load tables" and Start can
      // never disagree about what is readable. IS_ICEBERG rides along so the
      // wizard can label (and the engine can filter) Snowflake-managed Iceberg
      // tables. Previously Snowflake fell through to the generic branch and
      // returned "can't be enumerated here", while Start refused to run without
      // a table list -- a closed loop with no way out of it.
      const listed = await listSnowflakeTables(s.claims.oid, connectionId, database);
      if ('gate' in listed) {
        return NextResponse.json({ ok: false, gate: true, error: listed.gate.message }, { status: 200 });
      }
      const sf = listed.tables
        .map((t) => ({ schema: t.schema, table: t.table, isIceberg: t.isIceberg }))
        .sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
      return NextResponse.json({ ok: true, tables: sf, icebergKnown: listed.icebergKnown });
    } else if (sourceType === 'GoogleBigQuery') {
      return NextResponse.json(
        { ok: false, gate: true, error: 'BigQuery datasets are enumerated by the Azure-native copy (ADF Google BigQuery V2 connector) at run time. Leave the table list empty to mirror every table in the dataset, or list them as schema.table (schema = dataset).' },
        { status: 200 },
      );
    } else if (sourceType === 'Oracle') {
      return NextResponse.json(
        { ok: false, gate: true, error: 'Oracle tables are read through the on-prem data gateway by the Azure-native copy (ADF Oracle connector) at run time. Leave the table list empty to mirror everything, or list them as SCHEMA.TABLE (the schema/owner is required for Oracle).' },
        { status: 200 },
      );
    } else {
      return NextResponse.json(
        { ok: false, gate: true, error: `${sourceType || 'This source'} can't be enumerated here — leave the table list empty to mirror everything the engine discovers.` },
        { status: 200 },
      );
    }
    tables.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
    return NextResponse.json({ ok: true, tables });
  } catch (e: any) {
    return apiServerError(e);
  }
});
