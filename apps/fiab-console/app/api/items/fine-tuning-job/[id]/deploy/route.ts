/**
 * Fine-tuning job — deploy sub-route (WS-1.3).
 *   POST /api/items/fine-tuning-job/[id]/deploy
 *   body: { fineTunedModel, deploymentName, raiPolicyName?, skuName?, capacity? }
 *
 * Deploys the resulting fine-tuned model as a REAL Azure OpenAI deployment (the
 * canonical register+serve path for an AOAI fine-tuned model — invocable at the
 * AOAI chat endpoint and consumable by the WS-1.2 model-serving surface). A
 * strict RAI content-filter policy is bound by default. This creates the
 * deployment the safety-eval gate then evaluates; the item is marked deployable
 * only after that eval PASSES (see the safety-eval sub-route).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { deployFineTunedModel, fineTuneConfigGate, CsError } from '@/lib/azure/fine-tuning-client';
import { resolveFineTuningItem, persistFineTuningItem, fineTuningItemErrorResponse } from '@/lib/azure/fine-tuning-item';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    await resolveFineTuningItem(id, session.claims.oid);
  } catch (e) {
    const { status, body } = fineTuningItemErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const gate = fineTuneConfigGate();
  if (gate) return NextResponse.json({ ok: false, code: 'not_configured', gate, error: gate.hint }, { status: 503 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const fineTunedModel = String(body?.fineTunedModel || '').trim();
  const deploymentName = String(body?.deploymentName || '').trim();
  if (!fineTunedModel || !deploymentName) {
    return NextResponse.json({ ok: false, error: 'fineTunedModel and deploymentName are required' }, { status: 400 });
  }
  try {
    const deployment = await deployFineTunedModel({
      fineTunedModel, deploymentName,
      raiPolicyName: typeof body?.raiPolicyName === 'string' && body.raiPolicyName.trim() ? body.raiPolicyName.trim() : undefined,
      skuName: typeof body?.skuName === 'string' && body.skuName.trim() ? body.skuName.trim() : undefined,
      capacity: Number.isFinite(Number(body?.capacity)) && Number(body.capacity) > 0 ? Number(body.capacity) : undefined,
    });
    // Record the deployment + registered model. `deployable` stays false until
    // the safety-eval gate passes (the model is not yet approved for serving).
    await persistFineTuningItem(id, session.claims.oid, { fineTunedModel, deploymentName });
    return NextResponse.json({ ok: true, deployment, message: `Fine-tuned model "${fineTunedModel}" deploying as "${deploymentName}". Run the safety evaluation to approve it for serving.` });
  } catch (e: any) {
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
