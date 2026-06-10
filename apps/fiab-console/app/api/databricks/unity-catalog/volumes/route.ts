/**
 * Unity Catalog WRITE — volumes (managed/external storage volumes under a schema).
 *
 *   GET    /api/databricks/unity-catalog/volumes?catalog=&schema=        → { ok, volumes }
 *   POST   /api/databricks/unity-catalog/volumes                          → create volume (MANAGED/EXTERNAL)
 *   DELETE /api/databricks/unity-catalog/volumes?full_name=c.s.v          → drop volume
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET    /api/2.1/unity-catalog/volumes?catalog_name=&schema_name=
 *   POST   /api/2.1/unity-catalog/volumes
 *   DELETE /api/2.1/unity-catalog/volumes/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/volumes/
 *
 * Console UAMI needs `CREATE VOLUME` + `USE SCHEMA` + `USE CATALOG` on the parents.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  listUcVolumes, createUcVolume, deleteUcVolume,
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
  const catalog = req.nextUrl.searchParams.get('catalog')?.trim();
  const schema = req.nextUrl.searchParams.get('schema')?.trim();
  if (!catalog || !schema) {
    return NextResponse.json({ ok: false, error: 'catalog and schema are required' }, { status: 400 });
  }
  try {
    const volumes = await listUcVolumes(catalog, schema);
    return NextResponse.json({ ok: true, volumes });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
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
  const volume_type = body?.volume_type === 'EXTERNAL' ? 'EXTERNAL' : 'MANAGED';
  if (!name || !catalog_name || !schema_name) {
    return NextResponse.json({ ok: false, error: 'name, catalog_name and schema_name are required' }, { status: 400 });
  }
  if (volume_type === 'EXTERNAL' && !String(body?.storage_location || '').trim()) {
    return NextResponse.json({ ok: false, error: 'EXTERNAL volumes require storage_location (abfss://…)' }, { status: 400 });
  }
  try {
    const volume = await createUcVolume({
      name, catalog_name, schema_name, volume_type,
      storage_location: body?.storage_location ? String(body.storage_location).trim() : undefined,
      comment: body?.comment ? String(body.comment) : undefined,
    });
    return NextResponse.json({ ok: true, volume });
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
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema.volume) is required' }, { status: 400 });
  }
  try {
    await deleteUcVolume(fullName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
