/**
 * Shared store helpers for the Loom-native deployment-pipeline routes.
 *
 * All reads/writes are Cosmos-only (no Fabric / Power BI). Ownership is always
 * scoped by the caller's tenant (oid): a pipeline doc is PK'd by /tenantId, and
 * every workspace a stage points at is verified to belong to the tenant before
 * its items are read or written.
 */
import { NextResponse } from 'next/server';
import {
  loomPipelinesContainer,
  pipelineStageRulesContainer,
  workspacesContainer,
} from '@/lib/azure/cosmos-client';
import type { LoomPipeline, LoomDeployRule, LoomPipelineStageRulesDoc } from '@/lib/types/loom-pipeline';
import type { Workspace } from '@/lib/types/workspace';

export function jok(data: unknown, status = 200) {
  return NextResponse.json({ ok: true, data }, { status });
}
export function jerr(error: string, status = 500, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

/** Point-read a pipeline owned by the tenant. Returns null when missing. */
export async function loadPipeline(tenantId: string, id: string): Promise<LoomPipeline | null> {
  const c = await loomPipelinesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<LoomPipeline>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** List every pipeline owned by the tenant (newest first). */
export async function listPipelines(tenantId: string): Promise<LoomPipeline[]> {
  const c = await loomPipelinesContainer();
  const { resources } = await c.items
    .query<LoomPipeline>(
      { query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC', parameters: [{ name: '@t', value: tenantId }] },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources || [];
}

/** Confirm a workspace belongs to the tenant; returns it (or null). */
export async function ownedWorkspace(tenantId: string, workspaceId: string): Promise<Workspace | null> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Resolve a stage id → its bound workspace id within a pipeline. */
export function stageWorkspaceId(pipeline: LoomPipeline, stageId: string): string | undefined {
  return pipeline.stages.find((s) => s.id === stageId)?.workspaceId;
}

const rulesDocId = (pipelineId: string, stageId: string) => `rules:${pipelineId}:${stageId}`;

/** Load a stage's deployment rules ([] when none configured). */
export async function loadStageRules(pipelineId: string, stageId: string): Promise<LoomDeployRule[]> {
  const c = await pipelineStageRulesContainer();
  try {
    const { resource } = await c.item(rulesDocId(pipelineId, stageId), pipelineId).read<LoomPipelineStageRulesDoc>();
    return resource?.rules || [];
  } catch (e: any) {
    if (e?.code === 404) return [];
    throw e;
  }
}

/** Upsert a stage's deployment rules. */
export async function saveStageRules(
  pipelineId: string,
  stageId: string,
  rules: LoomDeployRule[],
  updatedBy: string,
): Promise<LoomDeployRule[]> {
  const c = await pipelineStageRulesContainer();
  const doc: LoomPipelineStageRulesDoc = {
    id: rulesDocId(pipelineId, stageId),
    pipelineId,
    stageId,
    rules,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await c.items.upsert(doc);
  return rules;
}
