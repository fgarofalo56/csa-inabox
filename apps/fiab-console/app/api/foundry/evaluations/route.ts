/**
 * GET    /api/foundry/evaluations            — list evaluations for the selected account.
 * GET    ?evalId=<id>                         — list runs for one evaluation.
 * GET    ?evalId=<id>&runId=<id>&items=1      — list per-row output items for a run.
 * POST   /api/foundry/evaluations            — create an evaluation (structure/graders),
 *   or start a run when body.action === 'start_run'.
 *   create body: { name, testingCriteria: [...], dataSourceConfig?, metadata?, account?, rg? }
 *   run body:    { action:'start_run', evalId, fileId, model, name?, inputMessages?, account?, rg? }
 * DELETE ?evalId=<id>                         — delete an evaluation.
 * DELETE ?evalId=<id>&runId=<id>             — delete an evaluation run.
 *
 * Azure OpenAI in Azure AI Foundry "Evals" data-plane (preview):
 *   list    = GET    {endpoint}/openai/v1/evals
 *   create  = POST   {endpoint}/openai/v1/evals
 *   runs    = GET    {endpoint}/openai/v1/evals/{eval-id}/runs
 *   run     = POST   {endpoint}/openai/v1/evals/{eval-id}/runs
 *   items   = GET    {endpoint}/openai/v1/evals/{eval-id}/runs/{run-id}/output_items
 *   del     = DELETE {endpoint}/openai/v1/evals/{eval-id}[/runs/{run-id}]
 * Ref: https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview-latest#list-evals
 *
 * Account is selected by the AI Foundry account picker (?account=&rg= or body).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listEvals,
  createEval,
  createEvalRun,
  listEvalRuns,
  deleteEval,
  deleteEvalRun,
  getEvalRunOutputItems,
  CsError,
  CsNotConfiguredError,
} from '@/lib/azure/foundry-cs-client';
import { selectorFromQuery, selectorFromBody } from '../_selector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(e: any) {
  if (e instanceof CsNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof CsError ? e.status : 502;
  // 404 on /evals usually means Evals preview isn't enabled on this account/region.
  const hint = status === 404
    ? 'Azure OpenAI Evals is a preview feature. It must be enabled on the selected AI Foundry / Azure OpenAI account and region. Open ai.azure.com → your project → Evaluation, or use an account in a region where Evals (preview) is available.'
    : undefined;
  return NextResponse.json({ ok: false, error: e?.message || String(e), hint, body: e?.body, notDeployed: status === 404 }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const evalId = req.nextUrl.searchParams.get('evalId')?.trim();
  const runId = req.nextUrl.searchParams.get('runId')?.trim();
  const items = req.nextUrl.searchParams.get('items');
  try {
    if (evalId && runId && items) {
      const { account, items: rows } = await getEvalRunOutputItems(evalId, runId, selectorFromQuery(req));
      return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, evalId, runId, items: rows });
    }
    if (evalId) {
      const { account, runs } = await listEvalRuns(evalId, selectorFromQuery(req));
      return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, evalId, runs });
    }
    const { account, evals } = await listEvals(selectorFromQuery(req));
    return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, evals });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();

    // Start a grading run against a pre-uploaded JSONL file.
    if (body?.action === 'start_run') {
      const evalId = String(body?.evalId || '').trim();
      const fileId = String(body?.fileId || '').trim();
      const model = String(body?.model || '').trim();
      if (!evalId) return NextResponse.json({ ok: false, error: 'evalId required' }, { status: 400 });
      if (!fileId) return NextResponse.json({ ok: false, error: 'fileId required (upload a JSONL dataset first)' }, { status: 400 });
      if (!model) return NextResponse.json({ ok: false, error: 'model (deployment name) required' }, { status: 400 });
      const run = await createEvalRun(evalId, {
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
        fileId,
        model,
        inputMessages: Array.isArray(body.inputMessages) ? body.inputMessages : undefined,
      }, selectorFromBody(body));
      return NextResponse.json({ ok: true, run });
    }

    // Otherwise: create an evaluation structure (schema + graders).
    const name = String(body?.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
    if (!Array.isArray(body?.testingCriteria) || body.testingCriteria.length === 0) {
      return NextResponse.json({ ok: false, error: 'testingCriteria (at least one grader) required' }, { status: 400 });
    }
    const created = await createEval({
      name,
      testingCriteria: body.testingCriteria,
      dataSourceConfig: body.dataSourceConfig,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    }, selectorFromBody(body));
    return NextResponse.json({ ok: true, eval: created });
  } catch (e: any) {
    return fail(e);
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const evalId = req.nextUrl.searchParams.get('evalId')?.trim();
  const runId = req.nextUrl.searchParams.get('runId')?.trim();
  if (!evalId) return NextResponse.json({ ok: false, error: 'evalId required' }, { status: 400 });
  try {
    if (runId) {
      await deleteEvalRun(evalId, runId, selectorFromQuery(req));
      return NextResponse.json({ ok: true, deleted: { evalId, runId } });
    }
    await deleteEval(evalId, selectorFromQuery(req));
    return NextResponse.json({ ok: true, deleted: { evalId } });
  } catch (e: any) {
    return fail(e);
  }
}
