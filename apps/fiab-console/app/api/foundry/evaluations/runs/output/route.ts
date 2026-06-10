/**
 * GET /api/foundry/evaluations/runs/output?evalId=&runId=[&account=&rg=]
 *   Per-row results of a run: each dataset row, its grader scores + sample output.
 * AOAI Evals: GET {endpoint}/openai/v1/evals/{eval-id}/runs/{run-id}/output_items
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getEvalRunOutputItems, CsError, CsNotConfiguredError } from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery } from '../../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const evalId = req.nextUrl.searchParams.get('evalId')?.trim();
  const runId = req.nextUrl.searchParams.get('runId')?.trim();
  if (!evalId || !runId) return NextResponse.json({ ok: false, error: 'evalId and runId required' }, { status: 400 });
  try {
    const { items } = await getEvalRunOutputItems(evalId, runId, selectorFromQuery(req));
    return NextResponse.json({ ok: true, evalId, runId, items });
  } catch (e: any) {
    if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof CsError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
