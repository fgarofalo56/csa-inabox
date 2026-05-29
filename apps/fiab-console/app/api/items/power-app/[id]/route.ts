/**
 * GET /api/items/power-app/[id]?envId=<env>&appId=<app> — Power App detail.
 *
 * The `[id]` is the **Loom item GUID** — NOT the Power Apps app id. The 404 bug
 * (#476-class) was passing the item GUID straight to api.powerapps.com.
 *
 * Resolution order for the real (envId, appId):
 *   1. Explicit ?envId & ?appId query params (used by the editor's app-picker
 *      before a binding is saved — lets the detail panel render immediately).
 *   2. Otherwise resolve the persisted binding from the Loom item's state
 *      (state.envId / state.appId / state.appType) via resolvePowerAppBinding.
 *
 * Unbound + no explicit params → 412 { code:'unbound' } so the editor shows its
 * full bind/select surface (no crash, no 404).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPowerApp, getEnvironment, PowerPlatformError } from '@/lib/azure/powerplatform-client';
import { resolvePowerAppBinding, powerAppBindingErrorResponse } from '@/lib/azure/power-app-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ppErr(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const qEnvId = req.nextUrl.searchParams.get('envId') || undefined;
  const qAppId = req.nextUrl.searchParams.get('appId') || undefined;
  const qAppType = req.nextUrl.searchParams.get('appType') || undefined;

  let envId: string;
  let appId: string;
  let appType: string | undefined;
  let bound = false;

  if (qEnvId && qAppId) {
    // Explicit (env, app) — app-picker / pre-bind preview.
    envId = qEnvId; appId = qAppId; appType = qAppType;
  } else {
    // Resolve persisted binding from item state (NOT the raw route id).
    try {
      const b = await resolvePowerAppBinding(id, 'power-app', session.claims.oid);
      envId = b.envId; appId = b.appId; appType = b.appType; bound = true;
    } catch (e) {
      const { status, body } = powerAppBindingErrorResponse(e);
      return NextResponse.json(body, { status });
    }
  }

  try {
    // Model-driven apps embed via the env instance URL; fetch it so the client
    // can build the deep link. Tolerate failure (canvas doesn't need it).
    let instanceUrl: string | undefined;
    if ((appType || '').toLowerCase().includes('modeldriven')) {
      try { instanceUrl = (await getEnvironment(envId)).instanceUrl; } catch { /* optional */ }
    }
    const app = await getPowerApp(envId, appId, { instanceUrl });
    return NextResponse.json({ ok: true, envId, appId, bound, app });
  } catch (e: any) { return ppErr(e); }
}
