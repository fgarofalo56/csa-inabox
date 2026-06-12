/**
 * Warp experience home — landing aggregator for the unified transform /
 * pipeline builder.
 *
 * GET /api/experience/warp/home
 *   → 401 { ok:false, error:'unauthenticated' }
 *   → 200 {
 *       ok: true,
 *       pipelines:  WarpItem[]   // ≤8 recent Pipeline-Builder items
 *       codeRepos:  WarpItem[]   // ≤8 recent Code-Repos (dbt) items
 *       counts: { pipelines, codeRepos, total }
 *     }
 *
 * Warp is NOT a new engine — it is a branded surface over three existing,
 * production pillars (see csa_loom_weave_epic.md):
 *   - Pillar 1/3 "Pipeline Builder": visual-query + data-pipeline +
 *     spark-job-definition + dataflow + synapse-pipeline items. The visual
 *     query canvas compiles to real T-SQL / Spark SQL via
 *     lib/editors/visual-query-compiler.ts:compileGraph and runs through
 *     /api/items/[type]/[id]/visual-query.
 *   - Pillar 2 "Code Repos": dbt-job items. The medallion DAG generates a real
 *     dbt Core project (lib/dbt/dbt-codegen.ts:generateProject) and runs it
 *     Azure-natively (lib/dbt/dbt-runner.ts:runDbtOnDatabricks, default) via
 *     /api/items/dbt-job/[id]/run.
 *
 * Everything here is real (no-vaporware): the lists come from the same Cosmos
 * `items` container the rest of the console reads, scoped to the signed-in
 * user's own workspaces. The Azure-native default path works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOP = 8;

/** Item types that build a transform/pipeline visually (the Pipeline Builder pillar). */
export const WARP_PIPELINE_TYPES = [
  'data-pipeline',
  'synapse-pipeline',
  'spark-job-definition',
  'dataflow',
  'copy-job',
];

/** Item types that are real code projects (the Code-Repos pillar). */
export const WARP_CODE_TYPES = ['dbt-job'];

export interface WarpItem {
  id: string;
  displayName: string;
  itemType: string;
  workspaceId: string;
  updatedAt?: string;
}

async function recentByTypes(tenantId: string, types: string[]): Promise<WarpItem[]> {
  const wsc = await workspacesContainer();
  const { resources: workspaces } = await wsc.items
    .query<Workspace>(
      {
        query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  const wsIds = workspaces.map((w) => w.id);
  if (wsIds.length === 0) return [];

  const wsParams = wsIds.map((id, i) => ({ name: `@w${i}`, value: id }));
  const wsExpr = wsParams.map((p) => p.name).join(',');
  const typeParams = types.map((t, i) => ({ name: `@k${i}`, value: t }));
  const typeExpr = typeParams.map((p) => p.name).join(',');

  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query:
        `SELECT TOP ${TOP} c.id, c.displayName, c.itemType, c.workspaceId, c.updatedAt ` +
        `FROM c WHERE c.workspaceId IN (${wsExpr}) AND c.itemType IN (${typeExpr}) ` +
        `ORDER BY c.updatedAt DESC`,
      parameters: [...wsParams, ...typeParams],
    })
    .fetchAll();

  return resources.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    itemType: r.itemType,
    workspaceId: r.workspaceId,
    updatedAt: r.updatedAt,
  }));
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const [pipeRes, codeRes] = await Promise.allSettled([
    recentByTypes(s.claims.oid, WARP_PIPELINE_TYPES),
    recentByTypes(s.claims.oid, WARP_CODE_TYPES),
  ]);

  const pipelines = pipeRes.status === 'fulfilled' ? pipeRes.value : [];
  const codeRepos = codeRes.status === 'fulfilled' ? codeRes.value : [];

  return NextResponse.json({
    ok: true,
    pipelines,
    codeRepos,
    counts: {
      pipelines: pipelines.length,
      codeRepos: codeRepos.length,
      total: pipelines.length + codeRepos.length,
    },
  });
}
