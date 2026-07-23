import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the grounded-chat backend + raw AOAI turn (no Azure), the target resolver,
// and the semantic-contract store (the loop takes a pre-evaluated decision via
// ctx.contractDecision in these tests, so evaluateContract is never hit — but the
// mock keeps the import graph free of Cosmos).
vi.mock('../data-agent-client', () => ({
  chatGrounded: vi.fn(),
  aoaiChatTurn: vi.fn(),
}));
const resolveTarget = vi.fn().mockResolvedValue({
  endpoint: 'https://acct.openai.azure.com', deployment: 'gpt-4o', apiVersion: '2024-10-21',
});
vi.mock('../copilot-orchestrator', () => ({ resolveAoaiTarget: () => resolveTarget() }));
vi.mock('../semantic-contract', () => ({ evaluateContract: vi.fn().mockResolvedValue({ mode: 'none' }) }));

import { runReasoningAgent } from '../data-agent-reasoning';
import { chatGrounded, aoaiChatTurn } from '../data-agent-client';

const groundedMock = chatGrounded as unknown as ReturnType<typeof vi.fn>;
const aoaiMock = aoaiChatTurn as unknown as ReturnType<typeof vi.fn>;

const cfg = {
  instructions: 'Route to the right source.',
  sources: [{ id: 's1', type: 'warehouse' as const, name: 'Sales WH' }],
};

const APPROVED_VQR = {
  id: 'vqr:1',
  tenantId: 'oid-1',
  docType: 'vqr' as const,
  schemaVersion: 1,
  question: 'What was total revenue by region?',
  query: 'SELECT region, SUM(rev) AS revenue FROM sales GROUP BY region',
  queryLang: 'sql' as const,
  sourceName: 'Sales WH',
  status: 'approved' as const,
  version: 1,
  createdAt: 't', createdBy: 'oid-1', updatedAt: 't',
};

const PLAN_JSON = '```json\n{"plan":[{"step":1,"source":"Sales WH","subQuery":"revenue by region"}]}\n```';
const VERIFY_JSON = '```json\n{"verdict":"pass","reason":"rows answer it","finalAnswer":"West leads at $4.2M."}\n```';

beforeEach(() => {
  groundedMock.mockReset();
  aoaiMock.mockReset();
  resolveTarget.mockClear();
});

describe('runReasoningAgent — N9 verified contract', () => {
  it('VQR HIT: runs the steward-approved query verbatim, skips NL2SQL planning', async () => {
    groundedMock.mockResolvedValue({
      answer: 'Revenue by region: West $4.2M.', raw: '',
      tools: [{ source: 'Sales WH', action: 'query', query: APPROVED_VQR.query, executed: true, rowCount: 4 }],
    });

    const out = await runReasoningAgent(cfg, [], 'total revenue by region', {
      tenantId: 'oid-1',
      contractDecision: { mode: 'verified', vqr: APPROVED_VQR, confidence: 0.95 },
    });

    // Verified-query signal for N10's receipt.
    expect(out.contract).toMatchObject({ mode: 'verified-query', vqrId: 'vqr:1', confidence: 0.95 });
    expect(out.refused).toBeFalsy();
    // Verified-query FIRST: no planner/verify AOAI calls happened.
    expect(aoaiMock).not.toHaveBeenCalled();
    // The approved query was pinned into the grounding so the real backend runs it.
    expect(groundedMock).toHaveBeenCalledTimes(1);
    const pinnedCfg = groundedMock.mock.calls[0][0];
    expect(pinnedCfg.instructions).toContain('SELECT region, SUM(rev)');
    expect(pinnedCfg.instructions).toContain('VERIFIED QUERY');
    // Scoped to the VQR's source so it grounds on the right backend.
    expect(pinnedCfg.sources).toHaveLength(1);
    expect(pinnedCfg.sources[0].name).toBe('Sales WH');
    // One executed step + a pass verdict.
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0].executed).toBe(true);
    expect(out.verify.verdict).toBe('pass');
  });

  it('REFUSE: out-of-contract → structured refusal, no model/backend call at all', async () => {
    const out = await runReasoningAgent(cfg, [], 'how tall is the eiffel tower', {
      tenantId: 'oid-1',
      contractDecision: {
        mode: 'refuse',
        reason: 'outside the governed semantic contract',
        suggestions: ['What was total revenue by region?'],
        metricLabels: ['Net Revenue'],
      },
    });

    expect(out.refused).toBe(true);
    expect(out.contract).toEqual({ mode: 'refused' });
    expect(out.verify.verdict).toBe('fail');
    // No fabrication: the guided message names what the agent CAN answer.
    expect(out.answer).toContain("won't guess");
    expect(out.answer).toContain('Net Revenue');
    expect(out.answer).toContain('What was total revenue by region?');
    // Refusal is pure — no AOAI target resolution, no planning, no grounded run.
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(aoaiMock).not.toHaveBeenCalled();
    expect(groundedMock).not.toHaveBeenCalled();
  });

  it('METRIC: grounds generation on the governed metric + tags the receipt', async () => {
    aoaiMock
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {} })    // PLAN
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {} }); // VERIFY
    groundedMock.mockResolvedValue({
      answer: 'a', raw: '', tools: [{ source: 'Sales WH', action: 'query', executed: true, rowCount: 1 }],
    });

    const out = await runReasoningAgent(cfg, [], 'break down net revenue by region', {
      tenantId: 'oid-1',
      contractDecision: {
        mode: 'metric', confidence: 0.8,
        metric: {
          id: 'metric:net_revenue', tenantId: 'oid-1', docType: 'metric', schemaVersion: 1,
          metricId: 'net_revenue', label: 'Net Revenue', owner: 'x',
          description: 'Gross revenue minus returns', synonyms: [], grain: 'per order',
          sourceKind: 'metric-view', sourceRef: 'mv-1', createdAt: 't', createdBy: 'oid-1', updatedAt: 't',
        },
      },
    });

    expect(out.contract).toMatchObject({ mode: 'metric-grounded', metricId: 'net_revenue', confidence: 0.8 });
    // The metric definition was layered onto the grounded EXECUTE step.
    expect(groundedMock.mock.calls[0][0].instructions).toContain('Governed metric');
    expect(groundedMock.mock.calls[0][0].instructions).toContain('Gross revenue minus returns');
  });

  it('NONE: no contract in force → the pre-N9 plan→execute→verify loop is unchanged', async () => {
    aoaiMock
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {} })
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {} });
    groundedMock.mockResolvedValue({
      answer: 'a', raw: '', tools: [{ source: 'Sales WH', action: 'query', executed: true, rowCount: 1 }],
    });

    const out = await runReasoningAgent(cfg, [], 'compare A vs B by region', {
      tenantId: 'oid-1',
      contractDecision: { mode: 'none' },
    });

    expect(out.contract).toBeUndefined();
    expect(out.refused).toBeFalsy();
    expect(out.mode).toBe('plan-execute-verify');
    expect(out.plan.length).toBeGreaterThan(0);
  });
});
