/**
 * GET    /api/items/prompt-flow/[id]?project=<name>
 * DELETE /api/items/prompt-flow/[id]?project=<name>
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPromptFlow, deletePromptFlow, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const flow = await getPromptFlow(project, ctx.params.id);
    if (!flow) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    await deletePromptFlow(project, ctx.params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
