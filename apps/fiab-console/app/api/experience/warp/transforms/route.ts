/**
 * Warp transforms API — list / save the editable visual-transform definitions
 * built on the Warp canvas, plus enumerate the real SQL engine targets a
 * transform can compile + run against.
 *
 * GET /api/experience/warp/transforms
 *   → 401 { ok:false, error:'unauthenticated' }
 *   → 200 {
 *       ok: true,
 *       transforms: WarpTransform[]   // saved warp-transform items (this user)
 *       targets:    WarpRunTarget[]   // real engines the canvas can run against
 *     }
 *
 * POST /api/experience/warp/transforms        (save / upsert a definition)
 *   body { id?, displayName, workspaceId, graph: VqGraph, target: WarpRunTarget, dialect }
 *   → 200 { ok:true, transform: WarpTransform }
 *
 * No-vaporware: transforms persist to the same Cosmos `items` container the rest
 * of the console reads (itemType `warp-transform`, the canvas graph in
 * `state.graph`). The run/preview/validate path is NOT in this route — the
 * canvas calls the existing, real /api/items/[engine]/[id]/visual-query route,
 * which executes the compiled SQL against the live Synapse / Databricks backend.
 *
 * No-fabric-dependency: targets are Azure-native SQL engines only
 * (Synapse Dedicated / Serverless, Databricks SQL warehouse, or a warehouse /
 * lakehouse-SQL-endpoint item). Never Fabric/OneLake/Power BI.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForItem } from '@/lib/azure/loom-search';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import type { VqGraph, SqlDialect } from '@/lib/editors/visual-query-compiler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const WARP_TRANSFORM_ITEM_TYPE = 'warp-transform';

/** Engine slugs the visual-query run route accepts (Azure-native, no Fabric). */
export type WarpRunEngine =
  | 'warehouse'
  | 'synapse-dedicated-sql-pool'
  | 'synapse-serverless-sql-pool'
  | 'databricks-sql-warehouse';

/** Item types whose SQL endpoint can serve as a run target for a transform. */
const TARGET_ITEM_TYPES = ['warehouse', 'lakehouse', 'synapse-serverless-sql-pool'];

export interface WarpRunTarget {
  /** The item id the visual-query route opens against (or a synthetic engine id). */
  id: string;
  /** Display label for the picker. */
  label: string;
  /** The engine slug used as [type] in /api/items/[type]/[id]/visual-query. */
  engine: WarpRunEngine;
  /** SQL dialect the compiler emits for this engine. */
  dialect: SqlDialect;
  workspaceId?: string;
}

export interface WarpTransform {
  id: string;
  displayName: string;
  workspaceId: string;
  graph: VqGraph;
  target: WarpRunTarget | null;
  dialect: SqlDialect;
  updatedAt?: string;
}

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, code }, { status });
}

/** All workspace ids in the signed-in user's tenant. */
async function tenantWorkspaceIds(tenantId: string): Promise<string[]> {
  const wsc = await workspacesContainer();
  const { resources } = await wsc.items
    .query<Workspace>(
      { query: 'SELECT c.id FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: tenantId }] },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return resources.map((w) => w.id);
}

export async function GET() {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');

  try {
    const wsIds = await tenantWorkspaceIds(session.claims.oid);
    if (wsIds.length === 0) {
      return NextResponse.json({ ok: true, transforms: [], targets: synapseDefaultTargets() });
    }
    const wsParams = wsIds.map((id, i) => ({ name: `@w${i}`, value: id }));
    const wsExpr = wsParams.map((p) => p.name).join(',');
    const items = await itemsContainer();

    // Saved transforms.
    const { resources: saved } = await items.items
      .query<WorkspaceItem>({
        query:
          `SELECT * FROM c WHERE c.workspaceId IN (${wsExpr}) AND c.itemType = @kind ORDER BY c.updatedAt DESC`,
        parameters: [...wsParams, { name: '@kind', value: WARP_TRANSFORM_ITEM_TYPE }],
      })
      .fetchAll();

    const transforms: WarpTransform[] = saved.map((it) => {
      const st = (it.state || {}) as Record<string, unknown>;
      return {
        id: it.id,
        displayName: it.displayName,
        workspaceId: it.workspaceId,
        graph: (st.graph as VqGraph) || { nodes: [] },
        target: (st.target as WarpRunTarget) || null,
        dialect: (st.dialect as SqlDialect) || 'sparksql',
        updatedAt: it.updatedAt,
      };
    });

    // Run targets — real warehouse / lakehouse-SQL-endpoint items, plus the
    // ambient Synapse engines (Dedicated / Serverless) the route can reach.
    const typeParams = TARGET_ITEM_TYPES.map((t, i) => ({ name: `@k${i}`, value: t }));
    const typeExpr = typeParams.map((p) => p.name).join(',');
    const { resources: targetItems } = await items.items
      .query<WorkspaceItem>({
        query:
          `SELECT c.id, c.displayName, c.itemType, c.workspaceId FROM c ` +
          `WHERE c.workspaceId IN (${wsExpr}) AND c.itemType IN (${typeExpr}) ORDER BY c.updatedAt DESC`,
        parameters: [...wsParams, ...typeParams],
      })
      .fetchAll();

    const itemTargets: WarpRunTarget[] = targetItems.map((it) => {
      const engine: WarpRunEngine =
        it.itemType === 'synapse-serverless-sql-pool' ? 'synapse-serverless-sql-pool' : 'warehouse';
      return {
        id: it.id,
        label: `${it.displayName} · ${it.itemType}`,
        engine,
        dialect: 'tsql',
        workspaceId: it.workspaceId,
      };
    });

    return NextResponse.json({
      ok: true,
      transforms,
      targets: [...itemTargets, ...synapseDefaultTargets()],
    });
  } catch (e: any) {
    return err(e?.message || 'Failed to load Warp transforms', 500, 'cosmos_error');
  }
}

/** Ambient engine targets that don't need a specific item id. */
function synapseDefaultTargets(): WarpRunTarget[] {
  return [
    {
      id: 'synapse-dedicated',
      label: 'Synapse Dedicated SQL pool (T-SQL)',
      engine: 'synapse-dedicated-sql-pool',
      dialect: 'tsql',
    },
    {
      id: 'synapse-serverless',
      label: 'Synapse Serverless SQL endpoint (T-SQL)',
      engine: 'synapse-serverless-sql-pool',
      dialect: 'tsql',
    },
  ];
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401, 'unauthenticated');

  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }

  const displayName = (body?.displayName || '').toString().trim();
  const workspaceId = (body?.workspaceId || '').toString().trim();
  const graph = body?.graph as VqGraph | undefined;
  const target = (body?.target as WarpRunTarget) || null;
  const dialect: SqlDialect = body?.dialect === 'tsql' ? 'tsql' : 'sparksql';
  if (!displayName) return err('displayName is required', 400, 'missing_displayName');
  if (!workspaceId) return err('workspaceId is required', 400, 'missing_workspaceId');
  if (!graph || !Array.isArray(graph.nodes)) return err('graph is required', 400, 'missing_graph');
  if (!(await assertOwner(workspaceId, session.claims.oid))) return err('Workspace not found', 404, 'not_found');

  try {
    // Authorize: the workspace must belong to the caller's tenant.
    const wsc = await workspacesContainer();
    const { resource: ws } = await wsc.item(workspaceId, session.claims.oid).read<Workspace>().catch(() => ({ resource: null as any }));
    if (!ws || ws.tenantId !== session.claims.oid) return err('Workspace not found', 404, 'not_found');

    const items = await itemsContainer();
    const now = new Date().toISOString();
    const existingId = (body?.id || '').toString().trim();

    let item: WorkspaceItem;
    if (existingId) {
      const { resource: cur } = await items.item(existingId, workspaceId).read<WorkspaceItem>().catch(() => ({ resource: null as any }));
      if (!cur) return err('Transform not found', 404, 'not_found');
      item = {
        ...cur,
        displayName,
        state: { ...(cur.state || {}), graph, target, dialect },
        updatedAt: now,
      };
    } else {
      item = {
        id: crypto.randomUUID(),
        workspaceId,
        itemType: WARP_TRANSFORM_ITEM_TYPE,
        displayName,
        state: { graph, target, dialect },
        createdBy: session.claims.upn || session.claims.email || session.claims.oid,
        createdAt: now,
        updatedAt: now,
      };
    }

    const { resource } = await items.items.upsert<WorkspaceItem>(item);
    if (resource) void upsertLoomDoc(docForItem(resource, session.claims.oid));

    const saved: WarpTransform = {
      id: item.id,
      displayName: item.displayName,
      workspaceId: item.workspaceId,
      graph,
      target,
      dialect,
      updatedAt: item.updatedAt,
    };
    return NextResponse.json({ ok: true, transform: saved });
  } catch (e: any) {
    return err(e?.message || 'Failed to save transform', 500, 'cosmos_error');
  }
}
