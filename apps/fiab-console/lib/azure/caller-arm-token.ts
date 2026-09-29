/**
 * Resolve the signed-in caller's own Azure Resource Manager access token, for a
 * BFF action that operates on a CALLER-CHOSEN Azure resource id.
 *
 * WHY: a route that resolves a secret (a Function key, a Logic App SAS callback)
 * from an id the browser supplies runs that privileged ARM call under the
 * CALLER's own Azure RBAC, not the platform identity's. ARM then decides — a
 * caller without rights gets a 403 and nothing is minted.
 *
 * Built on the repo's ONE per-user token seam, `getUserDataPlaneToken('arm')`
 * (`user-pool-registry.ts`): it reads the login-time cache and, when that has
 * aged out, silently refreshes via MSAL using the persisted refresh token — so
 * an interactive user is not gated an hour into their session.
 *
 * There is deliberately NO fallback to the platform identity. When no
 * delegated token can be resolved (never signed in interactively, consent
 * missing, refresh impossible) the caller gets an honest gate. A fallback would
 * reintroduce the platform identity on a caller-chosen resource, which is what
 * this module exists to prevent; `caller-arm-token.test.ts` pins that property.
 */
import { getUserDataPlaneToken, USER_TOKEN_GATE_CODE, userTokenRemediation } from './user-pool-registry';

export interface UserArmAuthz {
  /** The caller's ARM bearer, when one could be resolved. */
  token?: string;
  /** True when no caller token exists — the route must gate. */
  gate: boolean;
}

export async function callerArmToken(oid: string | undefined): Promise<UserArmAuthz> {
  const token = oid ? await getUserDataPlaneToken('arm', { oid }) : null;
  return token ? { token, gate: false } : { gate: true };
}

/**
 * The JSON body a route returns when the caller has no ARM token to act with.
 * `code` is the registry's `NO_USER_ARM_TOKEN`, so a client (and the e2e walk)
 * can tell "no delegated token" apart from every other failure.
 */
export function userArmGateBody(resourceLabel: string) {
  return {
    ok: false as const,
    code: USER_TOKEN_GATE_CODE.arm,
    error: `Azure sign-in required to act on '${resourceLabel}'.`,
    gate: {
      reason: 'This action runs with your own Azure permissions, not the platform identity.',
      remediation: userTokenRemediation('arm'),
    },
  };
}
