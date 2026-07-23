/**
 * E5 — copilot-quality pure-helper unit tests.
 *
 * Contract under test:
 *   • surfaceGrade — composite letter grade; judge-less runs graded on the two
 *     deterministic dimensions only (never penalized for a null grounding).
 *   • floorStatus — 'na' when a floor value or run metric is absent; never a
 *     false 'below'.
 *   • runsBySurface / trendPoints / runDelta — grouping, oldest→newest trend,
 *     delta only with a previous run.
 *   • buildSurfaceSummaries — one tile per surface incl. floored-but-runless.
 *   • worstQuestions — forbidden-phrase first, then retrieval miss, then lowest
 *     grounding.
 *   • overallStats — means over surfaces WITH runs; judged-only grounding mean.
 */
import { describe, it, expect } from 'vitest';
import {
  surfaceGrade, floorStatus, runsBySurface, trendPoints, runDelta,
  buildSurfaceSummaries, overallStats, worstQuestions,
  fmtPct, fmtScore5, fmtDeltaPct, type RunTotals,
} from '@/lib/admin/copilot-quality';
import type { CopilotEvalRunDoc, CopilotEvalResultDoc } from '@/lib/azure/copilot-evals-model';

function totals(p: Partial<RunTotals>): RunTotals {
  return {
    questions: 20, retrievalHitRate: 0.9, mrrAvg: 0.8, groundingAvg: 4.3,
    answerAvg: 4.2, passRate: 0.85, judged: 20, deferred: 0, autoFailed: 0, ...p,
  };
}

function run(surface: string, finishedAt: string, t: Partial<RunTotals>, extra: Partial<CopilotEvalRunDoc> = {}): CopilotEvalRunDoc {
  return {
    id: `${surface}:${finishedAt}`, surface, runId: `run-${finishedAt}`, docType: 'eval-run',
    schemaVersion: 1, corpusCommit: 'abc123', startedAt: finishedAt, finishedAt,
    judgeModel: 'strong', trigger: 'manual', totals: totals(t), ...extra,
  };
}

function result(p: Partial<CopilotEvalResultDoc>): CopilotEvalResultDoc {
  return {
    id: 'r', surface: 'help', runId: 'run-1', docType: 'eval-result', schemaVersion: 1,
    questionId: 'help-001', question: 'q', expectedChunks: ['a.md'], retrievedChunks: ['a.md'],
    retrievalHit: true, mrr: 1, mentionPass: true, forbiddenHit: false, judgeStatus: 'scored',
    judge: { grounding: 5, relevance: 5, completeness: 5, rationale: 'ok' }, pass: true,
    answer: 'a', tier: 'mini', latencyMs: 100, ...p,
  };
}

describe('surfaceGrade', () => {
  it('grades a strong judged run A', () => {
    expect(surfaceGrade(totals({ retrievalHitRate: 0.95, passRate: 0.95, groundingAvg: 4.8 }))).toBe('A');
  });
  it('grades a dead data path F', () => {
    expect(surfaceGrade(totals({ retrievalHitRate: 0, passRate: 0, groundingAvg: null }))).toBe('F');
  });
  it('a judge-less run is graded on deterministic dims only (not penalized for null grounding)', () => {
    // hit 0.95 + pass 0.95 → composite 0.95 → A even with no judge.
    expect(surfaceGrade(totals({ retrievalHitRate: 0.95, passRate: 0.95, groundingAvg: null }))).toBe('A');
    // The same totals WITH a low judge score drop below A.
    expect(surfaceGrade(totals({ retrievalHitRate: 0.95, passRate: 0.95, groundingAvg: 2 }))).not.toBe('A');
  });
  it('mid scores land in C/D band', () => {
    expect(surfaceGrade(totals({ retrievalHitRate: 0.7, passRate: 0.6, groundingAvg: 3.5 }))).toBe('C');
  });
});

describe('floorStatus', () => {
  it("marks 'below' when a metric drops under its floor", () => {
    const st = floorStatus(totals({ retrievalHitRate: 0.4 }), { retrievalHitRate: 0.5, groundingAvg: 3, passRate: 0.4 });
    expect(st.retrievalHitRate).toBe('below');
    expect(st.belowFloor).toBe(true);
  });
  it("marks 'na' for a missing floor value or a null run metric — never false 'below'", () => {
    const st = floorStatus(totals({ groundingAvg: null }), { retrievalHitRate: 0.5 });
    expect(st.groundingAvg).toBe('na'); // null run metric
    expect(st.passRate).toBe('na');     // no floor for passRate
    expect(st.retrievalHitRate).toBe('ok');
    expect(st.belowFloor).toBe(false);
  });
});

describe('runsBySurface / trend / delta', () => {
  const runs = [
    run('help', '2026-07-20T00:00:00Z', { passRate: 0.8 }),
    run('help', '2026-07-22T00:00:00Z', { passRate: 0.9 }),
    run('help', '2026-07-21T00:00:00Z', { passRate: 0.85 }),
    run('cost', '2026-07-22T00:00:00Z', { passRate: 0.7 }),
    { ...run('#ledger', '2026-07-22T00:00:00Z', {}), docType: 'judge-ledger' as any, surface: '#ledger' },
  ];
  it('groups by surface newest-first and drops non-run/ledger docs', () => {
    const by = runsBySurface(runs as CopilotEvalRunDoc[]);
    expect([...by.keys()].sort()).toEqual(['cost', 'help']);
    expect(by.get('help')!.map((r) => r.finishedAt)).toEqual([
      '2026-07-22T00:00:00Z', '2026-07-21T00:00:00Z', '2026-07-20T00:00:00Z',
    ]);
  });
  it('trendPoints returns oldest→newest', () => {
    const by = runsBySurface(runs as CopilotEvalRunDoc[]);
    const tp = trendPoints(by.get('help')!);
    expect(tp.map((p) => p.passRate)).toEqual([0.8, 0.85, 0.9]);
  });
  it('runDelta compares the two newest runs; null with <2 runs', () => {
    const by = runsBySurface(runs as CopilotEvalRunDoc[]);
    expect(runDelta(by.get('help')!)!.passRate).toBeCloseTo(0.05, 5);
    expect(runDelta(by.get('cost')!)).toBeNull();
  });
});

describe('buildSurfaceSummaries', () => {
  it('emits a runless tile for a floored surface with no runs', () => {
    const summaries = buildSurfaceSummaries(
      [run('help', '2026-07-22T00:00:00Z', {})],
      { help: { retrievalHitRate: 0.5 }, lakehouse: { retrievalHitRate: 0.5 } },
      ['help', 'lakehouse'],
    );
    expect(summaries.map((x) => x.surface)).toEqual(['help', 'lakehouse']);
    const lake = summaries.find((x) => x.surface === 'lakehouse')!;
    expect(lake.totals).toBeNull();
    expect(lake.grade).toBeNull();
    expect(lake.runCount).toBe(0);
  });
});

describe('overallStats', () => {
  it('averages only surfaces with runs, grounding only over judged runs', () => {
    const summaries = buildSurfaceSummaries(
      [
        run('help', '2026-07-22T00:00:00Z', { retrievalHitRate: 1, passRate: 1, groundingAvg: 4 }),
        run('cost', '2026-07-22T00:00:00Z', { retrievalHitRate: 0.8, passRate: 0.6, groundingAvg: null }),
      ],
      { help: { retrievalHitRate: 0.5 }, cost: { retrievalHitRate: 0.5 }, rbac: { retrievalHitRate: 0.5 } },
    );
    const st = overallStats(summaries);
    expect(st.surfaces).toBe(3);
    expect(st.surfacesWithRuns).toBe(2);
    expect(st.avgRetrievalHitRate).toBeCloseTo(0.9, 5);   // (1 + 0.8)/2
    expect(st.avgGroundingAvg).toBeCloseTo(4, 5);          // judged (help) only
  });
});

describe('worstQuestions', () => {
  it('ranks forbidden-phrase first, then retrieval miss, then lowest grounding', () => {
    const rows: CopilotEvalResultDoc[] = [
      result({ questionId: 'ok', pass: true }),
      result({ questionId: 'lowg', judge: { grounding: 2, relevance: 3, completeness: 3, rationale: '' }, pass: false }),
      result({ questionId: 'miss', retrievalHit: false, pass: false }),
      result({ questionId: 'forbidden', forbiddenHit: true, judgeStatus: 'auto-fail', judge: undefined, pass: false }),
    ];
    const ranked = worstQuestions(rows).map((r) => r.questionId);
    expect(ranked[0]).toBe('forbidden');
    expect(ranked[1]).toBe('miss');
    expect(ranked[2]).toBe('lowg');
    expect(ranked[3]).toBe('ok');
  });
});

describe('formatters', () => {
  it('render nullable metrics honestly', () => {
    expect(fmtPct(0.9)).toBe('90%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtScore5(4.3)).toBe('4.3/5');
    expect(fmtScore5(null)).toBe('—');
    expect(fmtDeltaPct(0.05)).toBe('+5%');
    expect(fmtDeltaPct(-0.03)).toBe('−3%');
    expect(fmtDeltaPct(0.001)).toBe('');
  });
});
