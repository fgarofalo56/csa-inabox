/**
 * POST /api/items/ai-builder-model/[id]/predict
 *   Body: { envId, request }  — request is the model-specific input payload.
 *   Runs a real-time prediction via the Dataverse unbound action Predict.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { predictAiBuilderModel, PowerPlatformError } from '@/lib/azure/powerplatform-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  const status = e instanceof PowerPlatformError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), hint: e?.hint, endpoint: e?.endpoint, body: e?.body },
    { status },
  );
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  let request: Record<string, unknown>;
  if (typeof body.request === 'object' && body.request) {
    request = body.request;
  } else if (typeof body.requestJson === 'string') {
    try { request = JSON.parse(body.requestJson); }
    catch { return NextResponse.json({ ok: false, error: 'request payload is not valid JSON' }, { status: 400 }); }
  } else {
    return NextResponse.json({ ok: false, error: 'request (object) or requestJson (string) is required' }, { status: 400 });
  }
  try {
    const r = await predictAiBuilderModel(String(body.envId), (await ctx.params).id, request);
    return NextResponse.json(r);
  } catch (e: any) { return err(e); }
}
