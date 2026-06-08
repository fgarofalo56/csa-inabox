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
import { itemsContainer, workspacesContainer, labelPropagationContainer } from '@/lib/azure/cosmos-client';
import { computePropagation, type PropagationStatus } from '@/lib/governance/label-propagation';

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
  /** F15 — downstream label-propagation status for this node. */
  propagation?: {
    status: PropagationStatus;
    currentLabel: string;
    expectedLabel: string;
    /** ISO timestamp of the last Function run that wrote this row, if any. */
    lastRunAt?: string;
  };
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

    // 6. F15 — overlay label-propagation status. We compute it LIVE over the
    //    current graph (so the indicator is never empty/stale before the timer
    //    Function runs) and MERGE the persisted state written by the
    //    label-propagation Function (its last-run timestamp = real provenance).
    const live = computePropagation(
      nodes.map((n) => ({ id: n.id, sensitivity: n.sensitivity })),
      edges.map((e) => ({ from: e.from, to: e.to })),
    );
    const liveById = new Map(live.map((r) => [r.itemId, r]));
    let lastRunAt: string | undefined;
    let propagationSource: 'cosmos' | 'live' = 'live';
    try {
      const propC = await labelPropagationContainer();
      const { resources: stored } = await propC.items.query({
        query: 'SELECT c.itemId, c.runAt FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: s.claims.oid }],
      }, { partitionKey: s.claims.oid }).fetchAll();
      const storedRun = new Map<string, string>();
      for (const r of stored as Array<{ itemId: string; runAt?: string }>) {
        if (r.runAt) {
          storedRun.set(r.itemId, r.runAt);
          if (!lastRunAt || r.runAt > lastRunAt) lastRunAt = r.runAt;
        }
      }
      if (stored.length > 0) propagationSource = 'cosmos';
      for (const n of nodes) {
        const rec = liveById.get(n.id);
        if (rec) {
          n.propagation = {
            status: rec.status,
            currentLabel: rec.currentLabel,
            expectedLabel: rec.expectedLabel,
            lastRunAt: storedRun.get(n.id),
          };
        }
      }
    } catch {
      // Container unavailable — still attach the live status so the UI works.
      for (const n of nodes) {
        const rec = liveById.get(n.id);
        if (rec) n.propagation = { status: rec.status, currentLabel: rec.currentLabel, expectedLabel: rec.expectedLabel };
      }
    }

    return NextResponse.json({
      ok: true,
      workspaces: workspaceNodes,
      nodes,
      edges,
      propagation: {
        source: propagationSource,   // 'cosmos' once the timer Function has written state
        lastRunAt: lastRunAt || null,
        pending: live.filter((r) => r.status === 'pending').length,
      },
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
