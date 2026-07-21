/**
 * WS-1.5 — evaluator-library unit tests (pure logic, no Azure calls).
 */
import { describe, it, expect } from 'vitest';
import {
  EVALUATOR_TYPES,
  EVALUATOR_META,
  buildEvaluatorPrompt,
  parseJudgeResponse,
  summarizeBatchEval,
  clusterFailures,
  type EvaluatorType,
  type FailingRow,
} from '../evaluator-library';

describe('EVALUATOR_TYPES / EVALUATOR_META', () => {
  it('has exactly 4 evaluator types', () => {
    expect(EVALUATOR_TYPES.length).toBe(4);
    expect(EVALUATOR_TYPES).toContain('groundedness');
    expect(EVALUATOR_TYPES).toContain('relevance');
    expect(EVALUATOR_TYPES).toContain('tool-call-accuracy');
    expect(EVALUATOR_TYPES).toContain('task-adherence');
  });

  it('every type has metadata with label + description + rubricSummary', () => {
    for (const t of EVALUATOR_TYPES) {
      const m = EVALUATOR_META[t];
      expect(m).toBeTruthy();
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.rubricSummary.length).toBeGreaterThan(0);
      expect(m.type).toBe(t);
    }
  });
});

describe('buildEvaluatorPrompt', () => {
  it('returns exactly 2 messages [system, user] for each evaluator type', () => {
    for (const t of EVALUATOR_TYPES) {
      const msgs = buildEvaluatorPrompt({ evaluatorType: t, question: 'q', answer: 'a' });
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].role).toBe('user');
    }
  });

  it('groundedness embeds context when provided', () => {
    const msgs = buildEvaluatorPrompt({
      evaluatorType: 'groundedness', question: 'q', answer: 'a',
      context: 'The sky is blue.',
    });
    expect(msgs[1].content).toContain('The sky is blue.');
  });

  it('groundedness warns when context is absent', () => {
    const msgs = buildEvaluatorPrompt({ evaluatorType: 'groundedness', question: 'q', answer: 'a' });
    expect(msgs[1].content).toMatch(/none provided/i);
  });

  it('tool-call-accuracy embeds toolCalls when provided', () => {
    const msgs = buildEvaluatorPrompt({
      evaluatorType: 'tool-call-accuracy', question: 'q', answer: 'a',
      toolCalls: 'search_data(query="revenue")',
    });
    expect(msgs[1].content).toContain('search_data');
  });

  it('task-adherence embeds instructions when provided', () => {
    const msgs = buildEvaluatorPrompt({
      evaluatorType: 'task-adherence', question: 'q', answer: 'a',
      instructions: 'Step 1: fetch. Step 2: format.',
    });
    expect(msgs[1].content).toContain('Step 1: fetch');
  });

  it('all system prompts include the JSON format instruction', () => {
    for (const t of EVALUATOR_TYPES) {
      const msgs = buildEvaluatorPrompt({ evaluatorType: t, question: 'q', answer: 'a' });
      expect(msgs[0].content).toContain('"score"');
      expect(msgs[0].content).toContain('"rationale"');
    }
  });
});

describe('parseJudgeResponse', () => {
  it('parses a valid 1-5 integer score', () => {
    const r = parseJudgeResponse({ score: 4, rationale: 'Good.' }, 'relevance');
    expect(r.score).toBe(4);
    expect(r.rationale).toBe('Good.');
    expect(r.evaluatorType).toBe('relevance');
    expect(r.scoredAt).toBeTruthy();
  });

  it('returns score=0 for out-of-range or missing score', () => {
    expect(parseJudgeResponse({ score: 9 }, 'relevance').score).toBe(0);
    expect(parseJudgeResponse({ score: -1 }, 'relevance').score).toBe(0);
    expect(parseJudgeResponse({}, 'relevance').score).toBe(0);
    expect(parseJudgeResponse({ score: 'x' }, 'relevance').score).toBe(0);
  });

  it('accepts Score (capital) as alias', () => {
    expect(parseJudgeResponse({ Score: 3, Rationale: 'ok' }, 'groundedness').score).toBe(3);
  });

  it('truncates long rationale to 500 chars', () => {
    const long = 'x'.repeat(600);
    const r = parseJudgeResponse({ score: 5, rationale: long }, 'relevance');
    expect(r.rationale.length).toBe(500);
  });
});

describe('summarizeBatchEval', () => {
  it('averages scored dimensions (>0) only', () => {
    const scores = [
      { evaluatorType: 'groundedness' as EvaluatorType, score: 4, rationale: '', scoredAt: '' },
      { evaluatorType: 'relevance'    as EvaluatorType, score: 3, rationale: '', scoredAt: '' },
      { evaluatorType: 'task-adherence' as EvaluatorType, score: 0, rationale: '', scoredAt: '' }, // unscored
    ];
    const r = summarizeBatchEval('Q', 'A', scores);
    expect(r.avgScore).toBeCloseTo(3.5, 2); // (4+3)/2
    expect(r.question).toBe('Q');
    expect(r.answer).toBe('A');
  });

  it('returns avgScore 0 when all unscored', () => {
    const scores = [
      { evaluatorType: 'groundedness' as EvaluatorType, score: 0, rationale: '', scoredAt: '' },
    ];
    const r = summarizeBatchEval('Q', 'A', scores);
    expect(r.avgScore).toBe(0);
  });
});

describe('clusterFailures', () => {
  it('returns empty array for empty input', () => {
    expect(clusterFailures([])).toEqual([]);
  });

  it('returns a single uncategorised cluster when no keywords overlap', () => {
    const rows: FailingRow[] = [
      { prompt: 'Abc', score: 1 },
      { prompt: 'Xyz', score: 2 },
    ];
    const clusters = clusterFailures(rows);
    // Both prompts have very short / unique words — falls to uncategorised.
    expect(clusters.length).toBeGreaterThan(0);
    const total = clusters.reduce((a, c) => a + c.count, 0);
    expect(total).toBe(2);
  });

  it('clusters rows sharing a keyword together', () => {
    const rows: FailingRow[] = [
      { prompt: 'show monthly revenue breakdown', score: 1, evaluatorType: 'relevance' },
      { prompt: 'what is revenue for Q3', score: 2, evaluatorType: 'groundedness' },
      { prompt: 'list customers from California', score: 1, evaluatorType: 'task-adherence' },
    ];
    const clusters = clusterFailures(rows);
    // 'revenue' should appear as a cluster centre matching the first two rows.
    const revenueCluster = clusters.find((c) => c.theme === 'revenue');
    expect(revenueCluster).toBeTruthy();
    expect(revenueCluster!.count).toBe(2);
    expect(revenueCluster!.evaluatorTypes).toContain('relevance');
    expect(revenueCluster!.evaluatorTypes).toContain('groundedness');
  });

  it('returns samples capped at 3 per cluster', () => {
    const rows: FailingRow[] = Array.from({ length: 10 }, (_, i) => ({
      prompt: `what is the revenue figure for item ${i}`,
      score: 1,
    }));
    const clusters = clusterFailures(rows, 2);
    for (const c of clusters) {
      expect(c.samples.length).toBeLessThanOrEqual(3);
    }
  });

  it('clusters sorted by count descending', () => {
    const rows: FailingRow[] = [
      { prompt: 'small data', score: 1 },
      { prompt: 'revenue data query', score: 1 },
      { prompt: 'revenue breakdown filter', score: 2 },
      { prompt: 'revenue totals report', score: 2 },
    ];
    const clusters = clusterFailures(rows);
    for (let i = 1; i < clusters.length; i++) {
      expect(clusters[i - 1].count).toBeGreaterThanOrEqual(clusters[i].count);
    }
  });
});
