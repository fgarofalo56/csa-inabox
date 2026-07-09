/**
 * AIF-13 — agent eval scoring (pure logic).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizePromptSet, buildJudgePrompt, clampScore, summarizeEval,
  MAX_EVAL_PROMPTS, DEFAULT_PASS_THRESHOLD,
} from '../agent-eval';

describe('normalizePromptSet', () => {
  it('trims, drops empty rows, and caps count', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ prompt: ` p${i} `, criteria: i % 2 ? ' c ' : '' }));
    rows.push({ prompt: '   ', criteria: 'x' }); // empty prompt → dropped
    const out = normalizePromptSet(rows);
    expect(out.length).toBe(MAX_EVAL_PROMPTS);
    expect(out[0].prompt).toBe('p0');
    expect(out[0].criteria).toBeUndefined(); // empty criteria normalized away
    expect(out[1].criteria).toBe('c');
  });
  it('is safe on null', () => {
    expect(normalizePromptSet(null)).toEqual([]);
  });
});

describe('buildJudgePrompt', () => {
  it('produces a system + user message and embeds criteria + answer', () => {
    const msgs = buildJudgePrompt({ prompt: 'What is 2+2?', criteria: 'must say 4', answer: '4' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('must say 4');
    expect(msgs[1].content).toContain('4');
  });
  it('falls back to a default criteria line when none given', () => {
    const msgs = buildJudgePrompt({ prompt: 'q', answer: 'a' });
    expect(msgs[1].content).toMatch(/overall correctness/i);
  });
});

describe('clampScore', () => {
  it('clamps into 1-5 integer, 0 for garbage', () => {
    expect(clampScore(3)).toBe(3);
    expect(clampScore(9)).toBe(5);
    expect(clampScore(0)).toBe(1);   // 0 rounds up into range (0 reserved for unscored via garbage)
    expect(clampScore('x')).toBe(0);
    expect(clampScore(null)).toBe(0);
    expect(clampScore(4.4)).toBe(4);
  });
});

describe('summarizeEval', () => {
  it('averages only scored rows and computes pass rate over all rows', () => {
    const rows = [{ score: 5 }, { score: 4 }, { score: 2 }, { score: 0 }]; // last is unscored
    const s = summarizeEval(rows, DEFAULT_PASS_THRESHOLD);
    expect(s.total).toBe(4);
    expect(s.scored).toBe(3);
    expect(s.avgScore).toBeCloseTo(3.67, 2); // (5+4+2)/3
    expect(s.passRate).toBe(0.5);            // scores>=4: two of four rows
    expect(s.passThreshold).toBe(4);
  });
  it('is safe on empty', () => {
    const s = summarizeEval([]);
    expect(s.avgScore).toBe(0);
    expect(s.passRate).toBe(0);
  });
});
