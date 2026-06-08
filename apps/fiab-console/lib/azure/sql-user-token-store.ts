/**
 * User SQL-token store — caches the signed-in user's Azure SQL Database
 * (the sovereign-cloud SQL audience) access token so the SQL query BFF routes
 * can connect to Synapse SQL with the USER's own identity ("user's identity"
 * data-access mode, F10) instead of the Loom console service principal/UAMI.
 *
 * This is the SQL-audience sibling of `user-token-store.ts` (which caches the
 * ARM-audience token). Both live in the same Cosmos `tenant-settings` container
 * to avoid provisioning another container — they differ only by doc id prefix
 * and `kind`.
 *
 * SECURITY:
 *   - The token is encrypted AT REST with AES-256-GCM (a key derived from
 *     SESSION_SECRET via a distinct HKDF label — see lib/auth/session.ts).
 *   - It is NEVER returned to the browser; only server-side query routes call
 *     getUserSqlToken() and hand it straight to the TDS connection.
 *   - It is NEVER logged.
 *
 * STORAGE: one doc per user in the Cosmos `tenant-settings` container
 * (partition key /tenantId), id `sqlusertoken:<oid>`, partition = oid (same
 * partition-by-oid trick the ARM token store uses).
 *
 * EXPIRY: SQL access tokens live ~60–90 min. We store the expiry and treat the
 * token as missing once it's within a 60s safety margin of expiring, so callers
 * surface an honest "sign in again" gate rather than failing mid-query.
 *
 * BEST-EFFORT WRITE: saveUserSqlToken swallows its own errors and degrades to
 * "no cached token" rather than throwing — the auth callback MUST keep working
 * (login succeeds) even when the SQL scope wasn't consented or Cosmos is down.
 */
import { tenantSettingsContainer } from './cosmos-client';
import { encryptAtRest, decryptAtRest } from '@/lib/auth/session';

const SAFETY_MARGIN_MS = 60_000;

interface SqlUserTokenDoc {
  id: string; // sqlusertoken:<oid>
  tenantId: string; // == oid (partition key)
  kind: 'sqlusertoken';
  enc: string; // AES-256-GCM(base64url) of the raw SQL access token
  expiresOn: number; // unix ms — when the token itself expires
  updatedAt: string;
}

function docId(oid: string): string {
  return `sqlusertoken:${oid}`;
}

/**
 * Persist the user's Azure SQL access token (encrypted) for later server-side
 * use by the query routes. Best-effort: returns false instead of throwing on
 * any failure so the auth callback can proceed with login regardless.
 */
export async function saveUserSqlToken(
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
    const doc: SqlUserTokenDoc = {
      id: docId(oid),
      tenantId: oid,
      kind: 'sqlusertoken',
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
 * Return a still-valid cached SQL access token for the user, or null if there
 * is no token, it's expired (within the safety margin), or anything goes wrong.
 * The raw token is decrypted only here, server-side, and handed straight to the
 * TDS connection (azure-active-directory-access-token auth) by the caller.
 */
export async function getUserSqlToken(oid: string): Promise<string | null> {
  if (!oid) return null;
  try {
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(docId(oid), oid).read<SqlUserTokenDoc>();
    if (!resource || resource.kind !== 'sqlusertoken') return null;
    if (!resource.expiresOn || resource.expiresOn - SAFETY_MARGIN_MS <= Date.now()) return null;
    const tok = decryptAtRest(resource.enc);
    return tok || null;
  } catch {
    return null;
  }
}
