/**
 * API Gateway Plane - trigger an inventory sync of one registered gateway (W1-3).
 *
 *   POST /api/admin/api-gateway/gateways/[id]/sync -> { ok, data: { counts, partialTypes, swept, mcp } }
 *
 * 409 when a sync of the same gateway is already running. Requires the
 * apiplane-admin capability (tenant admins are a superset).
 */
import { NextResponse } from 'next/server';
import '@/lib/api-gateway/observe/register';
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { actorFromSession } from '@/lib/api-gateway/registry/actor';
import { syncDeps } from '@/lib/api-gateway/observe/deps';
import { syncGateway } from '@/lib/api-gateway/observe/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withPlaneGroupHint<{ id: string }>(withCapability<{ id: string }>(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session, params }) => {
  const actor = actorFromSession(session);
  const r = await syncGateway(syncDeps(), actor.tenantId, params.id);
  if (!r.ok) {
    const status = r.status === 'not_found' ? 404 : r.status === 'in_flight' ? 409 : 422;
    return NextResponse.json({ ok: false, error: r.error, code: r.status }, { status });
  }
  return NextResponse.json({ ok: true, data: r });
}));
