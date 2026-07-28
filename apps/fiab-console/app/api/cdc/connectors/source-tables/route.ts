/**
 * N7b — enumerate a source's tables for the wizard's include picker (pre-create).
 *
 *   POST /api/cdc/connectors/source-tables
 *     body: { kind?, sourceType?, server?, database? }
 *   → { ok, tables: [{ schema, table }] }
 *
 * A shared enumerator resolved by the source coordinates the CALLER provides —
 * no per-resource ownership (the connector doesn't exist yet). Reuses the exact
 * per-family enumerators the mirror engine uses (SQL catalog / PostgreSQL
 * information_schema). ADF-copy families (MySQL / MongoDB / Oracle) enumerate at
 * Start via their copy runtime, so this returns an honest gate.
 */
import type { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';
import { cdcSource } from '@/lib/cdc/connector-plane';
import { listTables } from '@/lib/azure/sql-objects-client';
import { listPostgresTables } from '@/lib/azure/postgres-flex-client';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const def = body?.kind ? cdcSource(String(body.kind)) : undefined;
  const sourceType = String(body?.sourceType || def?.engineSourceType || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  if (!database) return apiError('database is required', 400);

  try {
    let tables: Array<{ schema: string; table: string }> = [];
    if (MIRROR_SQL_FAMILY.has(sourceType)) {
      if (!server) return apiError('server is required for SQL sources', 400);
      tables = (await listTables(server, database)).map((t) => ({ schema: t.schema, table: t.name }));
    } else if (MIRROR_PG_FAMILY.has(sourceType)) {
      if (!server) return apiError('server is required for PostgreSQL', 400);
      tables = await listPostgresTables(server, database);
    } else {
      return apiOk({
        gate: true,
        tables: [],
        error: `${def?.label || sourceType || 'This source'} enumerates its tables through the Azure-native copy runtime at Start. Leave the list empty to replicate everything, or type entries as schema.table.`,
      });
    }
    tables.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
    return apiOk({ tables });
  } catch (e) {
    return apiServerError(e);
  }
});
