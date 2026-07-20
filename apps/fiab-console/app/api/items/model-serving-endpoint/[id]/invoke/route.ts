/**
 * POST /api/items/model-serving-endpoint/[id]/invoke
 *   body { endpoint: string, payload: string }   (payload = raw JSON scoring body)
 * Scores real data against the serving endpoint from the console. AML: reads the
 * scoring URI + a listkeys key and POSTs the data plane. Databricks: POSTs the
 * Mosaic `/serving-endpoints/{name}/invocations`. Returns the model response +
 * measured round-trip latency (feeds the invoke console + latency tile).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  invokeServingEndpoint, shapeInvokePayload, resolveServingBackend, ServingError,
} from '@/lib/azure/model-serving-client';
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
  if (!endpoint) return NextResponse.json({ ok: false, error: 'endpoint is required' }, { status: 400 });
  let payload: unknown;
  try {
    payload = shapeInvokePayload(String(body?.payload ?? ''), resolveServingBackend());
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'invalid payload' }, { status: 400 });
  }
  try {
    const result = await invokeServingEndpoint(endpoint, payload);
    return NextResponse.json({ ok: result.status < 400, status: result.status, latencyMs: result.latencyMs, result: result.body });
  } catch (e: any) {
    const status = e instanceof ServingError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
