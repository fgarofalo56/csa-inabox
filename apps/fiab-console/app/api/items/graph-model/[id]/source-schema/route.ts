/**
 * GET /api/items/graph-model/[id]/source-schema
 *   Live ADX source-schema browser for the graph-model type designer's
 *   Source-binding pickers (P0 table-mapping parity).
 *     (no params)                 → { ok, databases: [{name,prettyName}] }
 *     ?database=DB                 → { ok, database, tables: [{name,folder}] }
 *     ?database=DB&table=T         → { ok, database, table, columns: [{name,type}] }
 *
 *   Azure-native, NO Fabric: every list comes from the env-configured ADX
 *   cluster via `.show databases` / `.show tables` / `.show table … schema`.
 *   When ADX isn't configured we return an honest gate (HTTP 200, ok:false,
 *   gate.remediation) naming the exact env var to set — never a Fabric prompt.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDatabases, listTables, getTableSchema, defaultDatabase, kustoConfigGate, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Normalize `.show table … schema as json` into [{name, type}] column rows. */
function columnsFromSchema(schema: unknown): Array<{ name: string; type: string }> {
  const s = schema as any;
  const cols = Array.isArray(s?.OrderedColumns) ? s.OrderedColumns
    : Array.isArray(s?.Columns) ? s.Columns : [];
  return cols.map((c: any) => ({
    name: String(c?.Name ?? c?.name ?? ''),
    type: String(c?.CslType ?? c?.Type ?? c?.type ?? 'string').replace(/^System\./, '').toLowerCase(),
  })).filter((c: { name: string }) => c.name);
}

export async function GET(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gate: { remediation: `Azure Data Explorer is not configured. Set ${gate.missing} to bind source tables.` },
      error: `ADX not configured (${gate.missing})`,
    });
  }

  const database = req.nextUrl.searchParams.get('database') || '';
  const table = req.nextUrl.searchParams.get('table') || '';

  try {
    if (database && table) {
      const schema = await getTableSchema(database, table).catch(() => null);
      return NextResponse.json({ ok: true, database, table, columns: columnsFromSchema(schema) });
    }
    if (database) {
      const tables = await listTables(database);
      return NextResponse.json({ ok: true, database, tables });
    }
    const databases = await listDatabases();
    return NextResponse.json({ ok: true, defaultDatabase: defaultDatabase(), databases });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
