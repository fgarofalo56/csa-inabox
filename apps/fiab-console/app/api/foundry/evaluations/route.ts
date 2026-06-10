/**
 * GET  /api/foundry/evaluations            — list evaluations for the selected account.
 * POST /api/foundry/evaluations            — create an evaluation (structure/graders).
 *   body: { name, testingCriteria: [...], dataSourceConfig?, metadata?, account?, rg? }
 * GET  /api/foundry/evaluations?evalId=<id>&runs=1 — list runs for one evaluation.
 *
 * Azure OpenAI in Azure AI Foundry "Evals" data-plane (preview):
 *   list   = GET  {endpoint}/openai/v1/evals
 *   create = POST {endpoint}/openai/v1/evals
 *   runs   = GET  {endpoint}/openai/v1/evals/{eval-id}/runs
 * Ref: https://learn.microsoft.com/azure/ai-foundry/openai/reference-preview-latest#list-evals
 *      https://learn.microsoft.com/azure/ai-foundry/openai/authoring-reference-preview#evaluation---getrunlist
 *
 * Account is selected by the AI Foundry account picker (?account=&rg= or body).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listEvals,
  createEval,
  listEvalRuns,
  getEval,
  deleteEval,
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
  const detail = req.nextUrl.searchParams.get('detail');
  try {
    if (evalId && detail) {
      const { account, eval: ev } = await getEval(evalId, selectorFromQuery(req));
      return NextResponse.json({ ok: true, account: { name: account.name, location: account.location }, eval: ev });
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

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const evalId = req.nextUrl.searchParams.get('evalId')?.trim();
  if (!evalId) return NextResponse.json({ ok: false, error: 'evalId required' }, { status: 400 });
  try {
    await deleteEval(evalId, selectorFromQuery(req));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
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
