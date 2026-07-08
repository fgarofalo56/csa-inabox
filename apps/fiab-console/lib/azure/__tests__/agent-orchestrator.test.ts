import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the grounded-chat backend so the orchestrator is tested without AOAI.
vi.mock('../data-agent-client', () => ({
  chatGrounded: vi.fn(),
}));

import { orchestrate, type SubAgentRuntime } from '../agent-orchestrator';
import { chatGrounded } from '../data-agent-client';

const mocked = chatGrounded as unknown as ReturnType<typeof vi.fn>;

const orchestratorCfg = { instructions: 'Route to the right sub-agent.', sources: [] as any[] };

beforeEach(() => {
  mocked.mockReset();
});

describe('orchestrate', () => {
  it('with no sub-agents is a single grounded turn', async () => {
    mocked.mockResolvedValueOnce({ answer: 'direct', raw: 'direct', tools: [] });
    const out = await orchestrate(orchestratorCfg, [], [], 'q');
    expect(out.answer).toBe('direct');
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('runs each sub-agent then a synthesis pass, and records delegate tools', async () => {
    const subs: SubAgentRuntime[] = [
      { name: 'Finance', role: 'analyst', config: { instructions: 'fin', sources: [] } },
      { name: 'Ops', config: { instructions: 'ops', sources: [] } },
    ];
    // 2 sub-agent runs + 1 synthesis = 3 calls.
    mocked
      .mockResolvedValueOnce({ answer: 'fin-answer', raw: '', tools: [] })
      .mockResolvedValueOnce({ answer: 'ops-answer', raw: '', tools: [] })
      .mockResolvedValueOnce({ answer: 'final synthesis', raw: '', tools: [{ source: 'wh', action: 'query' }] });

    const out = await orchestrate(orchestratorCfg, subs, [], 'q');
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(out.answer).toBe('final synthesis');
    const delegates = (out.tools || []).filter((t) => t.type === 'connected-agent');
    expect(delegates).toHaveLength(2);
    expect(delegates.map((d) => d.source).sort()).toEqual(['Finance', 'Ops']);
    expect(delegates.find((d) => d.source === 'Finance')?.query).toBe('fin-answer');
  });

  it('surfaces a gated sub-agent as an honest delegate trace (no run)', async () => {
    const subs: SubAgentRuntime[] = [
      { name: 'Broken', config: { instructions: '', sources: [] }, gate: 'not found' },
    ];
    // No runnable sub-agents → falls through to a plain orchestrator run.
    mocked.mockResolvedValueOnce({ answer: 'plain', raw: '', tools: [] });
    const out = await orchestrate(orchestratorCfg, subs, [], 'q');
    expect(mocked).toHaveBeenCalledTimes(1);
    const delegate = (out.tools || []).find((t) => t.source === 'Broken');
    expect(delegate?.gate).toBe('not found');
  });

  it('caps fan-out at 4 sub-agents', async () => {
    const subs: SubAgentRuntime[] = Array.from({ length: 6 }, (_, i) => ({
      name: `A${i}`, config: { instructions: 'x', sources: [] },
    }));
    mocked.mockResolvedValue({ answer: 'a', raw: '', tools: [] });
    await orchestrate(orchestratorCfg, subs, [], 'q');
    // 4 runnable + 1 synthesis = 5.
    expect(mocked).toHaveBeenCalledTimes(5);
  });
});
