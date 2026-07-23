/**
 * lineage-extractor — pure extraction core golden tests (loom-next-level L3).
 */
import { describe, it, expect } from 'vitest';
import { readCopyColumnMappings, extractLineageEdges, edgeId, type DatasetEndpoint } from './extract';

const declaredPipeline = {
  name: 'pl_sql_to_lake',
  properties: {
    activities: [
      {
        name: 'CopyOrders',
        type: 'Copy',
        inputs: [{ referenceName: 'ds_sql_orders' }],
        outputs: [{ referenceName: 'ds_lake_orders' }],
        typeProperties: {
          translator: {
            type: 'TabularTranslator',
            mappings: [
              { source: { name: 'OrderId', type: 'Int32' }, sink: { name: 'order_id', type: 'Int64' } },
              { source: { name: 'Total', type: 'Decimal' }, sink: { name: 'total', type: 'Decimal' } },
            ],
          },
        },
      },
    ],
  },
};

describe('readCopyColumnMappings (extractor)', () => {
  it('parses declared mappings with cast transform', () => {
    const [lin] = readCopyColumnMappings(declaredPipeline);
    expect(lin.mappingKind).toBe('declared');
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'OrderId', toColumn: 'order_id', confidence: 'declared', transform: 'CAST(Int32→Int64)' },
      { fromColumn: 'Total', toColumn: 'total', confidence: 'declared' },
    ]);
  });

  it('auto-maps by name (derived) when structures are supplied for a no-translator Copy', () => {
    const def = {
      properties: {
        activities: [
          { name: 'CopyAuto', type: 'Copy', inputs: [{ referenceName: 's' }], outputs: [{ referenceName: 'd' }], typeProperties: { source: {}, sink: {} } },
        ],
      },
    };
    const [lin] = readCopyColumnMappings(def, { s: ['id', 'name'], d: ['ID', 'name'] });
    expect(lin.mappingKind).toBe('derived');
    expect(lin.columnMappings).toEqual([
      { fromColumn: 'id', toColumn: 'ID', confidence: 'derived' },
      { fromColumn: 'name', toColumn: 'name', confidence: 'derived' },
    ]);
  });

  it('no-mapping Copy → table-grain (none)', () => {
    const def = { properties: { activities: [{ name: 'C', type: 'Copy', inputs: [{ referenceName: 's' }], outputs: [{ referenceName: 'd' }], typeProperties: {} }] } };
    const [lin] = readCopyColumnMappings(def);
    expect(lin.mappingKind).toBe('none');
    expect(lin.columnMappings).toEqual([]);
  });
});

describe('extractLineageEdges', () => {
  const endpoints: Record<string, DatasetEndpoint> = {
    ds_sql_orders: { itemId: 'item-src', itemType: 'azure-sql', itemName: 'Orders (SQL)', tenantId: 'tenant-A' },
    ds_lake_orders: { itemId: 'item-dst', itemType: 'lakehouse', itemName: 'Orders (Lake)', tenantId: 'tenant-A' },
  };

  it('produces a column-level edge under the sink tenant', () => {
    const edges = extractLineageEdges(declaredPipeline, endpoints, { runId: 'run-1' });
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.tenantId).toBe('tenant-A');
    expect(e.fromItemId).toBe('item-src');
    expect(e.toItemId).toBe('item-dst');
    expect(e.action).toBe('adf-copy');
    expect(e.runId).toBe('run-1');
    expect(e.pipelineName).toBe('pl_sql_to_lake');
    expect(e.columnMappings).toHaveLength(2);
    expect(e.columnMappings?.[0]).toEqual({ fromColumn: 'OrderId', toColumn: 'order_id', confidence: 'declared', transform: 'CAST(Int32→Int64)' });
  });

  it('skips a Copy when an endpoint does not resolve to a Loom item (no fabricated edges)', () => {
    const partial = { ds_sql_orders: endpoints.ds_sql_orders }; // sink unresolved
    expect(extractLineageEdges(declaredPipeline, partial)).toEqual([]);
  });

  it('records a table-grain edge (no columnMappings) for a translator-less Copy', () => {
    const def = { name: 'pl_bare', properties: { activities: [{ name: 'C', type: 'Copy', inputs: [{ referenceName: 'ds_sql_orders' }], outputs: [{ referenceName: 'ds_lake_orders' }], typeProperties: {} }] } };
    const [e] = extractLineageEdges(def, endpoints);
    expect(e.columnMappings).toBeUndefined();
    expect(e.fromItemId).toBe('item-src');
    expect(e.toItemId).toBe('item-dst');
  });

  it('refuses a cross-tenant edge only when neither endpoint carries a tenant', () => {
    const noTenant = {
      ds_sql_orders: { itemId: 'a' },
      ds_lake_orders: { itemId: 'b' },
    };
    expect(extractLineageEdges(declaredPipeline, noTenant)).toEqual([]);
  });

  it('edgeId is deterministic + sanitized (upsert, never duplicate)', () => {
    const id = edgeId({ tenantId: 'tenant-A', fromItemId: 'item-src', toItemId: 'item-dst', action: 'adf-copy' });
    expect(id).toBe('edge_tenant-A_item-src_item-dst_adf-copy');
    // Re-running the same run yields the same id.
    const edges = extractLineageEdges(declaredPipeline, endpoints);
    expect(edgeId(edges[0])).toBe(id);
  });
});
