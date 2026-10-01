/**
 * Key Vault secrets client — write/read/delete over the KV REST API (no
 * @azure/keyvault-secrets dependency), using the same UAMI→DefaultAzureCredential
 * chain every Loom Azure client uses. The data-plane host suffix and AAD scope
 * are sovereign-cloud aware via cloud-endpoints (`kvSuffix()` / `kvScope()` /
 * `kvUrlFromName()`) — Commercial/GCC `vault.azure.net`, GCC-High/IL5/DoD
 * `vault.usgovcloudapi.net`. Hard-coding the Commercial host silently fails KV
 * auth in Gov, so every literal goes through those helpers.
 *
 * Backs Loom **Connections**: when a user supplies a password / connection
 * string / account key / SPN secret for a data source (mirroring, ADF/Synapse
 * linked services, datasets), the secret is stored HERE — never in Cosmos or the
 * UI state. The connection record keeps only the KV secret NAME (`secretRef`).
 *
 * The Console UAMI must have **Key Vault Secrets Officer** (set/delete) on the
 * vault; a 403 surfaces verbatim so the UI shows the exact role to grant
 * (no-vaporware.md). No mocks.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { kvScope, kvUrlFromName } from '@/lib/azure/cloud-endpoints';
import { PagingBudget, PAGE_DEADLINE, isContinuationAllowed } from '@/lib/azure/paging-budget';
import { resolveSameOriginUrl } from '@/lib/util/same-origin-url';
import { assertSecretReadAllowed, type KvSecretPurpose } from '@/lib/azure/kv-secret-purpose';
import { sanitizeSecretName } from '@/lib/azure/kv-secret-name';

export type { KvSecretPurpose } from '@/lib/azure/kv-secret-purpose';
export { KeyVaultSecretPolicyError } from '@/lib/azure/kv-secret-purpose';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

const KV_API = '7.4';

export class KeyVaultError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'KeyVaultError'; this.status = status; }
}

/** Resolve the vault base URL from LOOM_KEY_VAULT_URI / _URL / _NAME. */
export function vaultUrl(): string | null {
  const uri = process.env.LOOM_KEY_VAULT_URI || process.env.LOOM_KEY_VAULT_URL;
  if (uri) return uri.replace(/\/$/, '');
  const name = process.env.LOOM_KEY_VAULT_NAME;
  if (name) return kvUrlFromName(name);
  return null;
}

/**
 * Resolve the vault base URL for SHORTCUT external-source credentials. Operators
 * may isolate shortcut credentials (S3/GCS/SAS/SA-JSON) to a dedicated vault via
 * `LOOM_SHORTCUT_KEYVAULT` (a full https URI or a bare vault name); when unset it
 * falls back to the general Loom vault (`vaultUrl()`). The sovereign suffix is
 * preserved because a full URI is passed through verbatim.
 */
export function shortcutVaultUrl(): string | null {
  const ov = (process.env.LOOM_SHORTCUT_KEYVAULT || '').trim();
  // SAME-ORIGIN-EXEMPT(deploy-config): `ov` is LOOM_SHORTCUT_KEYVAULT, which the
  // deploy sets. It DEFINES the boundary for this vault rather than travelling
  // through it, so there is no second origin to compare against — a check here
  // would compare the endpoint with itself. Nothing a response body or header
  // returns can reach this value.
  if (ov) return /^https?:\/\//i.test(ov) ? ov.replace(/\/$/, '') : kvUrlFromName(ov);
  return vaultUrl();
}

/** Honest-gate for the shortcut credential vault. Names LOOM_SHORTCUT_KEYVAULT. */
export function shortcutKeyVaultConfigGate(): { missing: string; detail: string } | null {
  if (!shortcutVaultUrl()) {
    return {
      missing: 'LOOM_SHORTCUT_KEYVAULT',
      detail:
        'No Key Vault configured for shortcut external-source credentials. Set LOOM_SHORTCUT_KEYVAULT ' +
        '(or LOOM_KEY_VAULT_URI) and grant the Console identity the "Key Vault Secrets Officer" role on that vault.',
    };
  }
  return null;
}

/**
 * Who a shortcut credential was saved FOR, recorded as Key Vault secret tags at
 * the moment Loom mints it (`putShortcutSecret(name, value, owner)`), and read
 * back by `lib/azure/shortcut-secret-resolver.ts` before the value is read.
 * Tags are metadata: listing a secret's versions returns them without the value.
 */
export interface ShortcutSecretOwnerRecord {
  /** Entra object id of the principal that saved the credential. */
  oid?: string;
  /** UPN of that principal (lower-cased on write). */
  upn?: string;
  /** Entra tenant id of that principal. */
  tid?: string;
  /** The lakehouse key the credential was saved for (registry partition key). */
  lakehouseId?: string;
  /** The lakehouse-shortcut ITEM id the credential was saved for. */
  itemId?: string;
  /** The workspace of that item. */
  workspaceId?: string;
}

/** Tag names used for {@link ShortcutSecretOwnerRecord}. Exported so tests pin the wire shape. */
export const SHORTCUT_OWNER_TAGS = {
  purpose: 'loom-purpose',
  oid: 'loom-owner-oid',
  upn: 'loom-owner-upn',
  tid: 'loom-owner-tid',
  lakehouseId: 'loom-lakehouse',
  itemId: 'loom-item',
  workspaceId: 'loom-workspace',
} as const;

/** Key Vault tag values are limited to 256 characters. */
const KV_TAG_VALUE_MAX = 256;

function ownerTags(owner: ShortcutSecretOwnerRecord): Record<string, string> {
  const tags: Record<string, string> = { [SHORTCUT_OWNER_TAGS.purpose]: 'shortcut-credential' };
  const put = (k: string, v: string | undefined, lower = false) => {
    const s = (v || '').trim();
    if (s) tags[k] = (lower ? s.toLowerCase() : s).slice(0, KV_TAG_VALUE_MAX);
  };
  put(SHORTCUT_OWNER_TAGS.oid, owner.oid, true);
  put(SHORTCUT_OWNER_TAGS.upn, owner.upn, true);
  put(SHORTCUT_OWNER_TAGS.tid, owner.tid, true);
  put(SHORTCUT_OWNER_TAGS.lakehouseId, owner.lakehouseId);
  put(SHORTCUT_OWNER_TAGS.itemId, owner.itemId);
  put(SHORTCUT_OWNER_TAGS.workspaceId, owner.workspaceId);
  return tags;
}

/**
 * PUT a secret into the SHORTCUT vault; returns the secret name actually used.
 * `owner` is recorded as secret tags (see {@link ShortcutSecretOwnerRecord}).
 */
export async function putShortcutSecret(
  name: string,
  value: string,
  owner?: ShortcutSecretOwnerRecord,
): Promise<{ name: string }> {
  const base = shortcutVaultUrl();
  if (!base) throw new KeyVaultError('Shortcut Key Vault not configured (LOOM_SHORTCUT_KEYVAULT)', 503);
  const secretName = sanitizeSecretName(name);
  const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(secretName)}?api-version=${KV_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(owner ? { value, tags: ownerTags(owner) } : { value }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new KeyVaultError(`Key Vault set-secret failed (${res.status}): ${body.slice(0, 300)}`, res.status);
  }
  return { name: secretName };
}

/**
 * The owner record of a SHORTCUT-vault secret, read from its tags WITHOUT
 * reading its value (the versions listing returns attributes and tags only).
 *
 *   { exists: false }                 — no such secret (404)
 *   { exists: true, owner: null }     — the secret carries no owner tags (saved
 *                                       before owners were recorded)
 *   { exists: true, owner: {...} }    — the newest ENABLED version's owner
 *
 * Any other failure throws {@link KeyVaultError}; an unreadable record is never
 * reported as "no record".
 */
export async function getShortcutSecretOwnerRecord(
  name: string,
): Promise<{ exists: boolean; owner: ShortcutSecretOwnerRecord | null }> {
  const base = shortcutVaultUrl();
  if (!base) throw new KeyVaultError('Shortcut Key Vault not configured (LOOM_SHORTCUT_KEYVAULT)', 503);
  let next = `${base}/secrets/${encodeURIComponent(name)}/versions?api-version=${KV_API}&maxresults=25`;
  let newest: { created: number; tags: Record<string, string> } | null = null;
  let sawAny = false;
  for (let page = 0; page < 4 && next; page += 1) {
    const res = await fetchWithTimeout(resolveSameOriginUrl(next, base, 'the Key Vault token'), {
      headers: { authorization: `Bearer ${await token()}` },
      cache: 'no-store',
    });
    if (res.status === 404) return { exists: false, owner: null };
    if (!res.ok) throw new KeyVaultError(`Key Vault list-secret-versions failed (${res.status})`, res.status);
    const j: any = await res.json().catch(() => ({}));
    const versions: any[] = Array.isArray(j?.value) ? j.value : [];
    for (const v of versions) {
      sawAny = true;
      if (v?.attributes?.enabled === false) continue;
      const created = Number(v?.attributes?.created || 0);
      if (!newest || created > newest.created) newest = { created, tags: (v?.tags || {}) as Record<string, string> };
    }
    next = typeof j?.nextLink === 'string' && j.nextLink ? j.nextLink : '';
  }
  if (!sawAny) return { exists: false, owner: null };
  const t = newest?.tags || {};
  const owner: ShortcutSecretOwnerRecord = {
    oid: t[SHORTCUT_OWNER_TAGS.oid] || undefined,
    upn: t[SHORTCUT_OWNER_TAGS.upn] || undefined,
    tid: t[SHORTCUT_OWNER_TAGS.tid] || undefined,
    lakehouseId: t[SHORTCUT_OWNER_TAGS.lakehouseId] || undefined,
    itemId: t[SHORTCUT_OWNER_TAGS.itemId] || undefined,
    workspaceId: t[SHORTCUT_OWNER_TAGS.workspaceId] || undefined,
  };
  return { exists: true, owner: owner.oid || owner.upn ? owner : null };
}

/** Soft-delete a secret from the SHORTCUT vault (best-effort — never throws). */
export async function deleteShortcutSecret(name: string): Promise<void> {
  const base = shortcutVaultUrl();
  if (!base || !name) return;
  await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  }).catch(() => { /* best-effort */ });
}

/**
 * GET the current value of a secret from the SHORTCUT vault.
 *
 * `purpose` is REQUIRED for the same reason it is on {@link getKeyVaultSecretValue}.
 * The ONLY caller is `lib/azure/shortcut-secret-resolver.ts` (for the browse tree),
 * which applies the name grammar and the ownership check first;
 * `scripts/ci/check-shortcut-secret-resolver.mjs` fails the build on any other
 * importer. The vault it reads is the MAIN Loom
 * vault in every shipped deployment — `admin-plane/main.bicep` sets
 * LOOM_SHORTCUT_KEYVAULT to the admin-plane vault unless an operator overrides it,
 * and no params file does — so that name-space includes the platform's own
 * credentials. The policy check runs BEFORE the vault URL is resolved and before a
 * token is minted, so a refused name never reaches Key Vault at all.
 */
export async function getShortcutSecretValue(name: string, purpose: KvSecretPurpose): Promise<string> {
  assertSecretReadAllowed(name, purpose);
  const base = shortcutVaultUrl();
  if (!base) throw new KeyVaultError('Shortcut Key Vault not configured (LOOM_SHORTCUT_KEYVAULT)', 503);
  const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new KeyVaultError(`Key Vault get-secret failed (${res.status})`, res.status);
  const j = await res.json();
  return j?.value || '';
}

export function kvSecretsConfigGate(): { missing: string; detail: string } | null {
  if (!vaultUrl()) {
    return {
      missing: 'LOOM_KEY_VAULT_URI',
      detail:
        'No Key Vault configured for Loom connection secrets. Set LOOM_KEY_VAULT_URI (or LOOM_KEY_VAULT_NAME) ' +
        'and grant the Console identity the "Key Vault Secrets Officer" role on that vault.',
    };
  }
  return null;
}

async function token(): Promise<string> {
  const t = await credential.getToken(kvScope());
  if (!t?.token) throw new KeyVaultError('Failed to acquire a Key Vault token', 401);
  return t.token;
}

/** Secret names must be 1-127 chars of [0-9a-zA-Z-]. Defined in the dependency-free kv-secret-name module. */
export { sanitizeSecretName } from '@/lib/azure/kv-secret-name';

/** PUT a secret value; returns the secret name actually used. */
export async function putKeyVaultSecret(name: string, value: string): Promise<{ name: string }> {
  const base = vaultUrl();
  if (!base) throw new KeyVaultError('Key Vault not configured (LOOM_KEY_VAULT_URI)', 503);
  const secretName = sanitizeSecretName(name);
  const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(secretName)}?api-version=${KV_API}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new KeyVaultError(`Key Vault set-secret failed (${res.status}): ${body.slice(0, 300)}`, res.status);
  }
  return { name: secretName };
}

/**
 * GET the current value of a secret.
 *
 * `purpose` is REQUIRED and is not decoration: several callers derive `name`
 * from user-writable item state or a request body, so the purpose decides which
 * secret name-space this read may touch (lib/azure/kv-secret-purpose.ts). It
 * makes Loom's own platform credentials — `loom-msal-client-secret` above all —
 * structurally unreachable from a request-driven path, whatever the caller
 * passes as `name`. A refusal throws KeyVaultSecretPolicyError (403).
 */
export async function getKeyVaultSecretValue(name: string, purpose: KvSecretPurpose): Promise<string> {
  assertSecretReadAllowed(name, purpose);
  const base = vaultUrl();
  if (!base) throw new KeyVaultError('Key Vault not configured (LOOM_KEY_VAULT_URI)', 503);
  const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new KeyVaultError(`Key Vault get-secret failed (${res.status})`, res.status);
  const j = await res.json();
  return j?.value || '';
}

// ---------------------------------------------------------------------------
// Key Vault CERTIFICATES — used by the eventstream MQTT/Kafka mTLS pickers.
// The CA / client certificate objects (PEM, contentType application/x-pem-file)
// live as KV certificate objects; the connector references them by
// {vaultUri, certName} so the secret material never touches Cosmos or the UI.
// The Console UAMI needs the "Key Vault Certificate User" (read) role on the
// vault; a 403 surfaces verbatim so the UI names the exact role to grant.
// ---------------------------------------------------------------------------

export interface KeyVaultCertificateRef {
  /** Bare certificate name (the value referenced by the connector). */
  name: string;
  /** Full https://{vault}.vault.azure.net/certificates/{name} identifier. */
  id: string;
  /** Whether the cert object is enabled. */
  enabled: boolean;
  /** ISO expiry (`exp`) if present, for the picker to flag expiring certs. */
  expires?: string;
}

/**
 * Resolve the vault base URL for eventstream mTLS certificates. Operators may
 * isolate streaming certs to a dedicated vault via `LOOM_EVENTSTREAM_CERT_VAULT`
 * (a full https URI or a bare vault name); when unset it falls back to the
 * general Loom vault. The sovereign suffix is preserved (full URI passed
 * through verbatim) so this works in Gov/secret clouds.
 */
export function certVaultUrl(): string | null {
  const ov = (process.env.LOOM_EVENTSTREAM_CERT_VAULT || '').trim();
  // SAME-ORIGIN-EXEMPT(deploy-config): `ov` is LOOM_EVENTSTREAM_CERT_VAULT, set
  // by the deploy. Same reasoning as shortcutVaultUrl above — this value IS the
  // boundary for this vault, not a candidate that has to be shown inside one.
  if (ov) return /^https?:\/\//i.test(ov) ? ov.replace(/\/$/, '') : kvUrlFromName(ov);
  return vaultUrl();
}

/** Honest-gate for the eventstream cert vault. Names LOOM_EVENTSTREAM_CERT_VAULT. */
export function certVaultConfigGate(): { missing: string; detail: string } | null {
  if (!certVaultUrl()) {
    return {
      missing: 'LOOM_EVENTSTREAM_CERT_VAULT',
      detail:
        'No Key Vault configured for eventstream mTLS certificates. Set LOOM_EVENTSTREAM_CERT_VAULT ' +
        '(or LOOM_KEY_VAULT_URI) and grant the Console identity the "Key Vault Certificate User" role on that vault.',
    };
  }
  return null;
}

/**
 * List certificate objects in the eventstream cert vault. Returns name + full
 * identifier + enabled/expiry so the mTLS cert picker can render real choices.
 * Throws KeyVaultError with the verbatim KV status (e.g. 403 Forbidden) so the
 * UI shows the exact role to grant — no mocks, no empty placeholder list.
 */
export async function listKeyVaultCertificates(): Promise<KeyVaultCertificateRef[]> {
  const base = certVaultUrl();
  if (!base) throw new KeyVaultError('Eventstream cert Key Vault not configured (LOOM_EVENTSTREAM_CERT_VAULT)', 503);
  const out: KeyVaultCertificateRef[] = [];
  // Follow KV paging (`nextLink`) so vaults with many certs return all of them —
  // BOUNDED by a PagingBudget (#2557/#2582). The old `guard < 50` capped pages
  // only; the wall clock is handed to each page's fetch through `runPage`, and a
  // breach INSIDE a fetch truncates (certs already read are kept, so the picker
  // still populates) rather than throwing a KeyVaultError the dialog would show
  // as "no certificates in this vault".
  const budget = new PagingBudget('key-vault certificates');
  let next: string = `${base}/certificates?api-version=${KV_API}`;
  while (budget.claimPage()) {
    // SECURITY (GHSA-4gvx-9p49-p43g): after the first page `next` is an
    // absolute URL read out of a RESPONSE BODY, and a Key Vault data-plane
    // bearer token rides on the request. Pin it to THIS vault's origin and fail
    // closed rather than fetching.
    const res = await budget.runPage(async (timeoutMs) => fetchWithTimeout(resolveSameOriginUrl(next, base, 'the Key Vault token'), {
      headers: { authorization: `Bearer ${await token()}` },
      cache: 'no-store',
    }, timeoutMs));
    if (res === PAGE_DEADLINE) break; // wall clock spent mid-fetch — keep rows
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new KeyVaultError(`Key Vault list-certificates failed (${res.status}): ${body.slice(0, 300)}`, res.status);
    }
    const j: any = await res.json().catch(() => ({}));
    for (const c of (j?.value || [])) {
      const id: string = String(c?.id || '');
      const name = id.split('/').filter(Boolean).pop() || '';
      if (!name) continue;
      out.push({
        name,
        id,
        enabled: c?.attributes?.enabled !== false,
        expires: c?.attributes?.exp ? new Date(c.attributes.exp * 1000).toISOString() : undefined,
      });
    }
    if (typeof j?.nextLink !== 'string' || !j.nextLink) break; // finished cleanly
    if (!isContinuationAllowed(budget.label, j.nextLink, base)) break;
    next = j.nextLink;
  }
  budget.warnIfTruncated(out.length);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Soft-delete a secret (best-effort). */
export async function deleteKeyVaultSecret(name: string): Promise<void> {
  const base = vaultUrl();
  if (!base) return;
  await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  }).catch(() => { /* best-effort */ });
}
