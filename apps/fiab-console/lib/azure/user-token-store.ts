/**
 * User ARM-token store — caches the signed-in user's Azure Resource Manager
 * (audience https://management.azure.com) access token so BFF routes can query
 * Azure with the USER's RBAC (e.g. Azure Resource Graph across every
 * subscription the user can see), instead of the single-subscription Loom UAMI.
 *
 * SECURITY:
 *   - The token is encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - It is NEVER returned to the browser; only server-side routes call
 *     getUserArmToken() and use it for an outbound ARM fetch.
 *   - It is NEVER logged.
 *
 * STORAGE: one doc per user in the Cosmos `tenant-settings` container
 * (partition key /tenantId), id `usertoken:<oid>`, partition = oid. Reuses the
 * existing container to avoid provisioning a new one (same pattern as
 * app/api/admin/domains/route.ts).
 *
 * EXPIRY: ARM access tokens live ~60–90 min. We store the expiry and treat the
 * token as missing once it's within a 60s safety margin of expiring, so callers
 * transparently fall through to the UAMI credential ladder.
 *
 * BEST-EFFORT: every function swallows its own errors and degrades to
 * "no cached token" rather than throwing — the caller MUST keep working
 * (login, resource listing) when this store is unavailable.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';

const SAFETY_MARGIN_MS = 60_000;

interface UserTokenDoc {
  id: string;            // usertoken:<oid>
  tenantId: string;      // == oid (partition key)
  kind: 'usertoken';
  enc: string;           // AES-256-GCM(base64url) of the raw ARM access token
  expiresOn: number;     // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(oid: string): string {
  return `usertoken:${oid}`;
}

/**
 * Persist the user's ARM access token (encrypted) for later server-side use.
 * Best-effort: returns false instead of throwing on any failure so the caller
 * (the auth callback) can proceed with login regardless.
 */
export async function saveUserToken(
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
    const doc: UserTokenDoc = {
      id: docId(oid),
      tenantId: oid,
      kind: 'usertoken',
      enc: encryptAtRest(token),
      expiresOn: expMs,
      updatedAt: new Date().toISOString(),
    };
    await c.items.upsert(doc);
    return true;
  } catch {
    // Never surface — login must not break on a cache write failure.
    return false;
  }
}

/**
 * Return a still-valid cached ARM access token for the user, or null if there
 * is no token, it's expired (within the safety margin), or anything goes wrong.
 * The raw token is decrypted only here, server-side, and handed straight to an
 * outbound ARM fetch by the caller.
 */
export async function getUserArmToken(oid: string): Promise<string | null> {
  if (!oid) return null;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(docId(oid), oid).read<UserTokenDoc>();
    if (!resource || resource.kind !== 'usertoken') return null;
    if (!resource.expiresOn || resource.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(resource.enc);
    return tok || null;
  } catch {
    return null;
  }
}
