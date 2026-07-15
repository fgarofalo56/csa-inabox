import { describe, it, expect } from 'vitest';
import {
  dqRunStatus, failingRuleCount, dqItemRunFromResult, appendDqItemRun, type DqItemRun,
} from '../dq-item-run';
import type { DqRunResult, DqRuleResult } from '../data-quality-client';

function rule(over: Partial<DqRuleResult>): DqRuleResult {
  return { ruleId: 'r', name: 'n', check: 'not-null', scope: 'table:t', percentage: 100, passed: true, detail: 'ok', ...over };
}
function result(over: Partial<DqRunResult>): DqRunResult {
  return {
    backend: 'kusto', target: 'kusto:loomdb', score: 100, ruleCount: 0, passingRules: 0,
    breakdown: [], computedAt: '2026-07-14T00:00:00Z', ...over,
  };
}

describe('dq-item-run — W11 run records', () => {
  it('classifies no_rules when nothing matched', () => {
    expect(dqRunStatus(result({ ruleCount: 0, breakdown: [] }))).toBe('no_rules');
  });

  it('classifies errored when rules matched but none could run', () => {
    const r = result({ ruleCount: 2, breakdown: [rule({ percentage: null, passed: false }), rule({ percentage: null, passed: false })] });
    expect(dqRunStatus(r)).toBe('errored');
  });

  it('classifies failed when a rule ran and did not pass', () => {
    const r = result({ ruleCount: 2, breakdown: [rule({ percentage: 100, passed: true }), rule({ ruleId: 'r2', percentage: 80, passed: false })] });
    expect(dqRunStatus(r)).toBe('failed');
    expect(failingRuleCount(r)).toBe(1);
  });

  it('classifies passed when every ran rule passed (null-percentage rules ignored)', () => {
    const r = result({ ruleCount: 2, breakdown: [rule({ percentage: 100, passed: true }), rule({ ruleId: 'r2', percentage: null, passed: false })] });
    expect(dqRunStatus(r)).toBe('passed');
    expect(failingRuleCount(r)).toBe(0);
  });

  it('maps the engine result into a persisted run record', () => {
    const r = result({ ruleCount: 3, passingRules: 2, score: 66.7, breakdown: [rule({ percentage: 50, passed: false })] });
    const run = dqItemRunFromResult(r, { durationMs: 1234, ranBy: 'me@x' });
    expect(run).toMatchObject({ backend: 'kusto', target: 'kusto:loomdb', score: 66.7, ruleCount: 3, passingRules: 2, failingRules: 1, status: 'failed', durationMs: 1234, ranBy: 'me@x' });
    expect(run.id).toBeTruthy();
  });

  it('appendDqItemRun keeps newest-first and caps at 50', () => {
    const mk = (i: number): DqItemRun => ({ id: `r${i}`, ranAt: 'now', backend: 'kusto', target: 't', score: 100, ruleCount: 1, passingRules: 1, failingRules: 0, status: 'passed', breakdown: [], durationMs: 1, ranBy: 'me' });
    let runs: DqItemRun[] = [];
    for (let i = 0; i < 55; i++) runs = appendDqItemRun(runs, mk(i));
    expect(runs).toHaveLength(50);
    expect(runs[0].id).toBe('r54');
  });
});
