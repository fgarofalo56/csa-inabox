import { describe, it, expect } from 'vitest';
import { buildContextUsagePayload, estimateTokens, type ContextUsageInput } from '../context-usage';

function baseInput(over: Partial<ContextUsageInput> = {}): ContextUsageInput {
  return {
    contextWindow: 128000,
    systemPromptTokens: 300,
    personaContextTokens: 50,
    skills: { count: 2, tokens: 120, names: ['Warehouse tuning', 'KQL authoring'] },
    tools: { count: 5, tokens: 800, names: ['loom_a', 'loom_b'] },
    memoryTokens: 0,
    knowledgeTokens: 0,
    conversation: { messages: 1, tokens: 40 },
    systemPromptPreview: 'You are the CSA Loom Copilot…',
    ...over,
  };
}

describe('estimateTokens', () => {
  it('is 0 for empty/whitespace and ~len/4 otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('buildContextUsagePayload (CTS-05 segment-sum invariant)', () => {
  it('holds the invariant: sum of segments === totalInputTokens', () => {
    const p = buildContextUsagePayload(baseInput());
    const sum =
      p.systemPromptTokens + p.personaContextTokens + p.skills.tokens + p.tools.tokens +
      p.memory.tokens + p.knowledge.tokens + p.conversationHistory.tokens;
    expect(sum).toBe(p.totalInputTokens);
    expect(p.segmentSum).toBe(p.totalInputTokens);
    expect(p.segmentsConsistent).toBe(true);
  });

  it('computes utilization + remaining against the window', () => {
    const p = buildContextUsagePayload(baseInput());
    // 300 + 50 + 120 + 800 + 0 + 0 + 40 = 1310
    expect(p.totalInputTokens).toBe(1310);
    expect(p.remainingTokens).toBe(128000 - 1310);
    expect(p.utilizationPct).toBe(Number(((1310 / 128000) * 100).toFixed(2)));
  });

  it('holds the invariant with memory + knowledge segments populated (CTS-08 forward-compat)', () => {
    const p = buildContextUsagePayload(baseInput({ memoryTokens: 220, knowledgeTokens: 640 }));
    expect(p.memory.tokens).toBe(220);
    expect(p.knowledge.tokens).toBe(640);
    expect(p.segmentSum).toBe(1310 + 220 + 640);
    expect(p.segmentsConsistent).toBe(true);
  });

  it('clamps negatives/NaN to 0, never over-fills remaining, truncates preview to 2k', () => {
    const p = buildContextUsagePayload(baseInput({
      systemPromptTokens: -5, conversation: { messages: -1, tokens: Number.NaN },
      contextWindow: 100, tools: { count: 1, tokens: 500, names: [] },
      systemPromptPreview: 'x'.repeat(5000),
    }));
    expect(p.systemPromptTokens).toBe(0);
    expect(p.conversationHistory.tokens).toBe(0);
    // total (0+50+120+500+0+0+0 = 670) exceeds the 100 window → remaining floored at 0.
    expect(p.remainingTokens).toBe(0);
    expect(p.systemPromptPreview.length).toBe(2000);
    // Invariant still holds regardless of over-fill.
    expect(p.segmentsConsistent).toBe(true);
  });

  it('defaults a 0/absent context window to 128k', () => {
    const p = buildContextUsagePayload(baseInput({ contextWindow: 0 }));
    expect(p.contextWindow).toBe(128000);
  });
});
