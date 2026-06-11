/**
 * Vitest — Plan (preview) EPM/CPM helpers (audit-T64).
 *
 * Exercises the pure planning math in lib/editors/_plan-model.ts: cell
 * addressing, row/period/grand totals, scenario branching + deletion, and
 * plan-vs-actual variance. These back the PlanningSheetPanel grid so a UI
 * smoke isn't needed to catch an off-by-one total or a scenario-clone leak.
 */
import { describe, it, expect } from 'vitest';
import {
  cellKey, getCell, rowTotal, periodTotal, grandTotal,
  cloneScenarioCells, dropScenarioCells, computeVariance,
  defaultScenarios, defaultPlanningSheet, type PlanningSheet,
} from '../_plan-model';

function seeded(): PlanningSheet {
  const s = defaultPlanningSheet();
  // revenue: 100/period across q1..q4 (baseline) = 400
  // cogs: 40/period = 160
  for (const p of s.periods) {
    s.cells[cellKey('revenue', p.id, 'baseline')] = 100;
    s.cells[cellKey('cogs', p.id, 'baseline')] = 40;
  }
  return s;
}

describe('_plan-model cell addressing', () => {
  it('cellKey is stable and parseable', () => {
    expect(cellKey('li', 'p', 'sc')).toBe('li|p|sc');
  });
  it('getCell returns 0 for unset / non-finite', () => {
    expect(getCell({}, 'a', 'b', 'c')).toBe(0);
    expect(getCell({ 'a|b|c': 5 }, 'a', 'b', 'c')).toBe(5);
  });
});

describe('_plan-model totals', () => {
  const s = seeded();
  it('rowTotal sums a line item across periods', () => {
    expect(rowTotal(s, 'baseline', 'revenue')).toBe(400);
    expect(rowTotal(s, 'baseline', 'cogs')).toBe(160);
  });
  it('periodTotal sums input line items for a period', () => {
    expect(periodTotal(s, 'baseline', 'q1')).toBe(140); // 100 + 40 (opex unset)
  });
  it('grandTotal sums everything for a scenario', () => {
    expect(grandTotal(s, 'baseline')).toBe(560); // 400 + 160
  });
  it('unknown scenario totals to 0', () => {
    expect(grandTotal(s, 'optimistic')).toBe(0);
  });
});

describe('_plan-model scenarios', () => {
  it('cloneScenarioCells copies one scenario onto a new id without touching the source', () => {
    const s = seeded();
    const cloned = cloneScenarioCells(s.cells, 'baseline', 'optimistic');
    expect(cloned[cellKey('revenue', 'q1', 'optimistic')]).toBe(100);
    expect(cloned[cellKey('revenue', 'q1', 'baseline')]).toBe(100); // source intact
  });
  it('dropScenarioCells removes only the target scenario cells', () => {
    const s = seeded();
    const withOpt = cloneScenarioCells(s.cells, 'baseline', 'optimistic');
    const dropped = dropScenarioCells(withOpt, 'optimistic');
    expect(dropped[cellKey('revenue', 'q1', 'optimistic')]).toBeUndefined();
    expect(dropped[cellKey('revenue', 'q1', 'baseline')]).toBe(100);
  });
  it('defaultScenarios seeds the three standard branches', () => {
    expect(defaultScenarios().map((x) => x.kind)).toEqual(['baseline', 'optimistic', 'pessimistic']);
  });
});

describe('_plan-model variance', () => {
  it('computes delta + pct per input line item', () => {
    const s = seeded();
    const v = computeVariance(s, 'baseline', { revenue: 440, cogs: 150 });
    const rev = v.find((r) => r.lineItemId === 'revenue')!;
    expect(rev.plan).toBe(400);
    expect(rev.actual).toBe(440);
    expect(rev.delta).toBe(40);
    expect(rev.pct).toBeCloseTo(0.1, 5);
    const cogs = v.find((r) => r.lineItemId === 'cogs')!;
    expect(cogs.delta).toBe(-10);
  });
  it('pct is null when plan is 0', () => {
    const s = defaultPlanningSheet();
    const v = computeVariance(s, 'baseline', { revenue: 50 });
    expect(v.find((r) => r.lineItemId === 'revenue')!.pct).toBeNull();
  });
});
