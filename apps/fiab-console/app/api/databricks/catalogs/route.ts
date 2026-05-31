/**
 * Unity Catalog catalogs (read-only) on the deployment-default Databricks
 * workspace (the Workspace Resources navigator → Unity Catalog group). Lists
 * catalogs — and, when ?catalog= is given, the schemas under it — via the real
 * Databricks Unity Catalog REST (api 2.1).
 *
 *   GET /api/databricks/catalogs                 → { ok, catalogs: [{name, type, comment}] }
 *   GET /api/databricks/catalogs?catalog=main    → { ok, schemas:  [{name, full_name, comment}] }
 *
 * Read-only — UC create/grant lives in the Databricks portal (touches
 * metastore-admin privileges). Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is
 * unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listUcCatalogs, listUcSchemas,
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
  try {
    if (catalog) {
      const schemas = (await listUcSchemas(catalog)).map((sc) => ({
        name: sc.name,
        full_name: sc.full_name,
        comment: sc.comment,
      }));
      return NextResponse.json({ ok: true, catalog, schemas });
    }
    const catalogs = (await listUcCatalogs()).map((c) => ({
      name: c.name,
      type: c.catalog_type,
      comment: c.comment,
      owner: c.owner,
    }));
    return NextResponse.json({ ok: true, catalogs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
