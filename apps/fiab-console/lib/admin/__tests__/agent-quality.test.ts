/**
 * WS-1.4 — Agent Quality pure aggregation (unit tests).
 *
 * Covers the regression-vs-baseline diff, the letter grades, the SLO roll-up,
 * the failing-row drill helper, and the overview scorecard builder — the pure
 * pieces the /api/admin/agent-quality route + the client panel share.
 */
import { describe, it, expect } from 'vitest';
import {
  regressionVsBaseline,
  latestRegression,
  failingEvalRows,
  gradeAvgScore,
  gradeRefusalRate,
  sloHealth,
  buildScorecard,
  type EvalRunLike,
} from '../agent-quality';

function run(id: string, rows: Array<[string, number]>, opts: Partial<EvalRunLike> = {}): EvalRunLike {
  const results = rows.map(([prompt, score]) => ({ prompt, score, status: 'completed' }));
  const threshold = opts.passThreshold ?? 4;
  const scored = results.filter((r) => r.score > 0);
  const avgScore = scored.length ? Number((scored.reduce((a, r) => a + r.score, 0) / scored.length).toFixed(2)) : 0;
  const passRate = results.length ? Number((results.filter((r) => r.score >= threshold).length / results.length).toFixed(4)) : 0;
  return {
    id,
    name: opts.name ?? id,
    avgScore: opts.avgScore ?? avgScore,
    passRate: opts.passRate ?? passRate,
    passThreshold: threshold,
    createdAt: opts.createdAt ?? '2026-07-20T00:00:00Z',
    results,
    ...opts,
  };
}

describe('regressionVsBaseline', () => {
  it('reports no-baseline when there is no prior run', () => {
    const reg = regressionVsBaseline(run('r1', [['a', 5], ['b', 4]]), null);
    expect(reg.status).toBe('no-baseline');
    expect(reg.avgScoreDelta).toBe(0);
    expect(reg.regressedPrompts).toEqual([]);
    expect(reg.baselineId).toBeUndefined();
  });

  it('flags a pass→fail crossing as regressed', () => {
    const baseline = run('base', [['a', 5], ['b', 5]]); // avg 5, pass 1.0
    const latest = run('new', [['a', 5], ['b', 2]]); // b dropped 5→2 (crosses threshold 4)
    const reg = regressionVsBaseline(latest, baseline);
    expect(reg.status).toBe('regressed');
    expect(reg.baselineId).toBe('base');
    expect(reg.avgScoreDelta).toBeLessThan(0);
    expect(reg.regressedPrompts).toHaveLength(1);
    expect(reg.regressedPrompts[0]).toMatchObject({ prompt: 'b', baselineScore: 5, latestScore: 2, crossedFail: true });
  });

  it('reports improved when both aggregates rise and counts improved prompts', () => {
    const baseline = run('base', [['a', 3], ['b', 3]]);
    const latest = run('new', [['a', 5], ['b', 4]]);
    const reg = regressionVsBaseline(latest, baseline);
    expect(reg.status).toBe('improved');
    expect(reg.avgScoreDelta).toBeGreaterThan(0);
    expect(reg.improvedCount).toBe(2);
    expect(reg.regressedPrompts).toEqual([]);
  });

  it('reports stable when the aggregates are unchanged', () => {
    const baseline = run('base', [['a', 4], ['b', 4]]);
    const latest = run('new', [['a', 4], ['b', 4]]);
    expect(regressionVsBaseline(latest, baseline).status).toBe('stable');
  });

  it('orders regressed prompts worst-drop first and ignores new prompts', () => {
    const baseline = run('base', [['a', 5], ['b', 5]]);
    const latest = run('new', [['a', 4], ['b', 1], ['c', 5]]); // a −1, b −4, c is new
    const reg = regressionVsBaseline(latest, baseline);
    expect(reg.regressedPrompts.map((r) => r.prompt)).toEqual(['b', 'a']); // −4 before −1
  });

  it('treats a slip in pass-rate as a regression even without a crossing', () => {
    // avg unchanged but passRate explicitly lower → regressed.
    const baseline = run('base', [['a', 4]], { avgScore: 4, passRate: 1 });
    const latest = run('new', [['a', 4]], { avgScore: 4, passRate: 0.5 });
    expect(regressionVsBaseline(latest, baseline).status).toBe('regressed');
  });
});

describe('latestRegression', () => {
  it('compares run[0] against run[1] (newest-first list)', () => {
    const runs = [run('r2', [['a', 3]]), run('r1', [['a', 5]])];
    const reg = latestRegression(runs)!;
    expect(reg.latestId).toBe('r2');
    expect(reg.baselineId).toBe('r1');
    expect(reg.status).toBe('regressed');
  });
  it('returns null on an empty list', () => {
    expect(latestRegression([])).toBeNull();
  });
  it('is no-baseline with a single run', () => {
    expect(latestRegression([run('only', [['a', 5]])])!.status).toBe('no-baseline');
  });
});

describe('failingEvalRows', () => {
  it('returns rows below the pass threshold, incl. unscored (0)', () => {
    const r = run('r', [['a', 5], ['b', 3], ['c', 0]]);
    expect(failingEvalRows(r).map((x) => x.prompt)).toEqual(['b', 'c']);
  });
});

describe('grades', () => {
  it('grades mean judge scores', () => {
    expect(gradeAvgScore(4.8)).toBe('A');
    expect(gradeAvgScore(4.1)).toBe('B');
    expect(gradeAvgScore(3.2)).toBe('C');
    expect(gradeAvgScore(2.1)).toBe('D');
    expect(gradeAvgScore(1)).toBe('F');
  });
  it('grades red-team refusal rates', () => {
    expect(gradeRefusalRate(100)).toBe('A');
    expect(gradeRefusalRate(96)).toBe('B');
    expect(gradeRefusalRate(91)).toBe('C');
    expect(gradeRefusalRate(82)).toBe('D');
    expect(gradeRefusalRate(50)).toBe('F');
  });
});

describe('sloHealth', () => {
  it('is vacuously healthy + noData when nothing sampled', () => {
    const h = sloHealth([{ met: false, sampled: 0 }]);
    expect(h).toMatchObject({ measured: 0, met: 0, allMet: true, noData: true });
  });
  it('counts only sampled objectives and detects a breach', () => {
    const h = sloHealth([{ met: true, sampled: 10 }, { met: false, sampled: 5 }, { met: true, sampled: 0 }]);
    expect(h).toMatchObject({ measured: 2, met: 1, allMet: false, noData: false });
  });
  it('is allMet when every measured objective is met', () => {
    expect(sloHealth([{ met: true, sampled: 3 }]).allMet).toBe(true);
  });
});

describe('buildScorecard', () => {
  it('renders honest em-dash tiles when no data is loaded', () => {
    const tiles = buildScorecard({});
    expect(tiles.map((t) => t.id)).toEqual(['eval-score', 'regression', 'red-team', 'slo', 'agentops']);
    expect(tiles.every((t) => t.value === '—' && t.tone === 'neutral')).toBe(true);
  });

  it('builds real tiles from loaded data with grades + tones', () => {
    const latestEval = run('e', [['a', 5], ['b', 4]]); // avg 4.5 pass 1.0
    const tiles = buildScorecard({
      latestEval,
      evalRegression: { status: 'regressed', latestId: 'e', baselineId: 'b', avgScoreDelta: -0.4, passRateDelta: -0.1, regressedPrompts: [{ prompt: 'b', baselineScore: 5, latestScore: 4, crossedFail: false }], improvedCount: 0 },
      redTeam: { total: 20, refusalRate: 95, attackSuccessRate: 5 },
      slo: { evaluations: [{ met: true, sampled: 10 }, { met: false, sampled: 4 }] },
      rollup: { runs: 12, successRate: 0.92, totalCostUsd: 1.234, avgLatencyMs: 800, p95LatencyMs: 1500 },
    });
    const byId = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(byId['eval-score'].grade).toBe('A');
    expect(byId['eval-score'].value).toContain('4.50');
    expect(byId['regression'].tone).toBe('bad');
    expect(byId['regression'].value).toBe('-0.40');
    expect(byId['red-team'].grade).toBe('B');
    expect(byId['slo'].tone).toBe('bad'); // one breaching
    expect(byId['slo'].value).toBe('1/2 met');
    expect(byId['agentops'].value).toContain('$1.23');
    expect(byId['agentops'].value).toContain('1.5s');
  });
});
