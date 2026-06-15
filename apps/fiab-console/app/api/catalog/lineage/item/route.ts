/**
 * GET /api/catalog/lineage/item?source=...&id=...&type=...&host=...&workspaceId=...&merge=true
 *   Per-item lineage resolver. Returns upstream + downstream items from real relationships.
 *   - onelake: semantic-model→report (admin scan), dataflow→table, pipeline→item, mirror→table
 *   - purview: Atlas relationships
 *   - unity-catalog: table lineage tracking
 *
 *   When `merge=true` the resolver returns the UNIFIED graph: it overlays the
 *   asset's own source with the other Azure-native lineage sources (Purview
 *   Data Map + Unity Catalog + Weave/Thread edges) collapsed by a common asset
 *   identity (see lib/azure/unified-lineage.ts). Per-source gates are reported
 *   in `sources[]` so one source's gate never blanks the graph. Fabric/OneLake
 *   focus assets are NOT unified (the admin scan is opt-in only); they keep the
 *   single-source behaviour below.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getLineageSubgraph, PurviewNotConfiguredError, PurviewError } from '@/lib/azure/purview-client';
import { getTableLineage, UnityCatalogNotConfiguredError, UnityCatalogError } from '@/lib/azure/unity-catalog-client';
import { getWorkspaceLineage, OneLakeError, OneLakeLineageNotSupportedError } from '@/lib/azure/onelake-catalog-client';
import { getFabricItem } from '@/lib/azure/fabric-client';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface CanvasLineageNode { id: string; label: string; type?: string; source: 'purview'|'unity-catalog'|'onelake'|'weave'; focus?: boolean; columns?: string[]; openHref?: string; multiSource?: string[]; identity?: string; }
export interface CanvasLineageEdge { from: string; to: string; type?: string; }

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const source = req.nextUrl.searchParams.get('source');
  const id = req.nextUrl.searchParams.get('id') || '';
  const host = req.nextUrl.searchParams.get('host') || '';
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';
  const merge = req.nextUrl.searchParams.get('merge') === 'true';
  const columnLineage = req.nextUrl.searchParams.get('columns') === 'true';
  const itemId = req.nextUrl.searchParams.get('itemId') || undefined;
  if (!source || !id) return NextResponse.json({ ok: false, error: 'source and id required' }, { status: 400 });

  // Unified merge: overlay the asset's own source with the other Azure-native
  // lineage sources. Fabric/OneLake focus assets stay single-source.
  if (merge && (source === 'purview' || source === 'unity-catalog')) {
    try {
      const result = await getUnifiedLineage({
        session: s,
        purviewGuid: source === 'purview' ? id : undefined,
        ucFullName: source === 'unity-catalog' ? id : undefined,
        ucHost: source === 'unity-catalog' ? (host || undefined) : undefined,
        itemId,
        columnLineage,
      });
      return NextResponse.json({ source, merged: true, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
  }

  try {
    if (source === 'purview') {
      const graph = await getLineageSubgraph(id);
      const nodes: CanvasLineageNode[] = Object.values(graph.guidEntityMap).map((n) => ({ id: n.guid, label: n.displayText || n.guid, type: n.typeName, source: 'purview', focus: n.guid === id }));
      const edges: CanvasLineageEdge[] = graph.relations.map((r) => ({ from: r.fromEntityId, to: r.toEntityId, type: r.relationshipType }));
      return NextResponse.json({ ok: true, source, nodes, edges, focusId: id });
    }
    if (source === 'unity-catalog') {
      if (!host) return NextResponse.json({ ok: false, error: 'host required' }, { status: 400 });
      const ucEdges = await getTableLineage(host, id);
      const seen = new Set<string>();
      const nodes: CanvasLineageNode[] = [];
      const edges: CanvasLineageEdge[] = [];
      for (const e of ucEdges) {
        if (!seen.has(e.source)) { seen.add(e.source); nodes.push({ id: e.source, label: e.source, type: 'table', source: 'unity-catalog', focus: e.source === id }); }
        if (!seen.has(e.target)) { seen.add(e.target); nodes.push({ id: e.target, label: e.target, type: 'table', source: 'unity-catalog', focus: e.target === id }); }
        edges.push({ from: e.source, to: e.target });
      }
      return NextResponse.json({ ok: true, source, nodes, edges, focusId: id });
    }
    if (source === 'onelake') {
      if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
      const [item, wsEdges] = await Promise.all([ getFabricItem(workspaceId, id).catch(() => null), getWorkspaceLineage(workspaceId).catch(() => []) ]);
      const seen = new Set<string>();
      const nodes: CanvasLineageNode[] = [];
      const edges: CanvasLineageEdge[] = [];
      if (item) { seen.add(id); nodes.push({ id, label: item.displayName || id, type: item.type, source: 'onelake', focus: true }); }
      for (const e of wsEdges) {
        if (e.source_item_id === id || e.target_item_id === id) {
          if (!seen.has(e.source_item_id)) { seen.add(e.source_item_id); nodes.push({ id: e.source_item_id, label: e.source_item_id, type: e.source_type, source: 'onelake' }); }
          if (!seen.has(e.target_item_id)) { seen.add(e.target_item_id); nodes.push({ id: e.target_item_id, label: e.target_item_id, type: e.target_type, source: 'onelake' }); }
          edges.push({ from: e.source_item_id, to: e.target_item_id, type: e.source_type === 'Dataflow' ? 'dataflow_output' : undefined });
        }
      }
      if (nodes.length === 0 && item) return NextResponse.json({ ok: true, source, nodes: [{ id, label: item.displayName || id, type: item.type, source: 'onelake', focus: true }], edges: [], focusId: id });
      return NextResponse.json({ ok: true, source, nodes, edges, focusId: id });
    }
    return NextResponse.json({ ok: false, error: 'source must be purview|unity-catalog|onelake' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    if (e instanceof OneLakeLineageNotSupportedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, endpoint: e.endpoint }, { status: 501 });
    const status = e instanceof PurviewError || e instanceof UnityCatalogError || e instanceof OneLakeError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
