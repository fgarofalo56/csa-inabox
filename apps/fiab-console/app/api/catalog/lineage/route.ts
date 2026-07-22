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
 *   Optional ?columns=true (L1 column facet) additionally returns a
 *   `columnEdges` array of column-grain edges (`kind:'column'`, endpoints are
 *   synthetic `col:<table>::<column>` ids) and badges each node with its
 *   participating `columns`. Default false → the payload is byte-identical to
 *   the pre-L1 shape (snapshot-tested).
 *
 * Returns: { ok, nodes: LineageNode[], edges: LineageEdge[], source, columnEdges? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getLineageSubgraph, PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';
import {
  getTableLineage, getColumnLineageSystemTables, lineageWarehouseId,
  UnityCatalogNotConfiguredError, UnityCatalogError,
} from '@/lib/azure/unity-catalog-client';
import { synthesizeColumnGraph, type ColumnGraphMember } from '@/lib/azure/unified-lineage';
import type { CanvasLineageEdge } from '@/lib/components/catalog/lineage-canvas';
import {
  getWorkspaceLineage, OneLakeError, OneLakeLineageNotSupportedError,
} from '@/lib/azure/onelake-catalog-client';
import { annotateDeletedLoomNodes } from '@/lib/azure/lineage-gc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface LineageNode {
  id: string;
  label: string;
  type?: string;
  source: 'purview' | 'unity-catalog' | 'onelake';
  multiSource?: string[];
  /** Atlas unique attribute (Purview nodes) — powers the deleted-node guard. */
  qualifiedName?: string;
  /** Set when the node's `loom://` entity no longer maps to a live item (LIN-GC-3). */
  deleted?: boolean;
  /** Columns participating in lineage (L1 column facet) — only populated when
   *  the request opts in via `?columns=true`. */
  columns?: string[];
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
  // L1 column facet — opt-in ONLY. When absent the response payload stays
  // byte-identical to the pre-L1 shape (no columnEdges key, no columns badges).
  const wantColumns = req.nextUrl.searchParams.get('columns') === 'true';

  if (!source || !id) {
    return NextResponse.json({ ok: false, error: 'source and id required' }, { status: 400 });
  }

  try {
    if (source === 'purview') {
      const graph = await getLineageSubgraph(id);
      const nodes: LineageNode[] = Object.values(graph.guidEntityMap).map((n) => ({
        id: n.guid, label: n.displayText || n.guid, type: n.typeName, source: 'purview',
        qualifiedName: n.qualifiedName,
      }));
      // Flag any `loom://` entity whose backing item was deleted so the canvas
      // renders it as a deleted ghost instead of a live node (LIN-GC-3).
      await annotateDeletedLoomNodes(nodes);
      const edges: LineageEdge[] = graph.relations.map((r) => ({
        from: r.fromEntityId, to: r.toEntityId, type: r.relationshipType,
      }));
      // Purview column facets land in L4 — until then the opted-in envelope
      // carries an honest empty columnEdges (no fabricated column lineage).
      return NextResponse.json({ ok: true, source, nodes, edges, ...(wantColumns ? { columnEdges: [] } : {}) });
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
      if (!wantColumns) return NextResponse.json({ ok: true, source, nodes, edges });
      // L1 column facet: real column lineage from the Databricks system tables
      // (`system.access.column_lineage`) when a lineage warehouse is wired.
      // Best-effort — a column-lineage gate must NOT blank the table graph.
      const columnEdges: CanvasLineageEdge[] = [];
      const warehouseId = lineageWarehouseId();
      if (warehouseId) {
        try {
          const col = await getColumnLineageSystemTables(host, id, warehouseId);
          for (const [table, cols] of Object.entries(col.columnsByTable)) {
            const n = nodes.find((x) => x.id.toLowerCase() === table);
            if (n) n.columns = [...new Set([...(n.columns || []), ...cols])];
          }
          const members: ColumnGraphMember[] = col.edges.map((ce) => ({
            fromTable: ce.sourceTable, fromColumn: ce.sourceColumn,
            toTable: ce.targetTable, toColumn: ce.targetColumn,
            confidence: 'declared' as const, source: 'unity-catalog' as const,
          }));
          columnEdges.push(...synthesizeColumnGraph(members).edges);
        } catch {
          // Column lineage unavailable (system.access.column_lineage gate) —
          // the table-grain graph stands on its own; no fabricated columns.
        }
      }
      return NextResponse.json({ ok: true, source, nodes, edges, columnEdges });
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
      // OneLake admin scan carries no column grain — honest empty when opted in.
      return NextResponse.json({ ok: true, source, nodes, edges, ...(wantColumns ? { columnEdges: [] } : {}) });
    }
    return NextResponse.json({ ok: false, error: 'source must be purview|unity-catalog|onelake' }, { status: 400 });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    if (e instanceof OneLakeLineageNotSupportedError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint, endpoint: e.endpoint }, { status: 501 });
    }
    // Honest Purview data-plane RBAC gate (audit B11): LOOM_PURVIEW_ACCOUNT is set
    // but the Console UAMI lacks an Atlas/Data Curator|Reader role on the
    // collection → Purview returns 403 "Not authorized to access account". Render
    // it as a remediation gate instead of a raw error.
    if (e instanceof PurviewError && (e.status === 403 || e.status === 401)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'purview_rbac_required',
          error: 'The Console UAMI is not authorized on the Purview account (data-plane RBAC).',
          gate: {
            reason: 'Federated Purview lineage needs a Purview data-plane role on the collection.',
            remediation:
              'In the Microsoft Purview governance portal, grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the ' +
              '"Data Curator" (or at least "Data Reader") role on the root collection (Data Map → Collections → ' +
              'Role assignments). LOOM_PURVIEW_ACCOUNT is already set; only the data-plane role is missing.',
          },
        },
        { status: 503 },
      );
    }
    const status = e instanceof PurviewError || e instanceof UnityCatalogError || e instanceof OneLakeError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status || 500 });
  }
}
