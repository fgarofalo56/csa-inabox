/**
 * Unity Catalog WORKSPACE-CATALOG BINDING (catalog isolation) — wave c3.
 *
 *   GET    /api/databricks/unity-catalog/bindings?securable_type=catalog&securable_name=main
 *            → { ok, bindings:[{workspace_id,binding_type}], isolationMode? }
 *   PATCH  /api/databricks/unity-catalog/bindings
 *            body { securable_type, securable_name, add?:[{workspace_id,binding_type}], remove?:[…] }
 *            → { ok, bindings[] }
 *   POST   /api/databricks/unity-catalog/bindings   (catalog isolation toggle)
 *            body { securable_name, isolation_mode:'OPEN'|'ISOLATED' }  → { ok, catalog }
 *
 * A binding restricts which workspaces can access a securable. It is a real
 * security boundary that SUPERSEDES explicit grants — but only when the catalog
 * is set ISOLATED (OPEN ⇒ any workspace, bindings not enforced). Real UC REST:
 *   GET/PATCH /api/2.1/unity-catalog/bindings/{securable_type}/{name}
 *   PATCH     /api/2.1/unity-catalog/catalogs/{name}  (isolation_mode)
 *   Learn: https://learn.microsoft.com/azure/databricks/data-governance/unity-catalog/access-control/workspace-catalog-binding
 *
 * The Console UAMI must be a metastore admin or the securable owner. Honest gate
 * when Databricks is not configured and at the GCC-High / DoD boundary (UC needs
 * an Entra-connected metastore; Gov falls back to Hive, which has no bindings).
 *
 * CAVEAT: the bindings endpoint is data-plane; the GET/PATCH (add/remove) shape
 * mirrors the documented `workspace-bindings get-bindings / update-bindings` CLI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listWorkspaceBindings, updateWorkspaceBindings, getCatalog, setCatalogIsolationMode,
  type UCBindingSecurableType, type UCWorkspaceBinding,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECURABLES = new Set<UCBindingSecurableType>(['catalog', 'external_location', 'storage_credential', 'credential']);
const BINDING_TYPES = new Set(['BINDING_TYPE_READ_WRITE', 'BINDING_TYPE_READ_ONLY']);
interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog workspace-catalog bindings are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore).`,
    };
  }
  return null;
}

function asSecurableType(v: string): UCBindingSecurableType | null {
  const t = String(v || '').toLowerCase().trim() as UCBindingSecurableType;
  return SECURABLES.has(t) ? t : null;
}

/** Coerce a loose [{workspace_id, binding_type}] array from the request body. */
function asBindings(v: unknown): UCWorkspaceBinding[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((b: any) => {
      const id = Number(b?.workspace_id);
      if (!Number.isFinite(id) || id <= 0) return null;
      const bt = String(b?.binding_type || '').toUpperCase().trim();
      return { workspace_id: Math.trunc(id), binding_type: BINDING_TYPES.has(bt) ? bt : 'BINDING_TYPE_READ_WRITE' } as UCWorkspaceBinding;
    })
    .filter((b): b is UCWorkspaceBinding => !!b);
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const securableType = asSecurableType(req.nextUrl.searchParams.get('securable_type') || 'catalog');
  const securableName = req.nextUrl.searchParams.get('securable_name')?.trim();
  if (!securableType) return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  if (!securableName) return NextResponse.json({ ok: false, error: 'securable_name is required' }, { status: 400 });

  try {
    const host = await primaryWorkspaceHost();
    const bindings = await listWorkspaceBindings(host, securableType, securableName);
    let isolationMode: string | undefined;
    if (securableType === 'catalog') {
      try { isolationMode = (await getCatalog(host, securableName)).isolation_mode; } catch { /* best-effort */ }
    }
    return NextResponse.json({ ok: true, securableType, securableName, bindings, isolationMode });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const securableType = asSecurableType(body?.securable_type || 'catalog');
  const securableName = String(body?.securable_name || '').trim();
  if (!securableType) return NextResponse.json({ ok: false, error: `securable_type must be one of ${[...SECURABLES].join(', ')}` }, { status: 400 });
  if (!securableName) return NextResponse.json({ ok: false, error: 'securable_name is required' }, { status: 400 });
  const add = asBindings(body?.add);
  const remove = asBindings(body?.remove);
  if (!add.length && !remove.length) return NextResponse.json({ ok: false, error: 'provide at least one workspace to add or remove' }, { status: 400 });

  try {
    const host = await primaryWorkspaceHost();
    const bindings = await updateWorkspaceBindings(host, securableType, securableName, { add, remove });
    return NextResponse.json({ ok: true, bindings, changedBy: session.claims.upn });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const securableName = String(body?.securable_name || '').trim();
  const isolationMode = String(body?.isolation_mode || '').toUpperCase().trim();
  if (!securableName) return NextResponse.json({ ok: false, error: 'securable_name is required' }, { status: 400 });
  if (isolationMode !== 'OPEN' && isolationMode !== 'ISOLATED') {
    return NextResponse.json({ ok: false, error: "isolation_mode must be 'OPEN' or 'ISOLATED'" }, { status: 400 });
  }
  try {
    const host = await primaryWorkspaceHost();
    const catalog = await setCatalogIsolationMode(host, securableName, isolationMode);
    return NextResponse.json({ ok: true, catalog, changedBy: session.claims.upn });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
