/**
 * Unity Catalog WRITE — tables, volumes, functions.
 *
 *   GET    /api/databricks/unity-catalog/tables?catalog=&schema=        → { ok, tables, volumes, functions }
 *   GET    /api/databricks/unity-catalog/tables?full_name=c.s.t         → { ok, table } (with columns)
 *   POST   /api/databricks/unity-catalog/tables                         → create table (MANAGED/EXTERNAL)
 *   PATCH  /api/databricks/unity-catalog/tables                         → change owner / comment
 *   DELETE /api/databricks/unity-catalog/tables?full_name=c.s.t         → drop table
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST /api/2.1/unity-catalog/tables
 *   GET/PATCH/DELETE /api/2.1/unity-catalog/tables/{full_name}
 *   GET /api/2.1/unity-catalog/volumes, /functions
 * Learn: https://learn.microsoft.com/azure/databricks/tables/tables-concepts
 *
 * Console UAMI needs `CREATE TABLE` + `USE SCHEMA` + `USE CATALOG` on the parents.
 * Ownership transfer needs current-owner / metastore-admin / MANAGE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listUcTables, listUcVolumes, listUcFunctions,
  getUcTable, createUcTable, deleteUcTable, patchUcTable,
  type UcColumnSpec,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  if (fullName) {
    if (fullName.split('.').length !== 3) {
      return NextResponse.json({ ok: false, error: 'full_name must be catalog.schema.table' }, { status: 400 });
    }
    try {
      const table = await getUcTable(fullName);
      return NextResponse.json({ ok: true, table });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }
  const catalog = req.nextUrl.searchParams.get('catalog')?.trim();
  const schema = req.nextUrl.searchParams.get('schema')?.trim();
  if (!catalog || !schema) {
    return NextResponse.json({ ok: false, error: 'catalog and schema are required' }, { status: 400 });
  }
  try {
    // Tables always; volumes + functions best-effort (some workspaces gate them).
    const tables = await listUcTables(catalog, schema);
    const [volumes, functions] = await Promise.all([
      listUcVolumes(catalog, schema).catch(() => []),
      listUcFunctions(catalog, schema).catch(() => []),
    ]);
    return NextResponse.json({ ok: true, tables, volumes, functions });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const name = String(body?.name || '').trim();
  const catalog_name = String(body?.catalog_name || '').trim();
  const schema_name = String(body?.schema_name || '').trim();
  const rawCols = Array.isArray(body?.columns) ? body.columns : [];
  if (!name || !catalog_name || !schema_name) {
    return NextResponse.json({ ok: false, error: 'name, catalog_name and schema_name are required' }, { status: 400 });
  }
  if (rawCols.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one column is required' }, { status: 400 });
  }
  const columns: UcColumnSpec[] = rawCols.map((c: any, i: number) => ({
    name: String(c?.name || '').trim(),
    type_name: String(c?.type_name || 'STRING').trim(),
    position: typeof c?.position === 'number' ? c.position : i,
    nullable: c?.nullable !== false,
    comment: c?.comment ? String(c.comment) : undefined,
  }));
  if (columns.some((c) => !c.name)) {
    return NextResponse.json({ ok: false, error: 'every column needs a name' }, { status: 400 });
  }
  try {
    const table = await createUcTable({
      name, catalog_name, schema_name, columns,
      table_type: body?.table_type === 'EXTERNAL' ? 'EXTERNAL' : 'MANAGED',
      data_source_format: body?.data_source_format ? String(body.data_source_format) : 'DELTA',
      storage_location: body?.storage_location ? String(body.storage_location) : undefined,
      comment: body?.comment ? String(body.comment) : undefined,
    });
    return NextResponse.json({ ok: true, table });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const fullName = String(body?.full_name || '').trim();
  if (!fullName || fullName.split('.').length !== 3) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema.table) is required' }, { status: 400 });
  }
  const owner = body?.owner !== undefined ? String(body.owner).trim() : undefined;
  const comment = body?.comment !== undefined ? String(body.comment) : undefined;
  if (owner === undefined && comment === undefined) {
    return NextResponse.json({ ok: false, error: 'provide owner and/or comment to update' }, { status: 400 });
  }
  try {
    const table = await patchUcTable(fullName, { owner, comment });
    return NextResponse.json({ ok: true, table });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  if (!fullName || fullName.split('.').length !== 3) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema.table) is required' }, { status: 400 });
  }
  try {
    await deleteUcTable(fullName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
