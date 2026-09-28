/**
 * Resolve the signed-in caller's own Azure Resource Manager access token, for a
 * BFF action that operates on a CALLER-CHOSEN Azure resource id.
 *
 * WHY: a route that resolves a secret (a Function key, a Logic App SAS callback)
 * from an id the browser supplies must run that privileged ARM call under the
 * CALLER's RBAC, not the Loom UAMI's. The UAMI holds broad rights, so using it
 * here would let any signed-in user have the console mint a secret for any
 * resource the UAMI can see. Acting as the user ties the mint to the user's own
 * permissions: ARM returns 403 when they lack rights, and nothing is minted.
 *
 * There is deliberately NO UAMI fallback. When the user has no cached ARM token
 * the caller returns an honest gate telling them to sign in / re-consent, per
 * `no-vaporware.md` — a fallback to the UAMI would reopen the hole this closes.
 */
import { getUserArmToken } from './user-token-store';

export interface UserArmAuthz {
  /** The caller's ARM bearer, when present and unexpired. */
  token?: string;
  /** True when no usable caller token exists — the caller must gate. */
  gate: boolean;
}

export async function callerArmToken(oid: string | undefined): Promise<UserArmAuthz> {
  const token = oid ? await getUserArmToken(oid) : null;
  return token ? { token, gate: false } : { gate: true };
}

/** The JSON body a route returns when the caller has no ARM token to act with. */
export function userArmGateBody(resourceLabel: string) {
  return {
    ok: false as const,
    error: `Azure sign-in required to act on '${resourceLabel}'.`,
    gate: {
      reason: 'This action runs with your own Azure permissions, not the platform identity.',
      remediation: 'Sign in to Azure (or re-consent the console) so it can act as you on this resource, then retry.',
    },
  };
}
