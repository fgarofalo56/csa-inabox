/**
 * Data pipeline detail.
 * GET    /api/items/data-pipeline/[id]?workspaceId=...   — metadata + ADF spec
 * PUT    /api/items/data-pipeline/[id]?workspaceId=...   — update displayName/description and/or definition (writes to ADF)
 * DELETE /api/items/data-pipeline/[id]?workspaceId=...   — delete (removes ADF pipeline + Cosmos item)
 *
 * v3.25: backed by ADF, not Fabric REST.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { getPipeline, upsertPipeline, deletePipeline, adfConfigGate, type AdfPipeline } from '@/lib/azure/adf-client';
import { pipelineDefinitionFromContent } from '@/lib/azure/pipeline-binding';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    const state = (resource.state as any) || {};
    const adfName = state?.adfPipelineName;
    let definition: AdfPipeline | null = null;
    if (adfName) {
      try { definition = await getPipeline(adfName); } catch { /* ADF may not have it yet */ }
    }
    // Fallback for bundle-installed pipelines whose rich activity graph was
    // stamped only into state.content (AdfPipelineContent / SynapsePipelineContent)
    // and never pushed to the live ADF factory — surface it as the editor's
    // expected ADF-pipeline JSON so the canvas opens FULLY BUILT-OUT (every
    // activity + dependency + parameter) rather than an empty pipeline. A
    // previously-saved state.definition takes precedence over the bundle content.
    if (!definition) {
      if (state?.definition?.properties) {
        definition = state.definition as AdfPipeline;
      } else {
        const fromContent = pipelineDefinitionFromContent(state?.content, adfName);
        if (fromContent) definition = fromContent as AdfPipeline;
      }
    }
    return NextResponse.json({
      ok: true,
      pipeline: { id: resource.id, displayName: resource.displayName, description: resource.description, adfPipelineName: adfName },
      definition,
    });
  } catch (e: any) {
    if (e?.code === 404) return apiError('pipeline not found', 404);
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'data-pipeline') return apiError('pipeline not found', 404);
    let adfName = (existing.state as any)?.adfPipelineName;
    const props = body?.definition ? (body.definition.properties || body.definition) : null;
    // Save = publish: when ADF is configured, ensure a LIVE ADF pipeline backs
    // this item. On first save of a new / bundle-installed pipeline there is no
    // adfPipelineName yet, so we mint one and create the ADF pipeline — without
    // this the pipeline saved to Cosmos but never got an ADF backing, and Run
    // gated forever ("no ADF backing — publish it first") with no way out.
    // When ADF isn't configured we still persist the definition to Cosmos; Run
    // surfaces the honest env-var gate instead.
    if (props && !adfConfigGate()) {
      if (!adfName) {
        const base = (body?.displayName?.trim() || existing.displayName || 'pipeline')
          .replace(/[^A-Za-z0-9 _()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'pipeline';
        adfName = `${base}_${(existing.id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'loom'}`;
      }
      try {
        await upsertPipeline(adfName, { name: adfName, properties: props });
      } catch (e: any) { return apiError(`ADF write failed: ${e?.message || e}`, 502); }
    }
    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: {
        ...(existing.state || {}),
        ...(body?.definition ? { definition: body.definition } : {}),
        ...(adfName ? { adfPipelineName: adfName } : {}),
      },
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({ ok: true, pipeline: resource, adfPipelineName: adfName, published: !!adfName });
  } catch (e: any) { return apiError(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    const adfName = (existing?.state as any)?.adfPipelineName;
    if (adfName) { try { await deletePipeline(adfName); } catch { /* tolerate ADF 404 */ } }
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiError(e?.message || String(e), 500);
  }
}
