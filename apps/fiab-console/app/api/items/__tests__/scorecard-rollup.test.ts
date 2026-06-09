import { describe, it, expect } from 'vitest';
import { computeRollups, applyStatusRules } from '../scorecard/rollup';
import type { ScorecardOkr, StatusRule } from '@/lib/apps/content-bundles/types';

describe('computeRollups — rollup methods', () => {
  const children: ScorecardOkr[] = [
    { id: 'c1', name: 'Child 1', metric: 'pct', target: 100, current: 80, parentId: 'p1' },
    { id: 'c2', name: 'Child 2', metric: 'pct', target: 100, current: 60, parentId: 'p1' },
  ];
  const parent = (method: ScorecardOkr['rollupMethod']): ScorecardOkr =>
    ({ id: 'p1', name: 'Parent', metric: 'pct', target: 100, rollupMethod: method });

  it('sum: parent computedValue = 140', () => {
    const r = computeRollups([parent('sum'), ...children]);
    expect(r.find((g) => g.id === 'p1')!.computedValue).toBe(140);
  });
  it('avg: parent computedValue = 70', () => {
    const r = computeRollups([parent('avg'), ...children]);
    expect(r.find((g) => g.id === 'p1')!.computedValue).toBe(70);
  });
  it('min (worst-child): parent computedValue = 60', () => {
    const r = computeRollups([parent('min'), ...children]);
    expect(r.find((g) => g.id === 'p1')!.computedValue).toBe(60);
  });
  it('max: parent computedValue = 80', () => {
    const r = computeRollups([parent('max'), ...children]);
    expect(r.find((g) => g.id === 'p1')!.computedValue).toBe(80);
  });
  it('no children → computedValue undefined, falls back to own current', () => {
    const r = computeRollups([{ id: 'p1', name: 'P', metric: 'pct', target: 100, current: 42, rollupMethod: 'min' }]);
    const p = r.find((g) => g.id === 'p1')!;
    expect(p.computedValue).toBeUndefined();
    expect(p.currentValue).toBe(42);
  });
});

describe('computeRollups — status rules (value-based)', () => {
  const rules: StatusRule[] = [
    { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' },
    { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' },
  ];
  const goal = (current: number, target = 100): ScorecardOkr =>
    ({ id: 'g1', name: 'G', metric: 'pct', target, current, statusRules: rules, otherwiseStatus: 'behind' });

  it('current=95 → on-track', () => expect(computeRollups([goal(95)])[0].status).toBe('on-track'));
  it('current=80 → at-risk', () => expect(computeRollups([goal(80)])[0].status).toBe('at-risk'));
  it('current=60 → behind', () => expect(computeRollups([goal(60)])[0].status).toBe('behind'));
  it('boundary current=90 → on-track (>= inclusive)', () => expect(computeRollups([goal(90)])[0].status).toBe('on-track'));
  it('boundary current=75 → at-risk (>= inclusive)', () => expect(computeRollups([goal(75)])[0].status).toBe('at-risk'));
});

describe('computeRollups — status rules (percent-of-target)', () => {
  const rules: StatusRule[] = [
    { operator: '>=', threshold: 90, metricKind: 'percent-of-target', status: 'on-track' },
    { operator: '>=', threshold: 70, metricKind: 'percent-of-target', status: 'at-risk' },
  ];
  const goal = (current: number, target: number): ScorecardOkr =>
    ({ id: 'g1', name: 'G', metric: 'count', target, current, statusRules: rules, otherwiseStatus: 'behind' });

  it('50/100 = 50% → behind', () => expect(computeRollups([goal(50, 100)])[0].status).toBe('behind'));
  it('75/100 = 75% → at-risk', () => expect(computeRollups([goal(75, 100)])[0].status).toBe('at-risk'));
  it('95/100 = 95% → on-track', () => expect(computeRollups([goal(95, 100)])[0].status).toBe('on-track'));
  it('45/50 = 90% → on-track (scales with target)', () => expect(computeRollups([goal(45, 50)])[0].status).toBe('on-track'));
});

describe('applyStatusRules — operators + fallback', () => {
  it('< operator fires below threshold', () => {
    expect(applyStatusRules(40, 100, [{ operator: '<', threshold: 50, metricKind: 'value', status: 'behind' }], 'on-track')).toBe('behind');
  });
  it('= operator exact match', () => {
    expect(applyStatusRules(100, 100, [{ operator: '=', threshold: 100, metricKind: 'value', status: 'completed' }], 'behind')).toBe('completed');
  });
  it('no rules → otherwiseStatus', () => {
    expect(applyStatusRules(50, 100, [], 'at-risk')).toBe('at-risk');
  });
  it('undefined value → otherwiseStatus (or not-started)', () => {
    expect(applyStatusRules(undefined, 100, [{ operator: '>=', threshold: 1, metricKind: 'value', status: 'on-track' }], undefined)).toBe('not-started');
  });
  it('percent rule with zero target is skipped (cannot compute %)', () => {
    expect(applyStatusRules(50, 0, [{ operator: '>=', threshold: 1, metricKind: 'percent-of-target', status: 'on-track' }], 'behind')).toBe('behind');
  });
});

describe('computeRollups — worst-child rollup + status (FedRAMP-style)', () => {
  it('nist-overall reflects SR=78 (lowest child) and is at-risk', () => {
    const okrs: ScorecardOkr[] = [
      {
        id: 'overall', name: 'NIST Overall', metric: 'pct', target: 100, rollupMethod: 'min',
        statusRules: [
          { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' },
          { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' },
        ],
        otherwiseStatus: 'behind',
      },
      { id: 'nist-AT', name: 'AT', metric: 'pct', target: 100, current: 95, parentId: 'overall' },
      { id: 'nist-SR', name: 'SR', metric: 'pct', target: 100, current: 78, parentId: 'overall' },
    ];
    const result = computeRollups(okrs);
    const parent = result.find((g) => g.id === 'overall')!;
    expect(parent.computedValue).toBe(78); // min(95, 78)
    expect(parent.status).toBe('at-risk'); // 78 >= 75
  });

  it('full 13-family worst-child = 78 → at-risk', () => {
    const values: Record<string, number> = {
      AC: 92, AU: 88, AT: 95, CM: 84, CP: 81, IA: 90, IR: 86, MP: 93, RA: 79, SA: 82, SC: 87, SI: 89, SR: 78,
    };
    const okrs: ScorecardOkr[] = [
      {
        id: 'overall', name: 'Overall', metric: 'pct', target: 100, rollupMethod: 'min',
        statusRules: [
          { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' },
          { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' },
        ],
        otherwiseStatus: 'behind',
      },
      ...Object.entries(values).map(([k, v]) => ({
        id: `nist-${k}`, name: k, metric: 'pct', target: 100, current: v, parentId: 'overall',
        statusRules: [
          { operator: '>=', threshold: 90, metricKind: 'value', status: 'on-track' } as StatusRule,
          { operator: '>=', threshold: 75, metricKind: 'value', status: 'at-risk' } as StatusRule,
        ],
        otherwiseStatus: 'behind' as const,
      })),
    ];
    const r = computeRollups(okrs);
    expect(r.find((g) => g.id === 'overall')!.computedValue).toBe(78);
    expect(r.find((g) => g.id === 'overall')!.status).toBe('at-risk');
    expect(r.find((g) => g.id === 'nist-AT')!.status).toBe('on-track'); // 95
    expect(r.find((g) => g.id === 'nist-SR')!.status).toBe('at-risk');  // 78
    expect(r.find((g) => g.id === 'nist-IA')!.status).toBe('on-track'); // 90 (boundary)
  });
});
