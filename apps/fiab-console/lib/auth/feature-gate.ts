/**
 * Phase 2 — Fabric-style feature-permission gate.
 *
 * Used by every BFF route + every server-rendered admin page to decide
 * whether the calling user is entitled to the surface they're invoking.
 * The check happens on every request — there is NO client-side cache
 * that could leak past a permission revoke.
 *
 * Algorithm:
 *   1. Resolve the caller's principal set: { user oid } ∪ groups[].
 *   2. Resolve the capability id from the route (editor type / admin
 *      page) + walk its ancestors (workload, domain).
 *   3. Look up any FeatureGrant rows in the tenant's
 *      feature-permissions container that match ANY of the principal ids
 *      and ANY of the capability ancestors.
 *   4. If at least one row has role >= 'Reader', allow.  Otherwise 403.
 *
 * Tenant admins (members of the tenant-bootstrap admin group set via
 * env var LOOM_TENANT_ADMIN_GROUP_ID) bypass the gate — they always
 * have full Admin on every capability so they can configure access
 * out of an empty state.
 *
 * Per .claude/rules/no-vaporware.md — this is real Cosmos lookup; no
 * mocked allow-list.
 */
import { NextResponse } from 'next/server';
import { featurePermissionsContainer } from '@/lib/azure/cosmos-client';
import type { SessionPayload } from './session';
import { ancestorIds, getCapability } from './feature-catalog';

export type FeatureRole = 'Reader' | 'Contributor' | 'Admin';

const ROLE_ORDER: Record<FeatureRole, number> = { Reader: 1, Contributor: 2, Admin: 3 };

export interface FeatureGrant {
  id: string;
  tenantId: string;
  capabilityId: string;
  principalId: string;
  principalType: 'user' | 'group';
  principalDisplayName?: string;
  principalUpn?: string;
  role: FeatureRole;
  grantedBy: string;
  grantedAt: string;
}

export interface GateResult {
  allow: boolean;
  /** Highest matched role; 'Admin' when tenant-admin bypass triggered. */
  role?: FeatureRole;
  /** Which capability id was matched (might be the requested id OR an ancestor). */
  matchedCapability?: string;
  /** Diagnostic — populated when allow===false. */
  reason?: string;
}

function tenantAdminGroupIds(): string[] {
  const raw = process.env.LOOM_TENANT_ADMIN_GROUP_ID || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Tenant admin = caller is in the LOOM_TENANT_ADMIN_GROUP_ID group OR
 * the caller's oid matches LOOM_TENANT_ADMIN_OID (single-user
 * bootstrap). Tenant admins bypass all permission checks. */
export function isTenantAdmin(session: SessionPayload): boolean {
  const adminGroups = tenantAdminGroupIds();
  if (adminGroups.length > 0 && session.claims.groups?.some((g) => adminGroups.includes(g))) return true;
  const bootstrapOid = process.env.LOOM_TENANT_ADMIN_OID;
  if (bootstrapOid && session.claims.oid === bootstrapOid) return true;
  return false;
}

/** Check whether the session is entitled to a capability. */
export async function checkCapability(
  session: SessionPayload,
  capabilityId: string,
  requiredRole: FeatureRole = 'Reader',
): Promise<GateResult> {
  // Tenant admin bypass.
  if (isTenantAdmin(session)) {
    return { allow: true, role: 'Admin', matchedCapability: capabilityId };
  }

  const principalIds = [session.claims.oid, ...(session.claims.groups || [])];
  const capabilityChain = ancestorIds(capabilityId);
  // If the requested capability isn't in our static catalog and has no
  // ancestors, fall back to a single-id lookup.
  const effectiveChain = capabilityChain.length > 0 ? capabilityChain : [capabilityId];

  const tenantId = session.claims.oid; // tenantId == owning user oid in this codebase
  try {
    const c = await featurePermissionsContainer();
    const { resources } = await c.items
      .query<FeatureGrant>({
        query: `SELECT * FROM c WHERE c.tenantId = @t
                AND ARRAY_CONTAINS(@caps, c.capabilityId)
                AND ARRAY_CONTAINS(@principals, c.principalId)`,
        parameters: [
          { name: '@t', value: tenantId },
          { name: '@caps', value: effectiveChain },
          { name: '@principals', value: principalIds },
        ],
      }, { partitionKey: tenantId })
      .fetchAll();

    if (!resources.length) {
      return {
        allow: false,
        reason: `No grant for capability ${capabilityId} on principals [${principalIds.join(', ')}].`,
      };
    }

    // Pick the highest-priority role that satisfies the requirement.
    let best: FeatureGrant | undefined;
    for (const g of resources) {
      if (ROLE_ORDER[g.role] >= ROLE_ORDER[requiredRole]) {
        if (!best || ROLE_ORDER[g.role] > ROLE_ORDER[best.role]) best = g;
      }
    }
    if (!best) {
      return {
        allow: false,
        role: resources[0]?.role,
        reason: `Caller has role ${resources[0]?.role} on ${capabilityId}, requires ${requiredRole}.`,
      };
    }
    return { allow: true, role: best.role, matchedCapability: best.capabilityId };
  } catch (e: any) {
    // Cosmos error — fail closed (return 403) with a structured reason.
    return {
      allow: false,
      reason: `feature-gate Cosmos lookup failed: ${e?.message || String(e)}`,
    };
  }
}

/** Convenience helper for BFF route handlers — call at the top of a
 * route to enforce the capability.  Returns null when allowed (so the
 * handler can proceed), or a NextResponse 403 when blocked. */
export async function enforceCapability(
  session: SessionPayload | null,
  capabilityId: string,
  requiredRole: FeatureRole = 'Reader',
): Promise<NextResponse | null> {
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const r = await checkCapability(session, capabilityId, requiredRole);
  if (r.allow) return null;
  const cap = getCapability(capabilityId);
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      capability: capabilityId,
      capabilityName: cap?.name,
      requiredRole,
      reason: r.reason,
      remediation:
        `Two ways to get access to '${cap?.name || capabilityId}': ` +
        '(1) Bootstrap admin — set LOOM_TENANT_ADMIN_OID to your user OID, or ' +
        'LOOM_TENANT_ADMIN_GROUP_ID to an Entra group you are in (these are deploy ' +
        'params: loomTenantAdminOid / loomTenantAdminGroupId in the bicepparam, wired ' +
        'into the console app env). Members bypass the gate with full Admin. This is ' +
        'how the first admin gets in before any grants exist. ' +
        '(2) Delegated — an existing tenant admin grants your account (or a group you ' +
        `belong to) at least the ${requiredRole} role at /admin/permissions.`,
      bootstrapEnv: { oid: 'LOOM_TENANT_ADMIN_OID', group: 'LOOM_TENANT_ADMIN_GROUP_ID' },
    },
    { status: 403 },
  );
}
