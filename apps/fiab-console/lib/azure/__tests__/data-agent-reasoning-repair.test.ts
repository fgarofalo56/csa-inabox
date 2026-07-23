/**
 * N12 — the self-healing / verified NL2SQL loop.
 *
 * A STALE-SCHEMA failure (`Invalid object name 'dbo.old_sales'`) must make the
 * loop REPAIR: re-read the LIVE schema, consult N9's metric contract, rewrite,
 * run the EXPLAIN cost guardrail, re-run on the real backend, and record EVERY
 * attempt for the receipt — all STRICTLY BOUNDED (no infinite loop).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data-agent-client', () => ({ chatGrounded: vi.fn(), aoaiChatTurn: vi.fn() }));
vi.mock('../copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://acct.openai.azure.com', deployment: 'gpt-4o', apiVersion: '2024-10-21',
  }),
}));

const matchMetric = vi.fn().mockResolvedValue(null);
vi.mock('../semantic-contract', () => ({
  evaluateContract: vi.fn().mockResolvedValue({ mode: 'none' }),
  matchMetric: (...a: any[]) => matchMetric(...a),
}));

const fetchSynapseSchemaContext = vi.fn().mockResolvedValue('dbo.sales(region varchar, rev int)');
const summarizeExplainXml = vi.fn().mockReturnValue('Total plan operations: 3.');
vi.mock('@/lib/copilot/sql-tools', () => ({
  fetchSynapseSchemaContext: (...a: any[]) => fetchSynapseSchemaContext(...a),
  summarizeExplainXml: (...a: any[]) => summarizeExplainXml(...a),
}));

const explainQuery = vi.fn().mockResolvedValue('<dsql_operations total_cost="1" />');
const dedicatedTarget = vi.fn().mockReturnValue({ server: 's', database: 'd' });
vi.mock('../synapse-sql-client', () => ({
  explainQuery: (...a: any[]) => explainQuery(...a),
  dedicatedTarget: (...a: any[]) => dedicatedTarget(...a),
}));

import {
  runReasoningAgent,
  assessPlausibility,
  assertedFigures,
  classifyStepFailure,
  extractQueryBlock,
  nl2sqlRepairMaxAttempts,
  reasoningReceiptExtras,
} from '../data-agent-reasoning';
import { chatGrounded, aoaiChatTurn } from '../data-agent-client';

const groundedMock = chatGrounded as unknown as ReturnType<typeof vi.fn>;
const aoaiMock = aoaiChatTurn as unknown as ReturnType<typeof vi.fn>;

const cfg = {
  instructions: 'Route to the warehouse.',
  sources: [{ id: 's1', type: 'warehouse' as const, name: 'Sales WH' }],
};

const PLAN_JSON = '```json\n{"plan":[{"step":1,"source":"Sales WH","subQuery":"revenue by region"}]}\n```';
const VERIFY_JSON = '```json\n{"verdict":"pass","reason":"rows answer it","finalAnswer":"West leads at 4200."}\n```';
const REWRITE = '```sql\nSELECT region, SUM(rev) AS revenue FROM dbo.sales GROUP BY region\n```';

const STALE_SCHEMA_FAILURE = {
  answer: 'I could not run that.',
  raw: '',
  tools: [{
    source: 'Sales WH', action: 'query', query: 'SELECT * FROM dbo.old_sales', executed: false,
    gate: "Query did not run against Sales WH: Invalid object name 'dbo.old_sales'.",
  }],
};
const REPAIRED = {
  answer: 'West leads at 4200.',
  raw: '',
  tools: [{
    source: 'Sales WH', action: 'query', query: 'SELECT region, SUM(rev) AS revenue FROM dbo.sales GROUP BY region',
    executed: true, rowCount: 1, columns: ['region', 'revenue'], rows: [['West', 4200]],
  }],
};

function wireAoai() {
  aoaiMock.mockImplementation(async (_t: any, messages: any[]) => {
    const sys = String(messages?.[0]?.content || '');
    if (/PLANNER/.test(sys)) return { content: PLAN_JSON, usage: {} };
    if (/REPAIR/.test(sys)) return { content: REWRITE, usage: {} };
    if (/VERIFIER/.test(sys)) return { content: VERIFY_JSON, usage: {} };
    return { content: '', usage: {} };
  });
}

const SAVED_MAX = process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS;

beforeEach(() => {
  groundedMock.mockReset();
  aoaiMock.mockReset();
  matchMetric.mockReset().mockResolvedValue(null);
  fetchSynapseSchemaContext.mockReset().mockResolvedValue('dbo.sales(region varchar, rev int)');
  explainQuery.mockReset().mockResolvedValue('<dsql_operations total_cost="1" />');
  summarizeExplainXml.mockReset().mockReturnValue('Total plan operations: 3.');
  dedicatedTarget.mockReset().mockReturnValue({ server: 's', database: 'd' });
  if (SAVED_MAX === undefined) delete process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS;
  else process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS = SAVED_MAX;
});

describe('nl2sqlRepairMaxAttempts (safe default, clamped)', () => {
  it('defaults to 2 and clamps out-of-range values', () => {
    delete process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS;
    expect(nl2sqlRepairMaxAttempts()).toBe(2);
    process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS = '50';
    expect(nl2sqlRepairMaxAttempts()).toBe(5);
    process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS = '-3';
    expect(nl2sqlRepairMaxAttempts()).toBe(0);
    delete process.env.LOOM_NL2SQL_REPAIR_MAX_ATTEMPTS;
    expect(nl2sqlRepairMaxAttempts(1)).toBe(1);
  });
});

describe('classifyStepFailure (pure — reads only real backend metadata)', () => {
  it('flags a stale-schema query error as repairable', () => {
    const c = classifyStepFailure(STALE_SCHEMA_FAILURE);
    expect(c.repairable).toBe(true);
    expect(c.query).toBe('SELECT * FROM dbo.old_sales');
    expect(c.source).toBe('Sales WH');
  });
  it('flags an all-empty executed result as implausible', () => {
    const c = classifyStepFailure({ tools: [{ source: 'x', action: 'query', executed: true, rowCount: 0 }] });
    expect(c.repairable).toBe(true);
    expect(c.reason).toMatch(/0 rows/);
  });
  it('does NOT repair an honest infra gate (that is a config problem, not a query bug)', () => {
    const c = classifyStepFailure({
      tools: [{ source: 'x', action: 'query', executed: false, gate: 'ADX not configured: set LOOM_KUSTO_CLUSTER_URI.' }],
    });
    expect(c.repairable).toBe(false);
  });
  it('leaves a healthy step alone', () => {
    expect(classifyStepFailure(REPAIRED).repairable).toBe(false);
  });
});

describe('extractQueryBlock', () => {
  it('pulls the fenced query out of a model reply', () => {
    expect(extractQueryBlock(REWRITE)).toBe('SELECT region, SUM(rev) AS revenue FROM dbo.sales GROUP BY region');
    expect(extractQueryBlock('SELECT 1')).toBe('SELECT 1');
  });
});

describe('runReasoningAgent — N12 repair sub-loop', () => {
  it('repairs a stale-schema failure and answers, recording the attempt', async () => {
    wireAoai();
    matchMetric.mockResolvedValue({
      metric: { metricId: 'net_revenue', label: 'Net Revenue', description: 'Gross minus returns', grain: 'per order' },
      confidence: 0.9,
    });
    groundedMock
      .mockResolvedValueOnce(STALE_SCHEMA_FAILURE)
      .mockResolvedValueOnce(REPAIRED);

    const out = await runReasoningAgent(cfg, [], 'revenue by region', { tenantId: 'oid-1' });

    // The step ends healthy — the loop actually answered.
    expect(out.steps[0].status).toBe('completed');
    expect(out.steps[0].executed).toBe(true);
    expect(out.answer).toBe('West leads at 4200.');

    // EVERY attempt is recorded for the receipt.
    expect(out.repairs).toHaveLength(1);
    const r = out.repairs![0];
    expect(r).toMatchObject({ step: 1, attempt: 1, outcome: 'repaired', metricConsulted: 'net_revenue' });
    expect(r.error).toMatch(/Invalid object name/);
    expect(r.rewrittenQuery).toContain('FROM dbo.sales');
    expect(r.explainSummary).toBe('Total plan operations: 3.');
    expect(r.schemaChars).toBeGreaterThan(0);

    // It RE-READ the live schema and consulted the governed metric contract.
    expect(fetchSynapseSchemaContext).toHaveBeenCalledTimes(1);
    expect(matchMetric).toHaveBeenCalledWith('oid-1', 'revenue by region');
    // The repair prompt carried the live schema + the failing query + the error.
    const repairUser = String(aoaiMock.mock.calls.find((c) => /REPAIR/.test(String(c[1][0].content)))![1][1].content);
    expect(repairUser).toContain('dbo.sales(region varchar, rev int)');
    expect(repairUser).toContain('dbo.old_sales');
    expect(repairUser).toContain('Net Revenue');
    // EXPLAIN ran as the guardrail BEFORE the re-run.
    expect(explainQuery).toHaveBeenCalledTimes(1);
    // The rewrite was PINNED so the real backend runs exactly it.
    expect(String(groundedMock.mock.calls[1][0].instructions)).toContain('REPAIRED QUERY');
    expect(String(groundedMock.mock.calls[1][0].instructions)).toContain('FROM dbo.sales');

    // Receipt wiring (N10).
    const extras = reasoningReceiptExtras(out);
    expect(extras.repairAttempts).toHaveLength(1);
    expect(extras.plausibility?.plausible).toBe(true);
  });

  it('is BOUNDED — a permanently failing query stops at maxAttempts (no infinite loop)', async () => {
    wireAoai();
    groundedMock.mockResolvedValue(STALE_SCHEMA_FAILURE);

    const out = await runReasoningAgent(cfg, [], 'revenue by region', {
      tenantId: 'oid-1',
      maxRepairAttempts: 2,
    });

    // 1 initial run + exactly 2 bounded repair runs.
    expect(groundedMock).toHaveBeenCalledTimes(3);
    expect(out.repairs).toHaveLength(2);
    expect(out.repairs![1].outcome).toBe('abandoned');
    // Honest outcome: the step is still gated, nothing is fabricated.
    expect(out.steps[0].status).toBe('gated');
  });

  it('maxRepairAttempts 0 keeps the pre-N12 behaviour exactly', async () => {
    wireAoai();
    groundedMock.mockResolvedValue(STALE_SCHEMA_FAILURE);
    const out = await runReasoningAgent(cfg, [], 'revenue by region', { tenantId: 'oid-1', maxRepairAttempts: 0 });
    expect(groundedMock).toHaveBeenCalledTimes(1);
    expect(out.repairs).toBeUndefined();
    expect(fetchSynapseSchemaContext).not.toHaveBeenCalled();
  });

  it('EXPLAIN guardrail rejects an invalid rewrite WITHOUT spending an execution', async () => {
    wireAoai();
    explainQuery.mockRejectedValue(new Error("Invalid column name 'revenu'."));
    groundedMock.mockResolvedValue(STALE_SCHEMA_FAILURE);

    const out = await runReasoningAgent(cfg, [], 'revenue by region', { tenantId: 'oid-1', maxRepairAttempts: 2 });

    // Two rewrites were compiled and BOTH rejected → the backend was only ever
    // hit by the ORIGINAL run (no wasted executions on a query that won't compile).
    expect(explainQuery).toHaveBeenCalledTimes(2);
    expect(groundedMock).toHaveBeenCalledTimes(1);
    expect(out.repairs).toHaveLength(2);
    expect(out.repairs![0].explainError).toMatch(/Invalid column name/);
    expect(out.repairs![1].outcome).toBe('abandoned');
  });

  it('skips EXPLAIN when no dedicated pool is wired (non-warehouse deployments)', async () => {
    wireAoai();
    dedicatedTarget.mockImplementation(() => { throw new Error('LOOM_SYNAPSE_DEDICATED_POOL is required'); });
    groundedMock.mockResolvedValueOnce(STALE_SCHEMA_FAILURE).mockResolvedValueOnce(REPAIRED);
    const out = await runReasoningAgent(cfg, [], 'revenue by region', { tenantId: 'oid-1' });
    expect(explainQuery).not.toHaveBeenCalled();
    expect(out.repairs![0].outcome).toBe('repaired');
    expect(out.repairs![0].explainSummary).toBeUndefined();
  });
});

describe('assertedFigures / assessPlausibility (pure verify-side check)', () => {
  it('ignores narration ordinals and bare years', () => {
    expect(assertedFigures('Step 1 of 2026 shows 4,200 and 18.5%')).toEqual(['4200', '18.5']);
  });

  it('fails an answer whose figures appear nowhere in the real rows', () => {
    const v = assessPlausibility('Revenue was 9,999,999.', [
      { step: 1, source: 'x', subQuery: 'q', status: 'completed', executed: true, rowCount: 1,
        tools: [{ source: 'x', action: 'query', executed: true, rowCount: 1, rows: [['West', 4200]] }] },
    ]);
    expect(v.plausible).toBe(false);
    expect(v.unsupportedFigures).toEqual(['9999999']);
  });

  it('passes an answer traceable to the returned rows', () => {
    const v = assessPlausibility('West leads at 4200.', [
      { step: 1, source: 'x', subQuery: 'q', status: 'completed', executed: true, rowCount: 1,
        tools: [{ source: 'x', action: 'query', executed: true, rowCount: 1, rows: [['West', 4200]] }] },
    ]);
    expect(v.plausible).toBe(true);
    expect(v.rowsSeen).toBe(1);
  });

  it('fails a confident answer over an EMPTY result set, but accepts an honest one', () => {
    const emptyStep = [{
      step: 1, source: 'x', subQuery: 'q', status: 'completed' as const, executed: true, rowCount: 0,
      tools: [{ source: 'x', action: 'query', executed: true, rowCount: 0, rows: [] }],
    }];
    expect(assessPlausibility('Revenue grew strongly.', emptyStep).plausible).toBe(false);
    expect(assessPlausibility('No matching rows were returned.', emptyStep).plausible).toBe(true);
  });

  it('fails when nothing executed at all', () => {
    const v = assessPlausibility('Revenue was 4200.', [
      { step: 1, source: 'x', subQuery: 'q', status: 'gated', executed: false, tools: [{ source: 'x', action: 'query', gate: 'not configured' }] },
    ]);
    expect(v.plausible).toBe(false);
    expect(v.rowsSeen).toBe(0);
  });
});
