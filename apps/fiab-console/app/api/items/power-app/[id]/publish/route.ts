/**
 * POST /api/items/power-app/[id]/publish[?envId=&appId=] — publish the latest
 * saved revision of a canvas app (api.powerapps.com publishAppRevision).
 *
 * (envId, appId) resolve from explicit query params (app-picker context) or the
 * persisted item binding (state.envId/appId). Unbound → 412 { code:'unbound' }.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { publishPowerApp, PowerPlatformError } from '@/lib/azure/powerplatform-client';
import { resolvePowerAppBinding, powerAppBindingErrorResponse } from '@/lib/azure/power-app-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  const qEnvId = req.nextUrl.searchParams.get('envId') || undefined;
  const qAppId = req.nextUrl.searchParams.get('appId') || undefined;

  let envId: string;
  let appId: string;
  if (qEnvId && qAppId) {
    envId = qEnvId; appId = qAppId;
  } else {
    try {
      const b = await resolvePowerAppBinding(id, 'power-app', session.claims.oid);
      envId = b.envId; appId = b.appId;
    } catch (e) {
      const { status, body } = powerAppBindingErrorResponse(e);
      return NextResponse.json(body, { status });
    }
  }

  try {
    const res = await publishPowerApp(envId, appId);
    return NextResponse.json({ ok: true, envId, appId, ...res });
  } catch (e: any) {
    const status = e instanceof PowerPlatformError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
      { status },
    );
  }
}
