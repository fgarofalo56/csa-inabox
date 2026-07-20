/**
 * POST /api/items/model-serving-endpoint/[id]/traffic
 *   body { endpoint: string, traffic: { <deployment>: <pct> } }
 * Sets the blue/green traffic split on a serving endpoint. Real ARM PUT (AML) /
 * update-config PUT (Databricks). Percentages must total 100 (validated).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { setServingTraffic, ServingError } from '@/lib/azure/model-serving-client';
import { resolveServingItem, servingItemErrorResponse } from '@/lib/azure/model-serving-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveServingItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = servingItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const endpoint = String(body?.endpoint || '').trim();
  const traffic = body?.traffic;
  if (!endpoint || !traffic || typeof traffic !== 'object') {
    return NextResponse.json({ ok: false, error: 'endpoint + traffic map are required' }, { status: 400 });
  }
  try {
    const updated = await setServingTraffic(endpoint, traffic as Record<string, number>);
    return NextResponse.json({ ok: true, endpoint: updated, message: 'Traffic split updated.' });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
