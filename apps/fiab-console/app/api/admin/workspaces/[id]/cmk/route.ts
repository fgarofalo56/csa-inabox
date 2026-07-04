/**
 * /api/admin/workspaces/[id]/cmk — Customer-Managed Keys (F14).
 *
 * GET    → live CMK status of the workspace's backing storage account + role
 *          checks (KV Crypto Service Encryption User, Storage Account
 *          Contributor). Optional ?vaultUri / ?keyName query params lazily list
 *          the vault's keys / a key's versions for the bind wizard pickers.
 * POST   → bind a customer key: PATCH encryption.keyVaultProperties on the
 *          storage account (real ARM). Optional bindCosmos binds the Cosmos
 *          account too. Persists the binding onto the workspace doc.
 * DELETE → revert the storage account to Microsoft-managed keys.
 *
 * Azure-native (no Fabric/Power BI). A 403 from ARM/KV surfaces as an honest
 * gate naming the exact role + GUID + bicep module — never a raw 5xx.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace } from '@/lib/types/workspace';
import {
  CmkError,
  cmkConfigGate,
  cmkVaultUrl,
  encryptionUamiResourceId,
  getStorageCmkStatus,
  bindStorageCmk,
  unbindStorageCmk,
  bindCosmosCmk,
  listVaultKeys,
  listKeyVersions,
  resolveStorageAccount,
  runCmkRoleChecks,
  vaultResourceId,
  KV_CRYPTO_SVC_ENC_USER_ROLE_ID,
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID,
} from '@/lib/clients/cmk-client';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KV_GATE_HINT =
  `Grant the Console UAMI "Key Vault Crypto Service Encryption User" (${KV_CRYPTO_SVC_ENC_USER_ROLE_ID}) ` +
  'on the Key Vault. Deploy platform/fiab/bicep/modules/admin-plane/keyvault.bicep with consolePrincipalNeedsCmkRole=true.';
const STORAGE_GATE_HINT =
  `Grant the Console UAMI "Storage Account Contributor" (${STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID}) on the ` +
  'storage account. Deploy platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep with consolePrincipalNeedsCmkBind=true.';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/** Map a KV/ARM 403 onto an honest gate payload (HTTP 200, ok:false, gate:true). */
function forbiddenGate(message: string) {
  const lower = message.toLowerCase();
  const isKv = lower.includes('vault') || lower.includes('key');
  return NextResponse.json({
    ok: false,
    gate: true,
    missing: isKv
      ? `Key Vault Crypto Service Encryption User (${KV_CRYPTO_SVC_ENC_USER_ROLE_ID})`
      : `Storage Account Contributor (${STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID})`,
    hint: isKv ? KV_GATE_HINT : STORAGE_GATE_HINT,
    bicepModule: isKv
      ? 'platform/fiab/bicep/modules/admin-plane/keyvault.bicep'
      : 'platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep',
    detail: message,
  });
}

function configGateResponse() {
  const gate = cmkConfigGate();
  if (!gate) return null;
  return NextResponse.json({
    ok: false,
    gate: true,
    missing: gate.missing,
    hint: gate.detail,
    code: 'not_configured',
  });
}

async function loadWorkspace(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  const gate = configGateResponse();
  if (gate) return gate;

  const ws = await loadWorkspace(id, session.claims.oid).catch(() => null);
  if (!ws) return err('Workspace not found', 404, 'not_found');

  // Lazy picker data for the bind wizard.
  const vaultUriParam = req.nextUrl.searchParams.get('vaultUri') || cmkVaultUrl() || undefined;
  const keyNameParam = req.nextUrl.searchParams.get('keyName') || undefined;

  try {
    if (keyNameParam && vaultUriParam) {
      const versions = await listKeyVersions(vaultUriParam, keyNameParam);
      return NextResponse.json({ ok: true, versions });
    }
    if (req.nextUrl.searchParams.get('list') === 'keys' && vaultUriParam) {
      const keys = await listVaultKeys(vaultUriParam);
      return NextResponse.json({ ok: true, keys });
    }

    const ref = resolveStorageAccount(ws.storageAccountId);
    const status = await getStorageCmkStatus(ref);
    const uami = encryptionUamiResourceId()!;
    const roleChecks = await runCmkRoleChecks(ref, uami, vaultResourceId());
    return NextResponse.json({
      ok: true,
      status,
      roleChecks,
      vaultUri: cmkVaultUrl(),
      uamiResourceId: uami,
      cosmosConfigured: !!process.env.LOOM_COSMOS_ACCOUNT_ID,
      binding: ws.cmkBinding ?? null,
    });
  } catch (e: any) {
    if (e instanceof CmkError) {
      if (e.status === 403) return forbiddenGate(e.message);
      return err(e.message, e.status >= 400 && e.status < 600 ? e.status : 502, 'cmk_error');
    }
    return err(e?.message || 'Failed to read CMK status', 502, 'cmk_error');
  }
}

// ---------------------------------------------------------------------------
// POST — bind
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  const gate = configGateResponse();
  if (gate) return gate;

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }

  const keyName = typeof body?.keyName === 'string' ? body.keyName.trim() : '';
  const vaultUri = (typeof body?.vaultUri === 'string' && body.vaultUri.trim()
    ? body.vaultUri.trim()
    : cmkVaultUrl()) as string | null;
  const keyVersion = typeof body?.keyVersion === 'string' ? body.keyVersion.trim() : '';
  const bindCosmos = body?.bindCosmos === true;
  if (!keyName) return err('keyName is required', 400, 'missing_key');
  if (!vaultUri) return err('vaultUri could not be resolved', 400, 'missing_vault');

  const ws = await loadWorkspace(id, session.claims.oid).catch(() => null);
  if (!ws) return err('Workspace not found', 404, 'not_found');

  const uami = encryptionUamiResourceId()!;

  try {
    const ref = resolveStorageAccount(ws.storageAccountId);
    const status = await bindStorageCmk({ ref, uamiResourceId: uami, vaultUri, keyName, keyVersion });

    let cosmosBound = false;
    if (bindCosmos) {
      const cosmosId = process.env.LOOM_COSMOS_ACCOUNT_ID;
      if (!cosmosId) {
        return err(
          'Cosmos CMK requested but LOOM_COSMOS_ACCOUNT_ID is not set on the console app.',
          400,
          'cosmos_not_configured',
        );
      }
      const keyUri = `${vaultUri.replace(/\/+$/, '')}/keys/${encodeURIComponent(keyName)}`;
      await bindCosmosCmk(cosmosId, keyUri, uami);
      cosmosBound = true;
    }

    // Persist the binding onto the workspace doc.
    const next: Workspace = {
      ...ws,
      cmkBinding: {
        status: 'bound',
        vaultUri: vaultUri.replace(/\/+$/, ''),
        keyName,
        keyVersion: keyVersion || '',
        uamiResourceId: uami,
        cosmosBound,
        boundAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    const c = await workspacesContainer();
    await c.item(ws.id, ws.tenantId).replace<Workspace>(next).catch(() => { /* binding still applied to Azure */ });

    return NextResponse.json({ ok: true, status, cosmosBound });
  } catch (e: any) {
    if (e instanceof CmkError) {
      if (e.status === 403) return forbiddenGate(e.message);
      return err(e.message, e.status >= 400 && e.status < 600 ? e.status : 502, 'cmk_error');
    }
    return err(e?.message || 'Failed to bind customer-managed key', 502, 'cmk_error');
  }
}

// ---------------------------------------------------------------------------
// DELETE — revert to Microsoft-managed keys
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');

  const gate = configGateResponse();
  if (gate) return gate;

  const ws = await loadWorkspace(id, session.claims.oid).catch(() => null);
  if (!ws) return err('Workspace not found', 404, 'not_found');

  try {
    const ref = resolveStorageAccount(ws.storageAccountId);
    const status = await unbindStorageCmk(ref);
    const next: Workspace = {
      ...ws,
      cmkBinding: ws.cmkBinding
        ? { ...ws.cmkBinding, status: 'unbound', boundAt: ws.cmkBinding.boundAt }
        : { status: 'unbound' },
      updatedAt: new Date().toISOString(),
    };
    const c = await workspacesContainer();
    await c.item(ws.id, ws.tenantId).replace<Workspace>(next).catch(() => {});
    return NextResponse.json({ ok: true, status });
  } catch (e: any) {
    if (e instanceof CmkError) {
      if (e.status === 403) return forbiddenGate(e.message);
      return err(e.message, e.status >= 400 && e.status < 600 ? e.status : 502, 'cmk_error');
    }
    return err(e?.message || 'Failed to remove customer-managed key', 502, 'cmk_error');
  }
}
