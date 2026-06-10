/**
 * POST   /api/foundry/evaluations/runs   — start a grading run for an eval.
 *   body: { evalId, name?, model, fileId?, inlineContent?, account?, rg? }
 * DELETE /api/foundry/evaluations/runs?evalId=&runId=[&account=&rg=]  — delete a run.
 *
 * AOAI Evals (preview):
 *   run    = POST   {endpoint}/openai/v1/evals/{eval-id}/runs
 *   delete = DELETE {endpoint}/openai/v1/evals/{eval-id}/runs/{run-id}
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  createEvalRun,
  deleteEvalRun,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body, notDeployed: status === 404 }, { status });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    const evalId = String(body?.evalId || '').trim();
    const model = String(body?.model || '').trim();
    if (!evalId) return NextResponse.json({ ok: false, error: 'evalId required' }, { status: 400 });
    if (!model) return NextResponse.json({ ok: false, error: 'model (deployment to grade) required' }, { status: 400 });
    const fileId = typeof body?.fileId === 'string' && body.fileId.trim() ? body.fileId.trim() : undefined;
    const inlineContent = Array.isArray(body?.inlineContent) ? body.inlineContent : undefined;
    if (!fileId && (!inlineContent || inlineContent.length === 0)) {
      return NextResponse.json({ ok: false, error: 'fileId or inlineContent (dataset rows) required' }, { status: 400 });
    }
    const { run } = await createEvalRun(evalId, {
      name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
      model,
      fileId,
      inlineContent,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, run });
  } catch (e: any) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const evalId = req.nextUrl.searchParams.get('evalId')?.trim();
  const runId = req.nextUrl.searchParams.get('runId')?.trim();
  if (!evalId || !runId) return NextResponse.json({ ok: false, error: 'evalId and runId required' }, { status: 400 });
  try {
    await deleteEvalRun(evalId, runId, selectorFromQuery(req));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return fail(e);
  }
}
