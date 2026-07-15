/**
 * Unity Catalog FUNCTIONS (UDFs) — backend-aware (Databricks UC + OSS UC).
 *
 *   GET    /api/databricks/unity-catalog/functions?catalog=&schema=   → { ok, functions[] }
 *   GET    /api/databricks/unity-catalog/functions?full_name=c.s.f    → { ok, function }
 *   DELETE /api/databricks/unity-catalog/functions?full_name=c.s.f&force= → drop
 *
 * Real Unity Catalog REST (api 2.1, both backends):
 *   GET    /api/2.1/unity-catalog/functions?catalog_name=&schema_name=
 *   GET    /api/2.1/unity-catalog/functions/{full_name}
 *   DELETE /api/2.1/unity-catalog/functions/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/udf/unity-catalog
 * OSS spec: github.com/unitycatalog/unitycatalog api/all.yaml (functions family)
 *
 * CREATE FUNCTION is a SQL DDL flow (warehouse on Databricks, engine-side on
 * OSS) — creation stays on the SQL surfaces; this route is the catalog-side
 * browse + governance anchor (grants use the FUNCTION securable).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  primaryWorkspaceHost, listFunctionsUc, getFunctionUc, deleteFunctionUc,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const sp = req.nextUrl.searchParams;
  const fullName = sp.get('full_name')?.trim();
  try {
    const host = await primaryWorkspaceHost();
    if (fullName) {
      if (fullName.split('.').length !== 3) {
        return NextResponse.json({ ok: false, error: 'full_name must be catalog.schema.function' }, { status: 400 });
      }
      const fn = await getFunctionUc(host, fullName);
      return NextResponse.json({ ok: true, function: fn });
    }
    const catalog = sp.get('catalog')?.trim();
    const schema = sp.get('schema')?.trim();
    if (!catalog || !schema) {
      return NextResponse.json({ ok: false, error: 'catalog and schema are required (or full_name for a single function)' }, { status: 400 });
    }
    const functions = await listFunctionsUc(host, catalog, schema);
    return NextResponse.json({ ok: true, backend: isOssUc() ? 'oss' : 'databricks', functions });
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
  if (!fullName || fullName.split('.').length !== 3) {
    return NextResponse.json({ ok: false, error: 'full_name (catalog.schema.function) is required' }, { status: 400 });
  }
  try {
    const host = await primaryWorkspaceHost();
    await deleteFunctionUc(host, fullName, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
