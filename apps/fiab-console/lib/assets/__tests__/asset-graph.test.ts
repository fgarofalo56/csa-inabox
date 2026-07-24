/**
 * N5 — lineage → software-defined-asset-graph derivation.
 *
 * The fixture is a REAL-shaped unified-lineage payload: a Purview/UC table
 * collapsed on its `uc:` identity, a Weave notebook process between two tables,
 * a synthetic `col:` column facet (the shape `synthesizeColumnGraph` emits from
 * `ThreadEdge.columnMappings`), and an N4 transformation-project DAG that names
 * one of the same physical tables. The assertions pin the three transformations
 * that make an asset graph out of a lineage graph: grain, process contraction,
 * and identity merge.
 */
import { describe, expect, it } from 'vitest';
import type {
  CanvasLineageEdge, CanvasLineageNode,
} from '@/lib/components/catalog/lineage-canvas';
import type { TransformDag } from '@/lib/transform/transform-dag';
import {
  assetKeyFromIdentity, assetsFromTransformDag, deriveAssetGraph, downstreamClosure,
  isProcessNode, layoutAssetGraph, mergeAssetGraphs, upstreamOf,
} from '../asset-graph';

// ── Fixture: what getUnifiedLineage returns for a real medallion chain ──────
const nodes: CanvasLineageNode[] = [
  {
    id: 'main.bronze.orders_raw',
    label: 'orders_raw',
    type: 'table',
    source: 'unity-catalog',
    identity: 'uc:main.bronze.orders_raw',
    columns: ['order_id'],
  },
  {
    id: 'dbx-entity:NOTEBOOK:abc123',
    label: 'notebook abc123',
    type: 'notebook',
    source: 'unity-catalog',
  },
  {
    id: 'main.silver.orders',
    label: 'orders',
    type: 'table',
    source: 'unity-catalog',
    identity: 'uc:main.silver.orders',
  },
  {
    id: 'abfss://gold@lake.dfs.core.windows.net/Tables/orders_agg',
    label: 'orders_agg',
    type: 'path',
    source: 'purview',
    identity: 'path:abfss://gold@lake.dfs.core.windows.net/tables/orders_agg',
  },
  // Column facet — synthesized `col:<table>::<column>` nodes (L1).
  {
    id: 'col:main.bronze.orders_raw::order_id',
    label: 'order_id',
    type: 'column',
    source: 'weave',
    parentTableId: 'main.bronze.orders_raw',
    columnOf: 'main.bronze.orders_raw',
  },
  {
    id: 'col:abfss://gold@lake.dfs.core.windows.net/Tables/orders_agg::order_id',
    label: 'order_id',
    type: 'column',
    source: 'weave',
    parentTableId: 'abfss://gold@lake.dfs.core.windows.net/Tables/orders_agg',
    columnOf: 'orders_agg',
  },
];

const edges: CanvasLineageEdge[] = [
  { from: 'main.bronze.orders_raw', to: 'dbx-entity:NOTEBOOK:abc123', type: 'produces' },
  { from: 'dbx-entity:NOTEBOOK:abc123', to: 'main.silver.orders', type: 'produces' },
  { from: 'main.silver.orders', to: 'abfss://gold@lake.dfs.core.windows.net/Tables/orders_agg' },
  {
    from: 'col:main.bronze.orders_raw::order_id',
    to: 'col:abfss://gold@lake.dfs.core.windows.net/Tables/orders_agg::order_id',
    kind: 'column',
  },
];

describe('assetKeyFromIdentity', () => {
  it('maps each unified-lineage identity namespace onto an asset key', () => {
    expect(assetKeyFromIdentity('uc:main.silver.orders', 'x')).toBe('table:main.silver.orders');
    expect(assetKeyFromIdentity('path:abfss://gold@l.dfs/x', 'x')).toBe('path:abfss://gold@l.dfs/x');
    expect(assetKeyFromIdentity('item:ITEM-1', 'x')).toBe('item:item-1');
  });

  it('falls back to the node id when the merge produced no identity', () => {
    expect(assetKeyFromIdentity(undefined, 'Some-Node')).toBe('asset:some-node');
  });
});

describe('isProcessNode', () => {
  it('classifies runners as processes and data types as assets', () => {
    expect(isProcessNode({ id: 'a', label: 'a', type: 'notebook', source: 'weave' })).toBe(true);
    expect(isProcessNode({ id: 'a', label: 'a', type: 'databricks_process', source: 'purview' })).toBe(true);
    expect(isProcessNode({ id: 'a', label: 'a', type: 'table', source: 'purview' })).toBe(false);
    expect(isProcessNode({ id: 'a', label: 'a', type: 'materialized-view', source: 'purview' })).toBe(false);
  });
});

describe('deriveAssetGraph', () => {
  const graph = deriveAssetGraph(nodes, edges);

  it('keeps only data-bearing nodes as assets — processes and columns are not assets', () => {
    expect(graph.assets.map((a) => a.key)).toEqual([
      'path:abfss://gold@lake.dfs.core.windows.net/tables/orders_agg',
      'table:main.bronze.orders_raw',
      'table:main.silver.orders',
    ]);
  });

  it('contracts the process out: bronze → silver becomes a DIRECT dep via the notebook', () => {
    const dep = graph.deps.find(
      (d) => d.from === 'table:main.bronze.orders_raw' && d.to === 'table:main.silver.orders',
    );
    expect(dep).toBeDefined();
    expect(dep!.via).toBe('dbx-entity:NOTEBOOK:abc123');
    // …and no dep ever points AT the process node.
    expect(graph.deps.some((d) => d.to.includes('NOTEBOOK'))).toBe(false);
  });

  it('records the contracted process as the downstream asset\'s producer', () => {
    const silver = graph.assets.find((a) => a.key === 'table:main.silver.orders')!;
    expect(silver.producedBy).toContain('notebook abc123');
  });

  it('turns a column→column mapping into a TABLE-grain dep (the columnMappings payoff)', () => {
    const dep = graph.deps.find(
      (d) =>
        d.from === 'table:main.bronze.orders_raw' &&
        d.to === 'path:abfss://gold@lake.dfs.core.windows.net/tables/orders_agg',
    );
    expect(dep).toBeDefined();
    expect(dep!.via).toBe('column-mapping');
  });

  it('folds column nodes back onto their owning asset as columns', () => {
    const gold = graph.assets.find((a) => a.key.startsWith('path:'))!;
    expect(gold.columns).toContain('order_id');
  });

  it('exposes upstream + the transitive downstream blast radius', () => {
    expect(upstreamOf(graph, 'table:main.silver.orders')).toEqual(['table:main.bronze.orders_raw']);
    expect(downstreamClosure(graph, 'table:main.bronze.orders_raw')).toEqual([
      'path:abfss://gold@lake.dfs.core.windows.net/tables/orders_agg',
      'table:main.silver.orders',
    ]);
  });
});

describe('assetsFromTransformDag + mergeAssetGraphs', () => {
  const dag: TransformDag = {
    nodes: [
      {
        id: 'orders',
        name: 'orders',
        kind: 'model',
        layer: 'silver',
        schema: 'main.silver',
        backend: 'sqlmesh',
        upstream: 0,
        downstream: 0,
        asset: {
          key: 'model:main.silver.orders',
          group: 'silver',
          owners: ['data-eng'],
          tags: ['core'],
          materialization: 'incremental',
          cadence: '@daily',
        },
        impact: null,
      },
      {
        id: 'orders_report',
        name: 'orders_report',
        kind: 'model',
        layer: 'gold',
        schema: 'main.gold',
        backend: 'sqlmesh',
        upstream: 1,
        downstream: 0,
        asset: { key: 'model:main.gold.orders_report', group: 'gold', owners: [], tags: [] },
        impact: null,
      },
    ],
    edges: [{ id: 'ref:orders->orders_report', source: 'orders', target: 'orders_report', kind: 'ref' }],
  };

  it('reuses the N4 asset descriptor rather than re-deriving the project graph', () => {
    const g = assetsFromTransformDag(dag, { itemId: 'tp-1', itemHref: '/items/transformation-project/tp-1' });
    const orders = g.assets.find((a) => a.key === 'model:main.silver.orders')!;
    expect(orders.owners).toEqual(['data-eng']);
    expect(orders.tags).toEqual(['core']);
    expect(orders.materialization).toBe('incremental');
    expect(orders.cadenceHint).toBe('@daily');
    expect(orders.openHref).toBe('/items/transformation-project/tp-1');
  });

  it('collapses the N4 model onto the SAME asset as the lineage table (alias merge)', () => {
    const merged = mergeAssetGraphs(
      deriveAssetGraph(nodes, edges),
      assetsFromTransformDag(dag, { itemId: 'tp-1' }),
    );
    // `model:main.silver.orders` and `table:main.silver.orders` are one asset,
    // and the table: namespace wins as the canonical key.
    const keys = merged.assets.map((a) => a.key);
    expect(keys).toContain('table:main.silver.orders');
    expect(keys).not.toContain('model:main.silver.orders');

    const orders = merged.assets.find((a) => a.key === 'table:main.silver.orders')!;
    expect(orders.owners).toEqual(['data-eng']);        // came from the N4 side
    expect(orders.producedBy).toContain('notebook abc123'); // came from the lineage side
    expect(orders.sources.sort()).toEqual(['loom', 'unity-catalog']);

    // The N4 edge was rewritten onto the surviving canonical key.
    expect(
      merged.deps.some(
        (d) => d.from === 'table:main.silver.orders' && d.to === 'model:main.gold.orders_report',
      ),
    ).toBe(true);
  });

  it('never emits a self-loop or a duplicate dep after the merge', () => {
    const merged = mergeAssetGraphs(
      deriveAssetGraph(nodes, edges),
      assetsFromTransformDag(dag, { itemId: 'tp-1' }),
      assetsFromTransformDag(dag, { itemId: 'tp-1' }),
    );
    expect(merged.deps.every((d) => d.from !== d.to)).toBe(true);
    const seen = merged.deps.map((d) => `${d.from}->${d.to}`);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('layoutAssetGraph', () => {
  it('places each asset one column right of its deepest upstream', () => {
    const graph = deriveAssetGraph(nodes, edges);
    const pos = layoutAssetGraph(graph.assets.map((a) => a.key), graph.deps);
    expect(pos['table:main.bronze.orders_raw'].x).toBe(0);
    expect(pos['table:main.silver.orders'].x).toBeGreaterThan(pos['table:main.bronze.orders_raw'].x);
    expect(pos['path:abfss://gold@lake.dfs.core.windows.net/tables/orders_agg'].x)
      .toBeGreaterThan(pos['table:main.silver.orders'].x);
  });

  it('terminates on a cyclic graph (a merged multi-source graph can contain one)', () => {
    const pos = layoutAssetGraph(['a', 'b'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    expect(Object.keys(pos).sort()).toEqual(['a', 'b']);
  });
});
