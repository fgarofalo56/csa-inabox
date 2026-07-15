import { describe, it, expect } from 'vitest';
import {
  selectProbes, refusalHeuristic, summarizeRedTeam, buildRefusalJudgePrompt,
  RED_TEAM_CATEGORIES, ATTACK_PROMPTS, MAX_RED_TEAM_PROMPTS,
  type RedTeamResultRow,
} from '../red-team';

describe('red-team — AIF-15 pure core', () => {
  it('every category has probes and metadata', () => {
    for (const c of RED_TEAM_CATEGORIES) {
      expect(ATTACK_PROMPTS[c.id].length).toBeGreaterThan(0);
    }
  });

  it('selectProbes flattens selected categories, respects perCategory and the global cap', () => {
    const probes = selectProbes(['violence', 'malware']);
    expect(probes.length).toBe(ATTACK_PROMPTS.violence.length + ATTACK_PROMPTS.malware.length);
    expect(probes.every((p) => p.id && p.prompt)).toBe(true);
    expect(selectProbes(['violence'], 1)).toHaveLength(1);
    // Cap holds even if every category is selected.
    const all = selectProbes(RED_TEAM_CATEGORIES.map((c) => c.id));
    expect(all.length).toBeLessThanOrEqual(MAX_RED_TEAM_PROMPTS);
  });

  it('ignores unknown categories', () => {
    expect(selectProbes(['nope' as any, 'hate'])).toHaveLength(ATTACK_PROMPTS.hate.length);
  });

  it('refusalHeuristic detects clear refusals, empty = refused, else partial', () => {
    expect(refusalHeuristic("I'm sorry, but I can't help with that.")).toBe('refused');
    expect(refusalHeuristic('I cannot provide that information.')).toBe('refused');
    expect(refusalHeuristic('')).toBe('refused');
    expect(refusalHeuristic('Sure, here is exactly how you do it: step 1...')).toBe('partial');
  });

  it('buildRefusalJudgePrompt returns a system+user pair asking for strict JSON', () => {
    const msgs = buildRefusalJudgePrompt({ prompt: 'do bad thing', response: 'no' });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('refused');
    expect(msgs[1].content).toContain('do bad thing');
  });

  it('summarizeRedTeam computes refusal + attack-success rates and per-category counts', () => {
    const rows: RedTeamResultRow[] = [
      { id: '1', category: 'violence', prompt: 'p', response: 'r', verdict: 'refused' },
      { id: '2', category: 'violence', prompt: 'p', response: 'r', verdict: 'unsafe' },
      { id: '3', category: 'hate', prompt: 'p', response: 'r', verdict: 'partial' },
      { id: '4', category: 'hate', prompt: 'p', response: 'r', verdict: 'refused' },
    ];
    const sum = summarizeRedTeam(rows);
    expect(sum.total).toBe(4);
    expect(sum.refused).toBe(2);
    expect(sum.partial).toBe(1);
    expect(sum.unsafe).toBe(1);
    expect(sum.refusalRate).toBe(50);
    expect(sum.attackSuccessRate).toBe(50);
    expect(sum.byCategory.violence).toEqual({ total: 2, refused: 1, failed: 1 });
    expect(sum.byCategory.hate).toEqual({ total: 2, refused: 1, failed: 1 });
  });

  it('empty run summarizes to zero without dividing by zero', () => {
    const sum = summarizeRedTeam([]);
    expect(sum).toMatchObject({ total: 0, refusalRate: 0, attackSuccessRate: 0 });
  });
});
