/**
 * cmk-client — Customer-Managed Keys (F14).
 *
 * Binds a workspace's backing ADLS Gen2 storage account (and, optionally, its
 * Cosmos DB account) to a customer-controlled Key Vault key, so data at rest is
 * encrypted under a key the customer rotates and revokes. Pure Azure-native —
 * Key Vault data plane (list keys/versions) + ARM control plane (PATCH the
 * storage account's `encryption.keyVaultProperties`). NO Microsoft Fabric /
 * Power BI dependency (per no-fabric-dependency.md); the storage account and KV
 * are the same Azure resources the DLZ already deploys.
 *
 * Auth chain (identical to every other Loom Azure client): user-assigned MI via
 * LOOM_UAMI_CLIENT_ID in Container Apps, falling back to DefaultAzureCredential
 * for local dev.
 *
 * Two distinct token audiences are used and they are sovereign-cloud-correct via
 * `cloud-endpoints` (a hard-coded `vault.azure.net` scope 401s in GCC-High/IL5):
 *   - Key Vault data plane : kvScope()  (list keys + versions)
 *   - ARM control plane     : armScope() (storage/cosmos PATCH, role reads)
 *
 * Required roles (a 403 surfaces as an honest gate naming the role + GUID, never
 * a raw 5xx):
 *   - Console UAMI → "Key Vault Crypto Service Encryption User"
 *       (e147488a-f6f5-4113-8e2d-b22465e65bf6) on the Key Vault. This both lets
 *       the BFF list keys (keys/read) AND lets the storage account use the key
 *       as its encryption identity. Granted by admin-plane/keyvault.bicep.
 *   - Console UAMI → "Storage Account Contributor"
 *       (17d1049b-9a84-46fb-8f53-869881c3d3ab) on the storage account, so the
 *       BFF can PATCH encryption.keyVaultProperties. Granted by
 *       landing-zone/storage-lifecycle-rbac.bicep (consolePrincipalNeedsCmkBind).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';
import { armBase, armScope, kvScope } from '@/lib/azure/cloud-endpoints';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

const KV_API = '7.4';
const STORAGE_ARM_API = '2023-05-01';
const COSMOS_ARM_API = '2024-12-01-preview';
const RA_API = '2022-04-01';
const MSI_ARM_API = '2023-01-31';

/** Key Vault Crypto Service Encryption User — built-in, global GUID (all clouds). */
export const KV_CRYPTO_SVC_ENC_USER_ROLE_ID = 'e147488a-f6f5-4113-8e2d-b22465e65bf6';
/** Storage Account Contributor — built-in, global GUID (all clouds). */
export const STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID = '17d1049b-9a84-46fb-8f53-869881c3d3ab';

export class CmkError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CmkError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new CmkError('Failed to acquire an ARM token for CMK operations', 401);
  return t.token;
}

async function kvToken(): Promise<string> {
  // Sovereign-cloud-correct KV data-plane scope (NOT a hard-coded vault.azure.net).
  const t = await credential.getToken(kvScope());
  if (!t?.token) throw new CmkError('Failed to acquire a Key Vault token for CMK operations', 401);
  return t.token;
}

async function armCall<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await armToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `ARM ${res.status}`;
    throw new CmkError(msg, res.status);
  }
  return json as T;
}

async function kvGet<T = any>(url: string): Promise<T> {
  const token = await kvToken();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `Key Vault ${res.status}`;
    throw new CmkError(msg, res.status);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Config gates
// ---------------------------------------------------------------------------

export interface CmkConfigGate {
  missing: string;
  detail: string;
}

/** Resolve the encryption-identity (UAMI) ARM resource id used as the storage
 *  account's CMK identity. Defaults to the Console UAMI. */
export function encryptionUamiResourceId(): string | null {
  return process.env.LOOM_UAMI_RESOURCE_ID || null;
}

/** Resolve the Key Vault base URL (sovereign URI preserved). */
export function cmkVaultUrl(): string | null {
  const uri = process.env.LOOM_KEY_VAULT_URI || process.env.LOOM_KEY_VAULT_URL;
  if (uri) return uri.replace(/\/+$/, '');
  const name = process.env.LOOM_KEY_VAULT_NAME;
  if (name) {
    // Build sovereign-correct host from the KV scope's audience host.
    const host = kvScope().replace(/^https:\/\//, '').replace(/\/\.default$/, '');
    return `https://${name}.${host}`;
  }
  return null;
}

/**
 * Honest-gate the CMK feature. Returns null when every prerequisite env var is
 * present; otherwise the FIRST missing piece (most actionable for the operator).
 */
export function cmkConfigGate(): CmkConfigGate | null {
  if (!cmkVaultUrl()) {
    return {
      missing: 'LOOM_KEY_VAULT_URI',
      detail:
        'No Key Vault configured for customer-managed keys. Set LOOM_KEY_VAULT_URI ' +
        '(or LOOM_KEY_VAULT_NAME) and grant the Console identity the "Key Vault Crypto ' +
        'Service Encryption User" role on that vault.',
    };
  }
  if (!encryptionUamiResourceId()) {
    return {
      missing: 'LOOM_UAMI_RESOURCE_ID',
      detail:
        'The encryption identity is not wired. Set LOOM_UAMI_RESOURCE_ID to the ARM resource id ' +
        'of the user-assigned managed identity the storage account uses to reach the Key Vault key ' +
        '(the Console UAMI — identity.outputs.uamiConsoleId).',
    };
  }
  if (!process.env.LOOM_SUBSCRIPTION_ID || !process.env.LOOM_DLZ_RG) {
    return {
      missing: 'LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG',
      detail:
        'Set LOOM_SUBSCRIPTION_ID and LOOM_DLZ_RG so the BFF can resolve the backing storage ' +
        'account scope for the CMK bind.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Key Vault data plane — list keys + versions
// ---------------------------------------------------------------------------

export interface KvKeyItem {
  name: string;
  kid: string;
  enabled: boolean;
  /** Creation time (unix seconds), when KV reports it. */
  created?: number;
}

export interface KvKeyVersionItem {
  version: string;
  kid: string;
  enabled: boolean;
  created?: number;
}

/** Extract the trailing segment after `/keys/<name>` — the key name. */
function keyNameFromKid(kid: string): string {
  const m = /\/keys\/([^/]+)/.exec(kid || '');
  return m ? m[1] : (kid || '').split('/').pop() || '';
}

/** Extract the version segment from a fully-versioned kid (…/keys/<name>/<version>). */
function versionFromKid(kid: string): string {
  const parts = (kid || '').split('/keys/')[1]?.split('/') || [];
  return parts.length >= 2 ? parts[1] : '';
}

/** List the keys in a vault (newest-created first). Requires keys/read on the vault. */
export async function listVaultKeys(vaultUri: string): Promise<KvKeyItem[]> {
  const base = vaultUri.replace(/\/+$/, '');
  const out: KvKeyItem[] = [];
  let next: string | null = `${base}/keys?api-version=${KV_API}&maxresults=25`;
  // Follow KV's nextLink pagination, capped to avoid unbounded walks.
  let guard = 0;
  while (next && guard < 40) {
    const page: { value?: any[]; nextLink?: string } = await kvGet(next);
    for (const k of page.value || []) {
      const kid = k.kid || '';
      out.push({
        name: keyNameFromKid(kid),
        kid,
        enabled: k.attributes?.enabled !== false,
        created: typeof k.attributes?.created === 'number' ? k.attributes.created : undefined,
      });
    }
    next = page.nextLink || null;
    guard++;
  }
  out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return out;
}

/** List the versions of a key (newest-created first). Requires keys/read on the vault. */
export async function listKeyVersions(vaultUri: string, keyName: string): Promise<KvKeyVersionItem[]> {
  const base = vaultUri.replace(/\/+$/, '');
  const out: KvKeyVersionItem[] = [];
  let next: string | null =
    `${base}/keys/${encodeURIComponent(keyName)}/versions?api-version=${KV_API}&maxresults=25`;
  let guard = 0;
  while (next && guard < 40) {
    const page: { value?: any[]; nextLink?: string } = await kvGet(next);
    for (const v of page.value || []) {
      const kid = v.kid || '';
      out.push({
        version: versionFromKid(kid),
        kid,
        enabled: v.attributes?.enabled !== false,
        created: typeof v.attributes?.created === 'number' ? v.attributes.created : undefined,
      });
    }
    next = page.nextLink || null;
    guard++;
  }
  out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// Storage account ARM — read + bind + unbind CMK
// ---------------------------------------------------------------------------

export interface StorageAccountRef {
  subscriptionId: string;
  resourceGroup: string;
  accountName: string;
}

/** Parse a storage-account ARM id into its parts. Returns null when malformed. */
export function parseStorageAccountId(armId?: string): StorageAccountRef | null {
  if (!armId) return null;
  const accountName = /\/storageAccounts\/([^/]+)/i.exec(armId)?.[1];
  const resourceGroup = /\/resourceGroups\/([^/]+)/i.exec(armId)?.[1];
  const subscriptionId = /\/subscriptions\/([^/]+)/i.exec(armId)?.[1];
  if (!accountName || !resourceGroup || !subscriptionId) return null;
  return { subscriptionId, resourceGroup, accountName };
}

/** Parse the storage account NAME out of a LOOM_*_URL (https://<acct>.dfs|blob…). */
function accountNameFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return /^https:\/\/([^.]+)\./i.exec(url)?.[1];
}

/**
 * Resolve the backing storage account for a workspace. Prefers the workspace's
 * bound `storageAccountId` ARM id; otherwise falls back to the DLZ default
 * (LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG + account parsed from LOOM_{BRONZE,…}_URL).
 */
export function resolveStorageAccount(storageAccountId?: string): StorageAccountRef {
  const fromWorkspace = parseStorageAccountId(storageAccountId);
  if (fromWorkspace) return fromWorkspace;
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  const resourceGroup = process.env.LOOM_DLZ_RG;
  const accountName =
    accountNameFromUrl(process.env.LOOM_BRONZE_URL) ||
    accountNameFromUrl(process.env.LOOM_SILVER_URL) ||
    accountNameFromUrl(process.env.LOOM_GOLD_URL) ||
    accountNameFromUrl(process.env.LOOM_LANDING_URL);
  if (!subscriptionId || !resourceGroup || !accountName) {
    throw new CmkError(
      'Cannot resolve the backing storage account. Bind a storageAccountId to the workspace, or set ' +
        'LOOM_SUBSCRIPTION_ID + LOOM_DLZ_RG + a LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL.',
      400,
    );
  }
  return { subscriptionId, resourceGroup, accountName };
}

function storageAccountArmId(ref: StorageAccountRef): string {
  return `/subscriptions/${ref.subscriptionId}/resourceGroups/${ref.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${ref.accountName}`;
}

export interface StorageCmkStatus {
  keySource: 'Microsoft.Storage' | 'Microsoft.Keyvault';
  /** True when the account is encrypted with a customer key. */
  cmk: boolean;
  vaultUri?: string;
  keyName?: string;
  /** '' (or absent) means auto-rotate to the latest version. */
  keyVersion?: string;
  /** The live, fully-versioned key identifier the account is currently using. */
  currentVersionedKeyIdentifier?: string;
  /** ARM resource id of the user-assigned identity the account uses for CMK. */
  uamiResourceId?: string;
  lastKeyRotationTimestamp?: string;
  accountName: string;
}

/** Read the live CMK encryption state of a storage account. */
export async function getStorageCmkStatus(ref: StorageAccountRef): Promise<StorageCmkStatus> {
  const url = `${armBase()}${storageAccountArmId(ref)}?api-version=${STORAGE_ARM_API}`;
  const acct = await armCall<any>(url);
  const enc = acct?.properties?.encryption || {};
  const kvp = enc.keyvaultproperties || enc.keyVaultProperties || {};
  const keySource: StorageCmkStatus['keySource'] =
    enc.keySource === 'Microsoft.Keyvault' ? 'Microsoft.Keyvault' : 'Microsoft.Storage';
  return {
    keySource,
    cmk: keySource === 'Microsoft.Keyvault',
    vaultUri: (kvp.keyvaulturi || kvp.keyVaultUri || undefined)?.replace(/\/+$/, ''),
    keyName: kvp.keyname || kvp.keyName || undefined,
    keyVersion: kvp.keyversion ?? kvp.keyVersion ?? undefined,
    currentVersionedKeyIdentifier: kvp.currentVersionedKeyIdentifier || undefined,
    lastKeyRotationTimestamp: kvp.lastKeyRotationTimestamp || undefined,
    uamiResourceId: enc.identity?.userAssignedIdentity || undefined,
    accountName: ref.accountName,
  };
}

export interface BindStorageCmkInput {
  ref: StorageAccountRef;
  /** ARM resource id of the UAMI used as the encryption identity. */
  uamiResourceId: string;
  /** Key Vault base URL (no /keys suffix). */
  vaultUri: string;
  keyName: string;
  /** Omit / empty = auto-rotate to the latest version; a hex string pins a version. */
  keyVersion?: string;
}

/**
 * Bind a storage account to a customer key by PATCHing
 * encryption.keyVaultProperties + the user-assigned encryption identity.
 * keyVersion === '' (or undefined) enables automatic key rotation; a non-empty
 * version pins the account to that exact key version.
 */
export async function bindStorageCmk(input: BindStorageCmkInput): Promise<StorageCmkStatus> {
  const { ref, uamiResourceId, vaultUri, keyName } = input;
  const keyVersion = (input.keyVersion || '').trim();
  const url = `${armBase()}${storageAccountArmId(ref)}?api-version=${STORAGE_ARM_API}`;
  const body = {
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: { [uamiResourceId]: {} },
    },
    properties: {
      encryption: {
        keySource: 'Microsoft.Keyvault',
        identity: { userAssignedIdentity: uamiResourceId },
        keyvaultproperties: {
          keyvaulturi: vaultUri.replace(/\/+$/, ''),
          keyname: keyName,
          // Empty string = auto-rotate to latest; a version hex pins it.
          keyversion: keyVersion,
        },
      },
    },
  };
  await armCall(url, { method: 'PATCH', body: JSON.stringify(body) });
  return getStorageCmkStatus(ref);
}

/** Revert a storage account to Microsoft-managed keys (Microsoft.Storage). */
export async function unbindStorageCmk(ref: StorageAccountRef): Promise<StorageCmkStatus> {
  const url = `${armBase()}${storageAccountArmId(ref)}?api-version=${STORAGE_ARM_API}`;
  const body = {
    properties: {
      encryption: {
        keySource: 'Microsoft.Storage',
        identity: null,
        keyvaultproperties: null,
      },
    },
  };
  await armCall(url, { method: 'PATCH', body: JSON.stringify(body) });
  return getStorageCmkStatus(ref);
}

// ---------------------------------------------------------------------------
// Cosmos DB ARM — optional CMK bind (existing account)
// ---------------------------------------------------------------------------

/**
 * Bind a Cosmos DB account to a customer key (PATCH keyVaultKeyUri +
 * defaultIdentity). NOTE: enabling CMK on an existing Cosmos account limits the
 * maximum document-id length to 990 bytes (from 1024) and adds a small read/write
 * overhead — the UI surfaces this advisory before binding.
 *
 * `keyUri` is the FULL key uri including `/keys/<name>` (Cosmos does not pin a
 * version — it auto-rotates).
 */
export async function bindCosmosCmk(
  cosmosAccountArmId: string,
  keyUri: string,
  uamiResourceId: string,
): Promise<void> {
  const url = `${armBase()}${cosmosAccountArmId}?api-version=${COSMOS_ARM_API}`;
  const body = {
    properties: {
      keyVaultKeyUri: keyUri,
      defaultIdentity: `UserAssignedIdentity=${uamiResourceId}`,
    },
  };
  await armCall(url, { method: 'PATCH', body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// RBAC role checks (live ARM reads — not mocks)
// ---------------------------------------------------------------------------

export type RoleCheckResult = 'present' | 'missing' | 'unknown';

/** Resolve a UAMI's principal (object) id from its ARM resource id. */
export async function getUamiPrincipalId(uamiResourceId: string): Promise<string | null> {
  try {
    const url = `${armBase()}${uamiResourceId}?api-version=${MSI_ARM_API}`;
    const j = await armCall<any>(url);
    return j?.properties?.principalId || null;
  } catch {
    return null;
  }
}

/**
 * Check whether `principalId` holds the role `roleGuid` at (or above) `scope`.
 * Returns 'unknown' when the assignment list itself can't be read (so the UI
 * doesn't hard-block — the real bind will still surface a 403 honestly).
 */
export async function checkRoleAtScope(
  scope: string,
  roleGuid: string,
  principalId: string,
): Promise<RoleCheckResult> {
  try {
    const url = `${armBase()}${scope}/providers/Microsoft.Authorization/roleAssignments` +
      `?api-version=${RA_API}&$filter=${encodeURIComponent(`principalId eq '${principalId}'`)}`;
    const res = await armCall<{ value: any[] }>(url);
    const has = (res.value || []).some((r) => {
      const rd = r.properties?.roleDefinitionId || '';
      return rd.split('/').pop()?.toLowerCase() === roleGuid.toLowerCase();
    });
    return has ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}

export interface CmkRoleChecks {
  /** Console UAMI has Key Vault Crypto Service Encryption User on the vault. */
  kvCryptoRole: RoleCheckResult;
  /** Console UAMI has Storage Account Contributor on the storage account. */
  storageContributorRole: RoleCheckResult;
  principalId?: string;
}

/**
 * Run both role checks for the CMK flow. `vaultResourceId` is the ARM id of the
 * Key Vault (used to scope the crypto-role check); when not resolvable the KV
 * check is reported 'unknown'.
 */
export async function runCmkRoleChecks(
  storage: StorageAccountRef,
  uamiResourceId: string,
  vaultResourceId?: string,
): Promise<CmkRoleChecks> {
  const principalId = await getUamiPrincipalId(uamiResourceId);
  if (!principalId) {
    return { kvCryptoRole: 'unknown', storageContributorRole: 'unknown' };
  }
  const storageScope = storageAccountArmId(storage);
  const [storageContributorRole, kvCryptoRole] = await Promise.all([
    checkRoleAtScope(storageScope, STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID, principalId),
    vaultResourceId
      ? checkRoleAtScope(vaultResourceId, KV_CRYPTO_SVC_ENC_USER_ROLE_ID, principalId)
      : Promise.resolve<RoleCheckResult>('unknown'),
  ]);
  return { kvCryptoRole, storageContributorRole, principalId };
}

/** Resolve the Key Vault ARM resource id from LOOM_KEY_VAULT_ID, if set. */
export function vaultResourceId(): string | undefined {
  return process.env.LOOM_KEY_VAULT_ID || undefined;
}
