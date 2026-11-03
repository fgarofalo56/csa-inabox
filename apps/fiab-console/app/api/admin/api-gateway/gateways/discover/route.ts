/**
 * API Gateway Plane - brownfield APIM discovery (W1-9, deploy-integrity R5).
 *
 *   GET /api/admin/api-gateway/gateways/discover
 *     -> { ok, data: { candidates, subscriptionsScanned, partial, failures, scannedAt } }
 *
 * Read only: scans the subscriptions the Console identity can read and offers each APIM
 * instance. It registers nothing; the operator registers the chosen candidate through
 * POST /gateways. partial:true means at least one read failed (failures name it with the
 * real ARM status), so an empty list is not proof that nothing exists.
 *
 * Gated by the apiplane-admin capability (tenant admins a superset; Q9, W1-8).
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { actorFromSession } from '@/lib/api-gateway/registry/actor';
import { registryDeps } from '@/lib/api-gateway/registry/deps';
import { discoverGateways } from '@/lib/api-gateway/registry/discovery/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session }) => {
  const deps = registryDeps();
  const data = await discoverGateways(deps, actorFromSession(session).tenantId);
  return NextResponse.json({ ok: true, data });
}));
