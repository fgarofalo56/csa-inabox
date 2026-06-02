/**
 * Unity Catalog WRITE — catalogs.
 *
 *   GET    /api/databricks/unity-catalog/catalogs            → { ok, catalogs }
 *   POST   /api/databricks/unity-catalog/catalogs            → create catalog
 *   DELETE /api/databricks/unity-catalog/catalogs?name=&force= → drop catalog
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST /api/2.1/unity-catalog/catalogs
 *   DELETE   /api/2.1/unity-catalog/catalogs/{name}
 * Learn: https://learn.microsoft.com/azure/databricks/catalogs/create-catalog
 *
 * The console UAMI needs `CREATE CATALOG` on the metastore (else UC 403s, which
 * we surface verbatim). Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listUcCatalogs, createUcCatalog, deleteUcCatalog,
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

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const catalogs = await listUcCatalogs();
    return NextResponse.json({ ok: true, catalogs });
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
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const catalog = await createUcCatalog({
      name,
      comment: body?.comment ? String(body.comment) : undefined,
      storage_root: body?.storage_root ? String(body.storage_root) : undefined,
    });
    return NextResponse.json({ ok: true, catalog });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  const force = req.nextUrl.searchParams.get('force') === 'true';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    await deleteUcCatalog(name, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
