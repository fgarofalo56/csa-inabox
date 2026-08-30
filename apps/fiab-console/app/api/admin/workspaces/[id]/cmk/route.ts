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
 *
 * #3757 — AND SO DOES A 404 ON THE BACKING STORAGE ACCOUNT. That promise used
 * to cover 403 ONLY. On the live Commercial estate every workspace without its
 * own `storageAccountId` resolves the deployment default out of
 * `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`; when that name no longer exists ARM
 * answers 404 and the raw string
 *     "The Resource 'Microsoft.Storage/storageAccounts/sa…' under resource
 *      group 'rg-…' was not found. For more details please go to
 *      https://aka.ms/ARMResourceNotFoundFix"
 * fell straight through `err()` into the pane's generic error MessageBar — an
 * internal Azure message, with a developer doc link, shown to a workspace
 * admin. Since "no bound account" is the DEFAULT state, that made the whole
 * Encryption tab non-functional across most of the estate.
 *
 * The 404 is now classified at the exact call that produced it (the ARM GET /
 * PATCH on THAT storage account id — no substring sniffing of the message) and
 * returned as the same `{ok:false, gate:true, …}` shape the role gates use.
 * Per deploy-integrity.md R7 the hint states only what was established: the
 * account Loom resolved, where it looked, and that ARM says it is not there.
 * It does NOT claim the account was deleted, nor that the env vars are stale —
 * both produce this identical 404 and this response cannot tell them apart.
 */

import { trimTrailingSlashes } from '@/lib/util/trim';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAdminWorkspace } from '@/lib/auth/workspace-guard';
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
  parseStorageAccountId,
  runCmkRoleChecks,
  vaultResourceId,
  KV_CRYPTO_SVC_ENC_USER_ROLE_ID,
  STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID,
  type StorageAccountRef,
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

/**
 * #3757 — the honest gate for "ARM says the backing storage account is not
 * there". Deliberately NOT keyed to any substring of the ARM message: the
 * caller only ever hands this a 404 raised by an ARM call whose URL was built
 * from `ref` itself, so the subject of the 404 is known by construction. A
 * bare-substring signal is how a Container Apps VNet error once became an RG
 * remediation, and this route already carries one classifier of that shape.
 *
 * `boundToWorkspace` changes ONLY the remediation, never the claim: an
 * explicitly bound account and a deployment-default one fail identically, and
 * the reader needs to know which one Loom was pointed at.
 */
function storageAccountMissingGate(
  ref: StorageAccountRef,
  boundToWorkspace: boolean,
  detail: string,
) {
  const where = `'${ref.accountName}' in resource group '${ref.resourceGroup}'`;
  return NextResponse.json({
    ok: false,
    gate: true,
    code: 'storage_account_not_found',
    title: "This workspace's backing storage account was not found",
    missing: `Storage account ${where}`,
    hint: boundToWorkspace
      ? `This workspace is bound to storage account ${where} (Workspace settings → OneLake), and ARM answers 404 for it. ` +
        'Encryption settings are read from and written to that account, so nothing can be reported until it resolves. ' +
        'Re-bind the workspace to a storage account that exists on the OneLake tab, or redeploy the landing zone so the bound account is recreated. ' +
        'This response cannot tell whether the account was deleted or the binding is stale — ARM returns the same 404 for both.'
      : `This workspace has no storage account of its own, so encryption falls back to the deployment default, which resolved to ${where} from ` +
        'LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL / LOOM_LANDING_URL on the console app. ARM answers 404 for that account. ' +
        'Bind this workspace to an existing storage account on the OneLake tab to get a working Encryption tab now; the deployment-wide fix is to redeploy the landing zone so those URLs point at the lake that is actually deployed. ' +
        'This response cannot tell whether the account was deleted or those values are stale — ARM returns the same 404 for both.',
    bicepModule: 'platform/fiab/bicep/modules/landing-zone/main.bicep',
    detail,
  });
}

/**
 * Run an ARM call that targets `ref` and convert its 404 into the honest gate.
 * Anything else re-throws to the handler's existing catch, so 403 → role gate
 * and everything else keeps its current shape.
 */
async function withStorageAccountGate<T>(
  ref: StorageAccountRef,
  boundToWorkspace: boolean,
  run: () => Promise<T>,
): Promise<{ value: T } | { gate: NextResponse }> {
  try {
    return { value: await run() };
  } catch (e: any) {
    if (e instanceof CmkError && e.status === 404) {
      return { gate: storageAccountMissingGate(ref, boundToWorkspace, e.message) };
    }
    throw e;
  }
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

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const resolved = await resolveAdminWorkspace(id);
  if (resolved.resp) return resolved.resp;
  const { ws } = resolved;

  const gate = configGateResponse();
  if (gate) return gate;

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
    const bound = !!parseStorageAccountId(ws.storageAccountId);
    const read = await withStorageAccountGate(ref, bound, () => getStorageCmkStatus(ref));
    if ('gate' in read) return read.gate;
    const status = read.value;
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
  const resolved = await resolveAdminWorkspace(id);
  if (resolved.resp) return resolved.resp;
  const { ws } = resolved;

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

  const uami = encryptionUamiResourceId()!;

  try {
    const ref = resolveStorageAccount(ws.storageAccountId);
    const bound = !!parseStorageAccountId(ws.storageAccountId);
    const applied = await withStorageAccountGate(ref, bound, () =>
      bindStorageCmk({ ref, uamiResourceId: uami, vaultUri, keyName, keyVersion }),
    );
    if ('gate' in applied) return applied.gate;
    const status = applied.value;

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
      const keyUri = `${trimTrailingSlashes(vaultUri)}/keys/${encodeURIComponent(keyName)}`;
      await bindCosmosCmk(cosmosId, keyUri, uami);
      cosmosBound = true;
    }

    // Persist the binding onto the workspace doc.
    const next: Workspace = {
      ...ws,
      cmkBinding: {
        status: 'bound',
        vaultUri: trimTrailingSlashes(vaultUri),
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
  const resolved = await resolveAdminWorkspace(id);
  if (resolved.resp) return resolved.resp;
  const { ws } = resolved;

  const gate = configGateResponse();
  if (gate) return gate;

  try {
    const ref = resolveStorageAccount(ws.storageAccountId);
    const bound = !!parseStorageAccountId(ws.storageAccountId);
    const reverted = await withStorageAccountGate(ref, bound, () => unbindStorageCmk(ref));
    if ('gate' in reverted) return reverted.gate;
    const status = reverted.value;
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
