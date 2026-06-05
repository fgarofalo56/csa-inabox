/**
 * Unity Catalog WRITE — grants (permissions on a securable).
 *
 *   GET   /api/databricks/unity-catalog/grants?securable_type=SCHEMA&full_name=main.sales[&effective=true]
 *           → { ok, grants: [{ principal, privileges }] }
 *   PATCH /api/databricks/unity-catalog/grants
 *           body { securable_type, full_name, changes: [{ principal, add?, remove? }] }
 *           → { ok, grants }
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET   /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 *   GET   /api/2.1/unity-catalog/effective-permissions/{securable_type}/{full_name}
 *   PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/
 *
 * Console UAMI must be the object owner / metastore admin / have MANAGE on the
 * securable (else UC 403s, surfaced verbatim).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate,
  getUcPermissions, getUcEffectivePermissions, updateUcPermissions,
  type UcPermissionsChange,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURABLES = new Set([
  'CATALOG', 'SCHEMA', 'TABLE', 'VOLUME', 'FUNCTION',
  'EXTERNAL_LOCATION', 'STORAGE_CREDENTIAL', 'METASTORE',
]);

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
  const securableType = (req.nextUrl.searchParams.get('securable_type') || '').toUpperCase().trim();
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  const effective = req.nextUrl.searchParams.get('effective') === 'true';
  if (!SECURABLES.has(securableType)) {
    return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  }
  if (!fullName && securableType !== 'METASTORE') {
    return NextResponse.json({ ok: false, error: 'full_name is required' }, { status: 400 });
  }
  try {
    if (effective) {
      const grants = await getUcEffectivePermissions(securableType, fullName || '');
      return NextResponse.json({ ok: true, effective: true, grants });
    }
    const grants = await getUcPermissions(securableType, fullName || '');
    return NextResponse.json({ ok: true, grants });
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
  const securableType = String(body?.securable_type || '').toUpperCase().trim();
  const fullName = String(body?.full_name || '').trim();
  const rawChanges = Array.isArray(body?.changes) ? body.changes : [];
  if (!SECURABLES.has(securableType)) {
    return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  }
  if (!fullName && securableType !== 'METASTORE') {
    return NextResponse.json({ ok: false, error: 'full_name is required' }, { status: 400 });
  }
  if (rawChanges.length === 0) {
    return NextResponse.json({ ok: false, error: 'changes[] is required' }, { status: 400 });
  }
  const changes: UcPermissionsChange[] = rawChanges
    .map((c: any) => ({
      principal: String(c?.principal || '').trim(),
      add: Array.isArray(c?.add) ? c.add.map((p: any) => String(p).toUpperCase().trim()).filter(Boolean) : undefined,
      remove: Array.isArray(c?.remove) ? c.remove.map((p: any) => String(p).toUpperCase().trim()).filter(Boolean) : undefined,
    }))
    .filter((c: UcPermissionsChange) => c.principal && ((c.add?.length ?? 0) > 0 || (c.remove?.length ?? 0) > 0));
  if (changes.length === 0) {
    return NextResponse.json({ ok: false, error: 'each change needs a principal and at least one add/remove privilege' }, { status: 400 });
  }
  try {
    const grants = await updateUcPermissions(securableType, fullName, changes);
    return NextResponse.json({ ok: true, grants });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
