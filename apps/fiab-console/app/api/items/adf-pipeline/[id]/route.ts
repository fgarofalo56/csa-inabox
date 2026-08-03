/**
 * GET    /api/items/adf-pipeline/[id]  — fetch the bound pipeline's spec
 * PUT    /api/items/adf-pipeline/[id]  — upsert the bound pipeline's spec
 * DELETE /api/items/adf-pipeline/[id]  — delete the bound pipeline
 *
 * `[id]` is the Loom Cosmos item GUID — NOT the Azure pipeline name. The real
 * pipeline name is resolved from the item's `state.pipelineName` binding via
 * resolveBinding(). When the item is unbound we 412 so the editor can show its
 * bind picker (list existing pipelines / create new + bind).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPipeline, upsertPipeline, deletePipeline, type AdfPipeline } from '@/lib/azure/adf-client';
import { withFactoryOverride } from '@/lib/azure/adf-factory-context';
import { resolveBinding, bindingErrorResponse, pipelineDefinitionFromContent, loadPipelineItem, bindingFactoryOverride } from '@/lib/azure/pipeline-binding';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'adf-pipeline';
// Accept the aliased persist form ('data-pipeline') alongside the native type —
// see pipeline-binding.ts loadPipelineItem for why.
const ACCEPTED_TYPES = [ITEM_TYPE, 'data-pipeline'];

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const { id } = params;
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid);
  } catch (e) {
    // Unbound item: a bundle-installed pipeline that was never bound to a live
    // Azure pipeline (e.g. the ADF factory env vars weren't set at install
    // time, so the provisioner config-gated and never stamped
    // state.pipelineName). Rather than 412 → empty canvas, surface the stamped
    // state.content so the designer opens FULLY BUILT-OUT. Save/Run still gate
    // on a real binding. Only fall through to the bind-picker 412 when the item
    // genuinely has no content to render.
    if ((e as any)?.code === 'unbound') {
      const item = await loadPipelineItem(id, ACCEPTED_TYPES, session.claims.oid).catch(() => null);
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
    const pipeline = await withFactoryOverride(bindingFactoryOverride(binding), () => getPipeline(pipelineName));
    return NextResponse.json({ ok: true, pipeline, boundTo: pipelineName });
  } catch (e: any) {
    // The item is bound but the live ADF pipeline can't be fetched yet (never
    // pushed / RBAC-gated / factory not provisioned). Fall back to the bundle's
    // stamped state.content so the canvas opens FULLY BUILT-OUT instead of
    // empty. Save/Run still target the live factory via the bound name.
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
    // #2895 — a 404 here means the item IS bound but the factory has no
    // pipeline by that name (never pushed, or deleted out from under us). That
    // is an expected, recoverable state, not a backend failure: the editor
    // renders a guided "create it or rebind" surface over a live canvas. Any
    // OTHER status is a genuine error and still surfaces as one (502).
    if (e?.status === 404) {
      return NextResponse.json({
        ok: false,
        code: 'pipeline-missing',
        pipelineName,
        error: `The Data Factory has no pipeline named "${pipelineName}" yet.`,
      }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const PUT = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const body = (await req.json().catch(() => null)) as AdfPipeline | null;
  if (!body || !body.properties) {
    return NextResponse.json({ ok: false, error: 'body must be { name?, properties: {...} }' }, { status: 400 });
  }
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid);
  } catch (e) {
    const { status, body: errBody } = bindingErrorResponse(e);
    return NextResponse.json(errBody, { status });
  }
  const { pipelineName } = binding;
  try {
    const pipeline = await withFactoryOverride(bindingFactoryOverride(binding), () => upsertPipeline(pipelineName, { ...body, name: pipelineName }));
    return NextResponse.json({ ok: true, pipeline, boundTo: pipelineName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

export const DELETE = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {
  const { id } = params;
  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid);
  } catch (e) {
    // Unbound draft item: there is NO live ADF pipeline to tear down, so deleting
    // it must always succeed (issue #1859 — a scratch/draft pipeline that was
    // never bound to a factory). Return ok so the caller can remove the Loom
    // item; only surface the binding error for non-unbound failures.
    if ((e as any)?.code === 'unbound') {
      return NextResponse.json({ ok: true, unbound: true });
    }
    const { status, body } = bindingErrorResponse(e);
    return NextResponse.json(body, { status });
  }
  const { pipelineName } = binding;
  try {
    await withFactoryOverride(bindingFactoryOverride(binding), () => deletePipeline(pipelineName));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
