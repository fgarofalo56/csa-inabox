/**
 * dbt-manifest-lineage — unit tests for the PURE manifest→lineage parser (L6).
 *
 * The fixtures are real (minimal) dbt Core `manifest.json` shapes exercised as
 * JSON strings through `parseManifestJson` so the tests prove the parser handles
 * genuine manifest bytes, not a hand-built object. Deterministic expected edges
 * (table-grain + derived column mappings), plus the ephemeral `ref()`-cycle
 * case the parser must resolve without spinning.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDbtManifestLineage, parseManifestJson, physicalRelation,
  type DbtManifest, type DbtCatalog,
} from '../dbt-manifest-lineage';

// A realistic small medallion project:
//   raw.orders (source, bronze)
//     → stg_orders (view, silver)                     [ref of source]
//         → dim_customers (table, gold)               [ref of stg]
//         → fct_orders (table, gold)                  [ref of stg + ephemeral]
//   int_ephemeral (ephemeral, reads source) inlined into fct_orders
//   a `test` node that must be ignored entirely.
const MANIFEST_JSON = JSON.stringify({
  nodes: {
    'model.shop.stg_orders': {
      resource_type: 'model',
      unique_id: 'model.shop.stg_orders',
      name: 'stg_orders',
      relation_name: '`analytics`.`silver`.`stg_orders`',
      config: { materialized: 'view' },
      columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' }, amount: { name: 'amount' } },
      depends_on: { nodes: ['source.shop.raw.orders'], macros: [] },
    },
    'model.shop.dim_customers': {
      resource_type: 'model',
      unique_id: 'model.shop.dim_customers',
      name: 'dim_customers',
      // No relation_name → database.schema.identifier fallback.
      database: 'analytics',
      schema: 'gold',
      identifier: 'dim_customers',
      config: { materialized: 'table' },
      columns: { customer_id: { name: 'customer_id' }, name: { name: 'name' } },
      depends_on: { nodes: ['model.shop.stg_orders'], macros: [] },
    },
    'model.shop.fct_orders': {
      resource_type: 'model',
      unique_id: 'model.shop.fct_orders',
      name: 'fct_orders',
      relation_name: '"analytics"."gold"."fct_orders"',
      config: { materialized: 'table' },
      columns: {
        order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' },
        amount: { name: 'amount' }, total: { name: 'total' },
      },
      depends_on: { nodes: ['model.shop.stg_orders', 'model.shop.int_ephemeral'], macros: [] },
    },
    'model.shop.int_ephemeral': {
      resource_type: 'model',
      unique_id: 'model.shop.int_ephemeral',
      name: 'int_ephemeral',
      config: { materialized: 'ephemeral' },
      columns: { order_id: { name: 'order_id' } },
      depends_on: { nodes: ['source.shop.raw.orders'], macros: [] },
    },
    'test.shop.not_null_stg_orders_order_id': {
      resource_type: 'test',
      unique_id: 'test.shop.not_null_stg_orders_order_id',
      name: 'not_null_stg_orders_order_id',
      depends_on: { nodes: ['model.shop.stg_orders'], macros: [] },
    },
  },
  sources: {
    'source.shop.raw.orders': {
      resource_type: 'source',
      unique_id: 'source.shop.raw.orders',
      name: 'orders',
      relation_name: '`analytics`.`bronze`.`orders`',
      columns: { order_id: { name: 'order_id' }, customer_id: { name: 'customer_id' }, amount: { name: 'amount' } },
    },
  },
});

/** Index emitted edges by "from->to" for order-independent assertions. */
function byPair(edges: ReturnType<typeof parseDbtManifestLineage>) {
  const m = new Map<string, (typeof edges)[number]>();
  for (const e of edges) m.set(`${e.fromItemId}->${e.toItemId}`, e);
  return m;
}

describe('parseDbtManifestLineage — table-grain DAG', () => {
  const manifest = parseManifestJson(MANIFEST_JSON) as DbtManifest;
  const edges = parseDbtManifestLineage(manifest);
  const pairs = byPair(edges);

  it('parses the manifest JSON string into a DbtManifest', () => {
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest.nodes || {})).toContain('model.shop.fct_orders');
  });

  it('emits exactly the expected physical-relation edges (deterministic)', () => {
    expect([...pairs.keys()].sort()).toEqual([
      'analytics.bronze.orders->analytics.gold.fct_orders', // via inlined ephemeral
      'analytics.bronze.orders->analytics.silver.stg_orders',
      'analytics.silver.stg_orders->analytics.gold.dim_customers',
      'analytics.silver.stg_orders->analytics.gold.fct_orders',
    ]);
  });

  it('ignores test resource types (no lineage from tests)', () => {
    for (const e of edges) {
      expect(e.fromType).not.toBe('test');
      expect(e.toType).not.toBe('test');
    }
  });

  it('strips adapter quoting from relation_name and falls back to db.schema.identifier', () => {
    const src = pairs.get('analytics.bronze.orders->analytics.silver.stg_orders');
    expect(src?.fromName).toBe('orders');
    expect(src?.toName).toBe('stg_orders');
    // dim_customers has no relation_name → assembled from database.schema.identifier.
    expect(pairs.has('analytics.silver.stg_orders->analytics.gold.dim_customers')).toBe(true);
  });

  it('maps materializations to node types (view / table)', () => {
    const toStg = pairs.get('analytics.bronze.orders->analytics.silver.stg_orders');
    expect(toStg?.toType).toBe('view'); // stg_orders is a view
    const toDim = pairs.get('analytics.silver.stg_orders->analytics.gold.dim_customers');
    expect(toDim?.toType).toBe('table');
    expect(toDim?.fromType).toBe('view'); // parent stg_orders is still a view
  });

  it('stamps the default action (overridable)', () => {
    expect(edges.every((e) => e.action === 'dbt-model')).toBe(true);
    const custom = parseDbtManifestLineage(manifest, { action: 'dbt-build' });
    expect(custom.every((e) => e.action === 'dbt-build')).toBe(true);
  });
});

describe('parseDbtManifestLineage — derived column mappings', () => {
  const manifest = parseManifestJson(MANIFEST_JSON) as DbtManifest;
  const pairs = byPair(parseDbtManifestLineage(manifest));

  it('emits identity (name-matched) column mappings where both endpoints declare columns', () => {
    const toStg = pairs.get('analytics.bronze.orders->analytics.silver.stg_orders');
    expect(toStg?.columnMappings).toEqual([
      { fromColumn: 'order_id', toColumn: 'order_id', confidence: 'derived' },
      { fromColumn: 'customer_id', toColumn: 'customer_id', confidence: 'derived' },
      { fromColumn: 'amount', toColumn: 'amount', confidence: 'derived' },
    ]);
  });

  it('only maps the shared columns (dim_customers shares just customer_id)', () => {
    const toDim = pairs.get('analytics.silver.stg_orders->analytics.gold.dim_customers');
    expect(toDim?.columnMappings).toEqual([
      { fromColumn: 'customer_id', toColumn: 'customer_id', confidence: 'derived' },
    ]);
  });

  it('carries column mappings across an inlined ephemeral parent', () => {
    const inlined = pairs.get('analytics.bronze.orders->analytics.gold.fct_orders');
    expect(inlined).toBeTruthy();
    // source(order_id,customer_id,amount) ∩ fct(order_id,customer_id,amount,total)
    expect(inlined?.columnMappings?.map((m) => m.toColumn).sort()).toEqual(
      ['amount', 'customer_id', 'order_id'],
    );
  });
});

describe('parseDbtManifestLineage — ref() cycle safety (ephemeral)', () => {
  // eph_a ⇄ eph_b form a ref() cycle; `final` reads eph_a; source feeds eph_a.
  const CYCLE_JSON = JSON.stringify({
    nodes: {
      'model.s.eph_a': {
        resource_type: 'model', unique_id: 'model.s.eph_a', name: 'eph_a',
        config: { materialized: 'ephemeral' },
        depends_on: { nodes: ['model.s.eph_b', 'source.s.raw.t'], macros: [] },
      },
      'model.s.eph_b': {
        resource_type: 'model', unique_id: 'model.s.eph_b', name: 'eph_b',
        config: { materialized: 'ephemeral' },
        depends_on: { nodes: ['model.s.eph_a'], macros: [] }, // back-edge (cycle)
      },
      'model.s.final': {
        resource_type: 'model', unique_id: 'model.s.final', name: 'final',
        relation_name: '`analytics`.`gold`.`final`',
        config: { materialized: 'table' },
        columns: { id: { name: 'id' } },
        depends_on: { nodes: ['model.s.eph_a'], macros: [] },
      },
    },
    sources: {
      'source.s.raw.t': {
        resource_type: 'source', unique_id: 'source.s.raw.t', name: 't',
        relation_name: '`analytics`.`bronze`.`t`',
        columns: { id: { name: 'id' } },
      },
    },
  });

  it('resolves through the cycle to the concrete source without hanging', () => {
    const manifest = parseManifestJson(CYCLE_JSON) as DbtManifest;
    const edges = parseDbtManifestLineage(manifest);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromItemId).toBe('analytics.bronze.t');
    expect(edges[0].toItemId).toBe('analytics.gold.final');
    expect(edges[0].columnMappings).toEqual([
      { fromColumn: 'id', toColumn: 'id', confidence: 'derived' },
    ]);
  });

  it('drops a self-referencing node (no self-loop edge)', () => {
    const SELF_JSON = JSON.stringify({
      nodes: {
        'model.s.loop': {
          resource_type: 'model', unique_id: 'model.s.loop', name: 'loop',
          relation_name: '`a`.`b`.`loop`', config: { materialized: 'table' },
          depends_on: { nodes: ['model.s.loop'], macros: [] },
        },
      },
      sources: {},
    });
    const manifest = parseManifestJson(SELF_JSON) as DbtManifest;
    expect(parseDbtManifestLineage(manifest)).toEqual([]);
  });
});

describe('parseDbtManifestLineage — catalog.json enrichment', () => {
  // Child declares NO columns in the manifest; catalog.json supplies them.
  const MANIFEST_NO_COLS = JSON.stringify({
    nodes: {
      'model.c.mart': {
        resource_type: 'model', unique_id: 'model.c.mart', name: 'mart',
        relation_name: '`db`.`gold`.`mart`', config: { materialized: 'table' },
        depends_on: { nodes: ['source.c.raw.src'], macros: [] },
      },
    },
    sources: {
      'source.c.raw.src': {
        resource_type: 'source', unique_id: 'source.c.raw.src', name: 'src',
        relation_name: '`db`.`bronze`.`src`',
        columns: { id: { name: 'id' }, val: { name: 'val' } },
      },
    },
  });
  const catalog: DbtCatalog = {
    nodes: { 'model.c.mart': { columns: { id: { name: 'id' }, extra: { name: 'extra' } } } },
    sources: {},
  };

  it('has no column mappings without the catalog', () => {
    const manifest = parseManifestJson(MANIFEST_NO_COLS) as DbtManifest;
    const edges = parseDbtManifestLineage(manifest);
    expect(edges).toHaveLength(1);
    expect(edges[0].columnMappings).toBeUndefined();
  });

  it('derives the shared column once the catalog supplies the child columns', () => {
    const manifest = parseManifestJson(MANIFEST_NO_COLS) as DbtManifest;
    const edges = parseDbtManifestLineage(manifest, { catalog });
    expect(edges[0].columnMappings).toEqual([
      { fromColumn: 'id', toColumn: 'id', confidence: 'derived' },
    ]);
  });
});

describe('physicalRelation / parseManifestJson helpers', () => {
  it('physicalRelation prefers relation_name (quotes stripped)', () => {
    expect(physicalRelation({ relation_name: '[db].[sch].[tbl]' })).toBe('db.sch.tbl');
    expect(physicalRelation({ relation_name: '"D"."S"."T"' })).toBe('D.S.T');
  });

  it('physicalRelation falls back to db.schema.identifier and returns "" when empty', () => {
    expect(physicalRelation({ database: 'd', schema: 's', identifier: 't' })).toBe('d.s.t');
    expect(physicalRelation({ database: 'd', schema: 's', name: 'n' })).toBe('d.s.n');
    expect(physicalRelation({})).toBe('');
  });

  it('parseManifestJson accepts objects and strings, rejects non-manifests', () => {
    expect(parseManifestJson('{"nodes":{}}')).toEqual({ nodes: {} });
    expect(parseManifestJson({ sources: {} })).toEqual({ sources: {} });
    expect(parseManifestJson('not json')).toBeNull();
    expect(parseManifestJson({ foo: 1 })).toBeNull();
    expect(parseManifestJson(null)).toBeNull();
  });
});
