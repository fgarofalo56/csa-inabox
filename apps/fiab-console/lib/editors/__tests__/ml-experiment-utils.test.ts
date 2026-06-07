/**
 * Vitest — ML Experiment editor pure-logic helpers (_ml-experiment-utils.ts).
 *
 * Covers the sort/filter/compare math behind the runs table, run detail, and
 * compare-runs (parallel coordinates) views — the class of bug a DOM smoke
 * can't catch (sort direction, missing-value ordering, axis normalization,
 * order_by string shape).
 */
import { describe, it, expect } from 'vitest';
import {
  type MlflowRunLite,
  runMetric, runParam, collectMetricKeys, collectParamKeys,
  columnId, parseColumnId, runValue, sortRuns, buildOrderBy,
  filterRunsLocal, userTags, buildParallelAxes, normalizeOnAxis, compareColor,
} from '../_ml-experiment-utils';

function mkRun(p: Partial<MlflowRunLite> & { runId: string }): MlflowRunLite {
  return { metrics: [], params: [], tags: [], ...p };
}

const runs: MlflowRunLite[] = [
  mkRun({ runId: 'r1', runName: 'alpha', status: 'FINISHED', startTime: 1000,
    metrics: [{ key: 'accuracy', value: 0.91 }, { key: 'loss', value: 0.3 }],
    params: [{ key: 'lr', value: '0.01' }, { key: 'opt', value: 'adam' }],
    tags: [{ key: 'mlflow.runName', value: 'alpha' }, { key: 'team', value: 'csa' }] }),
  mkRun({ runId: 'r2', runName: 'bravo', status: 'FAILED', startTime: 3000,
    metrics: [{ key: 'accuracy', value: 0.88 }],
    params: [{ key: 'lr', value: '0.1' }] }),
  mkRun({ runId: 'r3', runName: 'charlie', status: 'FINISHED', startTime: 2000,
    metrics: [{ key: 'accuracy', value: 0.95 }, { key: 'loss', value: 0.1 }],
    params: [{ key: 'lr', value: '0.001' }, { key: 'opt', value: 'sgd' }] }),
];

describe('runMetric / runParam', () => {
  it('reads last-value metric and param', () => {
    expect(runMetric(runs[0], 'accuracy')).toBe(0.91);
    expect(runMetric(runs[0], 'missing')).toBeUndefined();
    expect(runParam(runs[0], 'opt')).toBe('adam');
    expect(runParam(runs[1], 'opt')).toBeUndefined();
  });
});

describe('collectMetricKeys / collectParamKeys', () => {
  it('returns sorted unions', () => {
    expect(collectMetricKeys(runs)).toEqual(['accuracy', 'loss']);
    expect(collectParamKeys(runs)).toEqual(['lr', 'opt']);
  });
});

describe('columnId / parseColumnId', () => {
  it('round-trips a column with a colon-bearing field', () => {
    const col = { kind: 'metric' as const, field: 'val:loss' };
    expect(parseColumnId(columnId(col))).toEqual(col);
  });
});

describe('runValue', () => {
  it('reads metric, numeric param, string param, and attributes', () => {
    expect(runValue(runs[0], { kind: 'metric', field: 'accuracy' })).toBe(0.91);
    expect(runValue(runs[0], { kind: 'param', field: 'lr' })).toBe(0.01); // numeric param coerced
    expect(runValue(runs[0], { kind: 'param', field: 'opt' })).toBe('adam'); // non-numeric stays string
    expect(runValue(runs[0], { kind: 'attr', field: 'startTime' })).toBe(1000);
    expect(runValue(runs[0], { kind: 'attr', field: 'runName' })).toBe('alpha');
  });
});

describe('sortRuns', () => {
  it('sorts by metric descending', () => {
    const out = sortRuns(runs, { kind: 'metric', field: 'accuracy' }, 'desc');
    expect(out.map((r) => r.runId)).toEqual(['r3', 'r1', 'r2']);
  });
  it('sorts by start time ascending', () => {
    const out = sortRuns(runs, { kind: 'attr', field: 'startTime' }, 'asc');
    expect(out.map((r) => r.runId)).toEqual(['r1', 'r3', 'r2']);
  });
  it('puts missing values last regardless of direction', () => {
    const out = sortRuns(runs, { kind: 'metric', field: 'loss' }, 'asc');
    // r2 has no loss → last; r3=0.1 < r1=0.3
    expect(out.map((r) => r.runId)).toEqual(['r3', 'r1', 'r2']);
    const outDesc = sortRuns(runs, { kind: 'metric', field: 'loss' }, 'desc');
    expect(outDesc[outDesc.length - 1].runId).toBe('r2');
  });
  it('does not mutate the input array', () => {
    const before = runs.map((r) => r.runId);
    sortRuns(runs, { kind: 'metric', field: 'accuracy' }, 'asc');
    expect(runs.map((r) => r.runId)).toEqual(before);
  });
});

describe('buildOrderBy', () => {
  it('builds MLflow order_by for metrics and attributes, none for params', () => {
    expect(buildOrderBy({ kind: 'metric', field: 'accuracy' }, 'desc')).toEqual(['metrics.`accuracy` DESC']);
    expect(buildOrderBy({ kind: 'attr', field: 'startTime' }, 'asc')).toEqual(['attributes.start_time ASC']);
    expect(buildOrderBy({ kind: 'param', field: 'lr' }, 'asc')).toBeUndefined();
  });
});

describe('filterRunsLocal', () => {
  it('matches on run name, param key/value, and metric key', () => {
    expect(filterRunsLocal(runs, 'bravo').map((r) => r.runId)).toEqual(['r2']);
    expect(filterRunsLocal(runs, 'adam').map((r) => r.runId)).toEqual(['r1']);
    expect(filterRunsLocal(runs, 'loss').map((r) => r.runId)).toEqual(['r1', 'r3']);
    expect(filterRunsLocal(runs, '').length).toBe(3);
  });
});

describe('userTags', () => {
  it('hides mlflow.* system tags', () => {
    expect(userTags(runs[0]).map((t) => t.key)).toEqual(['team']);
  });
});

describe('buildParallelAxes / normalizeOnAxis', () => {
  it('builds numeric axes with ranges and normalizes', () => {
    const axes = buildParallelAxes(runs);
    const acc = axes.find((a) => a.col.kind === 'metric' && a.col.field === 'accuracy');
    expect(acc).toBeTruthy();
    expect(acc!.min).toBeCloseTo(0.88);
    expect(acc!.max).toBeCloseTo(0.95);
    // numeric param lr is included as an axis
    expect(axes.some((a) => a.col.kind === 'param' && a.col.field === 'lr')).toBe(true);
    // non-numeric param opt is NOT an axis
    expect(axes.some((a) => a.col.kind === 'param' && a.col.field === 'opt')).toBe(false);
    expect(normalizeOnAxis(acc!.max, acc!)).toBeCloseTo(1);
    expect(normalizeOnAxis(acc!.min, acc!)).toBeCloseTo(0);
  });
  it('returns 0.5 on a flat axis', () => {
    const flat = [
      mkRun({ runId: 'a', metrics: [{ key: 'm', value: 5 }] }),
      mkRun({ runId: 'b', metrics: [{ key: 'm', value: 5 }] }),
    ];
    const axes = buildParallelAxes(flat);
    expect(normalizeOnAxis(5, axes[0])).toBe(0.5);
  });
});

describe('compareColor', () => {
  it('cycles deterministically', () => {
    expect(compareColor(0)).toBe(compareColor(8));
    expect(compareColor(0)).not.toBe(compareColor(1));
  });
});
