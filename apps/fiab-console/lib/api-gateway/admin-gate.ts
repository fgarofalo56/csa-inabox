/**
 * Scoped administration of the API Gateway Plane (W1-8, decision Q9, 2026-10-29).
 *
 * Every route under app/api/admin/api-gateway/** is wrapped
 *   withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', handler))
 * `withCapability` is the non-discardable gate (tenant admins pass it implicitly, so they
 * are a superset); `withPlaneGroupHint` only REWRITES the refusal so it names the Entra
 * group(s) to join instead of the generic "ask a tenant admin" text. It never grants.
 * The capability is held through an ordinary /admin/permissions grant to an Entra group.
 */
import { NextResponse } from 'next/server';
import { featurePermissionsContainer } from '@/lib/azure/cosmos-client';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { getSession, tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import type { RouteHandler } from '@/lib/api/route-toolkit';

export const PLANE_ADMIN_CAPABILITY = 'apiplane-admin';
export type PlaneCapability = 'apiplane-admin' | 'tenant-admin';

/** The capability that authorised this call, recorded on every audited write (Q9). */
export function planeCapabilityUsed(session: SessionPayload): PlaneCapability {
  return isTenantAdmin(session) ? 'tenant-admin' : PLANE_ADMIN_CAPABILITY;
}

export interface PlaneHolder {
  principalId: string;
  principalType: 'user' | 'group';
  displayName: string;
  role: string;
}

/** Who holds apiplane-admin in this tenant (the grants written at /admin/permissions). */
export async function planeAdminHolders(tenantId: string): Promise<PlaneHolder[]> {
  const c = await featurePermissionsContainer();
  const { resources } = await c.items
    .query<{ principalId: string; principalType: 'user' | 'group'; principalDisplayName?: string; role: string }>(
      {
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.capabilityId = @cap',
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@cap', value: PLANE_ADMIN_CAPABILITY },
        ],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources.map((g) => ({
    principalId: g.principalId,
    principalType: g.principalType,
    displayName: g.principalDisplayName || g.principalId,
    role: g.role,
  }));
}

export function groupHintText(groups: PlaneHolder[]): string {
  if (groups.length > 0) {
    const names = groups.map((g) => `"${g.displayName}"`).join(', ');
    return `Join the Entra group ${names}, which holds the apiplane-admin capability, then sign in again. Tenant admins also have access.`;
  }
  return (
    'No Entra group holds the apiplane-admin capability yet. A tenant admin grants it to a group at ' +
    '/admin/permissions (capability "API Gateway Plane administration", role Admin); then join that group and sign in again. ' +
    'Settings -> Runtime under API Gateway shows the current holders.'
  );
}

/** Rewrites an apiplane-admin 403 so it names the group to join; every other response passes through. */
export function withPlaneGroupHint<P>(gated: RouteHandler<P>): RouteHandler<P> {
  return async (req, ctx) => {
    const res = await gated(req, ctx);
    if (res.status !== 403) return res;
    let body: Record<string, unknown>;
    try {
      body = (await res.clone().json()) as Record<string, unknown>;
    } catch {
      return res;
    }
    if (body.capability !== PLANE_ADMIN_CAPABILITY) return res; // e.g. the device-code refusal keeps its own text
    const session = getSession();
    let groups: PlaneHolder[] = [];
    let lookupFailed = false;
    try {
      if (session) groups = (await planeAdminHolders(tenantScopeId(session))).filter((h) => h.principalType === 'group');
    } catch {
      lookupFailed = true;
    }
    return NextResponse.json(
      {
        ...body,
        groups: groups.map((g) => ({ id: g.principalId, displayName: g.displayName })),
        remediation: lookupFailed
          ? 'Ask a tenant admin which Entra group holds the apiplane-admin capability (/admin/permissions); the holder lookup is unavailable right now.'
          : groupHintText(groups),
      },
      { status: 403 },
    );
  };
}
