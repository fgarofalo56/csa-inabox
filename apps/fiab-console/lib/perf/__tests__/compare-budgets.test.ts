import { describe, it, expect } from 'vitest';
import {
  evaluateBudgets,
  baselineMedians,
  median,
  rowKey,
  renderMarkdownTable,
  type PerfRow,
  type PerfBudgets,
} from '../compare-budgets';

const BUDGETS: PerfBudgets = {
  version: 1,
  trailingBaselineRuns: 5,
  defaults: { maxRegressionPct: 25 },
  metrics: {
    'spark-attach-warm': { p95CeilingMs: 15000, maxRegressionPct: 20, fabricBarMs: 10000 },
    'adx-query': { p95CeilingMs: 2000, maxRegressionPct: 20, fabricBarMs: 2000 },
    'page-tti': { p95CeilingMs: 4000, maxRegressionPct: 20 },
  },
};

function row(metric: string, backend: string, p95: number, overrides: Partial<PerfRow> = {}): PerfRow {
  return {
    runId: 'r1',
    gitSha: 'abc1234',
    metric,
    backend,
    p50: p95 * 0.6,
    p95,
    p99: p95 * 1.2,
    ts: '2026-07-09T00:00:00Z',
    ...overrides,
  };
}

describe('perf/compare-budgets — pure math', () => {
  it('median handles odd, even, and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 2, 1, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, 5])).toBe(5); // non-finite filtered
  });

  it('rowKey is stable metric|backend', () => {
    expect(rowKey('adx-query', 'adx')).toBe('adx-query|adx');
  });

  it('baselineMedians reduces trailing rows to one median per key', () => {
    const base = [
      row('adx-query', 'adx', 1000),
      row('adx-query', 'adx', 1200),
      row('adx-query', 'adx', 1400),
      row('page-tti', 'home', 3000),
    ];
    const m = baselineMedians(base);
    expect(m.get('adx-query|adx')).toBe(1200);
    expect(m.get('page-tti|home')).toBe(3000);
  });
});

describe('perf/compare-budgets — evaluateBudgets', () => {
  it('passes clean when within ceiling and regression budget', () => {
    const latest = [row('adx-query', 'adx', 1250)];
    const baseline = [row('adx-query', 'adx', 1200), row('adx-query', 'adx', 1100)];
    const res = evaluateBudgets({ latest, baseline, budgets: BUDGETS });
    expect(res.breached).toBe(false);
    expect(res.breachCount).toBe(0);
    expect(res.evaluations[0].deltaPct).toBeCloseTo(8.7, 1);
  });

  it('breaches on absolute p95 ceiling', () => {
    const latest = [row('adx-query', 'adx', 2500)]; // > 2000 ceiling
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS });
    expect(res.breached).toBe(true);
    expect(res.breachCount).toBe(1);
    expect(res.evaluations[0].ceilingBreach).toBe(true);
    expect(res.evaluations[0].note).toContain('over ceiling');
  });

  it('breaches on regression beyond maxRegressionPct even under ceiling', () => {
    // baseline 1000ms, latest 1300ms = +30% > 20% budget, but 1300 < 2000 ceiling
    const latest = [row('adx-query', 'adx', 1300)];
    const baseline = [row('adx-query', 'adx', 1000), row('adx-query', 'adx', 1000)];
    const res = evaluateBudgets({ latest, baseline, budgets: BUDGETS });
    expect(res.breached).toBe(true);
    expect(res.evaluations[0].regressionBreach).toBe(true);
    expect(res.evaluations[0].ceilingBreach).toBe(false);
    expect(res.evaluations[0].deltaPct).toBe(30);
  });

  it('no baseline → ceiling-only evaluation (no false regression)', () => {
    const latest = [row('page-tti', 'home', 3500)]; // under 4000 ceiling
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS });
    expect(res.breached).toBe(false);
    expect(res.evaluations[0].baselineP95).toBeNull();
    expect(res.evaluations[0].deltaPct).toBeNull();
    expect(res.evaluations[0].note).toContain('no baseline');
  });

  it('skips unbudgeted metrics (never fails the gate)', () => {
    const latest = [row('some-new-metric', 'x', 999999)];
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS });
    expect(res.evaluations).toHaveLength(0);
    expect(res.breached).toBe(false);
  });

  it('OVERRIDE_LABEL suppresses the red gate but keeps the breach visible', () => {
    const latest = [row('spark-attach-warm', 'synapse', 20000)]; // > 15000 ceiling
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS, overrideLabel: 'deliberate-cold-start-trade' });
    expect(res.breached).toBe(false); // override suppresses red
    expect(res.overridden).toBe(true);
    expect(res.breachCount).toBe(1); // breach still counted + visible
    expect(res.overrideLabel).toBe('deliberate-cold-start-trade');
  });

  it('blank override label is treated as no override', () => {
    const latest = [row('spark-attach-warm', 'synapse', 20000)];
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS, overrideLabel: '   ' });
    expect(res.breached).toBe(true);
    expect(res.overridden).toBe(false);
    expect(res.overrideLabel).toBeNull();
  });

  it('orders breaches first for readable output', () => {
    const latest = [row('page-tti', 'home', 3000), row('adx-query', 'adx', 2500)];
    const res = evaluateBudgets({ latest, baseline: [], budgets: BUDGETS });
    expect(res.evaluations[0].breach).toBe(true);
    expect(res.evaluations[0].metric).toBe('adx-query');
  });
});

describe('perf/compare-budgets — renderMarkdownTable', () => {
  it('renders a green summary with no breaches', () => {
    const res = evaluateBudgets({ latest: [row('adx-query', 'adx', 1200)], baseline: [], budgets: BUDGETS });
    const md = renderMarkdownTable(res);
    expect(md).toContain('| Metric | Backend | p95 |');
    expect(md).toContain('✅ GREEN');
    expect(md).toContain('adx-query');
  });

  it('renders a red summary and marks the breaching row', () => {
    const res = evaluateBudgets({ latest: [row('adx-query', 'adx', 2500)], baseline: [], budgets: BUDGETS });
    const md = renderMarkdownTable(res);
    expect(md).toContain('❌ RED');
    expect(md).toContain('❌ BREACH');
  });

  it('renders an overridden summary', () => {
    const res = evaluateBudgets({
      latest: [row('adx-query', 'adx', 2500)],
      baseline: [],
      budgets: BUDGETS,
      overrideLabel: 'ci-infra-noise',
    });
    const md = renderMarkdownTable(res);
    expect(md).toContain('⚠️ OVERRIDDEN');
    expect(md).toContain('ci-infra-noise');
  });
});
