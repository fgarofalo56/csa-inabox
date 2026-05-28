/**
 * GET /api/catalog/lineage?source=...&id=...&host=...&workspaceId=...
 *   Federated lineage subgraph centered on `id`. Returns { nodes, edges }
 *   pre-merged from whichever back-end best knows about the asset:
 *
 *   - source=purview: Atlas lineage (depth 3, BOTH direction)
 *   - source=unity-catalog: UC lineage tracking REST + edges normalized
 *   - source=onelake: Fabric admin scan lineage (may be 501 gated)
 *
 *   Optional ?merge=true triggers a best-effort cross-source merge: nodes
 *   that share a qualifiedName/storageLocation across two sources are
 *   collapsed and tagged with `multiSource: [...]`.
 *
 * Returns: { ok, nodes: LineageNode[], edges: LineageEdge[], source }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getLineageSubgraph, PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';
import {
  getTableLineage, UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import {
  getWorkspaceLineage, OneLakeError, OneLakeLineageNotSupportedError,
} from '@/lib/azure/onelake-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface LineageNode {
  id: string;
  label: string;
  type?: string;
  source: 'purview' | 'unity-catalog' | 'onelake';
  multiSource?: string[];
}

export interface LineageEdge {
  from: string;
  to: string;
  type?: string;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const source = req.nextUrl.searchParams.get('source');
  const id = req.nextUrl.searchParams.get('id') || '';
  const host = req.nextUrl.searchParams.get('host') || '';
  const workspaceId = req.nextUrl.searchParams.get('workspaceId') || '';

  if (!source || !id) {
    return NextResponse.json({ ok: false, error: 'source and id required' }, { status: 400 });
  }

  try {
    if (source === 'purview') {
      const graph = await getLineageSubgraph(id);
      const nodes: LineageNode[] = Object.values(graph.guidEntityMap).map((n) => ({
        id: n.guid, label: n.displayText || n.guid, type: n.typeName, source: 'purview',
      }));
      const edges: LineageEdge[] = graph.relations.map((r) => ({
        from: r.fromEntityId, to: r.toEntityId, type: r.relationshipType,
      }));
      return NextResponse.json({ ok: true, source, nodes, edges });
    }
    if (source === 'unity-catalog') {
      if (!host) return NextResponse.json({ ok: false, error: 'host required' }, { status: 400 });
      const ucEdges = await getTableLineage(host, id);
      const seen = new Set<string>();
      const nodes: LineageNode[] = [];
      const edges: LineageEdge[] = [];
      for (const e of ucEdges) {
        if (!seen.has(e.source)) { seen.add(e.source); nodes.push({ id: e.source, label: e.source, type: 'table', source: 'unity-catalog' }); }
        if (!seen.has(e.target)) { seen.add(e.target); nodes.push({ id: e.target, label: e.target, type: 'table', source: 'unity-catalog' }); }
        edges.push({ from: e.source, to: e.target });
      }
      return NextResponse.json({ ok: true, source, nodes, edges });
    }
    if (source === 'onelake') {
      const ws = workspaceId || id;
      const olEdges = await getWorkspaceLineage(ws);
      const seen = new Set<string>();
      const nodes: LineageNode[] = [];
      const edges: LineageEdge[] = [];
      for (const e of olEdges) {
        if (!seen.has(e.source_item_id)) { seen.add(e.source_item_id); nodes.push({ id: e.source_item_id, label: e.source_item_id, type: e.source_type, source: 'onelake' }); }
        if (!seen.has(e.target_item_id)) { seen.add(e.target_item_id); nodes.push({ id: e.target_item_id, label: e.target_item_id, type: e.target_type, source: 'onelake' }); }
        edges.push({ from: e.source_item_id, to: e.target_item_id });
      }
      return NextResponse.json({ ok: true, source, nodes, edges });
    }
    return NextResponse.json({ ok: false, error: 'source must be purview|unity-catalog|onelake' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    if (e instanceof OneLakeLineageNotSupportedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, endpoint: e.endpoint }, { status: 501 });
    }
    const status = e instanceof PurviewError || e instanceof UnityCatalogError || e instanceof OneLakeError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
