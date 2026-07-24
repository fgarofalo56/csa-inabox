/**
 * N1 — loom-lakehouse-interop doc model: MIG1 registration + the PURE state
 * helpers the Interop tab, the BFF and /admin/catalog all share.
 */
import { describe, it, expect } from 'vitest';
import { hasMigrators } from '../cosmos-migrations';
import {
  LAKEHOUSE_INTEROP_CONTAINER,
  LAKEHOUSE_INTEROP_SCHEMA_VERSION,
  defaultNamespaceFor,
  emptyInteropDoc,
  findTableState,
  icebergExposedCount,
  interopDocId,
  normalizeTableKey,
  tableNameOf,
  upsertTableState,
  type InteropTableState,
} from '../lakehouse-interop-model';

function row(table: string, iceberg: boolean): InteropTableState {
  return {
    table, namespace: 'gold', delta: true, iceberg,
    via: iceberg ? 'delta-uniform' : 'none',
    updatedAt: '2026-07-23T00:00:00.000Z', updatedBy: 'admin@contoso.com',
  };
}

describe('MIG1 registration', () => {
  it('is a v1 container with NO migrator yet (per the convention)', () => {
    expect(LAKEHOUSE_INTEROP_SCHEMA_VERSION).toBe(1);
    expect(hasMigrators(LAKEHOUSE_INTEROP_CONTAINER)).toBe(false);
  });
});

describe('doc identity', () => {
  it('keys one doc per lakehouse container, partitioned by tenant', () => {
    expect(interopDocId('gold')).toBe('interop:gold');
    const d = emptyInteropDoc('oid-1', 'gold');
    expect(d).toMatchObject({
      id: 'interop:gold', tenantId: 'oid-1', docType: 'lakehouse-interop',
      container: 'gold', tables: [], schemaVersion: 1,
    });
  });
});

describe('normalizeTableKey', () => {
  it('strips the structural Tables/ prefix and surrounding slashes', () => {
    expect(normalizeTableKey('/Tables/orders/')).toBe('orders');
    expect(normalizeTableKey('Tables/sales/orders')).toBe('sales/orders');
    expect(normalizeTableKey('orders')).toBe('orders');
  });

  it('rejects traversal and junk so a bad key can never reach a path', () => {
    for (const bad of ['', '   ', '../etc', 'Tables/../secret', 'a b', '?x', undefined, null]) {
      expect(normalizeTableKey(bad as unknown), String(bad)).toBe('');
    }
  });
});

describe('namespace derivation', () => {
  it('uses the container as the namespace for a flat table', () => {
    expect(defaultNamespaceFor('gold', 'orders')).toBe('gold');
  });

  it('appends the schema segments for a schema-enabled lakehouse', () => {
    expect(defaultNamespaceFor('gold', 'sales/orders')).toBe('gold.sales');
    expect(defaultNamespaceFor('gold', 'sales/eu/orders')).toBe('gold.sales.eu');
  });

  it('sanitizes an unusable container name rather than emitting an invalid namespace', () => {
    expect(defaultNamespaceFor('!!!', 'orders')).toBe('default');
  });

  it('takes the last path segment as the Iceberg table id', () => {
    expect(tableNameOf('sales/orders')).toBe('orders');
    expect(tableNameOf('orders')).toBe('orders');
  });
});

describe('upsertTableState', () => {
  it('appends, replaces in place, and keeps rows sorted (deterministic render)', () => {
    let doc = emptyInteropDoc('oid-1', 'gold');
    doc = upsertTableState(doc, row('orders', true));
    doc = upsertTableState(doc, row('customers', false));
    expect(doc.tables.map((t) => t.table)).toEqual(['customers', 'orders']);

    doc = upsertTableState(doc, row('orders', false));
    expect(doc.tables).toHaveLength(2);
    expect(findTableState(doc, 'orders')!.iceberg).toBe(false);
  });

  it('normalizes the key on write so Tables/orders and orders are ONE row', () => {
    let doc = emptyInteropDoc('oid-1', 'gold');
    doc = upsertTableState(doc, row('orders', true));
    doc = upsertTableState(doc, row('Tables/orders', false));
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].table).toBe('orders');
  });

  it('never mutates the input doc', () => {
    const doc = emptyInteropDoc('oid-1', 'gold');
    const next = upsertTableState(doc, row('orders', true));
    expect(doc.tables).toHaveLength(0);
    expect(next.tables).toHaveLength(1);
    expect(next).not.toBe(doc);
  });

  it('stamps the current schema version on every write', () => {
    const next = upsertTableState({ ...emptyInteropDoc('oid-1', 'gold'), schemaVersion: 0 }, row('orders', true));
    expect(next.schemaVersion).toBe(LAKEHOUSE_INTEROP_SCHEMA_VERSION);
  });
});

describe('icebergExposedCount (the /admin overview tile)', () => {
  it('counts only the exposed rows, and is null-safe', () => {
    let doc = emptyInteropDoc('oid-1', 'gold');
    doc = upsertTableState(doc, row('orders', true));
    doc = upsertTableState(doc, row('customers', false));
    doc = upsertTableState(doc, row('events', true));
    expect(icebergExposedCount(doc)).toBe(2);
    expect(icebergExposedCount(null)).toBe(0);
    expect(icebergExposedCount(undefined)).toBe(0);
  });
});
