/**
 * AIF-13 — AgentOps per-run metrics + per-agent rollup (pure logic).
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeUsage, stepTimings, runLatencyMs, runMetrics, rollupAgentRuns,
  type RunRecordLike,
} from '../agentops';

describe('normalizeUsage', () => {
  it('reads OpenAI-style token names', () => {
    expect(normalizeUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }))
      .toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
  });
  it('reads GenAI-style token names and derives total when absent', () => {
    expect(normalizeUsage({ input_tokens: 30, output_tokens: 20 }))
      .toEqual({ promptTokens: 30, completionTokens: 20, totalTokens: 50 });
  });
  it('defaults everything to 0 for null/garbage', () => {
    expect(normalizeUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(normalizeUsage({ prompt_tokens: 'x' })).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

describe('stepTimings / runLatencyMs', () => {
  const steps = [
    { id: 'a', type: 'tool_calls', status: 'completed', createdAt: 1000, completedAt: 1002 },
    { id: 'b', type: 'message_creation', status: 'completed', createdAt: 1002, completedAt: 1005 },
  ];
  it('converts seconds to ms and computes per-step durations', () => {
    const t = stepTimings(steps);
    expect(t[0].startedAt).toBe(1_000_000);
    expect(t[0].durationMs).toBe(2000);
    expect(t[1].durationMs).toBe(3000);
  });
  it('latency = last completion − first start (wall clock)', () => {
    expect(runLatencyMs(steps)).toBe(5000); // 1005s − 1000s = 5000ms
  });
  it('handles missing timestamps gracefully', () => {
    expect(runLatencyMs([{ id: 'x', type: 'step', status: 'completed' }])).toBe(0);
    expect(runLatencyMs([])).toBe(0);
    expect(runLatencyMs(undefined)).toBe(0);
  });
});

describe('runMetrics', () => {
  it('estimates cost from real token counts × the model list price', () => {
    const m = runMetrics({
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 10000, completion_tokens: 10000 },
      steps: [{ id: 'a', type: 'x', status: 'completed', createdAt: 10, completedAt: 12 }],
    });
    expect(m.usage.totalTokens).toBe(20000);
    // gpt-4o-mini = 0.00015 in + 0.0006 out per 1K → 10*(0.00015+0.0006) = 0.0075
    expect(m.costUsd).toBeCloseTo(0.0075, 4);
    expect(m.latencyMs).toBe(2000);
    expect(m.stepCount).toBe(1);
  });
});

describe('rollupAgentRuns', () => {
  const records: RunRecordLike[] = [
    { status: 'completed', model: 'gpt-4o-mini', costUsd: 0.001, latencyMs: 1000, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } },
    { status: 'completed', model: 'gpt-4o', costUsd: 0.02, latencyMs: 3000, usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } },
    { status: 'failed', model: 'gpt-4o-mini', costUsd: 0, latencyMs: 500, usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } },
  ];
  it('aggregates counts, success rate, tokens, cost, latency', () => {
    const r = rollupAgentRuns('finance-agent', records);
    expect(r.runs).toBe(3);
    expect(r.completed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.successRate).toBeCloseTo(0.6667, 3);
    expect(r.totalTokens).toBe(460);
    expect(r.totalCostUsd).toBeCloseTo(0.021, 4);
    expect(r.avgCostUsd).toBeCloseTo(0.007, 3);
    expect(r.avgLatencyMs).toBe(1500); // (1000+3000+500)/3
    expect(r.p50LatencyMs).toBeGreaterThan(0);
    expect(r.p95LatencyMs).toBe(3000);
  });
  it('breaks cost down per model, most-expensive first', () => {
    const r = rollupAgentRuns('finance-agent', records);
    expect(r.byModel[0].model).toBe('gpt-4o');
    const mini = r.byModel.find((m) => m.model === 'gpt-4o-mini')!;
    expect(mini.runs).toBe(2);
    expect(mini.totalTokens).toBe(160);
  });
  it('is safe on an empty record set', () => {
    const r = rollupAgentRuns('x', []);
    expect(r.runs).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.avgLatencyMs).toBe(0);
    expect(r.byModel).toEqual([]);
  });
});
