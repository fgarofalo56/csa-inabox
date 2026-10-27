/**
 * The `health.tenant-admin` gate - STRICT, not inherited (decision D12).
 *
 * PRPs/active/loom-health-data-services/RISKS-AND-OPEN-DECISIONS.md D12 resolves
 * the Health admin capability as "New `Health Tenant Admin` capability, NOT
 * inherited from Loom Admin" (the rejected alternative is "inherit"). The shared
 * `checkCapability` (lib/auth/feature-gate.ts) returns allow for every Loom
 * tenant admin before it reads any grant, and it also walks the capability's
 * ancestors. Either would make this capability inherited, so health uses this
 * gate instead: ONLY an explicit grant on `health.tenant-admin` itself admits a
 * caller, whatever else they hold.
 *
 * A Loom tenant admin is not locked out of the system: they can grant
 * themselves (or a group) the capability at /admin/permissions. What changes is
 * that the grant is deliberate and auditable rather than implied.
 *
 * Fails closed: a grants-store error denies.
 */
import { NextResponse } from 'next/server';
import { featurePermissionsContainer } from '@/lib/azure/cosmos-client';
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { deviceCodeAdminRefusal, isDeviceCodeSession } from '@/lib/auth/device-code-policy';
import type { FeatureGrant, FeatureRole } from '@/lib/auth/feature-gate';
import { withSession, type RouteHandler } from '@/lib/api/route-toolkit';

type SessionHandler<P> = Parameters<typeof withSession<P>>[0];

export const HEALTH_TENANT_ADMIN = 'health.tenant-admin';

const ROLE_ORDER: Record<FeatureRole, number> = { Reader: 1, Contributor: 2, Admin: 3 };

export interface HealthGateResult { allow: boolean; role?: FeatureRole; reason?: string }

/** True only when the caller (or a group they are in) holds an explicit grant of at least `required` on THIS capability. */
export async function checkHealthTenantAdmin(session: SessionPayload, required: FeatureRole): Promise<HealthGateResult> {
  const principals = [session.claims.oid, ...(session.claims.groups || [])];
  const tenantId = tenantScopeId(session);
  try {
    const c = await featurePermissionsContainer();
    const { resources } = await c.items
      .query<FeatureGrant>({
        // Exactly one capability id: no ancestor chain, so a grant on the parent workload/domain cannot cascade.
        query: `SELECT * FROM c WHERE c.tenantId = @t AND c.capabilityId = @cap AND ARRAY_CONTAINS(@principals, c.principalId)`,
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@cap', value: HEALTH_TENANT_ADMIN },
          { name: '@principals', value: principals },
        ],
      }, { partitionKey: tenantId })
      .fetchAll();
    if (!resources.length) {
      return { allow: false, reason: `No explicit grant of ${HEALTH_TENANT_ADMIN} on principals [${principals.join(', ')}]. Loom tenant administration does not imply it (D12).` };
    }
    let best: FeatureRole | undefined;
    for (const g of resources) {
      // Only an exact capability match counts; re-checked here so a store that ignores the query filter cannot widen access.
      if (g.capabilityId !== HEALTH_TENANT_ADMIN) continue;
      if (ROLE_ORDER[g.role] >= ROLE_ORDER[required] && (!best || ROLE_ORDER[g.role] > ROLE_ORDER[best])) best = g.role;
    }
    if (!best) return { allow: false, reason: `Caller holds ${resources[0]?.role} on ${HEALTH_TENANT_ADMIN}, requires ${required}.` };
    return { allow: true, role: best };
  } catch (e: any) {
    return { allow: false, reason: `feature-gate Cosmos lookup failed: ${e?.message || String(e)}` };
  }
}

/** `NextResponse` 403 when denied, else null. Same envelope fields as `enforceCapability` so clients render it the same way. */
export async function enforceHealthTenantAdmin(session: SessionPayload, required: FeatureRole): Promise<NextResponse | null> {
  if (isDeviceCodeSession(session)) return deviceCodeAdminRefusal();
  const r = await checkHealthTenantAdmin(session, required);
  if (r.allow) return null;
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      capability: HEALTH_TENANT_ADMIN,
      capabilityName: 'Health Tenant Admin',
      requiredRole: required,
      reason: r.reason,
      remediation: `A tenant admin grants your account (or a group you belong to) at least the ${required} role on 'Health Tenant Admin' at /admin/permissions. Loom tenant administration does not include it.`,
    },
    { status: 403 },
  );
}

/** Route wrapper: signed-in session AND an explicit health.tenant-admin grant. */
export function withHealthTenantAdmin<P = Record<string, string>>(required: FeatureRole, handler: SessionHandler<P>): RouteHandler<P> {
  return withSession<P>(async (req, sctx) => {
    const gate = await enforceHealthTenantAdmin(sctx.session, required);
    if (gate) return gate;
    return handler(req, sctx);
  });
}
