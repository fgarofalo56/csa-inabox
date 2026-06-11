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
  flattenPlanCells, filterPlanRows, sortPlanRows,
  periodSeries, linearFit, forecastPeriods, ganttLayout,
  planInsights, applyMappingsToActuals, type PlanSourceMapping,
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

describe('_plan-model PowerTable flatten/filter/sort', () => {
  it('flattenPlanCells emits one row per (input line item × period × scenario)', () => {
    const s = seeded();
    const rows = flattenPlanCells([s], defaultScenarios());
    // 2 input line items with values (revenue, cogs) but opex is also an input → 3 inputs × 4 periods × 3 scenarios.
    expect(rows.length).toBe(3 * 4 * 3);
    const rev = rows.find((r) => r.lineItemId === 'revenue' && r.periodId === 'q1' && r.scenarioId === 'baseline')!;
    expect(rev.value).toBe(100);
    expect(rev.key).toBe(cellKey('revenue', 'q1', 'baseline'));
  });
  it('filterPlanRows matches across labelled columns', () => {
    const rows = flattenPlanCells([seeded()], defaultScenarios());
    expect(filterPlanRows(rows, 'revenue').every((r) => r.lineItem === 'Revenue')).toBe(true);
    expect(filterPlanRows(rows, '').length).toBe(rows.length);
  });
  it('sortPlanRows orders numerically by value', () => {
    const rows = flattenPlanCells([seeded()], defaultScenarios());
    const asc = sortPlanRows(rows, 'value', 'asc');
    expect(asc[0].value).toBeLessThanOrEqual(asc[asc.length - 1].value);
    const desc = sortPlanRows(rows, 'value', 'desc');
    expect(desc[0].value).toBeGreaterThanOrEqual(desc[desc.length - 1].value);
  });
});

describe('_plan-model Intelligence trend/forecast', () => {
  it('periodSeries returns one subtotal point per period', () => {
    const s = seeded();
    const ser = periodSeries(s, 'baseline');
    expect(ser.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(ser[0].value).toBe(140); // 100 + 40
  });
  it('linearFit recovers a known slope/intercept', () => {
    const fit = linearFit([0, 2, 4, 6]); // y = 2x
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.intercept).toBeCloseTo(0, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
  });
  it('linearFit is flat for n<2', () => {
    expect(linearFit([5]).slope).toBe(0);
    expect(linearFit([]).intercept).toBe(0);
  });
  it('forecastPeriods appends horizon flagged points extrapolating the trend', () => {
    const s = defaultPlanningSheet();
    // revenue 100,200,300,400 → period subtotals trend +100/period.
    s.cells[cellKey('revenue', 'q1', 'baseline')] = 100;
    s.cells[cellKey('revenue', 'q2', 'baseline')] = 200;
    s.cells[cellKey('revenue', 'q3', 'baseline')] = 300;
    s.cells[cellKey('revenue', 'q4', 'baseline')] = 400;
    const fc = forecastPeriods(s, 'baseline', 2);
    expect(fc.length).toBe(6);
    expect(fc[4].forecast).toBe(true);
    expect(fc[4].value).toBeCloseTo(500, 5);
    expect(fc[5].value).toBeCloseTo(600, 5);
  });
  it('forecastPeriods with horizon 0 returns the history unchanged', () => {
    const s = seeded();
    expect(forecastPeriods(s, 'baseline', 0).length).toBe(4);
  });
});

describe('_plan-model Gantt layout', () => {
  it('lays out bars as fractions of the project window with dependency offset', () => {
    const bars = ganttLayout([
      { title: 'A', owner: '', due: '2026-01-10', status: 'done' },
      { title: 'B', owner: '', due: '2026-01-20', status: 'doing', dependsOn: 'A' },
    ], '2026-01-15');
    expect(bars.length).toBe(2);
    const b = bars.find((x) => x.title === 'B')!;
    expect(b.hasDep).toBe(true);
    expect(b.startPct).toBeCloseTo(0, 5); // dep A due = project min
    expect(b.widthPct).toBeCloseTo(1, 5);
    expect(b.overdue).toBe(false);
  });
  it('flags overdue not-done tasks', () => {
    const bars = ganttLayout([{ title: 'late', owner: '', due: '2026-01-01', status: 'todo' }], '2026-02-01');
    expect(bars[0].overdue).toBe(true);
  });
});

describe('_plan-model InfoBridge mappings', () => {
  it('applyMappingsToActuals writes mapped current actuals onto line items', () => {
    const mappings: PlanSourceMapping[] = [
      { lineItemId: 'revenue', sourceKind: 'semantic-model', sourceItemId: 'sm1', field: 'TotalRevenue', currentActual: 440 },
      { lineItemId: 'cogs', sourceKind: 'manual' }, // no currentActual → ignored
    ];
    const next = applyMappingsToActuals({ opex: 10 }, mappings);
    expect(next.revenue).toBe(440);
    expect(next.opex).toBe(10); // preserved
    expect(next.cogs).toBeUndefined();
  });
  it('planInsights produces a non-empty narrative', () => {
    const s = seeded();
    const v = computeVariance(s, 'baseline', { revenue: 440 });
    const lines = planInsights(s, 'baseline', v);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toMatch(/variance|period/i);
  });
});
