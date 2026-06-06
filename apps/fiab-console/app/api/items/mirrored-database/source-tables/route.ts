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
import { getSession } from '@/lib/auth/session';
import { listTables } from '@/lib/azure/sql-objects-client';
import { listPostgresTables } from '@/lib/azure/postgres-flex-client';
import { listContainers } from '@/lib/azure/cosmos-account-client';
import { MIRROR_SQL_FAMILY, MIRROR_PG_FAMILY, MIRROR_COSMOS_FAMILY } from '@/lib/azure/mirror-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const sourceType = String(body?.sourceType || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();

  if (!database) return NextResponse.json({ ok: false, error: 'database is required' }, { status: 400 });

  try {
    let tables: Array<{ schema: string; table: string }> = [];
    if (MIRROR_SQL_FAMILY.has(sourceType)) {
      if (!server) return NextResponse.json({ ok: false, error: 'server is required for SQL sources' }, { status: 400 });
      tables = (await listTables(server, database)).map((t) => ({ schema: t.schema, table: t.name }));
    } else if (MIRROR_PG_FAMILY.has(sourceType)) {
      if (!server) return NextResponse.json({ ok: false, error: 'server is required for PostgreSQL' }, { status: 400 });
      tables = await listPostgresTables(server, database);
    } else if (MIRROR_COSMOS_FAMILY.has(sourceType)) {
      tables = (await listContainers(database)).map((c: any) => ({ schema: 'cosmos', table: c.name || c.id }));
    } else {
      return NextResponse.json(
        { ok: false, gate: true, error: `${sourceType || 'This source'} can't be enumerated here — leave the table list empty to mirror everything the engine discovers.` },
        { status: 200 },
      );
    }
    tables.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
    return NextResponse.json({ ok: true, tables });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
