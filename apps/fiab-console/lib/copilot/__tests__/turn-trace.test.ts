import { describe, it, expect } from 'vitest';
import { deriveTurnTraces } from '../turn-trace';

const finalStep = (over: Record<string, unknown> = {}) => ({
  kind: 'final', content: 'answer', model: 'gpt-x', provider: 'Azure OpenAI',
  usage: { totalTokens: 100 }, turnLatencyMs: 1234, costUsd: 0.01,
  phaseTimings: [{ phase: 'classify', ms: 5 }, { phase: 'llm', ms: 900 }],
  turnDetail: { tools: [{ name: 'loom_list_items', durationMs: 42, ok: true }] },
  citations: [{ id: 'm1', kind: 'memory', heading: 'Memory · fact', preview: 'x' }],
  contextUsage: { utilizationPct: 12, contextWindow: 128000 },
  ...over,
});

describe('deriveTurnTraces', () => {
  it('returns no turns for empty/invalid input', () => {
    expect(deriveTurnTraces(undefined)).toEqual([]);
    expect(deriveTurnTraces([])).toEqual([]);
  });

  it('builds one turn ending at a final step, extracting all metadata', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: list my items' },
      { kind: 'context_usage', usage: {} },
      { kind: 'tool_call', name: 'loom_list_items', args: {}, callId: 'c1' },
      { kind: 'tool_result', name: 'loom_list_items', callId: 'c1', durationMs: 42 },
      finalStep(),
    ];
    const turns = deriveTurnTraces(steps);
    expect(turns).toHaveLength(1);
    const t = turns[0];
    expect(t.prompt).toBe('list my items');
    expect(t.model).toBe('gpt-x');
    expect(t.latencyMs).toBe(1234);
    expect(t.phaseTimings).toHaveLength(2);
    expect(t.tools[0]).toMatchObject({ name: 'loom_list_items', durationMs: 42, ok: true });
    expect(t.citations).toHaveLength(1);
    expect((t.contextUsage as any).utilizationPct).toBe(12);
  });

  it('splits a multi-turn session at each final and re-indexes', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: first' },
      finalStep({ content: 'a1' }),
      { kind: 'thought', content: 'User prompt: second' },
      finalStep({ content: 'a2' }),
    ];
    const turns = deriveTurnTraces(steps);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe('first');
    expect(turns[1].prompt).toBe('second');
    expect(turns[1].index).toBe(1);
  });

  it('reconstructs tools from tool_result steps when turnDetail is absent', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: q' },
      { kind: 'tool_result', name: 'adx_query', callId: 'c1', durationMs: 7, error: 'boom' },
      finalStep({ turnDetail: undefined }),
    ];
    const t = deriveTurnTraces(steps)[0];
    expect(t.tools[0]).toMatchObject({ name: 'adx_query', durationMs: 7, ok: false, error: 'boom' });
  });

  it('captures a trailing in-flight turn with no final and surfaces errors', () => {
    const steps = [
      { kind: 'thought', content: 'User prompt: broke' },
      { kind: 'error', error: 'AOAI 500' },
    ];
    const turns = deriveTurnTraces(steps);
    expect(turns).toHaveLength(1);
    expect(turns[0].error).toBe('AOAI 500');
  });
});
