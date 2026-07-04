/**
 * POST /api/items/data-pipeline/[id]/publish?workspaceId=...
 *
 * Publish a Loom pipeline to a LIVE Azure Data Factory pipeline so it can be
 * Run / Debugged / scheduled. This is the action the Run/Debug gate points at:
 * a freshly-created or bundle-installed pipeline has its activity graph in
 * Cosmos (state.definition / state.content) but no `adfPipelineName` binding
 * yet, so runPipeline() has nothing to call.
 *
 * Publish:
 *   1. resolves the pipeline definition (saved state.definition → bundle
 *      state.content → the request body, in that order),
 *   2. upserts it into ADF via adf-client.upsertPipeline (real ARM PUT),
 *   3. stamps state.adfPipelineName on the Cosmos item so Run/Debug work.
 *
 * Honest gate (no-vaporware): when ADF isn't configured in this deployment
 * (adfConfigGate) we return 503 with the exact env var / role to set rather
 * than pretending to publish.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { upsertPipeline, adfConfigGate, type AdfPipeline } from '@/lib/azure/adf-client';
import { pipelineDefinitionFromContent } from '@/lib/azure/pipeline-binding';
import { prepareItemCreate, isDeployTargetGate } from '@/lib/azure/topology';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

/** ADF pipeline names allow letters/digits/space/_/-/(). Derive a stable, valid
 *  name from the display name + a short id suffix so two pipelines named the
 *  same don't collide. Max 260 chars (we stay well under). */
function safeAdfPipelineName(displayName: string, id: string): string {
  const base = (displayName || 'pipeline')
    .replace(/[^A-Za-z0-9 _()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'pipeline';
  const suffix = (id || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'loom';
  return `${base}_${suffix}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('pipeline not found', 404);

  const gate = adfConfigGate();
  if (gate) {
    return err(
      `Azure Data Factory is not configured in this deployment (missing ${gate.missing}).`,
      503,
      {
        gate: {
          reason: `Set ${gate.missing} so Loom can publish + run pipelines on ADF.`,
          remediation:
            'Set LOOM_ADF_NAME (or LOOM_ADF_FACTORY), LOOM_DLZ_RG (or LOOM_ADF_RG), and LOOM_SUBSCRIPTION_ID on the Console container app, and grant the Console UAMI the "Data Factory Contributor" role on the factory. No Microsoft Fabric required.',
        },
      },
    );
  }

  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);

    const state = (resource.state as any) || {};
    // Resolve the definition: explicit body → saved state.definition → bundle content.
    let definition: AdfPipeline | null = null;
    if (body?.definition?.properties) definition = body.definition as AdfPipeline;
    else if (state?.definition?.properties) definition = state.definition as AdfPipeline;
    else {
      const fromContent = pipelineDefinitionFromContent(state?.content, state?.adfPipelineName);
      if (fromContent) definition = fromContent as AdfPipeline;
    }
    if (!definition?.properties) {
      return err('Pipeline has no activity definition to publish. Add at least one activity, then Save.', 400);
    }

    const adfName: string = state?.adfPipelineName || safeAdfPipelineName(resource.displayName, resource.id);

    // Domain routing: publish the pipeline into the ADF that lives in the
    // OWNING workspace's domain DLZ subscription + resource group. A cross-sub
    // permission gap surfaces as an honest, named remediation (409) instead of
    // an opaque ARM 403 on the pipeline PUT. Single-sub deployments resolve to
    // the env default with no behaviour change.
    const target = await prepareItemCreate(workspaceId, 'data-pipeline');
    if (isDeployTargetGate(target)) {
      return err(target.reason, 409, {
        code: 'rbac_gate',
        missingGrant: target.missingGrant,
        fixScript: target.fixScript,
        redeploy: true,
      });
    }
    try {
      await upsertPipeline(
        adfName,
        { name: adfName, properties: definition.properties },
        { subscriptionId: target.subscriptionId, resourceGroup: target.resourceGroup },
      );
    } catch (e: any) {
      return err(`ADF publish failed: ${e?.message || e}`, 502);
    }

    // Stamp the binding so Run/Debug/Schedule resolve the live ADF pipeline.
    const next: WorkspaceItem = {
      ...resource,
      state: { ...state, adfPipelineName: adfName, definition },
      updatedAt: new Date().toISOString(),
    };
    await items.item(resource.id, workspaceId).replace(next);

    return NextResponse.json({ ok: true, adfPipelineName: adfName, published: true });
  } catch (e: any) {
    if (e?.code === 404) return err('pipeline not found', 404);
    return err(e?.message || String(e), e?.status || 500);
  }
}
