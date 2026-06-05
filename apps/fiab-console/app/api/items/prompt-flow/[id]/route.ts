/**
 * GET    /api/items/prompt-flow/[id]?project=<name>
 * DELETE /api/items/prompt-flow/[id]?project=<name>
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPromptFlow, deletePromptFlow, updatePromptFlow, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { loadContentBackedItem, promptFlowFromContent } from '../../_lib/ai-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fall back to the bundle's PromptFlowContent (nodes + edges + systemPrompt)
 * stamped on the Cosmos item, projected into the editor's flow.dag shape, so a
 * bundle-installed flow opens FULLY BUILT-OUT (every node on the canvas) before
 * the live Foundry flow exists. Save/Run still target the real data-plane.
 */
async function promptFlowContentFallback(id: string, tenantId: string) {
  const item = await loadContentBackedItem(id, 'prompt-flow', tenantId);
  if (!item) return null;
  const built = promptFlowFromContent(item);
  return built ? { flow: built.flow, source: 'bundle' } : null;
}

function err(e: any) {
  if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
  const status = e instanceof FoundryError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const project = req.nextUrl.searchParams.get('project');
  const { id } = await ctx.params;
  // No Foundry project bound yet — the live data-plane is unreachable, but a
  // bundle-installed flow can still open from its stamped content.
  if (!project) {
    const fb = await promptFlowContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
    return NextResponse.json({ ok: false, error: 'project query param required' }, { status: 400 });
  }
  try {
    const flow = await getPromptFlow(project, id);
    if (!flow) {
      const fb = await promptFlowContentFallback(id, session.claims.oid);
      if (fb) return NextResponse.json({ ok: true, ...fb });
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, flow });
  } catch (e: any) {
    // Foundry not provisioned (or transient data-plane error): surface the
    // bundle definition rather than an empty canvas, when available.
    const fb = await promptFlowContentFallback(id, session.claims.oid);
    if (fb) return NextResponse.json({ ok: true, ...fb });
    return err(e);
  }
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
