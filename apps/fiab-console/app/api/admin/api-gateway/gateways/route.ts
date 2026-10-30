/**
 * API Gateway Plane - gateway registry (W1-2).
 *
 *   GET  /api/admin/api-gateway/gateways  -> { ok, data: { gateways, deployRegistration } }
 *        Auto-registers the deploy-owned gateway (LOOM_APIPLANE_DEPLOY_GATEWAY_ID) on first call.
 *   POST /api/admin/api-gateway/gateways  { resourceId, displayName? } -> { ok, data: gateway }
 *        Runs the access preflight; an unreadable service returns ok:false with the exact
 *        role, scope and az command.
 *
 * Tenant-admin only (W1-8 swaps in the apiplane-admin capability).
 */
import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { actorFromSession } from '@/lib/api-gateway/registry/actor';
import { registryDeps } from '@/lib/api-gateway/registry/deps';
import { ensureDeployGateway, listGateways, registerGateway } from '@/lib/api-gateway/registry/gateway-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (_req, { session }) => {
  const deps = registryDeps();
  const actor = actorFromSession(session);
  const reg = await ensureDeployGateway(deps, actor);
  const gateways = await listGateways(deps, actor.tenantId);
  return NextResponse.json({
    ok: true,
    data: {
      gateways,
      deployRegistration: reg.ok
        ? { ok: true, gatewayId: reg.data?.id ?? null }
        : { ok: false, code: reg.code, error: reg.error },
    },
  });
});

export const POST = withTenantAdmin(async (req, { session }) => {
  let body: { resourceId?: unknown; displayName?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Request body must be JSON.', code: 'invalid_json' }, { status: 400 });
  }
  const r = await registerGateway(registryDeps(), actorFromSession(session), body ?? {});
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error, code: r.code, data: r.data }, { status: r.status });
  }
  return NextResponse.json({ ok: true, data: r.data }, { status: 201 });
});
