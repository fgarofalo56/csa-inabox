/**
 * GET  /api/items/power-app/[id]/state  — current binding (envId/appId/appType) from item state.
 * POST /api/items/power-app/[id]/state  — bind: { envId, appId, appType } → persists to item state.
 *
 * This is the resource-binding writer for the `power-app` item (same model as
 * the pipeline binding fix). The editor calls POST after the operator picks an
 * environment + app, so subsequent detail/publish calls resolve the REAL
 * Power Apps app id from state instead of the Loom item GUID.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadPowerAppItem, persistPowerAppBinding, powerAppBindingErrorResponse,
} from '@/lib/azure/power-app-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const item = await loadPowerAppItem(id, 'power-app', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, code: 'not_found', error: 'item not found' }, { status: 404 });
    const state = (item.state || {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      bound: !!(state.envId && state.appId),
      envId: (state.envId as string) || null,
      appId: (state.appId as string) || null,
      appType: (state.appType as string) || null,
    });
  } catch (e) {
    const { status, body } = powerAppBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const envId = typeof body?.envId === 'string' ? body.envId.trim() : '';
  const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
  const appType = typeof body?.appType === 'string' ? body.appType.trim() : undefined;
  if (!envId || !appId) {
    return NextResponse.json({ ok: false, error: 'envId and appId are required to bind' }, { status: 400 });
  }
  try {
    const item = await persistPowerAppBinding(id, 'power-app', session.claims.oid, { envId, appId, appType });
    const state = (item.state || {}) as Record<string, unknown>;
    return NextResponse.json({
      ok: true,
      bound: true,
      envId: state.envId,
      appId: state.appId,
      appType: state.appType || null,
    });
  } catch (e) {
    const { status, body } = powerAppBindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
}
