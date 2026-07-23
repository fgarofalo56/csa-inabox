import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the grounded-chat backend + the raw AOAI turn so the loop is tested
// without any Azure call. resolveAoaiTarget is mocked to a fixed base target.
vi.mock('../data-agent-client', () => ({
  chatGrounded: vi.fn(),
  aoaiChatTurn: vi.fn(),
}));
vi.mock('../copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://acct.openai.azure.com',
    deployment: 'gpt-4o',
    apiVersion: '2024-10-21',
  }),
}));

import { runReasoningAgent } from '../data-agent-reasoning';
import { chatGrounded, aoaiChatTurn } from '../data-agent-client';

const groundedMock = chatGrounded as unknown as ReturnType<typeof vi.fn>;
const aoaiMock = aoaiChatTurn as unknown as ReturnType<typeof vi.fn>;

const cfg = {
  instructions: 'Route to the right source.',
  sources: [
    { id: 's1', type: 'warehouse' as const, name: 'Sales WH' },
    { id: 's2', type: 'kql' as const, name: 'Support KQL' },
  ],
};

const PLAN_JSON =
  '```json\n{"plan":[{"step":1,"source":"Sales WH","subQuery":"revenue by region","rationale":"base"},{"step":2,"source":"Support KQL","subQuery":"tickets by region"}]}\n```';
const VERIFY_JSON =
  '```json\n{"verdict":"pass","reason":"rows answer it","finalAnswer":"West leads at $4.2M with 12 tickets."}\n```';

const SAVED_STRONG = process.env.LOOM_AOAI_STRONG_DEPLOYMENT;

beforeEach(() => {
  groundedMock.mockReset();
  aoaiMock.mockReset();
});
afterEach(() => {
  if (SAVED_STRONG === undefined) delete process.env.LOOM_AOAI_STRONG_DEPLOYMENT;
  else process.env.LOOM_AOAI_STRONG_DEPLOYMENT = SAVED_STRONG;
});

describe('runReasoningAgent — plan → execute → verify', () => {
  it('plans, executes each step on the real grounded backend, and verifies', async () => {
    process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'o3-reasoning';
    // aoaiChatTurn: 1st call = PLAN, 2nd call = VERIFY.
    aoaiMock
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {} })
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {} });
    // chatGrounded: one real executed answer per step.
    groundedMock.mockImplementation(async (_cfg: any, _hist: any, q: string) => ({
      answer: `answer for: ${q}`,
      raw: '',
      tools: [{ source: _cfg.sources[0]?.name || 'src', action: 'query', query: 'select 1', executed: true, rowCount: 3 }],
    }));

    const out = await runReasoningAgent(cfg, [], 'Compare revenue vs tickets by region', { tenantId: 'oid-1' });

    // Plan surfaced (2 ordered steps) + real per-step execution.
    expect(out.mode).toBe('plan-execute-verify');
    expect(out.plan).toHaveLength(2);
    expect(out.steps).toHaveLength(2);
    expect(out.steps.every((s) => s.status === 'completed' && s.executed)).toBe(true);
    expect(out.steps[0].rowCount).toBe(3);
    // Verify verdict + grounded final answer.
    // N12 (self-healing / verified NL2SQL): the verifier CLAIMS 'pass', but its
    // finalAnswer asserts figures ($4.2M, 12) that appear nowhere in the real
    // executed rows (this fixture's grounded backend returns only prose +
    // rowCount, no cells). assessPlausibility traces asserted figures back to
    // actual returned values and DOWNGRADES an unsupported 'pass' to 'partial'
    // — refuse-not-guess applied to the verify step. A model-claimed 'pass'
    // is no longer taken at face value; this is the guarantee, not a quirk.
    expect(out.verify.verdict).toBe('partial');
    expect(out.plausibility?.plausible).toBe(false);
    // The downgrade names the exact untraceable figures — the auditable "why".
    expect(out.plausibility?.unsupportedFigures ?? []).toEqual(
      expect.arrayContaining(['4.2', '12']),
    );
    expect(out.answer).toBe('West leads at $4.2M with 12 tickets.');
    // Executed once per step against the real backend.
    expect(groundedMock).toHaveBeenCalledTimes(2);
    // Each step scoped to the named source (so it grounds on the right backend).
    expect(groundedMock.mock.calls[0][0].sources).toHaveLength(1);
    expect(groundedMock.mock.calls[0][0].sources[0].name).toBe('Sales WH');
    expect(groundedMock.mock.calls[1][0].sources[0].name).toBe('Support KQL');
    // Step 2 sees step 1's answer threaded into its history (dependent multi-hop).
    const step2History = groundedMock.mock.calls[1][1];
    expect(step2History.some((h: any) => h.content === 'answer for: revenue by region')).toBe(true);
  });

  it('routes the PLAN + VERIFY passes to the configured reasoning (strong) deployment', async () => {
    process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'o3-reasoning';
    aoaiMock
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {} })
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {} });
    groundedMock.mockResolvedValue({ answer: 'a', raw: '', tools: [{ source: 'Sales WH', action: 'query', executed: true, rowCount: 1 }] });

    const out = await runReasoningAgent(cfg, [], 'compare A vs B by region', {});

    expect(out.reasoningConfigured).toBe(true);
    expect(out.modelTier).toBe('strong');
    // Both PLAN and VERIFY were dispatched with the strong deployment override.
    expect(aoaiMock.mock.calls[0][2]).toMatchObject({ deployment: 'o3-reasoning' });
    expect(aoaiMock.mock.calls[1][2]).toMatchObject({ deployment: 'o3-reasoning' });
  });

  it('degrades honestly to the base deployment when no reasoning tier is configured', async () => {
    delete process.env.LOOM_AOAI_STRONG_DEPLOYMENT;
    aoaiMock
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {} })
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {} });
    groundedMock.mockResolvedValue({ answer: 'a', raw: '', tools: [{ source: 'Sales WH', action: 'query', executed: true, rowCount: 1 }] });

    const out = await runReasoningAgent(cfg, [], 'compare A vs B by region', {});

    expect(out.reasoningConfigured).toBe(false);
    // Plan/verify still ran — on the base deployment (still functional).
    expect(aoaiMock.mock.calls[0][2]).toMatchObject({ deployment: 'gpt-4o' });
    expect(out.plan.length).toBeGreaterThan(0);
  });

  it('falls back to a single grounded pass when the model produces no plan', async () => {
    aoaiMock.mockResolvedValueOnce({ content: 'I could not make a plan.', usage: {} });
    groundedMock.mockResolvedValue({ answer: 'single-shot answer', raw: '', tools: [] });

    const out = await runReasoningAgent(cfg, [], 'compare A vs B by region', {});

    expect(out.plan).toEqual([]);
    expect(out.steps).toEqual([]);
    expect(out.answer).toBe('single-shot answer');
    expect(out.verify.verdict).toBe('partial');
    // Only the PLAN aoai call happened (no verify), then one grounded fallback.
    expect(aoaiMock).toHaveBeenCalledTimes(1);
    expect(groundedMock).toHaveBeenCalledTimes(1);
  });
});
