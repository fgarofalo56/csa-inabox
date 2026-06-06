/**
 * Key Vault secrets client — write/read/delete over the KV REST API (no
 * @azure/keyvault-secrets dependency), using the same UAMI→DefaultAzureCredential
 * chain every Loom Azure client uses. Scope: https://vault.azure.net/.default.
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
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
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
  if (name) return `https://${name}.vault.azure.net`;
  return null;
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
  const t = await credential.getToken('https://vault.azure.net/.default');
  if (!t?.token) throw new KeyVaultError('Failed to acquire a Key Vault token', 401);
  return t.token;
}

/** Secret names must be 1-127 chars of [0-9a-zA-Z-]. */
export function sanitizeSecretName(raw: string): string {
  return (raw || '').replace(/[^0-9a-zA-Z-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 127) || 'loom-secret';
}

/** PUT a secret value; returns the secret name actually used. */
export async function putKeyVaultSecret(name: string, value: string): Promise<{ name: string }> {
  const base = vaultUrl();
  if (!base) throw new KeyVaultError('Key Vault not configured (LOOM_KEY_VAULT_URI)', 503);
  const secretName = sanitizeSecretName(name);
  const res = await fetch(`${base}/secrets/${encodeURIComponent(secretName)}?api-version=${KV_API}`, {
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

/** GET the current value of a secret. */
export async function getKeyVaultSecretValue(name: string): Promise<string> {
  const base = vaultUrl();
  if (!base) throw new KeyVaultError('Key Vault not configured (LOOM_KEY_VAULT_URI)', 503);
  const res = await fetch(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new KeyVaultError(`Key Vault get-secret failed (${res.status})`, res.status);
  const j = await res.json();
  return j?.value || '';
}

/** Soft-delete a secret (best-effort). */
export async function deleteKeyVaultSecret(name: string): Promise<void> {
  const base = vaultUrl();
  if (!base) return;
  await fetch(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${await token()}` },
    cache: 'no-store',
  }).catch(() => { /* best-effort */ });
}
