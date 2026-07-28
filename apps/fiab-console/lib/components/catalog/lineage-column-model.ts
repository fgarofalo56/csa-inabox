/**
 * lineage-column-model — pure helpers behind the L5 column-level lineage UI
 * (table→column fan-out + column impact analysis) on the lineage canvas.
 *
 * Everything here is deterministic and side-effect free so the fan-out /
 * visibility / impact-walk semantics are unit-testable without mounting the
 * React Flow canvas. The canvas (lineage-canvas.tsx) is the only consumer; the
 * import direction is one-way (canvas → model) so no import cycle is possible.
 *
 * The column data model is the L1 shape produced by
 * lib/azure/unified-lineage.ts `synthesizeColumnGraph`:
 *   - synthetic column nodes  id `col:<table>::<column>`, `parentTableId`
 *     pointing at the owning table node, `type:'column'`;
 *   - column→column edges     `kind:'column'` (optionally carrying the
 *     `transform` expression the source declared).
 *
 * The types below are STRUCTURAL subsets of CanvasLineageNode /
 * CanvasLineageEdge — declared locally (not imported from lineage-canvas) so
 * this file never imports the component module (check-circular-deps).
 */

export interface ColumnModelNode {
  id: string;
  label: string;
  type?: string;
  /** Owning table node id — set on column-grain nodes only (L1). */
  parentTableId?: string;
  columnOf?: string;
}

export interface ColumnModelEdge {
  from: string;
  to: string;
  type?: string;
  /** 'column' marks a column→column edge (L1); absent/table = table grain. */
  kind?: 'table' | 'column';
  /** Optional transform expression the source declared (e.g. "UPPER(x)"). */
  transform?: string;
}

/** True when the node is a column-grain node (L1 `col:` synthetic node). */
export function isColumnNode(n: Pick<ColumnModelNode, 'id' | 'parentTableId' | 'type'>): boolean {
  return !!n.parentTableId || n.type === 'column' || n.id.startsWith('col:');
}

/**
 * Group column nodes by their owning table node id. Only columns whose parent
 * actually exists in the node set are grouped — a column whose parent didn't
 * survive (e.g. a Purview column keyed on an identity string rather than a
 * node id) is treated as a standalone node by the visibility/layout rules.
 */
export function groupColumnsByTable<N extends ColumnModelNode>(nodes: N[]): Map<string, N[]> {
  const tableIds = new Set(nodes.filter((n) => !isColumnNode(n)).map((n) => n.id));
  const byTable = new Map<string, N[]>();
  for (const n of nodes) {
    if (!isColumnNode(n) || !n.parentTableId || !tableIds.has(n.parentTableId)) continue;
    const arr = byTable.get(n.parentTableId) || [];
    arr.push(n);
    byTable.set(n.parentTableId, arr);
  }
  // Stable, readable order inside a fan-out.
  for (const arr of byTable.values()) arr.sort((a, b) => a.label.localeCompare(b.label));
  return byTable;
}

/**
 * Compute the VISIBLE subgraph for a given set of expanded tables:
 *   - table-grain nodes are always visible;
 *   - a column node is visible when its owning table is expanded;
 *   - a column with no resolvable parent stays visible (real lineage is never
 *     silently dropped — it renders as a standalone column node);
 *   - an edge is visible when both endpoints are.
 */
export function visibleLineageGraph<N extends ColumnModelNode, E extends ColumnModelEdge>(
  nodes: N[],
  edges: E[],
  expandedTables: ReadonlySet<string>,
): { nodes: N[]; edges: E[] } {
  const tableIds = new Set(nodes.filter((n) => !isColumnNode(n)).map((n) => n.id));
  const visible = nodes.filter((n) => {
    if (!isColumnNode(n)) return true;
    if (!n.parentTableId || !tableIds.has(n.parentTableId)) return true; // orphan column
    return expandedTables.has(n.parentTableId);
  });
  const ids = new Set(visible.map((n) => n.id));
  return { nodes: visible, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// ---------------------------------------------------------------------------
// Column-grain chain walk (impact analysis)
// ---------------------------------------------------------------------------

export interface ColumnAdjacency {
  up: Map<string, Set<string>>;
  down: Map<string, Set<string>>;
}

/** Adjacency restricted to `kind:'column'` edges — the impact-walk substrate. */
export function columnAdjacency(edges: ColumnModelEdge[]): ColumnAdjacency {
  const up = new Map<string, Set<string>>();
  const down = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  for (const e of edges) {
    if (e.kind !== 'column') continue;
    add(down, e.from, e.to);
    add(up, e.to, e.from);
  }
  return { up, down };
}

/** BFS over one direction of the column adjacency → node id → hop distance. */
export function walkColumns(
  dir: Map<string, Set<string>>,
  start: string,
): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = [start];
  let hop = 0;
  const seen = new Set<string>([start]);
  while (frontier.length) {
    hop += 1;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const nxt of dir.get(cur) || []) {
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        dist.set(nxt, hop);
        next.push(nxt);
      }
    }
    frontier = next;
  }
  return dist;
}

export interface ColumnImpactEntry {
  /** Column node id (`col:<table>::<column>`). */
  id: string;
  /** Column display name. */
  label: string;
  /** Owning table node id (when resolvable). */
  tableId?: string;
  /** Owning table display label (when resolvable). */
  tableLabel?: string;
  /** Hop distance from the analyzed column (1 = direct). */
  distance: number;
  /** Transform expression on the DIRECT edge (1-hop entries only). */
  transform?: string;
}

export interface ColumnImpact {
  upstream: ColumnImpactEntry[];
  downstream: ColumnImpactEntry[];
  directDownstream: number;
  transitiveDownstream: number;
}

/**
 * Impact analysis for one column: every upstream contributor and every
 * downstream dependent along `kind:'column'` edges, with hop distances and the
 * declared transform expression on direct edges — "what breaks if this column
 * changes" (the downstream list) plus "where does it come from" (upstream).
 */
export function columnImpact(
  nodes: ColumnModelNode[],
  edges: ColumnModelEdge[],
  columnId: string,
): ColumnImpact {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = columnAdjacency(edges);
  const directTransform = new Map<string, string>();
  for (const e of edges) {
    if (e.kind !== 'column' || !e.transform) continue;
    if (e.from === columnId) directTransform.set(`down:${e.to}`, e.transform);
    if (e.to === columnId) directTransform.set(`up:${e.from}`, e.transform);
  }
  const toEntries = (dist: Map<string, number>, side: 'up' | 'down'): ColumnImpactEntry[] =>
    [...dist.entries()]
      .map(([id, distance]) => {
        const n = byId.get(id);
        const parent = n?.parentTableId ? byId.get(n.parentTableId) : undefined;
        const transform = distance === 1 ? directTransform.get(`${side}:${id}`) : undefined;
        return {
          id,
          label: n?.label || columnNameFromId(id) || id,
          ...(n?.parentTableId ? { tableId: n.parentTableId } : {}),
          ...(parent ? { tableLabel: parent.label } : n?.columnOf ? { tableLabel: n.columnOf } : {}),
          distance,
          ...(transform ? { transform } : {}),
        };
      })
      .sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label));
  const upstream = toEntries(walkColumns(adj.up, columnId), 'up');
  const downstream = toEntries(walkColumns(adj.down, columnId), 'down');
  return {
    upstream,
    downstream,
    directDownstream: downstream.filter((d) => d.distance === 1).length,
    transitiveDownstream: downstream.filter((d) => d.distance > 1).length,
  };
}

// ---------------------------------------------------------------------------
// `col:` id parsing + column-graph derivation from bare column edges
// ---------------------------------------------------------------------------

/** Parse a canonical `col:<table>::<column>` node id. Null when not one. */
export function parseColumnNodeId(id: string): { table: string; column: string } | null {
  if (!id.startsWith('col:')) return null;
  const sep = id.lastIndexOf('::');
  if (sep <= 4) return null;
  return { table: id.slice(4, sep), column: id.slice(sep + 2) };
}

function columnNameFromId(id: string): string | undefined {
  return parseColumnNodeId(id)?.column;
}

/**
 * Derive column nodes from a bare `columnEdges` array (the
 * GET /api/catalog/lineage?columns=true envelope carries edges only — the
 * node endpoints are canonical `col:<table>::<column>` ids). Each column is
 * anchored to its owning table node by a case-insensitive id match; edges
 * whose table cannot be anchored are skipped (honest — a floating column with
 * no owning table in the graph cannot be drawn as a fan-out).
 */
export function deriveColumnGraphFromEdges<S extends string>(
  tables: Array<{ id: string; source: S }>,
  columnEdges: ColumnModelEdge[],
): {
  nodes: Array<{
    id: string; label: string; type: 'column'; source: S; parentTableId: string; columnOf: string;
  }>;
  edges: ColumnModelEdge[];
} {
  const byLower = new Map(tables.map((t) => [t.id.toLowerCase(), t]));
  const nodes = new Map<string, {
    id: string; label: string; type: 'column'; source: S; parentTableId: string; columnOf: string;
  }>();
  const edges: ColumnModelEdge[] = [];
  const ensure = (id: string): boolean => {
    if (nodes.has(id)) return true;
    const parsed = parseColumnNodeId(id);
    if (!parsed) return false;
    const table = byLower.get(parsed.table.toLowerCase());
    if (!table) return false;
    nodes.set(id, {
      id,
      label: parsed.column,
      type: 'column',
      source: table.source,
      parentTableId: table.id,
      columnOf: parsed.table,
    });
    return true;
  };
  for (const e of columnEdges) {
    if (e.kind !== 'column' && e.type !== 'column') continue;
    if (!ensure(e.from) || !ensure(e.to)) continue;
    edges.push({ ...e, kind: 'column' });
  }
  return { nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------------------
// Layered layout with column fan-out
// ---------------------------------------------------------------------------

export interface LineageLayoutOpts {
  /** Horizontal distance between layers. */
  colGap: number;
  /** Vertical space one table node occupies (node height + gap). */
  rowGap: number;
  /** Vertical space one column node occupies (node height + gap). */
  columnRowGap: number;
  /** Horizontal indent of a fanned-out column under its table. */
  columnIndent: number;
}

/**
 * Deterministic left→right layered layout (longest-path layering, matching the
 * pre-L5 table-grain layout) extended with column fan-out: a visible column
 * node is stacked directly beneath its owning table (indented), consuming
 * vertical space inside the table's layer so nothing overlaps. Column→column
 * edges are projected onto the owning tables for layering so two tables that
 * are connected ONLY at the column grain still order left→right.
 */
export function layoutLineage(
  nodes: ColumnModelNode[],
  edges: ColumnModelEdge[],
  opts: LineageLayoutOpts,
): Map<string, { x: number; y: number }> {
  const tableIds = new Set(nodes.filter((n) => !isColumnNode(n)).map((n) => n.id));
  const byTable = groupColumnsByTable(nodes);
  const grouped = new Set([...byTable.values()].flat().map((n) => n.id));
  // Layout "units": tables + orphan columns (columns with no resolvable parent).
  const units = nodes.filter((n) => !isColumnNode(n) || !grouped.has(n.id));
  const unitIds = new Set(units.map((n) => n.id));
  const parentOf = new Map<string, string>();
  for (const [tid, cols] of byTable) for (const c of cols) parentOf.set(c.id, tid);
  const toUnit = (id: string): string | undefined =>
    unitIds.has(id) ? id : parentOf.get(id);

  // Longest-path layering over unit-projected edges (cap passes for cycles).
  const layer = new Map<string, number>();
  for (const id of unitIds) layer.set(id, 0);
  const projected: Array<{ from: string; to: string }> = [];
  for (const e of edges) {
    const from = toUnit(e.from);
    const to = toUnit(e.to);
    if (!from || !to || from === to) continue;
    projected.push({ from, to });
  }
  for (let pass = 0; pass < Math.min(unitIds.size, 64); pass++) {
    let changed = false;
    for (const e of projected) {
      const next = (layer.get(e.from) ?? 0) + 1;
      if (next > (layer.get(e.to) ?? 0)) { layer.set(e.to, next); changed = true; }
    }
    if (!changed) break;
  }

  // Bucket units by layer, stack each unit + its fanned-out columns.
  const byLayer = new Map<number, string[]>();
  for (const id of unitIds) {
    const l = layer.get(id) ?? 0;
    const arr = byLayer.get(l) || [];
    arr.push(id);
    byLayer.set(l, arr);
  }
  const unitHeight = (id: string): number =>
    (tableIds.has(id) ? opts.rowGap : opts.columnRowGap) +
    (byTable.get(id)?.length || 0) * opts.columnRowGap;

  const heights = new Map<number, number>();
  for (const [l, col] of byLayer) {
    col.sort((a, b) => a.localeCompare(b));
    heights.set(l, col.reduce((acc, id) => acc + unitHeight(id), 0));
  }
  const maxHeight = Math.max(...heights.values(), 1);

  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, col] of byLayer) {
    const x = l * opts.colGap;
    let y = (maxHeight - (heights.get(l) || 0)) / 2; // vertically centre the layer
    for (const id of col) {
      pos.set(id, { x, y });
      y += tableIds.has(id) ? opts.rowGap : opts.columnRowGap;
      for (const c of byTable.get(id) || []) {
        pos.set(c.id, { x: x + opts.columnIndent, y });
        y += opts.columnRowGap;
      }
    }
  }
  return pos;
}
