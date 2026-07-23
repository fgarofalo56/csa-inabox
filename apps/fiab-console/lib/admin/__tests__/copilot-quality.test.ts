/**
 * E5 — pure copilot-quality helpers (lib/admin/copilot-quality.ts).
 *
 * Grades, floor comparison, per-surface roll-up, program overview, and the
 * worst-question ranking — no Azure, no React. Guards the invariants the admin
 * page + routes depend on: judge-deferred runs grade on retrieval alone (never
 * failed on a grounding floor they can't measure), forbidden phrases rank first,
 * trend is oldest→newest, and belowFloor is honest.
 */
import { describe, it, expect } from 'vitest';
import {
  gradeHitRate, gradePassRate, worstGrade, compositeGrade, floorStatusFor,
  buildSurfaceSummaries, buildOverview, worstQuestions, worstReasonLabel,
  compositeSearchGrade, searchFloorStatusFor, buildSearchSummaries,
  type EvalFloors, type SearchFloors,
} from '@/lib/admin/copilot-quality';
import type { CopilotEvalRunDoc, CopilotEvalResultDoc, CopilotSearchRunDoc } from '@/lib/azure/copilot-evals-model';

const totals = (o: Partial<CopilotEvalRunDoc['totals']>): CopilotEvalRunDoc['totals'] => ({
  questions: 10, retrievalHitRate: 0.9, mrrAvg: 0.8, groundingAvg: 4.2,
  answerAvg: 4.0, passRate: 0.85, judged: 10, deferred: 0, autoFailed: 0, ...o,
});

const run = (surface: string, o: Partial<CopilotEvalRunDoc> = {}): CopilotEvalRunDoc => ({
  id: `${surface}:${o.runId ?? 'r1'}`, surface, runId: (o.runId as string) ?? 'r1',
  docType: 'eval-run', schemaVersion: 1, corpusCommit: 'abc', startedAt: '2026-07-23T00:00:00Z',
  finishedAt: (o.finishedAt as string) ?? '2026-07-23T00:05:00Z', judgeModel: 'strong',
  trigger: 'manual', totals: totals(o.totals ?? {}), ...o,
});

const result = (o: Partial<CopilotEvalResultDoc>): CopilotEvalResultDoc => ({
  id: 'r1:q1', surface: 'help', runId: 'r1', docType: 'eval-result', schemaVersion: 1,
  questionId: 'q1', question: 'Q?', expectedChunks: ['docs/a.md'], retrievedChunks: ['docs/a.md'],
  retrievalHit: true, mrr: 1, mentionPass: true, forbiddenHit: false, judgeStatus: 'scored',
  judge: { grounding: 5, relevance: 5, completeness: 5, rationale: 'ok' }, pass: true,
  answer: 'a', tier: 'strong', latencyMs: 100, ...o,
});

describe('grades', () => {
  it('gradeHitRate bands', () => {
    expect(gradeHitRate(0.95)).toBe('A');
    expect(gradeHitRate(0.82)).toBe('B');
    expect(gradeHitRate(0.72)).toBe('C');
    expect(gradeHitRate(0.55)).toBe('D');
    expect(gradeHitRate(0.3)).toBe('F');
  });
  it('gradePassRate bands', () => {
    expect(gradePassRate(0.95)).toBe('A');
    expect(gradePassRate(0.4)).toBe('F');
  });
  it('worstGrade picks the lower', () => {
    expect(worstGrade('A', 'C')).toBe('C');
    expect(worstGrade('D', 'B')).toBe('D');
    expect(worstGrade('A', 'A')).toBe('A');
  });
  it('compositeGrade folds grounding only when judged', () => {
    // High retrieval, low grounding → composite drops to the grounding grade.
    expect(compositeGrade(totals({ retrievalHitRate: 0.95, groundingAvg: 2.5 }))).toBe('D');
    // Judge-deferred (null grounding) → grade on retrieval alone, not penalized.
    expect(compositeGrade(totals({ retrievalHitRate: 0.95, groundingAvg: null }))).toBe('A');
  });
});

describe('floorStatusFor', () => {
  const floor = { retrievalHitRate: 0.8, groundingAvg: 4, passRate: 0.8 };
  it('flags below and ok correctly', () => {
    const st = floorStatusFor(totals({ retrievalHitRate: 0.7, groundingAvg: 4.2, passRate: 0.85 }), floor);
    expect(st.find((s) => s.metric === 'retrievalHitRate')!.verdict).toBe('below');
    expect(st.find((s) => s.metric === 'groundingAvg')!.verdict).toBe('ok');
    expect(st.find((s) => s.metric === 'passRate')!.verdict).toBe('ok');
  });
  it('never fails a judge-deferred run on the grounding floor', () => {
    const st = floorStatusFor(totals({ groundingAvg: null }), floor);
    expect(st.find((s) => s.metric === 'groundingAvg')!.verdict).toBe('not-judged');
  });
  it('no-floor when the surface has no floor entry', () => {
    const st = floorStatusFor(totals({}), undefined);
    expect(st.every((s) => s.verdict === 'no-floor')).toBe(true);
  });
});

describe('buildSurfaceSummaries', () => {
  const floors: EvalFloors = { help: { retrievalHitRate: 0.8, groundingAvg: 4, passRate: 0.8, provisional: true } };
  it('groups by surface, latest first, trend oldest→newest', () => {
    const runs = [
      run('help', { runId: 'r2', finishedAt: '2026-07-23T02:00:00Z', totals: { retrievalHitRate: 0.95 } }),
      run('help', { runId: 'r1', finishedAt: '2026-07-23T01:00:00Z', totals: { retrievalHitRate: 0.6 } }),
      run('lakehouse', { runId: 'r1' }),
      // Non-run docs / ledger are ignored:
      { ...run('#ledger'), surface: '#ledger', docType: 'judge-ledger' } as unknown as CopilotEvalRunDoc,
    ];
    const s = buildSurfaceSummaries(runs, floors);
    expect(s.map((x) => x.surface)).toEqual(['help', 'lakehouse']); // sorted, no ledger
    const help = s.find((x) => x.surface === 'help')!;
    expect(help.latest.runId).toBe('r2'); // newest
    expect(help.trend.map((t) => t.runId)).toEqual(['r1', 'r2']); // oldest→newest
    expect(help.runCount).toBe(2);
    expect(help.provisionalFloor).toBe(true);
  });
  it('belowFloor is honest', () => {
    const runs = [run('help', { totals: { retrievalHitRate: 0.5, passRate: 0.5 } })];
    const s = buildSurfaceSummaries(runs, floors);
    expect(s[0].belowFloor).toBe(true);
  });
});

describe('buildOverview', () => {
  it('aggregates means + belowFloor', () => {
    const floors: EvalFloors = { help: { retrievalHitRate: 0.9 } };
    const runs = [
      run('help', { totals: { retrievalHitRate: 0.8, groundingAvg: 4 } }),
      run('cost', { totals: { retrievalHitRate: 1.0, groundingAvg: null } }),
    ];
    const ov = buildOverview(buildSurfaceSummaries(runs, floors));
    expect(ov.surfaces).toBe(2);
    expect(ov.meanHitRate).toBeCloseTo(0.9, 5);
    expect(ov.meanGrounding).toBe(4); // only the judged surface counts
    expect(ov.belowFloor).toBe(1); // help 0.8 < 0.9
  });
  it('empty is all-null', () => {
    const ov = buildOverview([]);
    expect(ov).toMatchObject({ surfaces: 0, runs: 0, belowFloor: 0, meanHitRate: null, meanGrounding: null, lastRunAt: null });
  });
});

describe('worstQuestions', () => {
  it('ranks forbidden phrases first, then retrieval misses, then low grounding', () => {
    const results = [
      result({ questionId: 'good', pass: true }),
      result({ questionId: 'lowg', judge: { grounding: 2, relevance: 4, completeness: 4, rationale: 'weak' }, pass: false }),
      result({ questionId: 'miss', retrievalHit: false, mrr: 0, pass: false }),
      result({ questionId: 'forbidden', forbiddenHit: true, pass: false }),
    ];
    const w = worstQuestions(results);
    expect(w.map((x) => x.questionId)).toEqual(['forbidden', 'miss', 'lowg']); // 'good' excluded
    expect(w[0].reason).toBe('forbidden-phrase');
    expect(w[1].reason).toBe('retrieval-miss');
    expect(w[2].reason).toBe('low-grounding');
  });
  it('carries drill-in evidence and respects the limit', () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      result({ questionId: `q${i}`, retrievalHit: false, mrr: 0, pass: false, expectedChunks: ['docs/x.md'], retrievedChunks: [] }));
    const w = worstQuestions(results, 5);
    expect(w).toHaveLength(5);
    expect(w[0].expectedChunks).toEqual(['docs/x.md']);
    expect(w[0].retrievedChunks).toEqual([]);
  });
  it('ignores non-result docs', () => {
    const w = worstQuestions([{ docType: 'eval-run' } as unknown as CopilotEvalResultDoc]);
    expect(w).toHaveLength(0);
  });
  it('worstReasonLabel covers every reason', () => {
    for (const r of ['forbidden-phrase', 'retrieval-miss', 'low-grounding', 'missed-mention', 'judge-error'] as const) {
      expect(worstReasonLabel(r).length).toBeGreaterThan(0);
    }
  });
});

// ── SRCH1 — search relevance summaries ───────────────────────────────────────

const searchRun = (domain: string, o: Partial<CopilotSearchRunDoc> = {}): CopilotSearchRunDoc => ({
  id: `${domain}:r1`, surface: `search:${domain}`, domain, runId: (o.runId as string) ?? 'r1',
  docType: 'search-run', schemaVersion: 1, startedAt: '2026-07-23T00:00:00Z',
  finishedAt: (o.finishedAt as string) ?? '2026-07-23T00:05:00Z', trigger: 'manual', k: 5,
  totals: { queries: 12, hitRate: 0.9, mrrAvg: 0.8, ndcgAvg: 0.85, ...(o.totals ?? {}) }, ...o,
});

describe('search relevance', () => {
  it('compositeSearchGrade = worse of hit-rate and ndcg', () => {
    expect(compositeSearchGrade({ queries: 5, hitRate: 0.95, mrrAvg: 0.9, ndcgAvg: 0.55 })).toBe('D');
    expect(compositeSearchGrade({ queries: 5, hitRate: 0.95, mrrAvg: 0.9, ndcgAvg: 0.92 })).toBe('A');
  });
  it('searchFloorStatusFor flags below and no-floor', () => {
    const st = searchFloorStatusFor({ queries: 5, hitRate: 0.5, mrrAvg: 0.5, ndcgAvg: 0.9 }, { searchHitRate: 0.6, ndcg: 0.5 });
    expect(st.find((s) => s.metric === 'searchHitRate')!.verdict).toBe('below');
    expect(st.find((s) => s.metric === 'ndcg')!.verdict).toBe('ok');
    const none = searchFloorStatusFor({ queries: 5, hitRate: 0.5, mrrAvg: 0.5, ndcgAvg: 0.9 }, undefined);
    expect(none.every((s) => s.verdict === 'no-floor')).toBe(true);
  });
  it('buildSearchSummaries groups by domain, latest first, trend oldest→newest', () => {
    const floors: SearchFloors = { catalog: { searchHitRate: 0.6, ndcg: 0.5, provisional: true } };
    const runs = [
      searchRun('catalog', { runId: 'r2', finishedAt: '2026-07-23T02:00:00Z', totals: { hitRate: 0.95 } as any }),
      searchRun('catalog', { runId: 'r1', finishedAt: '2026-07-23T01:00:00Z', totals: { hitRate: 0.4 } as any }),
      searchRun('analytics', { runId: 'r1' }),
    ];
    const s = buildSearchSummaries(runs, floors);
    expect(s.map((x) => x.domain)).toEqual(['analytics', 'catalog']);
    const cat = s.find((x) => x.domain === 'catalog')!;
    expect(cat.latest.runId).toBe('r2');
    expect(cat.trend.map((t) => t.runId)).toEqual(['r1', 'r2']);
    expect(cat.provisionalFloor).toBe(true);
  });
  it('belowFloor honest for search', () => {
    const floors: SearchFloors = { catalog: { searchHitRate: 0.6, ndcg: 0.5 } };
    const s = buildSearchSummaries([searchRun('catalog', { totals: { hitRate: 0.3, ndcgAvg: 0.2 } as any })], floors);
    expect(s[0].belowFloor).toBe(true);
  });
});
