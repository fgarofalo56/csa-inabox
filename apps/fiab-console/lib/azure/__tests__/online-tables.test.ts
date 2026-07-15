import { describe, it, expect } from 'vitest';
import { buildOnlineTableSpec, isThreePartName, UnityCatalogError } from '../unity-catalog-client';

describe('isThreePartName', () => {
  it('accepts valid catalog.schema.table names', () => {
    expect(isThreePartName('main.sales.orders')).toBe(true);
    expect(isThreePartName('cat_1.sch_2.tbl_3')).toBe(true);
  });
  it('rejects non-three-part or malformed names', () => {
    expect(isThreePartName('sales.orders')).toBe(false);
    expect(isThreePartName('a.b.c.d')).toBe(false);
    expect(isThreePartName('main..orders')).toBe(false);
    expect(isThreePartName('main.sales.orders-x')).toBe(false);
    expect(isThreePartName('')).toBe(false);
  });
});

describe('buildOnlineTableSpec', () => {
  const base = {
    name: 'main.features.customer_online',
    sourceTableFullName: 'main.features.customer',
    primaryKeyColumns: ['customer_id'],
    runMode: 'triggered' as const,
  };

  it('builds a triggered spec', () => {
    const out = buildOnlineTableSpec(base);
    expect(out.name).toBe('main.features.customer_online');
    expect(out.spec.source_table_full_name).toBe('main.features.customer');
    expect(out.spec.primary_key_columns).toEqual(['customer_id']);
    expect(out.spec).toHaveProperty('run_triggered');
    expect(out.spec).not.toHaveProperty('run_continuously');
  });

  it('builds a continuous spec with a timeseries key + full copy', () => {
    const out = buildOnlineTableSpec({ ...base, runMode: 'continuous', timeseriesKey: 'event_ts', performFullCopy: true });
    expect(out.spec).toHaveProperty('run_continuously');
    expect(out.spec).not.toHaveProperty('run_triggered');
    expect(out.spec.timeseries_key).toBe('event_ts');
    expect(out.spec.perform_full_copy).toBe(true);
  });

  it('trims + filters primary-key columns', () => {
    const out = buildOnlineTableSpec({ ...base, primaryKeyColumns: [' customer_id ', '', 'region'] });
    expect(out.spec.primary_key_columns).toEqual(['customer_id', 'region']);
  });

  it('rejects a non-three-part online table name', () => {
    expect(() => buildOnlineTableSpec({ ...base, name: 'features.customer_online' })).toThrow(UnityCatalogError);
  });

  it('rejects a non-three-part source table name', () => {
    expect(() => buildOnlineTableSpec({ ...base, sourceTableFullName: 'customer' })).toThrow(UnityCatalogError);
  });

  it('rejects an empty primary-key set', () => {
    expect(() => buildOnlineTableSpec({ ...base, primaryKeyColumns: ['', '  '] })).toThrow(/primary-key/);
  });

  it('rejects an invalid run mode', () => {
    expect(() => buildOnlineTableSpec({ ...base, runMode: 'bogus' as any })).toThrow(UnityCatalogError);
  });
});
