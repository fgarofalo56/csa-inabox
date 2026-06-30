/**
 * Unity Catalog STORAGE CREDENTIALS — wave c2.
 *
 *   GET    /api/databricks/unity-catalog/storage-credentials  → { ok, storageCredentials[] }
 *   POST   /api/databricks/unity-catalog/storage-credentials  → create
 *            body { name, access_connector_id, managed_identity_id?, comment?,
 *                   read_only?, skip_validation? }
 *   PATCH  /api/databricks/unity-catalog/storage-credentials  → update
 *            body { name, comment?, read_only?, new_name? }
 *   DELETE /api/databricks/unity-catalog/storage-credentials?name=&force=  → drop
 *
 * Real Databricks Unity Catalog REST (api 2.1):
 *   GET/POST     /api/2.1/unity-catalog/storage-credentials
 *   PATCH/DELETE /api/2.1/unity-catalog/storage-credentials/{name}
 *   Learn: https://learn.microsoft.com/azure/databricks/connect/unity-catalog/cloud-storage/azure-managed-identities
 *
 * Azure-native path only (no secrets): the credential is an Azure Databricks
 * Access Connector managed identity (access_connector_id [+ managed_identity_id
 * for a user-assigned MI]). No client secret ever crosses this route. Honest
 * gate when Databricks is unconfigured or at the GCC-High / DoD boundary.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost,
  listStorageCredentials, createStorageCredential, updateStorageCredential, deleteStorageCredential,
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
        `Unity Catalog storage credentials are not available at the ${cloudBoundaryLabel()} boundary. ` +
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
    const storageCredentials = await listStorageCredentials(host);
    return NextResponse.json({ ok: true, storageCredentials });
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
  const accessConnectorId = String(body?.access_connector_id || '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  if (!accessConnectorId) {
    return NextResponse.json({ ok: false, error: 'access_connector_id is required (the ARM id of the Azure Databricks Access Connector)' }, { status: 400 });
  }
  const managedIdentityId = String(body?.managed_identity_id || '').trim();
  try {
    const host = await primaryWorkspaceHost();
    const storageCredential = await createStorageCredential(host, {
      name,
      comment: body?.comment ? String(body.comment) : undefined,
      read_only: body?.read_only === true,
      skip_validation: body?.skip_validation === true,
      azure_managed_identity: {
        access_connector_id: accessConnectorId,
        ...(managedIdentityId ? { managed_identity_id: managedIdentityId } : {}),
      },
    });
    return NextResponse.json({ ok: true, storageCredential });
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
  const patch: { comment?: string; read_only?: boolean; new_name?: string } = {};
  if (body?.comment !== undefined) patch.comment = String(body.comment);
  if (body?.read_only !== undefined) patch.read_only = body.read_only === true;
  if (body?.new_name !== undefined) patch.new_name = String(body.new_name).trim();
  if (!Object.keys(patch).length) return NextResponse.json({ ok: false, error: 'provide at least one field to update' }, { status: 400 });
  try {
    const host = await primaryWorkspaceHost();
    const storageCredential = await updateStorageCredential(host, name, patch);
    return NextResponse.json({ ok: true, storageCredential });
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
    await deleteStorageCredential(host, name, force);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
