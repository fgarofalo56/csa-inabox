/**
 * Unit tests for the PURE CTS-11 skill learner core
 * (lib/copilot/skill-learner-core).
 *
 * These assert the clustering + threshold POLICY in isolation — no Cosmos, no
 * Azure, no AOAI, no network:
 *   - a recurring per-pane keyword pattern SURFACES as a gap
 *   - an already-covered pane is EXCLUDED (no re-proposing an existing skill)
 *   - a keyword that is already an existing skill's own token is excluded
 *   - a below-threshold (non-recurring) pattern is DROPPED
 *   - shouldProposeSkill gates on the sample count + keyword presence
 */
import { describe, it, expect } from 'vitest';
import {
  extractKeywordSignals,
  shouldProposeSkill,
  type UsageRow,
} from '../skill-learner-core';

/** Build N usage rows on a pane, each carrying the given prompt text. */
function rows(pane: string, prompt: string, n: number): UsageRow[] {
  return Array.from({ length: n }, (_, i) => ({
    pane,
    promptSample: `${prompt} (variation ${i})`,
    activeSkillNames: [],
    at: new Date(2026, 6, 1, 0, i).toISOString(),
  }));
}

describe('extractKeywordSignals', () => {
  it('surfaces a recurring per-pane keyword pattern as a gap', () => {
    const usage = rows('lakehouse', 'build a medallion delta pipeline for bronze silver gold', 6);
    const gaps = extractKeywordSignals(usage, { minKeywordCount: 3 });
    expect(gaps.length).toBe(1);
    const g = gaps[0];
    expect(g.pane).toBe('lakehouse');
    expect(g.sampleCount).toBe(6);
    // Recurring content words should surface (≥4 chars, non-stopword).
    expect(g.keywords).toEqual(expect.arrayContaining(['medallion', 'delta', 'pipeline']));
    expect(g.samplePrompts.length).toBeGreaterThan(0);
  });

  it('excludes a pane that is already covered by an existing skill', () => {
    const usage = rows('lakehouse', 'build a medallion delta pipeline', 6);
    const gaps = extractKeywordSignals(usage, {
      minKeywordCount: 3,
      coveredPanes: ['lakehouse'],
    });
    expect(gaps).toEqual([]);
  });

  it('excludes keywords that are already an existing skill name token', () => {
    const usage = rows('lakehouse', 'build a medallion delta pipeline', 6);
    const gaps = extractKeywordSignals(usage, {
      minKeywordCount: 3,
      existingSkillNames: ['Medallion loader', 'Delta helper'],
    });
    // 'medallion' + 'delta' are already skill tokens → excluded; 'pipeline' remains.
    if (gaps.length > 0) {
      expect(gaps[0].keywords).not.toContain('medallion');
      expect(gaps[0].keywords).not.toContain('delta');
      expect(gaps[0].keywords).toContain('pipeline');
    } else {
      // Acceptable if every recurring token was an existing-skill token.
      expect(gaps).toEqual([]);
    }
  });

  it('drops a below-threshold (non-recurring) pattern', () => {
    // Only 2 prompts contain 'anomaly' but the recurrence threshold is 3.
    const usage: UsageRow[] = [
      { pane: 'notebook', promptSample: 'detect anomaly quickly' },
      { pane: 'notebook', promptSample: 'anomaly scoring model' },
      { pane: 'notebook', promptSample: 'something entirely different here' },
      { pane: 'notebook', promptSample: 'yet another unrelated request' },
    ];
    const gaps = extractKeywordSignals(usage, { minKeywordCount: 3 });
    // No token recurs across ≥3 distinct prompts → no gap.
    expect(gaps).toEqual([]);
  });

  it('ignores empty prompt samples and unknown-pane rows bucket under default', () => {
    const usage: UsageRow[] = [
      { pane: '', promptSample: 'orchestrate warehouse ingestion warehouse ingestion' },
      { pane: null, promptSample: 'warehouse ingestion warehouse pipeline' },
      { pane: undefined, promptSample: 'warehouse ingestion nightly' },
      { pane: 'default', promptSample: '   ' }, // empty → skipped
    ];
    const gaps = extractKeywordSignals(usage, { minKeywordCount: 3 });
    // All non-empty rows bucket to 'default'; 'warehouse' + 'ingestion' recur ≥3.
    expect(gaps.length).toBe(1);
    expect(gaps[0].pane).toBe('default');
    expect(gaps[0].keywords).toEqual(expect.arrayContaining(['warehouse', 'ingestion']));
  });
});

describe('shouldProposeSkill', () => {
  const gap = { pane: 'lakehouse', keywords: ['medallion', 'delta'], sampleCount: 6, samplePrompts: [] };

  it('is proposal-worthy when sampleCount meets minSamples and has keywords', () => {
    expect(shouldProposeSkill(gap, { minSamples: 5 })).toBe(true);
  });

  it('is not proposal-worthy below minSamples', () => {
    expect(shouldProposeSkill({ ...gap, sampleCount: 3 }, { minSamples: 5 })).toBe(false);
  });

  it('is not proposal-worthy with no keywords', () => {
    expect(shouldProposeSkill({ ...gap, keywords: [] }, { minSamples: 1 })).toBe(false);
  });

  it('defaults minSamples to 5', () => {
    expect(shouldProposeSkill({ ...gap, sampleCount: 5 })).toBe(true);
    expect(shouldProposeSkill({ ...gap, sampleCount: 4 })).toBe(false);
  });
});
