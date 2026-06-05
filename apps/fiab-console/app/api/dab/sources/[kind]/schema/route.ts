/**
 * GET /api/dab/sources/[kind]/schema?server=&database=
 *   → enumerate the database objects (schemas → tables / views / stored
 *     procedures) that can become DAB entities. Real data-plane introspection
 *     via sql-objects-client (sys.* catalog over the AAD-token TDS connection).
 *
 * Only mssql is introspectable here today; postgresql/cosmos return an honest
 * gate (Cosmos is schema-less → user supplies the container + .gql).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../../../items/_lib/item-crud';
import { sqlConfigGate, listSchemas, listTables, listViews, listProcedures } from '@/lib/azure/sql-objects-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { kind } = await ctx.params;
  const server = req.nextUrl.searchParams.get('server') || '';
  const database = req.nextUrl.searchParams.get('database') || '';

  // mssql + dwsql (Azure Synapse) both speak T-SQL over TDS, so the same sys.*
  // catalog introspection path works for Azure SQL, the Synapse Dedicated pool,
  // and (for exploration only) the Synapse Serverless endpoint — getPool()
  // connects to a fully-qualified server FQDN directly with the AAD token.
  if (kind !== 'mssql' && kind !== 'dwsql') {
    return NextResponse.json(
      { ok: false, gate: { missing: kind === 'cosmosdb_nosql' ? 'cosmos-graphql-schema' : 'LOOM_POSTGRES_DISCOVERY' }, error: `Schema introspection for ${kind} is not wired; ${kind === 'cosmosdb_nosql' ? 'Cosmos is schema-less — supply a .gql type per container' : 'use information_schema via the PG navigator'}.` },
      { status: 503 },
    );
  }
  if (!server || !database) return jerr('server and database are required', 400);
  const gate = sqlConfigGate(server);
  if (gate) {
    return NextResponse.json({ ok: false, gate, error: `SQL source not configured: set ${gate.missing}.` }, { status: 503 });
  }

  try {
    const [schemas, tables, views, procedures] = await Promise.all([
      listSchemas(server, database),
      listTables(server, database),
      listViews(server, database),
      listProcedures(server, database),
    ]);
    return NextResponse.json({
      ok: true,
      schemas: schemas.map((s) => s.name),
      tables: tables.map((t) => ({ objectId: t.objectId, schema: t.schema, name: t.name })),
      views: views.map((v) => ({ objectId: v.objectId, schema: v.schema, name: v.name })),
      procedures: procedures.map((p) => ({ objectId: p.objectId, schema: p.schema, name: p.name })),
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
