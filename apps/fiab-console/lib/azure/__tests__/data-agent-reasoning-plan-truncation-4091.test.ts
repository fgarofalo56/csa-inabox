/**
 * #4091 — `plan: []`, `steps: []`, and a reassuring reason that hid a
 * MEASUREMENT failure.
 *
 * The reported payload from the live estate:
 *
 *   "mode": "plan-execute-verify", "reasoningConfigured": true,
 *   "modelTier": "strong", "plan": [], "steps": [],
 *   "verify": { "verdict": "partial",
 *               "reason": "No multi-step plan was produced; answered in a
 *                          single grounded pass." }
 *
 * Two distinct defects produced that:
 *
 *  1. The PLAN pass rides the STRONG (reasoning) tier, where reasoning tokens
 *     are billed against the SAME `max_completion_tokens` cap as the visible
 *     JSON. A 900-token cap could be consumed entirely by reasoning, returning
 *     `finish_reason:'length'` with EMPTY content — which the loop read as "the
 *     model chose not to plan". An empty plan was ambiguous and the ambiguity
 *     was resolved the wrong way.
 *  2. The single-pass fallback reported `steps: []` even when that pass had
 *     generated AND executed real SQL, hiding the evidence entirely.
 *
 * Every test here is mutation-proven: see the "MUTATION" note on each.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../data-agent-client', () => ({ chatGrounded: vi.fn(), aoaiChatTurn: vi.fn() }));
vi.mock('../copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://acct.openai.azure.com', deployment: 'gpt-5.6-sol', apiVersion: '2024-10-21',
  }),
}));
vi.mock('../semantic-contract', () => ({
  evaluateContract: vi.fn().mockResolvedValue({ mode: 'none' }),
  matchMetric: vi.fn().mockResolvedValue(null),
}));

import { runReasoningAgent } from '../data-agent-reasoning';
import { chatGrounded, aoaiChatTurn } from '../data-agent-client';

const groundedMock = chatGrounded as unknown as ReturnType<typeof vi.fn>;
const aoaiMock = aoaiChatTurn as unknown as ReturnType<typeof vi.fn>;

const cfg = {
  instructions: 'Answer questions about casino performance.',
  sources: [{ id: 'wh-1', type: 'warehouse' as const, name: 'loompool' }],
};

const TOP_PLAYERS_SQL =
  'SELECT TOP 5 p.player_name, SUM(f.net_win) AS net_win FROM casino.fact_session f ' +
  'JOIN casino.dim_player p ON p.player_id = f.player_id GROUP BY p.player_name ORDER BY net_win DESC';

const PLAN_JSON =
  '```json\n{"plan":[{"step":1,"source":"loompool","subQuery":"rank players by net win","rationale":"the question"}]}\n```';
const VERIFY_JSON =
  '```json\n{"verdict":"pass","reason":"the rows answer it","finalAnswer":"Ada Lovelace leads with 48,210."}\n```';

/** A grounded pass that really executed SQL and got rows back. */
const EXECUTED_ANSWER = {
  answer: 'Ada Lovelace leads with a net win of 48,210.',
  raw: '',
  grounded: true,
  tools: [{
    source: 'loompool', type: 'warehouse', action: 'query', query: TOP_PLAYERS_SQL,
    executed: true, rowCount: 3,
    columns: ['player_name', 'net_win'],
    rows: [['Ada Lovelace', 48210], ['Grace Hopper', 39115], ['Alan Turing', 27640]],
  }],
};

const SAVED_STRONG = process.env.LOOM_AOAI_STRONG_DEPLOYMENT;

beforeEach(() => {
  groundedMock.mockReset();
  aoaiMock.mockReset();
  process.env.LOOM_AOAI_STRONG_DEPLOYMENT = 'gpt-5.6-sol';
});

afterEach(() => {
  if (SAVED_STRONG === undefined) delete process.env.LOOM_AOAI_STRONG_DEPLOYMENT;
  else process.env.LOOM_AOAI_STRONG_DEPLOYMENT = SAVED_STRONG;
});

describe('#4091 — a TRUNCATED plan pass must not be read as "no plan"', () => {
  it('RETRIES the plan pass with a larger budget when it truncates, then executes the plan', async () => {
    // MUTATION RECEIPT: delete the `if (plan.length === 0 && planTruncated)`
    // retry block and this fails — plan stays [], the loop degrades to the
    // single-pass fallback, and steps[0].executed is never asserted true.
    aoaiMock
      .mockResolvedValueOnce({ content: '', usage: {}, finishReason: 'length' }) // PLAN — reasoning ate the cap
      .mockResolvedValueOnce({ content: PLAN_JSON, usage: {}, finishReason: 'stop' }) // PLAN retry — fits
      .mockResolvedValueOnce({ content: VERIFY_JSON, usage: {}, finishReason: 'stop' }); // VERIFY
    groundedMock.mockResolvedValue(EXECUTED_ANSWER);

    const ans = await runReasoningAgent(cfg, [], 'who are my top players by net win?');

    expect(ans.plan).toHaveLength(1);
    expect(ans.steps).toHaveLength(1);
    expect(ans.steps[0].executed).toBe(true);
    expect(ans.steps[0].rowCount).toBe(3);
    expect(ans.steps[0].tools?.[0]?.query).toContain('casino.fact_session');
    expect(ans.verify.verdict).toBe('pass');
    expect(ans.planTruncated).toBeUndefined(); // the retry succeeded

    // The retry must actually RAISE the budget — retrying with the same cap
    // would just reproduce the truncation.
    const firstCap = aoaiMock.mock.calls[0][2].maxCompletionTokens;
    const retryCap = aoaiMock.mock.calls[1][2].maxCompletionTokens;
    expect(retryCap).toBeGreaterThan(firstCap);
  });

  it('reports planTruncated + an HONEST reason when the plan pass truncates TWICE', async () => {
    // The degradation is still allowed — but it must no longer claim the model
    // "produced no plan" when the truth is "the plan never fit in the budget".
    // MUTATION RECEIPT: restore the old constant reason string ('No multi-step
    // plan was produced; answered in a single grounded pass.') and this fails on
    // both the /TRUNCATED/ match and the planTruncated flag.
    aoaiMock
      .mockResolvedValueOnce({ content: '', usage: {}, finishReason: 'length' })
      .mockResolvedValueOnce({ content: '', usage: {}, finishReason: 'length' })
      .mockResolvedValue({ content: VERIFY_JSON, usage: {}, finishReason: 'stop' });
    groundedMock.mockResolvedValue(EXECUTED_ANSWER);

    const ans = await runReasoningAgent(cfg, [], 'who are my top players by net win?');

    expect(ans.planTruncated).toBe(true);
    expect(ans.verify.reason).toMatch(/TRUNCATED/i);
    expect(ans.verify.reason).toMatch(/finish_reason=length/);
    // The old, misleading sentence must be gone.
    expect(ans.verify.reason).not.toBe('No multi-step plan was produced; answered in a single grounded pass.');
  });

  it('does NOT retry the plan pass when the model genuinely returned a complete non-plan', async () => {
    // The control: `finish_reason:'stop'` with no JSON is a real model decision,
    // not a truncation, and must not cost a second planning call.
    // MUTATION RECEIPT: drop `&& planTruncated` from the retry condition → a
    // second PLAN call is made and this fails on the call count.
    aoaiMock
      .mockResolvedValueOnce({ content: 'This is a single-hop question.', usage: {}, finishReason: 'stop' })
      .mockResolvedValue({ content: VERIFY_JSON, usage: {}, finishReason: 'stop' });
    groundedMock.mockResolvedValue(EXECUTED_ANSWER);

    const ans = await runReasoningAgent(cfg, [], 'who are my top players by net win?');

    expect(aoaiMock).toHaveBeenCalledTimes(1); // PLAN only — no retry, no verify on this path
    expect(ans.planTruncated).toBeUndefined();
    expect(ans.verify.reason).not.toMatch(/TRUNCATED/i);
  });
});

describe('#4091 — the single-pass fallback must SHOW the SQL it executed', () => {
  it('surfaces the executed query as a step instead of reporting steps: []', async () => {
    // This is the operator-visible half of the bug: a single grounded pass that
    // really ran SQL still reported `steps: []`, so the trace looked identical
    // to a pass that touched nothing.
    // MUTATION RECEIPT: replace the synthesized `steps` with `[]` and this fails
    // on steps.length, the visible query, and the verdict.
    aoaiMock
      .mockResolvedValueOnce({ content: 'no plan needed', usage: {}, finishReason: 'stop' })
      .mockResolvedValue({ content: VERIFY_JSON, usage: {}, finishReason: 'stop' });
    groundedMock.mockResolvedValue(EXECUTED_ANSWER);

    const ans = await runReasoningAgent(cfg, [], 'who are my top players by net win?');

    expect(ans.plan).toHaveLength(0);            // genuinely no multi-step plan
    expect(ans.steps).toHaveLength(1);           // …but the pass IS reported
    expect(ans.steps[0].executed).toBe(true);
    expect(ans.steps[0].rowCount).toBe(3);
    expect(ans.steps[0].tools?.[0]?.query).toContain('SUM(f.net_win)'); // SQL VISIBLE
    expect(ans.verify.verdict).toBe('pass');
    expect(ans.verify.reason).toMatch(/returned 3 row/);
    expect(ans.plausibility?.plausible).toBe(true);
    expect(ans.plausibility?.rowsSeen).toBe(3);
  });

  it('stays HONEST when the single pass executed nothing', async () => {
    // A pass that produced no query must not be dressed up as a verified answer.
    // MUTATION RECEIPT: hard-code the verdict to 'pass' and this fails; drop the
    // groundingGate passthrough and the reason loses the cause.
    aoaiMock
      .mockResolvedValueOnce({ content: 'no plan needed', usage: {}, finishReason: 'stop' })
      .mockResolvedValue({ content: VERIFY_JSON, usage: {}, finishReason: 'stop' });
    groundedMock.mockResolvedValue({
      answer: '[Not grounded] The model produced no runnable query for the attached source(s).',
      raw: '',
      grounded: false,
      groundingGate: 'The model produced no runnable query for the attached source(s).',
      tools: [],
    });

    const ans = await runReasoningAgent(cfg, [], 'who are my top players by net win?');

    expect(ans.steps).toHaveLength(0);           // nothing executed → nothing to show
    expect(ans.verify.verdict).toBe('partial');
    expect(ans.verify.reason).toMatch(/executed no query/i);
    expect(ans.verify.reason).toMatch(/no runnable query/i);
    expect(ans.plausibility?.plausible).toBe(false);
  });
});
