/**
 * M2 — copy-in PLAN builder unit tests (pure; consumes M1's readiness report).
 *
 * Pins: copyable TABLE objects (relational tables + lakehouse/warehouse tables)
 * become copy targets with a safe managed-Delta name + landing segment; every
 * non-table object is SKIPPED with an honest reason (never a fabricated copy);
 * target-table names de-duplicate; totals roll up correctly.
 */
import { describe, it, expect } from 'vitest';
import { assessInventory, type EnumeratedInventory } from '@/lib/migrate/assessment';
import {
  buildCopyInPlan, landingSegmentFor, targetTableNameFor, COPYABLE_SOURCE_KINDS,
} from '@/lib/migrate/copy-plan';

const INVENTORY: EnumeratedInventory = {
  sourceType: 'snowflake',
  sourceLabel: 'ACME account',
  objects: [
    { kind: 'relational-table', name: 'Orders', schema: 'sales', database: 'ANALYTICS' },
    { kind: 'relational-table', name: 'Orders', schema: 'ops', database: 'ANALYTICS' }, // name collision
    { kind: 'lakehouse', name: 'events' },
    { kind: 'warehouse', name: 'dw_facts', schema: 'dbo' },
    { kind: 'sql-view', name: 'v_active', schema: 'sales' },        // → skipped (M3)
    { kind: 'stored-routine', name: 'sp_refresh', schema: 'sales' }, // → skipped (M3)
    { kind: 'report', name: 'Exec dashboard' },                      // → skipped (renderer)
    { kind: 'notebook', name: 'etl' },                               // → skipped (notebook migrator)
  ],
};

describe('buildCopyInPlan', () => {
  const report = assessInventory(INVENTORY, '2026-07-24T00:00:00.000Z');
  const plan = buildCopyInPlan(report, { now: '2026-07-24T00:00:00.000Z' });

  it('includes only copyable table objects', () => {
    expect(plan.totals.copyable).toBe(4); // 2 relational + 1 lakehouse + 1 warehouse
    for (const o of plan.objects) {
      expect(COPYABLE_SOURCE_KINDS.has(o.source.sourceKind)).toBe(true);
    }
  });

  it('skips non-table objects with an honest reason', () => {
    expect(plan.totals.skipped).toBe(4); // view + routine + report + notebook
    for (const s of plan.skipped) {
      expect(s.reason.length).toBeGreaterThan(10);
    }
    const view = plan.skipped.find((s) => s.sourceKind === 'sql-view');
    expect(view?.reason).toMatch(/M3|code translation/i);
  });

  it('de-duplicates target table names across a collision', () => {
    const names = plan.objects.map((o) => o.targetTable);
    expect(new Set(names).size).toBe(names.length);
  });

  it('routes warehouse-mapped objects to the warehouse target kind', () => {
    const wh = plan.objects.find((o) => o.source.name === 'dw_facts');
    expect(wh?.targetKind).toBe('warehouse');
    const lh = plan.objects.find((o) => o.source.name === 'events');
    expect(lh?.targetKind).toBe('lakehouse');
  });

  it('carries a stable landing segment and by-name column mapping', () => {
    const first = plan.objects[0];
    expect(first.landingSegment).toBe('ANALYTICS.sales.Orders');
    expect(first.columnMapping).toBe('by-name');
  });

  it('is deterministic (same report → same plan)', () => {
    const again = buildCopyInPlan(report, { now: '2026-07-24T00:00:00.000Z' });
    expect(again).toEqual(plan);
  });
});

describe('landingSegmentFor / targetTableNameFor', () => {
  it('joins present parts with dots, dropping empties', () => {
    expect(landingSegmentFor({ name: 't' })).toBe('t');
    expect(landingSegmentFor({ database: 'db', schema: 's', name: 't' })).toBe('db.s.t');
    expect(landingSegmentFor({ schema: 's', name: 't' })).toBe('s.t');
  });

  it('produces valid, unique Delta table names', () => {
    const used = new Set<string>();
    const a = targetTableNameFor({ schema: 'sales', name: 'Orders' }, used);
    const b = targetTableNameFor({ schema: 'ops', name: 'Orders' }, used);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(b).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
