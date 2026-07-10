/**
 * obo — resolve a per-USER delegated (On-Behalf-Of) access token for a downstream
 * Azure scope, so a BFF route can act with the SIGNED-IN USER'S own RBAC instead
 * of the shared Console UAMI.
 *
 * ## Why (user-passthrough for DLZ create/attach)
 *
 * Deploying a Data Landing Zone must reflect what the CALLER can actually deploy,
 * not what the Loom service principal can. The DLZ deploy pre-flight therefore
 * checks the user's effective ARM permissions under THEIR token; the shared UAMI
 * remains the fallback (and still performs the platform's own ongoing-operations
 * grants at deploy time). This module is the single place that mints that user
 * token.
 *
 * ## How it resolves a token (two proven Loom paths, in order)
 *
 *  1. **Login-captured per-audience store** — at sign-in the auth callback already
 *     captures the user's ARM token (`captureUserArmToken` → `user-token-store`,
 *     encrypted at rest, persisted in Cosmos so it survives across ACA replicas).
 *     For the ARM audience we read that back first — it's the most reliable
 *     cross-replica path and needs no MSAL cache warm-up.
 *  2. **MSAL silent acquire** — resolve the user's account from the shared
 *     confidential-client token cache by `oid` and `acquireTokenSilent` for the
 *     requested scope (the same call `captureUser*`/`acquireUserDelegatedToken`
 *     use). Works for any audience the user consented at login.
 *
 * Returns `null` (never throws) on any miss — scope not consented, no cached
 * account, store/Cosmos unavailable — so every caller degrades HONESTLY to the
 * shared UAMI (no-vaporware: no fake token, ever). The token is never logged and
 * never returned to the browser.
 *
 * NOTE (merge-time unification): a sibling Power BI OBO effort
 * (feat/pbi-obo-passthrough) is introducing this same `getOboToken(session, scope)`
 * shape for the Power BI audience. When both land, the two collapse to this single
 * helper — the PBI capture already lives in the analogous `pbi-user-token-store`,
 * so `getOboToken` just needs its audience branch added here.
 */

import type { SessionPayload } from '@/lib/auth/session';
import { armBase } from '@/lib/azure/cloud-endpoints';

/** Delegated ARM audience (user_impersonation) — matches the auth-callback capture. */
export function armOboScope(): string {
  return `${armBase()}/user_impersonation`;
}

/** Is a scope the ARM (management) audience, in either delegated or .default form? */
function isArmScope(scope: string): boolean {
  const base = armBase().toLowerCase().replace(/\/+$/, '');
  return scope.toLowerCase().startsWith(base);
}

/**
 * Resolve a per-user delegated token for `scope`, or null. See the file header
 * for the resolution order. `session` supplies the user's `oid`; a PAT / token
 * session (no interactive user) always yields null so the caller uses the UAMI.
 */
export async function getOboToken(
  session: Pick<SessionPayload, 'claims' | 'pat'>,
  scope: string,
): Promise<string | null> {
  const oid = session?.claims?.oid;
  if (!oid || session.pat) return null; // non-interactive token → no user OBO

  // 1) Login-captured ARM store (reliable across replicas).
  if (isArmScope(scope)) {
    try {
      const { getUserArmToken } = await import('@/lib/azure/user-token-store');
      const tok = await getUserArmToken(oid);
      if (tok) return tok;
    } catch {
      // fall through to silent acquire
    }
  }

  // 2) MSAL silent acquire against the user's cached account.
  try {
    const { getMsalClient } = await import('@/lib/auth/msal');
    const client = getMsalClient();
    const accounts = await client.getTokenCache().getAllAccounts();
    // The session oid is homeAccountId.split('.')[0] (the same mapping msal.ts uses).
    const account =
      accounts.find((a) => (a.homeAccountId || '').split('.')[0] === oid) ??
      accounts.find((a) => a.localAccountId === oid);
    if (!account) return null;
    const res = await client.acquireTokenSilent({ account, scopes: [scope] });
    return res?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Which identity ultimately produced an ARM token — for honest gate copy. */
export type ArmTokenIdentity = 'user' | 'uami';

export interface ArmTokenResult {
  token: string;
  identity: ArmTokenIdentity;
}

/**
 * Acquire an ARM token, PREFERRING the signed-in user's delegated token
 * (user-passthrough) and falling back to the shared Console UAMI. The DLZ deploy
 * pre-flight uses this so "can this deploy proceed?" reflects the USER's rights;
 * when the user's ARM scope wasn't consented at login it degrades to the UAMI
 * (today's behavior) with `identity:'uami'` so the caller can say which principal
 * it checked. Throws only if BOTH the user path returns null AND the UAMI token
 * acquisition itself fails.
 */
export async function getArmTokenPreferUser(
  session: Pick<SessionPayload, 'claims' | 'pat'>,
): Promise<ArmTokenResult> {
  const userTok = await getOboToken(session, armOboScope());
  if (userTok) return { token: userTok, identity: 'user' };

  const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
  const { armScope } = await import('@/lib/azure/cloud-endpoints');
  const t = await uamiArmCredential().getToken(armScope());
  if (!t?.token) throw new Error('Failed to acquire an ARM token (user OBO unavailable and UAMI token acquisition failed)');
  return { token: t.token, identity: 'uami' };
}
