/**
 * Unity Catalog WRITE — schemas.
 *
 *   GET    /api/databricks/unity-catalog/schemas?catalog=main         → { ok, schemas }
 *   POST   /api/databricks/unity-catalog/schemas                      → create schema (+ tags)
 *   PATCH  /api/databricks/unity-catalog/schemas                      → change owner / comment
 *   DELETE /api/databricks/unity-catalog/schemas?full_name=main.sales&force= → drop schema
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST /api/2.1/unity-catalog/schemas
 *   PATCH    /api/2.1/unity-catalog/schemas/{full_name}
 *   DELETE   /api/2.1/unity-catalog/schemas/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/schemas/create-schema
 *
 * Console UAMI needs `CREATE SCHEMA` + `USE CATALOG` on the parent catalog.
 * Ownership transfer needs current-owner / metastore-admin / MANAGE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listUcSchemas, createUcSchema, deleteUcSchema, patchUcSchema,
} from '@/lib/azure/databricks-client';

// Coerce a free-form object into a Record<string,string> (drops empty keys).
function toStringMap(v: any): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const key = String(k).trim();
    if (key) out[key] = String(val ?? '');
  }
  return Object.keys(out).length ? out : undefined;
}

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
  const catalog = req.nextUrl.searchParams.get('catalog')?.trim();
  if (!catalog) return NextResponse.json({ ok: false, error: 'catalog is required' }, { status: 400 });
  try {
    const schemas = await listUcSchemas(catalog);
    return NextResponse.json({ ok: true, schemas });
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
  if (!name || !catalog_name) {
    return NextResponse.json({ ok: false, error: 'name and catalog_name are required' }, { status: 400 });
  }
  try {
    const schema = await createUcSchema({
      name,
      catalog_name,
      comment: body?.comment ? String(body.comment) : undefined,
      storage_root: body?.storage_root ? String(body.storage_root) : undefined,
      properties: toStringMap(body?.properties),
    });
    return NextResponse.json({ ok: true, schema });
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
  if (!fullName || fullName.split('.').length !== 2) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema) is required' }, { status: 400 });
  }
  const owner = body?.owner !== undefined ? String(body.owner).trim() : undefined;
  const comment = body?.comment !== undefined ? String(body.comment) : undefined;
  // Rename (UC `new_name`). Requires the caller to own the schema + USE CATALOG
  // on the parent catalog (Learn: Manage schemas). A UC 403 surfaces verbatim.
  const newName = body?.new_name !== undefined ? String(body.new_name).trim() : undefined;
  if (owner === undefined && comment === undefined && !newName) {
    return NextResponse.json({ ok: false, error: 'provide owner, comment, and/or new_name to update' }, { status: 400 });
  }
  try {
    const schema = await patchUcSchema(fullName, { owner, comment, new_name: newName });
    return NextResponse.json({ ok: true, schema });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  const force = req.nextUrl.searchParams.get('force') === 'true';
  if (!fullName || fullName.split('.').length !== 2) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema) is required' }, { status: 400 });
  }
  try {
    await deleteUcSchema(fullName, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
