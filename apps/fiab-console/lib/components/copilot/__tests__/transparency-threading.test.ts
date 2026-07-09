import { describe, it, expect } from 'vitest';
import { groupTurns, type Step } from '../types';

/**
 * CTS-01/02/05: groupTurns must thread the new transparency metadata off the
 * `final` step onto the Turn, and attach a `context_usage` step (which arrives
 * before `final`) to the in-flight turn — without breaking older turns that
 * carry none of it.
 */
describe('groupTurns — transparency metadata threading', () => {
  it('copies CTS-01 status-bar fields from the final step onto the turn', () => {
    const steps: Step[] = [
      { kind: 'tool_call', name: 'loom_x', callId: 'c1' },
      { kind: 'tool_result', name: 'loom_x', callId: 'c1', durationMs: 42 },
      {
        kind: 'final', content: 'done',
        usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020, aoaiCalls: 2, toolCalls: 1 },
        model: 'gpt-4o', provider: 'Azure OpenAI',
        promptTokens: 900, completionTokens: 120, turnLatencyMs: 3400, costUsd: 0.0063,
      },
    ];
    const [turn] = groupTurns(steps);
    expect(turn.model).toBe('gpt-4o');
    expect(turn.provider).toBe('Azure OpenAI');
    expect(turn.promptTokens).toBe(900);
    expect(turn.completionTokens).toBe(120);
    expect(turn.turnLatencyMs).toBe(3400);
    expect(turn.costUsd).toBe(0.0063);
    expect(turn.usage?.totalTokens).toBe(1020);
  });

  it('attaches a context_usage step (emitted before final) to the same turn', () => {
    const usage = {
      contextWindow: 128000, systemPromptTokens: 100, personaContextTokens: 0,
      skills: { count: 0, tokens: 0, names: [] }, tools: { count: 3, tokens: 200 } as any,
      memory: { tokens: 0 }, knowledge: { tokens: 0 },
      conversationHistory: { messages: 1, tokens: 20 },
      totalInputTokens: 320, remainingTokens: 127680, utilizationPct: 0.25,
      segmentSum: 320, segmentsConsistent: true, systemPromptPreview: 'You are…',
    };
    const steps: Step[] = [
      { kind: 'context_usage', usage: { ...usage, tools: { count: 3, tokens: 200, names: ['a'] } } },
      { kind: 'final', content: 'hi', model: 'gpt-4o' },
    ];
    const [turn] = groupTurns(steps);
    expect(turn.contextUsage?.totalInputTokens).toBe(320);
    // context_usage is not rendered as a transcript step row.
    expect(turn.steps.find((s) => s.kind === 'context_usage')).toBeUndefined();
  });

  it('leaves a legacy turn (no metadata) unchanged', () => {
    const steps: Step[] = [{ kind: 'final', content: 'ok' }];
    const [turn] = groupTurns(steps);
    expect(turn.final).toBe('ok');
    expect(turn.costUsd).toBeUndefined();
    expect(turn.turnLatencyMs).toBeUndefined();
    expect(turn.contextUsage).toBeUndefined();
    expect(turn.routedTier).toBeUndefined();
  });

  it('CTS-16: threads routedTier off the final step onto the turn', () => {
    const steps: Step[] = [
      { kind: 'final', content: 'done', model: 'o3', routedTier: 'strong' },
    ];
    const [turn] = groupTurns(steps);
    expect(turn.routedTier).toBe('strong');
  });
});
