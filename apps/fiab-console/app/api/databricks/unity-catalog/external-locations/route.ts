/**
 * Unity Catalog EXTERNAL LOCATIONS — wave c2.
 *
 *   GET    /api/databricks/unity-catalog/external-locations   → { ok, externalLocations[] }
 *   POST   /api/databricks/unity-catalog/external-locations   → create
 *            body { name, url, credential_name, comment?, read_only?, skip_validation? }
 *   PATCH  /api/databricks/unity-catalog/external-locations   → update
 *            body { name, url?, credential_name?, comment?, read_only?, new_name? }
 *   DELETE /api/databricks/unity-catalog/external-locations?name=&force=  → drop
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST   /api/2.1/unity-catalog/external-locations
 *   PATCH/DELETE /api/2.1/unity-catalog/external-locations/{name}
 *   Learn: https://learn.microsoft.com/azure/databricks/connect/unity-catalog/cloud-storage
 *
 * The Console UAMI needs CREATE EXTERNAL LOCATION on the metastore + the storage
 * credential (UC 403s are surfaced verbatim). Honest gate when Databricks is not
 * configured, and at the GCC-High / DoD boundary (UC requires an Entra-connected
 * metastore — Gov falls back to Hive, which has no external locations).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listExternalLocations, createExternalLocation, updateExternalLocation, deleteExternalLocation,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
        `Unity Catalog external locations are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore).`,
    };
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });
  try {
    const host = await primaryWorkspaceHost();
    const externalLocations = await listExternalLocations(host);
    return NextResponse.json({ ok: true, externalLocations });
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
  const name = String(body?.name || '').trim();
  const url = String(body?.url || '').trim();
  const credentialName = String(body?.credential_name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!url) return NextResponse.json({ ok: false, error: 'url is required (abfss://…)' }, { status: 400 });
  if (!credentialName) return NextResponse.json({ ok: false, error: 'credential_name is required' }, { status: 400 });
  try {
    const host = await primaryWorkspaceHost();
    const externalLocation = await createExternalLocation(host, {
      name, url, credential_name: credentialName,
      comment: body?.comment ? String(body.comment) : undefined,
      read_only: body?.read_only === true,
      skip_validation: body?.skip_validation === true,
    });
    return NextResponse.json({ ok: true, externalLocation });
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
  const name = String(body?.name || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  const patch: { url?: string; credential_name?: string; comment?: string; read_only?: boolean; new_name?: string } = {};
  if (body?.url !== undefined) patch.url = String(body.url).trim();
  if (body?.credential_name !== undefined) patch.credential_name = String(body.credential_name).trim();
  if (body?.comment !== undefined) patch.comment = String(body.comment);
  if (body?.read_only !== undefined) patch.read_only = body.read_only === true;
  if (body?.new_name !== undefined) patch.new_name = String(body.new_name).trim();
  if (!Object.keys(patch).length) return NextResponse.json({ ok: false, error: 'provide at least one field to update' }, { status: 400 });
  try {
    const host = await primaryWorkspaceHost();
    const externalLocation = await updateExternalLocation(host, name, patch);
    return NextResponse.json({ ok: true, externalLocation });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });
  const name = req.nextUrl.searchParams.get('name')?.trim();
  const force = req.nextUrl.searchParams.get('force') === 'true';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  try {
    const host = await primaryWorkspaceHost();
    await deleteExternalLocation(host, name, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
