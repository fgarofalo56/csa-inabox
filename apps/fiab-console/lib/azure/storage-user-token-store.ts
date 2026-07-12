/**
 * User STORAGE-token store (EH-P1-OBO, #1800) — caches the signed-in user's
 * Azure Storage data-plane access token (the `https://storage.azure.com`
 * audience, which is cloud-invariant across Commercial and the sovereign
 * clouds) so ADLS Gen2 data-plane reads can run under the USER's own Azure
 * RBAC/ACLs ("user's identity" data-access mode) instead of the Loom console
 * service identity (UAMI).
 *
 * This is the STORAGE-audience sibling of `user-token-store.ts` (ARM),
 * `sql-user-token-store.ts` (Azure SQL) and `pbi-user-token-store.ts`
 * (Power BI). All live in the same Cosmos `tenant-settings` container to avoid
 * provisioning another container — they differ only by doc id prefix and
 * `kind`. The per-kind resolution (which store serves which backend) lives in
 * `user-pool-registry.ts`, which also performs the MSAL silent-acquire refresh
 * when this cache misses.
 *
 * SECURITY:
 *   - The token is encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - It is NEVER returned to the browser; only server-side data-plane code
 *     (adls-user-client.ts) reads it and hands it straight to the outbound
 *     ADLS Gen2 request.
 *   - It is NEVER logged.
 *
 * STORAGE: one doc per user in the Cosmos `tenant-settings` container
 * (partition key /tenantId), id `storageusertoken:<oid>`, partition = oid
 * (same partition-by-oid trick the ARM / SQL / PBI token stores use).
 *
 * EXPIRY: storage access tokens live ~60–90 min. We store the expiry and treat
 * the token as missing once it's within a 60s safety margin of expiring, so
 * callers refresh (registry silent-acquire) or surface an honest "sign in
 * again / consent the Azure Storage delegated permission" gate rather than
 * failing mid-read.
 *
 * BEST-EFFORT WRITE: saveUserStorageToken swallows its own errors and degrades
 * to "no cached token" rather than throwing — token refresh MUST keep working
 * even when Cosmos is down.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';

const SAFETY_MARGIN_MS = 60_000;

/**
 * The Azure Storage AAD resource. Per Microsoft Learn this audience is the
 * SAME in every cloud (Commercial, GCC-High/DoD, China) — unlike ARM/SQL/PBI
 * there is no sovereign-suffixed variant, so no cloud-endpoints lookup needed.
 */
export const STORAGE_OBO_RESOURCE = 'https://storage.azure.com';

/** Delegated OBO scope for the Azure Storage data plane (`.default` form —
 *  carries the tenant's admin-consented `user_impersonation` permission). */
export function storageOboScope(): string {
  return `${STORAGE_OBO_RESOURCE}/.default`;
}

interface StorageUserTokenDoc {
  id: string; // storageusertoken:<oid>
  tenantId: string; // == oid (partition key)
  kind: 'storageusertoken';
  enc: string; // AES-256-GCM(base64url) of the raw storage access token
  expiresOn: number; // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(oid: string): string {
  return `storageusertoken:${oid}`;
}

/**
 * Persist the user's Azure Storage access token (encrypted) for later
 * server-side use by the ADLS user client. Best-effort: returns false instead
 * of throwing on any failure so the caller (registry refresh / auth flows) can
 * proceed regardless.
 */
export async function saveUserStorageToken(
  oid: string,
  token: string,
  expiresOn: Date | number | null | undefined,
): Promise<boolean> {
  if (!oid || !token) return false;
  try {
    const expMs =
      expiresOn instanceof Date
        ? expiresOn.getTime()
        : typeof expiresOn === 'number'
          ? expiresOn
          : Date.now() + 60 * 60 * 1000; // default 60m if MSAL didn't give one
    const c = await tenantSettingsContainer();
    const doc: StorageUserTokenDoc = {
      id: docId(oid),
      tenantId: oid,
      kind: 'storageusertoken',
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
 * Return a still-valid cached Azure Storage access token for the user, or null
 * if there is no token, it's expired (within the safety margin), or anything
 * goes wrong. The raw token is decrypted only here, server-side, and handed
 * straight to the outbound ADLS Gen2 request by the caller — a null result is
 * the signal for the registry to silent-refresh, then for the honest "sign in
 * again / consent the Azure Storage delegated permission" gate (no-vaporware).
 */
export async function getUserStorageToken(oid: string): Promise<string | null> {
  if (!oid) return null;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(docId(oid), oid).read<StorageUserTokenDoc>();
    if (!resource || resource.kind !== 'storageusertoken') return null;
    if (!resource.expiresOn || resource.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(resource.enc);
    return tok || null;
  } catch {
    return null;
  }
}
