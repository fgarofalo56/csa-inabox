/**
 * GET  /api/items/prompt-flow?project=<name> — list flows in a project
 * POST /api/items/prompt-flow — create flow { project, flowName, flowType?, flowDefinition, description? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPromptFlows, createPromptFlow, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) {
    return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  }
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const flows = await listPromptFlows(project);
    return NextResponse.json({ ok: true, flows, project });
  } catch (e: any) { return err(e); }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const body = await req.json();
    if (!body?.project || !body?.flowName || !body?.flowDefinition) {
      return NextResponse.json({ ok: false, error: 'project, flowName, flowDefinition required' }, { status: 400 });
    }
    const flow = await createPromptFlow(body.project, {
      flowName: body.flowName,
      flowType: body.flowType || 'standard',
      flowDefinition: body.flowDefinition,
      description: body.description,
    });
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) { return err(e); }
}
