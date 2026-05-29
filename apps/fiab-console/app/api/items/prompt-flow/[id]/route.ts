/**
 * GET    /api/items/prompt-flow/[id]?project=<name>
 * DELETE /api/items/prompt-flow/[id]?project=<name>
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPromptFlow, deletePromptFlow, updatePromptFlow, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const flow = await getPromptFlow(project, (await ctx.params).id);
    if (!flow) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) { return err(e); }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    const body = await req.json();
    if (body?.flowDefinition === undefined) return NextResponse.json({ ok: false, error: 'flowDefinition required' }, { status: 400 });
    const flow = await updatePromptFlow(project, (await ctx.params).id, body.flowDefinition);
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) { return err(e); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  if (!project) return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  try {
    await deletePromptFlow(project, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e: any) { return err(e); }
}
