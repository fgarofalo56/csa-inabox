/**
 * M1 — assessment engine unit tests (pure; the shared substrate M2/M3 consume).
 *
 * Pins: a fixture inventory maps each object to the expected Loom item type +
 * effort; an unknown source object resolves to needs-review WITH a reason (never
 * a fabricated 1:1); and the report totals/rollup are correct.
 */
import { describe, it, expect } from 'vitest';
import {
  assessInventory,
  assessObject,
  MIGRATION_SOURCE_LABELS,
  effortBadgeColor,
  type EnumeratedInventory,
} from '@/lib/migrate/assessment';

describe('assessObject — per-object mapping', () => {
  it('maps a lake table store 1:1 to lakehouse', () => {
    const a = assessObject({ kind: 'lakehouse', name: 'sales' }, 'databricks-uc');
    expect(a.loomItemType).toBe('lakehouse');
    expect(a.effort).toBe('1:1');
    expect(a.reason.length).toBeGreaterThan(0);
  });

  it('maps a relational table to lakehouse but flags needs-review (data copy)', () => {
    const a = assessObject({ kind: 'relational-table', name: 'orders', schema: 'public', database: 'ANALYTICS' }, 'snowflake');
    expect(a.loomItemType).toBe('lakehouse');
    expect(a.effort).toBe('needs-review');
    expect(a.schema).toBe('public');
    expect(a.database).toBe('ANALYTICS');
  });

  it('maps a semantic model / report 1:1 with no Power BI dependency', () => {
    expect(assessObject({ kind: 'semantic-model', name: 'ds' }, 'powerbi')).toMatchObject({ loomItemType: 'semantic-model', effort: '1:1' });
    expect(assessObject({ kind: 'report', name: 'r' }, 'powerbi')).toMatchObject({ loomItemType: 'report', effort: '1:1' });
  });

  it('maps an eventhouse/eventstream to the ADX / Event Hubs Azure-native targets', () => {
    expect(assessObject({ kind: 'eventhouse', name: 'eh' }, 'fabric').loomItemType).toBe('eventhouse');
    expect(assessObject({ kind: 'eventstream', name: 'es' }, 'fabric').loomItemType).toBe('eventstream');
  });

  it('resolves a stored routine to needs-review (no 1:1 Loom item)', () => {
    const a = assessObject({ kind: 'stored-routine', name: 'sp_calc', rawType: 'FUNCTION' }, 'databricks-uc');
    expect(a.loomItemType).toBe('needs-review');
    expect(a.effort).toBe('needs-review');
    expect(a.reason).toMatch(/user-data-function|notebook/);
  });

  it('resolves an UNKNOWN source object to needs-review WITH a reason — never a fake 1:1', () => {
    // A kind the engine does not recognize (deploy skew / a new source object).
    const a = assessObject({ kind: 'something-new' as never, name: 'x' }, 'snowflake');
    expect(a.loomItemType).toBe('needs-review');
    expect(a.effort).toBe('needs-review');
    expect(a.reason).toMatch(/manual review/i);
  });
});

describe('assessInventory — readiness report', () => {
  const inventory: EnumeratedInventory = {
    sourceType: 'fabric',
    sourceLabel: 'Fabric workspace demo',
    objects: [
      { kind: 'lakehouse', name: 'bronze' },
      { kind: 'warehouse', name: 'gold_wh' },
      { kind: 'semantic-model', name: 'sales_model' },
      { kind: 'report', name: 'exec_dash' },
      { kind: 'notebook', name: 'etl' },
      { kind: 'stored-routine', name: 'udf_x' },
      { kind: 'unknown', name: 'mystery' },
    ],
  };

  it('produces per-object rows + correct totals and rollup', () => {
    const report = assessInventory(inventory, '2026-07-24T00:00:00.000Z');
    expect(report.generatedAt).toBe('2026-07-24T00:00:00.000Z');
    expect(report.totals.objects).toBe(7);
    // 1:1 → lakehouse, semantic-model, report, notebook = 4
    expect(report.totals.oneToOne).toBe(4);
    // needs-review → warehouse, stored-routine, unknown = 3
    expect(report.totals.needsReview).toBe(3);
    expect(report.byLoomItemType.lakehouse).toBe(1);
    expect(report.byLoomItemType.warehouse).toBe(1);
    expect(report.byLoomItemType['needs-review']).toBe(2); // stored-routine + unknown
    expect(report.objects).toHaveLength(7);
    expect(report.sourceLabel).toBe('Fabric workspace demo');
  });

  it('is deterministic (same inventory → same report modulo generatedAt)', () => {
    const a = assessInventory(inventory, 'T');
    const b = assessInventory(inventory, 'T');
    expect(a).toEqual(b);
  });

  it('handles an empty inventory without fabricating rows', () => {
    const report = assessInventory({ sourceType: 'snowflake', objects: [] }, 'T');
    expect(report.totals).toEqual({ objects: 0, oneToOne: 0, needsReview: 0 });
    expect(report.objects).toEqual([]);
    expect(report.byLoomItemType).toEqual({});
  });
});

describe('surface helpers', () => {
  it('labels every source type', () => {
    expect(MIGRATION_SOURCE_LABELS.snowflake).toBe('Snowflake');
    expect(MIGRATION_SOURCE_LABELS['databricks-uc']).toMatch(/Unity Catalog/);
  });

  it('colors effort badges by flag', () => {
    expect(effortBadgeColor('1:1')).toBe('success');
    expect(effortBadgeColor('needs-review')).toBe('warning');
  });
});
