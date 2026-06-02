/**
 * GET    /api/items/synapse-pipeline/[id]   — fetch the bound pipeline's spec
 * PUT    /api/items/synapse-pipeline/[id]   — upsert the bound pipeline's spec
 * DELETE /api/items/synapse-pipeline/[id]   — delete the bound pipeline
 *
 * `[id]` is the Loom Cosmos item GUID — NOT the Azure pipeline name. The real
 * Azure pipeline name is resolved from the item's `state.pipelineName` binding
 * via resolveBinding(). When the item is unbound we 412 so the editor can show
 * its bind picker (list existing pipelines / create new + bind).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getPipeline, upsertPipeline, deletePipeline, type SynapsePipeline } from '@/lib/azure/synapse-dev-client';
import { resolveBinding, bindingErrorResponse, pipelineDefinitionFromContent, loadPipelineItem } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'synapse-pipeline';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ITEM_TYPE, session.claims.oid);
  } catch (e) {
    // Unbound item: a bundle-installed pipeline that was never bound to a live
    // Azure pipeline (e.g. the Synapse workspace env vars weren't set at
    // install time, so the provisioner config-gated and never stamped
    // state.pipelineName). Rather than 412 → empty canvas, surface the stamped
    // state.content so the designer opens FULLY BUILT-OUT. Save/Run still gate
    // on a real binding. Only fall through to the bind-picker 412 when the item
    // genuinely has no content to render.
    if ((e as any)?.code === 'unbound') {
      const item = await loadPipelineItem(id, ITEM_TYPE, session.claims.oid).catch(() => null);
      const fromContent = pipelineDefinitionFromContent(item?.state?.content);
      if (fromContent) {
        return NextResponse.json({ ok: true, pipeline: fromContent, boundTo: null, fromContent: true, unbound: true });
      }
    }
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const { pipelineName, item } = binding;
  try {
    const pipeline = await getPipeline(pipelineName);
    return NextResponse.json({ ok: true, pipeline, boundTo: pipelineName });
  } catch (e: any) {
    // The item is bound but the live Synapse pipeline can't be fetched yet
    // (never pushed / RBAC-gated / workspace not provisioned). Fall back to the
    // bundle's stamped state.content so the canvas opens FULLY BUILT-OUT instead
    // of empty. Save/Run still target the live workspace via the bound name.
    const fromContent = pipelineDefinitionFromContent(item.state?.content, pipelineName);
    if (fromContent) {
      return NextResponse.json({
        ok: true,
        pipeline: fromContent,
        boundTo: pipelineName,
        fromContent: true,
        backendError: e?.message || String(e),
      });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as SynapsePipeline | null;
  if (!body || !body.properties) {
    return NextResponse.json({ ok: false, error: 'body must be { name?, properties: {...} }' }, { status: 400 });
  }
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  try {
    const pipeline = await upsertPipeline(pipelineName, { ...body, name: pipelineName });
    return NextResponse.json({ ok: true, pipeline, boundTo: pipelineName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, ITEM_TYPE, session.claims.oid));
  } catch (e) {
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  try {
    await deletePipeline(pipelineName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
