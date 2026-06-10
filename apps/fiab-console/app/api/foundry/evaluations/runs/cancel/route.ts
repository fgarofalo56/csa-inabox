/**
 * POST /api/foundry/evaluations/runs/cancel — cancel an in-progress eval run.
 *   body: { evalId, runId, account?, rg? }
 * AOAI Evals: POST {endpoint}/openai/v1/evals/{eval-id}/runs/{run-id} { status: canceled }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { cancelEvalRun, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromBody } from '../../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const evalId = String(body?.evalId || '').trim();
    const runId = String(body?.runId || '').trim();
    if (!evalId || !runId) return NextResponse.json({ ok: false, error: 'evalId and runId required' }, { status: 400 });
    const { run } = await cancelEvalRun(evalId, runId, selectorFromBody(body));
    return NextResponse.json({ ok: true, run });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
