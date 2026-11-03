/**
 * GET /api/admin/api-gateway/runtime -> who administers the API Gateway Plane (Q9, W1-8).
 *   { ok, data: { capability, groups, users, capabilityUsed, remediation } }
 * `groups` are the Entra groups holding apiplane-admin (Settings -> Runtime renders them);
 * `remediation` is non-null only when no group holds it. Gated like every plane admin route.
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { tenantScopeId } from '@/lib/auth/session';
import { PLANE_ADMIN_CAPABILITY, groupHintText, planeAdminHolders, planeCapabilityUsed, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session }) => {
  let holders;
  try {
    holders = await planeAdminHolders(tenantScopeId(session));
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Could not read the capability grants: ${e instanceof Error ? e.message : String(e)}. Cosmos DB is required (LOOM_COSMOS_ENDPOINT).` },
      { status: 503 },
    );
  }
  const groups = holders.filter((h) => h.principalType === 'group');
  return NextResponse.json({
    ok: true,
    data: {
      capability: PLANE_ADMIN_CAPABILITY,
      groups: groups.map((g) => ({ id: g.principalId, displayName: g.displayName, role: g.role })),
      users: holders.filter((h) => h.principalType === 'user').length,
      capabilityUsed: planeCapabilityUsed(session),
      remediation: groups.length === 0 ? groupHintText([]) : null,
    },
  });
}));
