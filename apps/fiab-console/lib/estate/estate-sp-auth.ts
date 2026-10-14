/**
 * ESTATE POWER — authorize the CI deploy service principal (PRP-02 step 3, #4876).
 *
 * Reuses the repo's canonical inbound verifier (`verifyEntraBearer`: RS256
 * signature against the active cloud's JWKS, issuer pinned to the estate tenant
 * on that cloud's authority, audience pinned, exp/nbf, ID tokens refused) and
 * adds only what is specific to this API:
 *   - the token's `tid` must equal the estate tenant (defence in depth over the
 *     issuer pin);
 *   - the token must carry an appid/azp (the audit identity);
 *   - the app role `Estate.Power` must be in `roles`. A delegated `scp` of the
 *     same name does NOT qualify: this route is for an application principal.
 *
 * Fail CLOSED: every missing claim is a refusal. Statuses:
 *   401 the credential is bad (absent, malformed, forged, expired, wrong
 *       audience/issuer/tenant, no caller identity);
 *   403 a VALID credential that lacks the Estate.Power role;
 *   503 the console cannot verify at all (no tenant / no audience pinned).
 *
 * Cloud-agnostic: the authority host comes from `entraAuthorityHost()` (driven by
 * AZURE_CLOUD), never a hard-coded Commercial host.
 */
import { verifyEntraBearer, estateTenantId } from '@/lib/azure/entra-bearer-verify';
import { ESTATE_POWER_ROLE } from './estate-power-contract';
import type { EstateCaller } from './estate-power-handlers';

/**
 * Accepted audiences: `LOOM_ESTATE_POWER_AUDIENCE` (comma/space separated) when
 * set, else this console's own app registration, in both its `api://<id>` (v1
 * token) and bare-GUID (v2 token) forms. The role requirement, not the audience
 * form, is what keeps an ID token or a foreign app out.
 */
export function estatePowerAudiences(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = (env.LOOM_ESTATE_POWER_AUDIENCE || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  const clientId = (env.LOOM_MSAL_CLIENT_ID || '').trim();
  return clientId ? [`api://${clientId}`, clientId] : [];
}

export type EstatePowerAuthResult =
  | { ok: true; caller: EstateCaller; appId: string }
  | { ok: false; status: 401 | 403 | 503; error: string; reason: string; appId?: string; tenantId?: string };

export async function verifyEstatePowerCaller(
  authorizationHeader: string | null | undefined,
): Promise<EstatePowerAuthResult> {
  const verified = await verifyEntraBearer(authorizationHeader, {
    audiences: estatePowerAudiences(),
    // allowIdTokens stays false: an interactive sign-in credential must not work here.
  });
  if (!verified.ok) {
    return { ok: false, status: verified.status, error: verified.error, reason: verified.error };
  }
  const c = verified.claims;
  const estateTenant = estateTenantId().toLowerCase();
  if (!estateTenant || !c.tenantId || c.tenantId.toLowerCase() !== estateTenant) {
    return {
      ok: false, status: 401,
      error: 'token tenant is not the estate tenant',
      reason: 'tid-mismatch',
    };
  }
  if (!c.appId) {
    return {
      ok: false, status: 401,
      error: 'token carries no application id (appid/azp), so the caller cannot be identified',
      reason: 'no-appid',
    };
  }
  if (!c.roles.includes(ESTATE_POWER_ROLE)) {
    return {
      ok: false, status: 403,
      error: `the token is valid but does not carry the ${ESTATE_POWER_ROLE} app role on this API`,
      reason: 'missing-role',
      appId: c.appId,
      tenantId: c.tenantId,
    };
  }
  return {
    ok: true,
    appId: c.appId,
    caller: {
      tenantId: c.tenantId,
      who: `sp:${c.appId}`,
      actorOid: c.objectId || c.appId,
      actorTid: c.tenantId,
      auditExtra: { via: 'service-principal', appId: c.appId },
    },
  };
}
