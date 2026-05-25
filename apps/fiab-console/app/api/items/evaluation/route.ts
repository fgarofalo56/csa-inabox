/**
 * GET  /api/items/evaluation?project=<name>
 * POST /api/items/evaluation — body: { project, displayName, datasetId, modelDeployment?, evaluatorIds[] }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listEvaluations, createEvaluation, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const evaluations = await listEvaluations(project);
    return NextResponse.json({ ok: true, evaluations, project });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.project || !body?.displayName || !body?.datasetId || !Array.isArray(body?.evaluatorIds)) {
      return NextResponse.json({ ok: false, error: 'project, displayName, datasetId, evaluatorIds[] required' }, { status: 400 });
    }
    const evaluation = await createEvaluation(body.project, {
      displayName: body.displayName,
      datasetId: body.datasetId,
      modelDeployment: body.modelDeployment,
      evaluatorIds: body.evaluatorIds,
    });
    return NextResponse.json({ ok: true, evaluation });
  } catch (e: any) { return err(e); }
}
