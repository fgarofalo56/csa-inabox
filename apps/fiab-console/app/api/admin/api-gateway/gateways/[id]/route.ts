/**
 * API Gateway Plane - remove a registered gateway (W1-2).
 *
 *   DELETE /api/admin/api-gateway/gateways/[id] -> { ok, data: { id } }
 *
 * Deploy-owned gateways refuse removal (they re-register automatically).
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { actorFromSession } from '@/lib/api-gateway/registry/actor';
import { registryDeps } from '@/lib/api-gateway/registry/deps';
import { removeGateway } from '@/lib/api-gateway/registry/gateway-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withPlaneGroupHint<{ id: string }>(withCapability<{ id: string }>(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session, params }) => {
  const r = await removeGateway(registryDeps(), actorFromSession(session), params.id);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json({ ok: true, data: r.data });
}));
