/**
 * GET /api/governance/lineage
 *   Returns a node/edge graph of the caller's tenant items.
 *   Edges derive from typed references in item.state:
 *     - lakehouseId, warehouseId, datasetId, datasourceId, sourceItemId
 *     - attachedSources[].id (notebooks)
 *     - reportId (dashboards / scorecards)
 *
 * This is the FALLBACK rendering when Microsoft Purview isn't bound. If
 * Purview IS bound (tenant-settings purview.bound = true), a future
 * iteration will fan out to the Purview Catalog REST and merge.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REFERENCE_KEYS = [
  'lakehouseId', 'warehouseId', 'datasetId', 'datasourceId',
  'sourceItemId', 'targetItemId', 'sourceLakehouseId', 'sourceWarehouseId',
  'reportId', 'modelId', 'kqlDatabaseId', 'pipelineId',
];

interface LineageNode {
  id: string;
  label: string;
  type: string;
  workspaceId: string;
  classifications?: string[];
  sensitivity?: string;
}
interface LineageEdge {
  from: string;
  to: string;
  /** Why the edge exists — which state key linked the two. */
  via: string;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const wsC = await workspacesContainer();
    const itC = await itemsContainer();

    // 1. List workspaces in this tenant
    const { resources: workspaces } = await wsC.items.query({
      query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: s.claims.oid }],
    }, { partitionKey: s.claims.oid }).fetchAll();

    // 2. Across all workspaces, list every item (cross-partition fanout is fine
    //    for governance views; expected order of magnitude ≤ thousands per tenant)
    const wsIds = new Set(workspaces.map((w: any) => w.id));
    const { resources: items } = await itC.items.query({
      query: 'SELECT c.id, c.workspaceId, c.itemType, c.displayName, c.state FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
      parameters: [{ name: '@w', value: Array.from(wsIds) }],
    }).fetchAll();

    // 3. Build nodes
    const nodes: LineageNode[] = items.map((i: any) => ({
      id: i.id,
      label: i.displayName,
      type: i.itemType,
      workspaceId: i.workspaceId,
      classifications: i.state?.classifications,
      sensitivity: i.state?.sensitivityLabel,
    }));
    const nodeIds = new Set(nodes.map((n) => n.id));

    // 4. Build edges by scanning each item's state for known reference keys
    const edges: LineageEdge[] = [];
    for (const it of items) {
      const st = (it.state || {}) as Record<string, unknown>;
      for (const k of REFERENCE_KEYS) {
        const v = st[k];
        if (typeof v === 'string' && v && nodeIds.has(v) && v !== it.id) {
          edges.push({ from: v, to: it.id, via: k });
        }
      }
      // Notebook attached sources
      const attached = st.attachedSources as Array<{ id?: string; kind?: string }> | undefined;
      if (Array.isArray(attached)) {
        for (const a of attached) {
          if (a?.id && nodeIds.has(a.id) && a.id !== it.id) {
            edges.push({ from: a.id, to: it.id, via: 'attachedSource' });
          }
        }
      }
      // Pipeline activities can reference notebooks / lakehouses
      const pipelineRefs = st.activityRefs as string[] | undefined;
      if (Array.isArray(pipelineRefs)) {
        for (const r of pipelineRefs) {
          if (typeof r === 'string' && nodeIds.has(r) && r !== it.id) {
            edges.push({ from: r, to: it.id, via: 'pipelineActivity' });
          }
        }
      }
    }

    // 5. Workspace nodes (composite) — show as section labels
    const workspaceNodes = workspaces.map((w: any) => ({
      id: `ws:${w.id}`, label: w.name, type: 'workspace', workspaceId: w.id,
    }));

    return NextResponse.json({
      ok: true,
      workspaces: workspaceNodes,
      nodes,
      edges,
      counts: {
        workspaces: workspaces.length,
        items: items.length,
        edges: edges.length,
      },
      source: 'cosmos', // 'purview' once binding lands
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
