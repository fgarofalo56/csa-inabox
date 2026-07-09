/**
 * GET /api/deployment-pipelines/loom/[id]/variables
 *   → { ok, data: { stages: [{id, displayName, valueSet}], variables: VariableDiffRow[] } }
 *
 * Backs the "Variable overrides" tab (FGC-24) — mirrors Fabric's variable-library
 * view in the deployment-pipeline compare. For every variable defined in any
 * Variable Library bound to the pipeline's stage workspaces, it resolves the
 * value for each stage's value set (dev/test/prod) and flags which variables
 * differ stage-to-stage — so the operator sees exactly which values will be
 * rebound on promotion. Secret-ref values are masked. Cosmos-only, no Fabric.
 */
import { NextRequest } from 'next/server';
import { listAllOwnedItems } from '@/app/api/items/_lib/item-crud';
import { stageValueSet, variableDiffRows } from '@/lib/install/pipeline-variables';
import type { VarDef } from '@/lib/variables/resolve';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { jok, jerr, loadPipeline, resolveCaller } from '../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function variableSetsFrom(items: WorkspaceItem[]): VarDef[][] {
  const out: VarDef[][] = [];
  for (const it of items) {
    if (it.itemType !== 'variable-library') continue;
    const vars = (it.state as any)?.variables;
    if (Array.isArray(vars)) out.push(vars as VarDef[]);
  }
  return out;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const caller = resolveCaller(req);
  if (!caller) return jerr('unauthenticated', 401, 'unauthorized');
  const { id } = await ctx.params;
  try {
    const pipeline = await loadPipeline(caller.tenantId, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');

    const stages = [...pipeline.stages].sort((a, b) => a.order - b.order);

    // Gather every Variable Library across all stage workspaces (later stages
    // win on a name clash, matching the promote path's target-wins merge).
    const perWorkspace = await Promise.all(
      stages.map((st) => listAllOwnedItems(caller.tenantId, st.workspaceId)),
    );
    const variableSets: VarDef[][] = perWorkspace.flatMap((items) => variableSetsFrom(items));

    const variables = variableDiffRows(
      variableSets,
      stages.map((s) => ({ id: s.id, displayName: s.displayName, order: s.order })),
    );

    return jok({
      stages: stages.map((s) => ({ id: s.id, displayName: s.displayName, valueSet: stageValueSet(s) })),
      variables,
    });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to load pipeline variables');
  }
}
