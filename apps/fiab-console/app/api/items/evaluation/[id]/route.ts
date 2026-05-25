/**
 * GET /api/items/evaluation/[id]?project=<name>&results=1 — fetch evaluation,
 * optionally with results table.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getEvaluation, getEvaluationResults, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  const wantResults = req.nextUrl.searchParams.get('results') === '1';
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const evaluation = await getEvaluation(project, ctx.params.id);
    if (!evaluation) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    let results: any = null;
    if (wantResults) {
      try { results = await getEvaluationResults(project, ctx.params.id); } catch { results = null; }
    }
    return NextResponse.json({ ok: true, evaluation, results });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
