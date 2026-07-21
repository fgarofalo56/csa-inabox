/**
 * Fine-tuning job — safety-eval sub-route (WS-1.3).
 *   POST /api/items/fine-tuning-job/[id]/safety-eval
 *   body: { deploymentName }
 *
 * The RESULTING-MODEL-SAFETY-EVAL gate: probes the DEPLOYED fine-tuned model with
 * adversarial requests (the Loom red-team engine), scores each completion with
 * Azure Content Safety (Foundry RAI), and grades the refusal rate. On PASS the
 * item is marked `deployable` — the resulting model is then approved for serving
 * via WS-1.2. On FAIL the model stays gated. Real model calls + real
 * Content-Safety scoring; never a vacuous pass (no-vaporware.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { runSafetyEval, fineTuneConfigGate, CsError } from '@/lib/azure/fine-tuning-client';
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
  const deploymentName = String(body?.deploymentName || '').trim();
  if (!deploymentName) return NextResponse.json({ ok: false, error: 'deploymentName is required — deploy the fine-tuned model first' }, { status: 400 });
  try {
    const result = await runSafetyEval(deploymentName);
    // Persist the decision + flip `deployable` strictly on the pass.
    await persistFineTuningItem(id, session.claims.oid, {
      deploymentName,
      deployable: result.decision.passed,
      safetyEval: {
        passed: result.decision.passed,
        grade: result.decision.grade,
        refusalRate: result.decision.refusalRate,
        attackSuccessRate: result.decision.attackSuccessRate,
        unsafe: result.decision.unsafe,
        contentSafetyConfigured: result.decision.contentSafetyConfigured,
        reason: result.decision.reason,
        ranAt: result.ranAt,
      },
    });
    return NextResponse.json({ ok: true, summary: result.summary, decision: result.decision, rows: result.rows, ranAt: result.ranAt });
  } catch (e: any) {
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
