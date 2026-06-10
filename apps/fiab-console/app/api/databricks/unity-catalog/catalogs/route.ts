/**
 * Unity Catalog WRITE — catalogs.
 *
 *   GET    /api/databricks/unity-catalog/catalogs            → { ok, catalogs }
 *   POST   /api/databricks/unity-catalog/catalogs            → create catalog
 *                                                              (standard / foreign / Delta-Sharing, + tags)
 *   PATCH  /api/databricks/unity-catalog/catalogs            → change owner / comment
 *   DELETE /api/databricks/unity-catalog/catalogs?name=&force= → drop catalog
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST  /api/2.1/unity-catalog/catalogs
 *   PATCH     /api/2.1/unity-catalog/catalogs/{name}
 *   DELETE    /api/2.1/unity-catalog/catalogs/{name}
 * Learn: https://learn.microsoft.com/azure/databricks/catalogs/create-catalog
 *
 * The console UAMI needs `CREATE CATALOG` on the metastore (else UC 403s, which
 * we surface verbatim). Ownership transfer needs current-owner / metastore-admin /
 * MANAGE. Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listUcCatalogs, createUcCatalog, deleteUcCatalog, patchUcCatalog,
} from '@/lib/azure/databricks-client';

const CATALOG_TYPES = new Set(['MANAGED_CATALOG', 'FOREIGN_CATALOG', 'DELTASHARING_CATALOG']);

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
  const catalogType = String(body?.catalog_type || '').toUpperCase().trim();
  if (catalogType && !CATALOG_TYPES.has(catalogType)) {
    return NextResponse.json({ ok: false, error: `catalog_type must be one of ${[...CATALOG_TYPES].join(', ')}` }, { status: 400 });
  }
  if (catalogType === 'FOREIGN_CATALOG' && !String(body?.connection_name || '').trim()) {
    return NextResponse.json({ ok: false, error: 'connection_name is required for a FOREIGN catalog' }, { status: 400 });
  }
  if (catalogType === 'DELTASHARING_CATALOG' && (!String(body?.provider_name || '').trim() || !String(body?.share_name || '').trim())) {
    return NextResponse.json({ ok: false, error: 'provider_name and share_name are required for a Delta-Sharing catalog' }, { status: 400 });
  }
  try {
    const catalog = await createUcCatalog({
      name,
      comment: body?.comment ? String(body.comment) : undefined,
      storage_root: body?.storage_root ? String(body.storage_root) : undefined,
      properties: toStringMap(body?.properties),
      catalog_type: catalogType ? (catalogType as any) : undefined,
      connection_name: body?.connection_name ? String(body.connection_name) : undefined,
      options: toStringMap(body?.options),
      provider_name: body?.provider_name ? String(body.provider_name) : undefined,
      share_name: body?.share_name ? String(body.share_name) : undefined,
    });
    return NextResponse.json({ ok: true, catalog });
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
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const owner = body?.owner !== undefined ? String(body.owner).trim() : undefined;
  const comment = body?.comment !== undefined ? String(body.comment) : undefined;
  if (owner === undefined && comment === undefined) {
    return NextResponse.json({ ok: false, error: 'provide owner and/or comment to update' }, { status: 400 });
  }
  try {
    const catalog = await patchUcCatalog(name, { owner, comment });
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
