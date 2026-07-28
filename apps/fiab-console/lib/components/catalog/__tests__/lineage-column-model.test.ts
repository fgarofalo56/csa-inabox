/**
 * L5 — column-level lineage UI model tests.
 *
 * Pins the pure semantics behind the canvas fan-out:
 *   - visibility: column nodes hide until their owning table is expanded;
 *     orphan columns (unresolvable parent) are never silently dropped;
 *   - impact walk: restricted to `kind:'column'` edges, downstream vs upstream,
 *     hop distances, and the declared transform on DIRECT edges only;
 *   - `col:` id parsing + column-graph derivation from a bare columnEdges
 *     array (the GET /api/catalog/lineage?columns=true envelope);
 *   - layout: fanned-out columns stack beneath their table (indented) without
 *     overlapping the next table, and column-only connectivity still orders
 *     tables left→right.
 */
import { describe, it, expect } from 'vitest';
import {
  isColumnNode,
  groupColumnsByTable,
  visibleLineageGraph,
  columnAdjacency,
  walkColumns,
  columnImpact,
  parseColumnNodeId,
  deriveColumnGraphFromEdges,
  layoutLineage,
  type ColumnModelNode,
  type ColumnModelEdge,
} from '../lineage-column-model';

const t = (id: string): ColumnModelNode => ({ id, label: id.split('.').pop() || id, type: 'table' });
const c = (table: string, col: string): ColumnModelNode => ({
  id: `col:${table}::${col}`, label: col, type: 'column', parentTableId: table, columnOf: table,
});
const ce = (from: string, to: string, transform?: string): ColumnModelEdge => ({
  from, to, type: 'column', kind: 'column', ...(transform ? { transform } : {}),
});

// raw --id--> customers.customer_id --> gold.customer_key (2-hop chain)
const NODES: ColumnModelNode[] = [
  t('main.bronze.raw'), t('main.bronze.customers'), t('main.gold.dim'),
  c('main.bronze.raw', 'id'),
  c('main.bronze.customers', 'customer_id'),
  c('main.gold.dim', 'customer_key'),
];
const EDGES: ColumnModelEdge[] = [
  { from: 'main.bronze.raw', to: 'main.bronze.customers' },
  { from: 'main.bronze.customers', to: 'main.gold.dim' },
  ce('col:main.bronze.raw::id', 'col:main.bronze.customers::customer_id', 'UPPER(id)'),
  ce('col:main.bronze.customers::customer_id', 'col:main.gold.dim::customer_key'),
];

describe('isColumnNode / groupColumnsByTable', () => {
  it('classifies col: nodes and groups them under their table', () => {
    expect(isColumnNode(c('t', 'x'))).toBe(true);
    expect(isColumnNode(t('t'))).toBe(false);
    const groups = groupColumnsByTable(NODES);
    expect(groups.get('main.bronze.raw')?.map((n) => n.label)).toEqual(['id']);
    expect(groups.get('main.gold.dim')?.map((n) => n.label)).toEqual(['customer_key']);
  });

  it('does not group a column whose parent table is missing (orphan)', () => {
    const orphan = c('ghost.table', 'x');
    const groups = groupColumnsByTable([t('real'), orphan]);
    expect(groups.size).toBe(0);
  });
});

describe('visibleLineageGraph', () => {
  it('hides all column nodes + column edges when nothing is expanded', () => {
    const { nodes, edges } = visibleLineageGraph(NODES, EDGES, new Set());
    expect(nodes.map((n) => n.id)).toEqual(['main.bronze.raw', 'main.bronze.customers', 'main.gold.dim']);
    expect(edges).toHaveLength(2); // table edges only
  });

  it('reveals a table’s columns when expanded; a column edge needs BOTH ends visible', () => {
    const one = visibleLineageGraph(NODES, EDGES, new Set(['main.bronze.raw']));
    expect(one.nodes.some((n) => n.id === 'col:main.bronze.raw::id')).toBe(true);
    // the raw→customers column edge is hidden: its target column is collapsed
    expect(one.edges.filter((e) => e.kind === 'column')).toHaveLength(0);

    const both = visibleLineageGraph(NODES, EDGES, new Set(['main.bronze.raw', 'main.bronze.customers']));
    expect(both.edges.filter((e) => e.kind === 'column')).toHaveLength(1);
  });

  it('never drops an orphan column (unresolvable parent stays visible)', () => {
    const orphan = c('ghost.table', 'x');
    const { nodes } = visibleLineageGraph([t('real'), orphan], [], new Set());
    expect(nodes.some((n) => n.id === orphan.id)).toBe(true);
  });
});

describe('columnAdjacency / walkColumns / columnImpact', () => {
  it('walks ONLY column edges, with hop distances', () => {
    const adj = columnAdjacency(EDGES);
    const down = walkColumns(adj.down, 'col:main.bronze.raw::id');
    expect(down.get('col:main.bronze.customers::customer_id')).toBe(1);
    expect(down.get('col:main.gold.dim::customer_key')).toBe(2);
    // table edges are NOT in the column walk
    expect(down.has('main.bronze.customers')).toBe(false);
  });

  it('columnImpact reports downstream (direct + transitive) with transforms on direct hops', () => {
    const impact = columnImpact(NODES, EDGES, 'col:main.bronze.raw::id');
    expect(impact.downstream.map((d) => [d.label, d.distance])).toEqual([
      ['customer_id', 1], ['customer_key', 2],
    ]);
    expect(impact.directDownstream).toBe(1);
    expect(impact.transitiveDownstream).toBe(1);
    expect(impact.downstream[0].transform).toBe('UPPER(id)');
    expect(impact.downstream[0].tableLabel).toBe('customers');
    expect(impact.downstream[1].transform).toBeUndefined();
    expect(impact.upstream).toHaveLength(0);
  });

  it('columnImpact reports upstream contributors for a mid-chain column', () => {
    const impact = columnImpact(NODES, EDGES, 'col:main.bronze.customers::customer_id');
    expect(impact.upstream.map((d) => d.label)).toEqual(['id']);
    expect(impact.upstream[0].transform).toBe('UPPER(id)');
    expect(impact.downstream.map((d) => d.label)).toEqual(['customer_key']);
  });
});

describe('parseColumnNodeId / deriveColumnGraphFromEdges', () => {
  it('parses the canonical col:<table>::<column> id', () => {
    expect(parseColumnNodeId('col:main.bronze.raw::id')).toEqual({ table: 'main.bronze.raw', column: 'id' });
    expect(parseColumnNodeId('main.bronze.raw')).toBeNull();
    // the table part may itself contain a normalized identity prefix
    expect(parseColumnNodeId('col:uc:main.a.b::x')).toEqual({ table: 'uc:main.a.b', column: 'x' });
  });

  it('derives anchored column nodes from bare columnEdges (case-insensitive table match)', () => {
    const tables = [
      { id: 'Main.Bronze.Raw', source: 'unity-catalog' },
      { id: 'main.bronze.customers', source: 'unity-catalog' },
    ];
    const { nodes, edges } = deriveColumnGraphFromEdges(tables, [
      ce('col:main.bronze.raw::id', 'col:main.bronze.customers::customer_id', '1:1'),
    ]);
    expect(nodes).toHaveLength(2);
    const from = nodes.find((n) => n.id === 'col:main.bronze.raw::id')!;
    expect(from.parentTableId).toBe('Main.Bronze.Raw'); // anchored to the REAL node id
    expect(from.label).toBe('id');
    expect(edges).toHaveLength(1);
    expect(edges[0].transform).toBe('1:1');
  });

  it('skips a column edge whose table cannot be anchored (honest, no floating nodes)', () => {
    const { nodes, edges } = deriveColumnGraphFromEdges(
      [{ id: 'main.bronze.customers', source: 'unity-catalog' }],
      [ce('col:ghost.table::x', 'col:main.bronze.customers::customer_id')],
    );
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});

describe('layoutLineage', () => {
  const OPTS = { colGap: 280, rowGap: 112, columnRowGap: 40, columnIndent: 28 };

  it('keeps the table-grain left→right layering', () => {
    const pos = layoutLineage(
      NODES.filter((n) => !isColumnNode(n)),
      EDGES.filter((e) => e.kind !== 'column'),
      OPTS,
    );
    expect(pos.get('main.bronze.raw')!.x).toBeLessThan(pos.get('main.bronze.customers')!.x);
    expect(pos.get('main.bronze.customers')!.x).toBeLessThan(pos.get('main.gold.dim')!.x);
  });

  it('stacks expanded columns beneath their table, indented, without overlap', () => {
    const nodes = [t('a'), t('b'), c('a', 'x'), c('a', 'y')];
    const edges: ColumnModelEdge[] = [];
    const pos = layoutLineage(nodes, edges, OPTS);
    const table = pos.get('a')!;
    const colX = pos.get('col:a::x')!;
    const colY = pos.get('col:a::y')!;
    expect(colX.x).toBe(table.x + OPTS.columnIndent);
    expect(colX.y).toBeGreaterThan(table.y);
    expect(colY.y).toBeGreaterThan(colX.y);
    // the sibling table in the same layer starts BELOW the whole fan-out
    const sibling = pos.get('b')!;
    const fanBottom = Math.max(colX.y, colY.y);
    // a/b share layer 0 (no edges) — whichever is stacked second must clear the fan-out
    if (sibling.y > table.y) expect(sibling.y).toBeGreaterThan(fanBottom);
  });

  it('orders tables connected ONLY at the column grain left→right (projected layering)', () => {
    const nodes = [t('src'), t('dst'), c('src', 'x'), c('dst', 'y')];
    const edges = [ce('col:src::x', 'col:dst::y')];
    const pos = layoutLineage(nodes, edges, OPTS);
    expect(pos.get('src')!.x).toBeLessThan(pos.get('dst')!.x);
  });
});
