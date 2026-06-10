/**
 * GET  /api/deployment-pipelines/loom        — list the tenant's Loom-native pipelines
 * POST /api/deployment-pipelines/loom        — create a pipeline (2–10 stages,
 *                                               each bound to an owned workspace)
 *
 * Azure-native parity for Fabric Deployment pipelines (no-fabric-dependency.md).
 * Cosmos-only; no Fabric / Power BI dependency. Each stage is bound to a Loom
 * workspace the caller's tenant owns.
 *
 * Shapes:
 *   GET  → { ok, data: { pipelines: LoomPipeline[] } }
 *   POST → { ok, data: { pipeline: LoomPipeline } }
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { loomPipelinesContainer } from '@/lib/azure/cosmos-client';
import type { LoomPipeline, LoomPipelineStage } from '@/lib/types/loom-pipeline';
import { jok, jerr, listPipelines, ownedWorkspace } from './_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  try {
    const pipelines = await listPipelines(s.claims.oid);
    return jok({ pipelines });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to list pipelines');
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const tenantId = s.claims.oid;

  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 1024) : undefined;
  const rawStages = Array.isArray(body?.stages) ? body.stages : [];

  if (!displayName) return jerr('displayName is required', 400, 'bad_request');
  if (rawStages.length < 2 || rawStages.length > 10) {
    return jerr('A pipeline needs between 2 and 10 stages', 400, 'bad_request');
  }

  // Validate + resolve each stage's workspace (must be owned by the tenant).
  // Each stage must use a DISTINCT workspace: a stage bound to the same
  // workspace as an earlier stage could only ever promote into its own
  // source, which is not a valid deploy. Fabric enforces the same invariant —
  // a workspace belongs to a single stage of a single pipeline
  // (learn.microsoft.com/fabric/cicd/deployment-pipelines/assign-pipeline,
  // limitation 1.2). We reject it here at construction time with a clear
  // message rather than letting deploy fail later with a "promote error".
  const stages: LoomPipelineStage[] = [];
  const workspaceToStage = new Map<string, string>();
  for (let i = 0; i < rawStages.length; i++) {
    const st = rawStages[i] || {};
    const stageName = String(st.displayName || '').trim();
    const workspaceId = String(st.workspaceId || '').trim();
    if (!stageName) return jerr(`Stage ${i + 1} needs a name`, 400, 'bad_request');
    if (!workspaceId) return jerr(`Stage "${stageName}" needs a bound workspace`, 400, 'bad_request');
    const priorStage = workspaceToStage.get(workspaceId);
    if (priorStage) {
      return jerr(
        `Each stage must use a distinct workspace. Stage "${stageName}" reuses the workspace already bound to "${priorStage}". Pick a different workspace so content can be promoted between stages.`,
        400,
        'duplicate_workspace',
      );
    }
    let ws;
    try {
      ws = await ownedWorkspace(tenantId, workspaceId);
    } catch (e) {
      return jerr((e as Error).message || 'workspace lookup failed');
    }
    if (!ws) return jerr(`Workspace for stage "${stageName}" not found or not owned`, 404, 'workspace_not_found');
    workspaceToStage.set(workspaceId, stageName);
    stages.push({ id: crypto.randomUUID(), displayName: stageName, order: i, workspaceId, workspaceName: ws.name });
  }

  const now = new Date().toISOString();
  const pipeline: LoomPipeline = {
    id: crypto.randomUUID(),
    tenantId,
    displayName,
    description,
    stages,
    createdAt: now,
    updatedAt: now,
    createdBy: s.claims.upn || s.claims.email || tenantId,
  };

  try {
    const c = await loomPipelinesContainer();
    const { resource } = await c.items.create<LoomPipeline>(pipeline);
    return jok({ pipeline: resource });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to create pipeline');
  }
}
