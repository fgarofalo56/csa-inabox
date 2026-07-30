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
import {
  databricksConfigGate, listUcCatalogs, createUcCatalog, deleteUcCatalog, patchUcCatalog,
} from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  primaryWorkspaceHost,
  listCatalogs as listCatalogsUc, createCatalog as createCatalogUc,
  updateCatalog as updateCatalogUc, deleteCatalog as deleteCatalogUc,
} from '@/lib/azure/unity-catalog-client';
import { toSafeStringMap } from '@/lib/security/safe-object';
import { withSession } from '@/lib/api/route-toolkit';

const CATALOG_TYPES = new Set(['MANAGED_CATALOG', 'FOREIGN_CATALOG', 'DELTASHARING_CATALOG']);

// Coerce a free-form object into a Record<string,string> (drops empty keys).
// Delegates to the audited `toSafeStringMap`, which builds a NULL-PROTOTYPE
// record (js/remote-property-injection): the keys are caller-supplied, and on an
// object literal `out.__proto__ = 'x'` is silently dropped by the prototype
// setter while `out.toString = 'x'` / `out.valueOf` / `out.hasOwnProperty`
// SHADOW inherited methods — so a later `String(out)` or `out.hasOwnProperty(k)`
// throws "is not a function". `Object.create(null)` has nothing to shadow and no
// `__proto__` accessor, so every key round-trips as plain data. JSON.stringify
// serialises it identically.
const toStringMap = toSafeStringMap;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  // OSS Unity Catalog backend (loom-unity — the Azure-Government default) has
  // no Databricks dependency; the UC client routes to LOOM_UNITY_URL and
  // throws its own structured gate when that is unset.
  if (isOssUc()) return null;
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export const GET = withSession(async (_req, { session }) => {
  const g = gate(); if (g) return g;
  try {
    const catalogs = isOssUc()
      ? await listCatalogsUc(await primaryWorkspaceHost())
      : await listUcCatalogs();
    return NextResponse.json({ ok: true, backend: isOssUc() ? 'oss' : 'databricks', catalogs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

export const POST = withSession(async (req: NextRequest, { session }) => {
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
  if (isOssUc() && catalogType && catalogType !== 'MANAGED_CATALOG') {
    return NextResponse.json({
      ok: false,
      error: 'Foreign and Delta-Sharing catalogs are Databricks Unity Catalog features. The OSS Unity Catalog backend supports standard (managed) catalogs; use Linked Services / Loom Marketplace for federation and sharing.',
    }, { status: 501 });
  }
  try {
    if (isOssUc()) {
      const catalog = await createCatalogUc(await primaryWorkspaceHost(), {
        name,
        comment: body?.comment ? String(body.comment) : undefined,
        storage_root: body?.storage_root ? String(body.storage_root) : undefined,
      });
      return NextResponse.json({ ok: true, catalog });
    }
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
});

export const PATCH = withSession(async (req: NextRequest, { session }) => {
  const g = gate(); if (g) return g;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const owner = body?.owner !== undefined ? String(body.owner).trim() : undefined;
  const comment = body?.comment !== undefined ? String(body.comment) : undefined;
  // Rename (UC `new_name`). Requires the caller to own the catalog AND hold
  // CREATE CATALOG on the metastore + USE CATALOG (Learn: Manage catalogs →
  // Update a catalog). A UC 403 is surfaced verbatim.
  const newName = body?.new_name !== undefined ? String(body.new_name).trim() : undefined;
  if (owner === undefined && comment === undefined && !newName) {
    return NextResponse.json({ ok: false, error: 'provide owner, comment, and/or new_name to update' }, { status: 400 });
  }
  try {
    const catalog = isOssUc()
      ? await updateCatalogUc(await primaryWorkspaceHost(), name, { owner, comment, new_name: newName })
      : await patchUcCatalog(name, { owner, comment, new_name: newName });
    return NextResponse.json({ ok: true, catalog });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

export const DELETE = withSession(async (req: NextRequest) => {
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  const force = req.nextUrl.searchParams.get('force') === 'true';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    if (isOssUc()) await deleteCatalogUc(await primaryWorkspaceHost(), name, force);
    else await deleteUcCatalog(name, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});
