/**
 * User KUSTO-token store (EH-P1-OBO, #1800) — caches the signed-in user's
 * Azure Data Explorer (ADX / Kusto) data-plane access token so KQL reads can
 * run under the USER's own ADX RBAC ("user's identity" data-access mode)
 * instead of the Loom console service identity (UAMI).
 *
 * UNLIKE the ARM / SQL / Storage / PBI siblings, the Kusto audience is
 * PER-CLUSTER: the AAD resource is the cluster URI itself
 * (`https://<cluster>.<region>.kusto.windows.net`, or the Gov-suffixed
 * `…kusto.usgovcloudapi.net` — the sovereign form arrives naturally because
 * the configured LOOM_KUSTO_CLUSTER_URI / cloud-endpoints `kustoClusterUri()`
 * already carries the right suffix). Tokens are therefore cached per
 * (clusterKey, oid), not just per oid.
 *
 * SECURITY (identical to the sibling stores):
 *   - The token is encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - It is NEVER returned to the browser; only server-side query code reads
 *     it and hands it straight to the outbound ADX `/v1/rest/*` call.
 *   - It is NEVER logged.
 *
 * STORAGE: one doc per (cluster, user) in the Cosmos `tenant-settings`
 * container (partition key /tenantId), id `kustousertoken:<clusterKey>:<oid>`,
 * partition = oid (same reuse-an-existing-container, partition-by-oid trick
 * the ARM / SQL / PBI / MCP-OBO token stores use).
 *
 * EXPIRY: ADX access tokens live ~60–90 min. We store the expiry and treat the
 * token as missing once it's within a 60s safety margin of expiring, so
 * callers refresh (user-pool-registry silent-acquire) or surface an honest
 * "sign in again / consent the ADX delegated permission" gate rather than
 * failing mid-query.
 *
 * BEST-EFFORT WRITE: saveUserKustoToken swallows its own errors and degrades
 * to "no cached token" rather than throwing.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';

const SAFETY_MARGIN_MS = 60_000;

/**
 * Delegated OBO scope for an ADX cluster: the cluster URI's `.default` form
 * (carries the tenant's admin-consented `user_impersonation` permission on the
 * Azure Data Explorer resource). Sovereign-cloud correct by construction — the
 * cluster URI already carries the Gov/DoD suffix when deployed there.
 */
export function kustoOboScope(clusterUri: string): string {
  return `${(clusterUri || '').trim().replace(/\/+$/, '')}/.default`;
}

/**
 * Normalize a cluster URI into a stable, doc-id-safe key (mirrors
 * mcp-obo-token-store's oboResourceKey derivation so key shapes stay uniform).
 */
export function kustoClusterKey(clusterUri: string): string {
  return (clusterUri || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

interface KustoUserTokenDoc {
  id: string; // kustousertoken:<clusterKey>:<oid>
  tenantId: string; // == oid (partition key)
  kind: 'kustousertoken';
  clusterKey: string;
  enc: string; // AES-256-GCM(base64url) of the raw ADX access token
  expiresOn: number; // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(clusterKey: string, oid: string): string {
  return `kustousertoken:${clusterKey}:${oid}`;
}

/**
 * Persist the user's ADX access token (encrypted) for `clusterUri`, for later
 * server-side use by the KQL query routes. Best-effort: returns false instead
 * of throwing on any failure so the caller (registry refresh) can proceed.
 */
export async function saveUserKustoToken(
  oid: string,
  clusterUri: string,
  token: string,
  expiresOn: Date | number | null | undefined,
): Promise<boolean> {
  if (!oid || !clusterUri || !token) return false;
  const key = kustoClusterKey(clusterUri);
  if (!key) return false;
  try {
    const expMs =
      expiresOn instanceof Date
        ? expiresOn.getTime()
        : typeof expiresOn === 'number'
          ? expiresOn
          : Date.now() + 60 * 60 * 1000; // default 60m if MSAL didn't give one
    const c = await tenantSettingsContainer();
    const doc: KustoUserTokenDoc = {
      id: docId(key, oid),
      tenantId: oid,
      kind: 'kustousertoken',
      clusterKey: key,
      enc: encryptAtRest(token),
      expiresOn: expMs,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
    return true;
  } catch {
    // Never surface — a cache write failure must not break the caller.
    return false;
  }
}

/**
 * Return a still-valid cached ADX access token for the user + cluster, or null
 * if there is no token, it's expired (within the safety margin), or anything
 * goes wrong. The raw token is decrypted only here, server-side, and handed
 * straight to the outbound ADX request (Authorization: Bearer) by the caller —
 * a null result is the signal for the registry to silent-refresh, then for the
 * honest "sign in again / consent the ADX delegated permission" gate.
 */
export async function getUserKustoToken(oid: string, clusterUri: string): Promise<string | null> {
  if (!oid || !clusterUri) return null;
  const key = kustoClusterKey(clusterUri);
  if (!key) return null;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(docId(key, oid), oid).read<KustoUserTokenDoc>();
    if (!resource || resource.kind !== 'kustousertoken') return null;
    if (!resource.expiresOn || resource.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(resource.enc);
    return tok || null;
  } catch {
    return null;
  }
}
