/**
 * Tables on the ADX/KQL database bound to a kql-database item.
 *
 *   GET    /api/adx/tables?id=ITEM            → { ok, tables: [{name, totalRowCount, ...}] }
 *   GET    /api/adx/tables?id=ITEM&schema=N   → { ok, name, cslSchema } (for the ALTER grid)
 *   POST   /api/adx/tables?id=ITEM            body { name, schema } → .create table
 *   PATCH  /api/adx/tables?id=ITEM            body { name, schema } → .alter-merge table (add cols)
 *   DELETE /api/adx/tables?id=ITEM&name=NAME  → .drop table NAME ifexists
 *
 * Real Kusto control commands to /v1/rest/mgmt. Honest 503 gate when the
 * cluster env var (LOOM_KUSTO_CLUSTER_URI) is unset. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listTableDetails, createTable, dropTable, alterMergeTable, getTableCslSchema,
} from '@/lib/azure/kusto-client';
import { guardAdxRequest, adxError, validName } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const schemaFor = req.nextUrl.searchParams.get('schema')?.trim();
  try {
    if (schemaFor) {
      if (!validName(schemaFor)) return NextResponse.json({ ok: false, error: 'invalid table name' }, { status: 400 });
      const cslSchema = await getTableCslSchema(g.ctx.database, schemaFor);
      return NextResponse.json({ ok: true, name: schemaFor, cslSchema });
    }
    const tables = await listTableDetails(g.ctx.database);
    return NextResponse.json({ ok: true, database: g.ctx.database, tables });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function POST(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const schema: string = typeof body?.schema === 'string' ? body.schema.trim() : '';
  if (!validName(name)) return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore (letters, digits, _)' }, { status: 400 });
  if (!schema) return NextResponse.json({ ok: false, error: 'schema is required, e.g. "ts:datetime, value:long"' }, { status: 400 });
  try {
    const r = await createTable(g.ctx.database, name, schema);
    return NextResponse.json({ ok: true, name, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function PATCH(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const body = await req.json().catch(() => ({}));
  const name: string = typeof body?.name === 'string' ? body.name.trim() : '';
  const schema: string = typeof body?.schema === 'string' ? body.schema.trim() : '';
  if (!validName(name)) return NextResponse.json({ ok: false, error: 'name must start with a letter/underscore (letters, digits, _)' }, { status: 400 });
  if (!schema) return NextResponse.json({ ok: false, error: 'schema is required, e.g. "newcol:string"' }, { status: 400 });
  try {
    const r = await alterMergeTable(g.ctx.database, name, schema);
    return NextResponse.json({ ok: true, name, rowCount: r.rowCount });
  } catch (e: any) {
    return adxError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const g = await guardAdxRequest(req);
  if (g.res) return g.res;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await dropTable(g.ctx.database, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return adxError(e);
  }
}
