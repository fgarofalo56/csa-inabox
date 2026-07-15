/**
 * Unity Catalog WRITE — grants (permissions on a securable). Backend-aware:
 * the same route serves Databricks Unity Catalog (Commercial default) AND the
 * self-hosted OSS Unity Catalog server (loom-unity, the Azure-Government
 * default) — both implement GET/PATCH /permissions/{securable_type}/{full_name}.
 *
 *   GET   /api/databricks/unity-catalog/grants?securable_type=SCHEMA&full_name=main.sales[&effective=true]
 *           → { ok, grants: [{ principal, privileges }] }
 *   PATCH /api/databricks/unity-catalog/grants
 *           body { securable_type, full_name, changes: [{ principal, add?, remove? }] }
 *           → { ok, grants }
 *
 * Real Unity Catalog REST (api 2.1, both backends):
 *   GET   /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 *   GET   /api/2.1/unity-catalog/effective-permissions/{securable_type}/{full_name}   (Databricks only)
 *   PATCH /api/2.1/unity-catalog/permissions/{securable_type}/{full_name}
 * Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/manage-privileges/
 * OSS spec: github.com/unitycatalog/unitycatalog api/all.yaml (permissions family)
 *
 * Effective (inherited) permissions are Databricks-only; on the OSS backend
 * `effective=true` transparently falls back to the direct grants and flags it
 * (`effective: false`) so the UI can annotate honestly.
 *
 * Console UAMI must be the object owner / metastore admin / have MANAGE on the
 * securable (else UC 403s, surfaced verbatim).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  primaryWorkspaceHost, listPermissions, listEffectivePermissions, updatePermissions,
  type UCSecurableType, type UCPermissionAssignment,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURABLES = new Set<UCSecurableType>([
  'CATALOG', 'SCHEMA', 'TABLE', 'VOLUME', 'FUNCTION', 'REGISTERED_MODEL',
  'EXTERNAL_LOCATION', 'STORAGE_CREDENTIAL', 'METASTORE',
]);

function gate() {
  // On the OSS backend there is no Databricks dependency — the client routes to
  // LOOM_UNITY_URL and throws its own structured gate when that is unset.
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

function grantsOf(p: { privilege_assignments?: UCPermissionAssignment[] }): UCPermissionAssignment[] {
  return (p.privilege_assignments || []).map((a) => ({
    principal: a.principal,
    // Databricks spells privileges USE_CATALOG; OSS UC spells them "USE CATALOG".
    // Normalize to the underscore form the UI uses for both. Effective
    // (inherited) rows arrive as { privilege, inherited_from_type } objects —
    // flatten them with the inheritance annotation the dialog shows.
    privileges: (a.privileges || []).map((v: unknown) => {
      if (typeof v === 'string') return v.toUpperCase().replace(/ /g, '_');
      const o = v as { privilege?: string; inherited_from_type?: string };
      const name = String(o?.privilege || '').toUpperCase().replace(/ /g, '_');
      return o?.inherited_from_type ? `${name} (inherited)` : name;
    }),
  }));
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const securableType = (req.nextUrl.searchParams.get('securable_type') || '').toUpperCase().trim() as UCSecurableType;
  const fullName = req.nextUrl.searchParams.get('full_name')?.trim();
  const effective = req.nextUrl.searchParams.get('effective') === 'true';
  if (!SECURABLES.has(securableType)) {
    return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  }
  if (!fullName && securableType !== 'METASTORE') {
    return NextResponse.json({ ok: false, error: 'full_name is required' }, { status: 400 });
  }
  try {
    const host = await primaryWorkspaceHost();
    if (effective && !isOssUc()) {
      const p = await listEffectivePermissions(host, securableType, fullName || '');
      return NextResponse.json({ ok: true, effective: true, grants: grantsOf(p) });
    }
    const p = await listPermissions(host, securableType, fullName || '');
    return NextResponse.json({
      ok: true,
      effective: false,
      ...(effective && isOssUc()
        ? { note: 'Effective (inherited) permissions are Databricks-only; showing the direct grants from the OSS Unity Catalog backend.' }
        : {}),
      grants: grantsOf(p),
    });
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
  const securableType = String(body?.securable_type || '').toUpperCase().trim() as UCSecurableType;
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
  // The OSS server expects space-separated privilege spellings ("USE CATALOG");
  // Databricks accepts the underscore form. Normalize per backend.
  const oss = isOssUc();
  const norm = (p: any) => {
    const v = String(p).toUpperCase().trim();
    return oss ? v.replace(/_/g, ' ') : v.replace(/ /g, '_');
  };
  const add: UCPermissionAssignment[] = [];
  const remove: UCPermissionAssignment[] = [];
  for (const c of rawChanges) {
    const principal = String(c?.principal || '').trim();
    if (!principal) continue;
    const a = Array.isArray(c?.add) ? c.add.map(norm).filter(Boolean) : [];
    const r = Array.isArray(c?.remove) ? c.remove.map(norm).filter(Boolean) : [];
    if (a.length) add.push({ principal, privileges: a });
    if (r.length) remove.push({ principal, privileges: r });
  }
  if (!add.length && !remove.length) {
    return NextResponse.json({ ok: false, error: 'each change needs a principal and at least one add/remove privilege' }, { status: 400 });
  }
  try {
    const host = await primaryWorkspaceHost();
    const p = await updatePermissions(host, securableType, fullName, { add, remove });
    return NextResponse.json({ ok: true, grants: grantsOf(p) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
