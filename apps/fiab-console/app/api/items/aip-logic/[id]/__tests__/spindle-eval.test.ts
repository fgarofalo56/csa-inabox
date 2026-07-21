/**
 * runSpindleEvalSuite — the evals-in-CI publish gate engine (WS-4.6).
 *
 * The REAL block-graph runtime and the AOAI judge are mocked so the test stays
 * pure and asserts the GATE LOGIC: each case runs the graph, is judged 1–5, and
 * the suite passes only when the pass-rate clears the configured threshold.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy block-graph runtime (Azure OpenAI + Synapse + Cosmos) — the
// gate only cares about the {ok, output} contract.
vi.mock('../_block-graph', () => ({
  runBlockGraph: vi.fn(),
}));
// Mock the AOAI judge; keep the real agent-eval scoring (pure).
vi.mock('@/lib/azure/aoai-chat-client', () => ({
  aoaiChatJson: vi.fn(),
  NoAoaiDeploymentError: class NoAoaiDeploymentError extends Error {},
}));

import { runSpindleEvalSuite, normalizeEvalSuite } from '../_spindle-eval';
import { runBlockGraph } from '../_block-graph';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';

const mockRun = runBlockGraph as unknown as ReturnType<typeof vi.fn>;
const mockJudge = aoaiChatJson as unknown as ReturnType<typeof vi.fn>;

function stateWith(cases: any[], settings: any = {}) {
  return { blocks: [{ id: 'b1', kind: 'use-llm', output: 'answer1' }], evalSuite: cases, settings } as Record<string, unknown>;
}

describe('normalizeEvalSuite', () => {
  it('keeps only cases with criteria and caps at 8', () => {
    const raw = [
      { id: '1', criteria: 'ok', inputs: { a: 1 } },
      { id: '2' }, // no criteria → dropped
      ...Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, criteria: 'c' })),
    ];
    expect(normalizeEvalSuite(raw).length).toBe(8);
    expect(normalizeEvalSuite('nope' as any)).toEqual([]);
  });
});

describe('runSpindleEvalSuite — publish gate', () => {
  beforeEach(() => { mockRun.mockReset(); mockJudge.mockReset(); });

  it('passes when every case meets the threshold', async () => {
    mockRun.mockResolvedValue({ ok: true, output: 'High risk: customer 42', outputType: 'string', steps: [] });
    mockJudge.mockResolvedValue({ score: 5, rationale: 'matches criteria' });
    const state = stateWith([
      { id: 'c1', criteria: 'names a risk band', inputs: { customerId: '42' } },
      { id: 'c2', criteria: 'names the customer', inputs: { customerId: '7' } },
    ]);
    const r = await runSpindleEvalSuite(state, 'tenant-1');
    expect(r.passed).toBe(true);
    expect(r.summary.total).toBe(2);
    expect(r.summary.passRate).toBe(1);
    expect(r.rows.every((x) => x.status === 'pass')).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('BLOCKS publish when a case scores below threshold', async () => {
    mockRun.mockResolvedValue({ ok: true, output: 'meh', outputType: 'string', steps: [] });
    mockJudge
      .mockResolvedValueOnce({ score: 5, rationale: 'good' })
      .mockResolvedValueOnce({ score: 2, rationale: 'off-topic' });
    const state = stateWith([
      { id: 'c1', criteria: 'a', inputs: {} },
      { id: 'c2', criteria: 'b', inputs: {} },
    ]);
    const r = await runSpindleEvalSuite(state, 'tenant-1');
    expect(r.passed).toBe(false);               // gate fails
    expect(r.summary.passRate).toBe(0.5);
    expect(r.rows.find((x) => x.id === 'c2')?.status).toBe('fail');
  });

  it('honors a custom threshold + minPassRate', async () => {
    mockRun.mockResolvedValue({ ok: true, output: 'x', outputType: 'string', steps: [] });
    mockJudge.mockResolvedValue({ score: 3, rationale: 'ok-ish' });
    // threshold 3 ⇒ score 3 passes; minPassRate 1 ⇒ all must pass
    const state = stateWith([{ id: 'c1', criteria: 'a', inputs: {} }], { evalThreshold: 3, minPassRate: 1 });
    const r = await runSpindleEvalSuite(state, 'tenant-1');
    expect(r.passThreshold).toBe(3);
    expect(r.passed).toBe(true);
  });

  it('surfaces an honest AOAI gate (not a pass) when the graph is not deployed', async () => {
    mockRun.mockResolvedValue({ ok: false, notDeployed: true, output: '', outputType: 'string', steps: [], gate: { reason: 'r', remediation: 'deploy a model' } });
    const state = stateWith([{ id: 'c1', criteria: 'a', inputs: {} }]);
    const r = await runSpindleEvalSuite(state, 'tenant-1');
    expect(r.notDeployed).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.rows[0].status).toBe('gate');
    expect(mockJudge).not.toHaveBeenCalled();
  });
});
