import { describe, it, expect } from 'vitest';
import {
  assembleFinopsTiles,
  budgetBurnState,
  worstBudget,
  anomalyFeed,
  type FinopsSummaryInput,
} from '../finops-view';
import type { CostAnomaly } from '@/lib/azure/cost-anomaly-core';
import type { CostBudget } from '@/lib/azure/cost-client';

const budget = (name: string, percentUsed: number): CostBudget => ({
  name, subscription: 's', amount: 100, currentSpend: percentUsed, percentUsed, timeGrain: 'Monthly', scope: 'Cost',
});
const anom = (severity: 'high' | 'medium'): CostAnomaly => ({
  date: '2026-07-15', cost: 900, expected: 100, deviationPct: 800, severity,
});

describe('budgetBurnState', () => {
  it('maps percentUsed to intent', () => {
    expect(budgetBurnState({ percentUsed: 10 })).toBe('success');
    expect(budgetBurnState({ percentUsed: 85 })).toBe('warning');
    expect(budgetBurnState({ percentUsed: 120 })).toBe('error');
  });
});

describe('worstBudget', () => {
  it('returns the most-consumed budget, or null', () => {
    expect(worstBudget([])).toBeNull();
    expect(worstBudget([budget('a', 10), budget('b', 90)])!.name).toBe('b');
  });
});

describe('assembleFinopsTiles', () => {
  const base: FinopsSummaryInput = {
    currency: 'USD', monthToDate: 1234.5, forecast: 3000, forecastMethod: 'api',
    trendPct: 12, anomalies: [], budgets: [],
  };

  it('builds four KPI tiles with derived values (no hard-coded numbers)', () => {
    const tiles = assembleFinopsTiles(base);
    expect(tiles.map((t) => t.key)).toEqual(['mtd', 'forecast', 'anomalies', 'budgets']);
    expect(tiles[0].value).toContain('1,234.50');
    expect(tiles[1].caption).toBe('method: api');
    expect(tiles[2].intent).toBe('success'); // no anomalies
    expect(tiles[3].caption).toBe('none configured');
  });

  it('flags high-severity anomalies as error intent', () => {
    const tiles = assembleFinopsTiles({ ...base, anomalies: [anom('high'), anom('medium')] });
    const a = tiles.find((t) => t.key === 'anomalies')!;
    expect(a.value).toBe('2');
    expect(a.intent).toBe('error');
    expect(a.caption).toContain('1 high-severity');
  });

  it('reflects the worst budget burn on the budgets tile', () => {
    const tiles = assembleFinopsTiles({ ...base, budgets: [budget('a', 30), budget('over', 110)] });
    const b = tiles.find((t) => t.key === 'budgets')!;
    expect(b.value).toBe('2');
    expect(b.intent).toBe('error');
    expect(b.caption).toContain('over');
  });

  it('warns on a steep spend trend', () => {
    const tiles = assembleFinopsTiles({ ...base, trendPct: 40 });
    expect(tiles[0].intent).toBe('warning');
  });
});

describe('anomalyFeed', () => {
  it('flattens per-scope anomalies most-severe-first', () => {
    const rows = anomalyFeed({ all: [anom('medium')], 'sub-1': [anom('high')] });
    expect(rows).toHaveLength(2);
    expect(rows[0].severity).toBe('high');
    expect(rows[0].scope).toBe('sub-1');
  });
});
