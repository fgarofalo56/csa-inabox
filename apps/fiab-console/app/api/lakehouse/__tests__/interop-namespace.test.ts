/**
 * Pure helpers behind the interop namespace. Each assertion names the value a
 * regression would produce.
 */
import { describe, it, expect } from 'vitest';
import {
  NAMESPACE_RE, itemDefaultNamespace, itemNamespaceBase, mergeInteropTables, recordedNamespaceFor,
} from '../_lib/interop-namespace';
import { itemSparkPrefix } from '../_lib/spark-namespace';

const row = (table: string, namespace: string) => ({ table, namespace } as any);

describe('interop namespace helpers', () => {
  it('the item base is the Spark prefix without its trailing underscore', () => {
    const base = itemNamespaceBase('lh-1');
    expect(base).toMatch(/^lh_[0-9a-f]{12}$/);
    expect(`${base}_`).toBe(itemSparkPrefix('lh-1'));
    // Two items never share a base (breaks if the id is not in the digest).
    expect(itemNamespaceBase('lh-2')).not.toBe(base);
  });

  it('adds sanitized sub-folders and drops the table segment', () => {
    const base = itemNamespaceBase('lh-1');
    expect([
      itemDefaultNamespace('lh-1', 'orders'),
      itemDefaultNamespace('lh-1', 'sales/orders'),
      itemDefaultNamespace('lh-1', 'sa les/eu.w/orders'),
    ]).toEqual([base, `${base}.sales`, `${base}.sales.euw`]);
  });

  it('NAMESPACE_RE accepts dotted names and refuses separators and spaces', () => {
    expect(['sales', 'sales.curated', 'lh_0123456789ab', 'a-b.c_d'].map((n) => NAMESPACE_RE.test(n))).toEqual([true, true, true, true]);
    expect(['', '.a', 'a.', 'a..b', 'a/b', 'a b', '-a', 'a.-b'].map((n) => NAMESPACE_RE.test(n))).toEqual(Array(8).fill(false));
  });

  it('merges earlier rows after the item rows, the item row winning on the same table', () => {
    const merged = mergeInteropTables(
      { tables: [row('Orders', 'lh_x')] } as any,
      { tables: [row('orders', 'gold'), row('customers', 'gold')] } as any,
    );
    expect(merged.map((t) => [t.table, t.namespace, !!t.legacy])).toEqual([
      ['Orders', 'lh_x', false],
      ['customers', 'gold', true],
    ]);
    expect(mergeInteropTables(null, null)).toEqual([]);
  });

  it('the recorded namespace comes from the item doc first, then the earlier doc', () => {
    const own = { tables: [row('orders', 'lh_x')] } as any;
    const legacy = { tables: [row('orders', 'gold'), row('customers', 'gold')] } as any;
    expect([
      recordedNamespaceFor(own, legacy, 'orders'),
      recordedNamespaceFor(own, legacy, 'customers'),
      recordedNamespaceFor(own, legacy, 'missing'),
    ]).toEqual(['lh_x', 'gold', '']);
  });
});
