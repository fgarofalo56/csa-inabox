/**
 * Trigger parameter resolver (F4: schedule-time parameter overrides).
 *
 * Resolves per-parameter value bindings supplied in the TriggerWizard into the
 * plain string literals that ADF stores in a trigger's pipeline `parameters`.
 *
 *   direct     — the literal value (or an ADF expression) as typed
 *   keyvault   — GET a secret from LOOM_PARAM_KEYVAULT via the KV REST API
 *   appconfig  — GET a key from LOOM_PARAM_APPCONFIG via the App Config REST API
 *
 * KV/App Config values are read ONCE here (snapshot semantics) — ADF cannot
 * dereference an AzureKeyVaultSecretReference in trigger.parameters, and the
 * @Microsoft.AppConfiguration(...) syntax is an App Service feature, not an ADF
 * one. So Loom resolves server-side at trigger-creation time and writes the
 * resolved literal. The UI surfaces this ("resolved at creation").
 *
 * Auth uses the same UAMI→DefaultAzureCredential chain as every other Loom
 * Azure client. AAD scopes are derived from the configured endpoint so the same
 * code works in Commercial and Gov (vault.azure.net vs vault.usgovcloudapi.net,
 * azconfig.io vs azconfig.azure.us). No mocks — a missing env var or a real KV
 * 403 surfaces verbatim with the right HTTP status (no-vaporware.md).
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { getAppConfigScope } from './cloud-endpoints';

export type ParamSource = 'direct' | 'keyvault' | 'appconfig';

export interface ParamBinding {
  source: ParamSource;
  directValue: string;
  secretName: string;
  configKey: string;
  configLabel: string;
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

const KV_API = '7.4';
const APPCONFIG_API = '2023-11-01';

export class ParamResolveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ParamResolveError';
    this.status = status;
  }
}

/** Derive the Key Vault AAD scope from a vault URI (commercial vs gov). */
function kvScope(vaultUri: string): string {
  return vaultUri.includes('.usgovcloudapi.net')
    ? 'https://vault.usgovcloudapi.net/.default'
    : 'https://vault.azure.net/.default';
}

/**
 * Derive the App Configuration AAD scope from the configured store ENDPOINT
 * (commercial vs gov) — symmetric with `kvScope()` above. Centralised in
 * cloud-endpoints.ts (the only file allowed the azconfig.* literals) so the
 * no-vaporware grep gate stays green and every boundary resolves from one
 * source of truth. Endpoint-derived (not cloud-derived) so a Gov store
 * (`*.azconfig.azure.us`) mints a Gov-audience token even when LOOM_CLOUD is
 * unset/Commercial — otherwise the Commercial-scope token 401s (issue #1531).
 */
function acScope(endpoint: string): string {
  return getAppConfigScope(endpoint);
}

async function token(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new ParamResolveError(`Failed to acquire a token for ${scope}`, 401);
  return t.token;
}

/** GET a secret value from the configured parameter Key Vault. */
async function getParamKvSecretValue(vaultUri: string, secretName: string): Promise<string> {
  const base = vaultUri.replace(/\/$/, '');
  const name = (secretName || '').trim();
  if (!name) throw new ParamResolveError('Key Vault binding is missing a secret name', 400);
  const res = await fetchWithTimeout(`${base}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`, {
    headers: { authorization: `Bearer ${await token(kvScope(base))}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ParamResolveError(
      `Key Vault get-secret '${name}' failed (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const j = await res.json().catch(() => ({}));
  return j?.value ?? '';
}

/** GET a key value from the configured App Configuration store. */
async function getAppConfigValue(endpoint: string, key: string, label?: string): Promise<string> {
  const base = endpoint.replace(/\/$/, '');
  const k = (key || '').trim();
  if (!k) throw new ParamResolveError('App Config binding is missing a key', 400);
  // The App Config REST API treats label as a query param; the "no label"
  // sentinel is %00. A user-supplied label is passed through verbatim.
  const labelQs = label && label.trim() ? `&label=${encodeURIComponent(label.trim())}` : '';
  const res = await fetchWithTimeout(`${base}/kv/${encodeURIComponent(k)}?api-version=${APPCONFIG_API}${labelQs}`, {
    headers: { authorization: `Bearer ${await token(acScope(base))}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ParamResolveError(
      `App Config get-key '${k}' failed (${res.status}): ${body.slice(0, 200)}`,
      res.status,
    );
  }
  const j = await res.json().catch(() => ({}));
  return j?.value ?? '';
}

/**
 * Resolve a map of paramName -> ParamBinding into paramName -> resolved string.
 * `direct` bindings with an empty value are skipped (the pipeline's declared
 * default is used). KV/App Config bindings always resolve (or throw).
 */
export async function resolveParamBindings(
  bindings: Record<string, ParamBinding> | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!bindings) return out;
  for (const [paramName, b] of Object.entries(bindings)) {
    if (!b || !b.source) continue;
    if (b.source === 'direct') {
      // Only override when the operator typed something — otherwise let the
      // pipeline's declared default stand.
      if (b.directValue !== '' && b.directValue != null) out[paramName] = b.directValue;
    } else if (b.source === 'keyvault') {
      const vaultUri = process.env.LOOM_PARAM_KEYVAULT;
      if (!vaultUri) {
        throw new ParamResolveError(
          `Parameter '${paramName}' is bound to Key Vault but LOOM_PARAM_KEYVAULT is not configured. ` +
          'Set LOOM_PARAM_KEYVAULT to the vault URI and grant the Console identity "Key Vault Secrets User" on it.',
          503,
        );
      }
      out[paramName] = await getParamKvSecretValue(vaultUri, b.secretName);
    } else if (b.source === 'appconfig') {
      const endpoint = process.env.LOOM_PARAM_APPCONFIG;
      if (!endpoint) {
        throw new ParamResolveError(
          `Parameter '${paramName}' is bound to App Configuration but LOOM_PARAM_APPCONFIG is not configured. ` +
          'Set LOOM_PARAM_APPCONFIG to the App Configuration endpoint and grant the Console identity "App Configuration Data Reader".',
          503,
        );
      }
      out[paramName] = await getAppConfigValue(endpoint, b.configKey, b.configLabel);
    }
  }
  return out;
}

/** Whether the KV / App Config parameter sources are configured (for UI gates). */
export function paramSourceAvailability(): { kvAvailable: boolean; appConfigAvailable: boolean } {
  return {
    kvAvailable: !!process.env.LOOM_PARAM_KEYVAULT,
    appConfigAvailable: !!process.env.LOOM_PARAM_APPCONFIG,
  };
}
