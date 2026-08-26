/**
 * #4091 — a data agent bound to a working Synapse warehouse answered fluently,
 * generated NO SQL, and touched NO data.
 *
 * The live symptom, verbatim from the estate:
 *
 *   "To answer your question, I will query the `casino.fact_session` table…
 *    Let me run the query."
 *
 * …returned as HTTP 200 / ok:true, with zero rows behind it. `chatGrounded` had
 * no post-condition: when the model narrated instead of emitting the tools JSON
 * (or the trailing JSON was truncated off a long completion), phase 2 had
 * nothing to run, and the narration was returned verbatim as a successful,
 * confident, data-free answer.
 *
 * These tests mock at the FETCH layer, not at `aoaiChatTurn`, so the real
 * request/response handling — including the `finish_reason` capture the fix
 * adds — is exercised rather than stubbed.
 *
 * Every test here is mutation-proven: see the "MUTATION" note on each.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (all side-effecting deps) ───────────────────────────────────
// `vi.hoisted` because data-agent-client builds its credential and resolves its
// fetch import at MODULE scope — these have to exist before the import runs.
const { fetchWithTimeout, getToken } = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getToken: vi.fn().mockResolvedValue({ token: 'fake-token' }),
}));

vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout,
  LLM_FETCH_TIMEOUT_MS: 60_000,
}));

vi.mock('@azure/identity', () => {
  class Cred { getToken = getToken; }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  AcaManagedIdentityCredential: class { getToken = getToken; },
}));

vi.mock('../copilot-orchestrator', () => ({
  resolveAoaiTarget: vi.fn().mockResolvedValue({
    endpoint: 'https://acct.openai.azure.com',
    deployment: 'gpt-5.6-sol',
    apiVersion: '2024-10-21',
  }),
  NoAoaiDeploymentError: class NoAoaiDeploymentError extends Error {},
}));

// The REAL executor is covered by data-agent-execute*.test.ts; here we assert
// that chatGrounded actually REACHES it with a runnable query.
const { executeSourceQuery } = vi.hoisted(() => ({ executeSourceQuery: vi.fn() }));
vi.mock('../data-agent-execute', () => ({
  executeSourceQuery,
  executionToText: (src: string, exec: any) =>
    exec.executed
      ? `Source "${src}" returned ${exec.rowCount} row(s):\n${(exec.columns || []).join(' | ')}\n${(exec.rows || []).map((r: any[]) => r.join(' | ')).join('\n')}`
      : `Source "${src}": NOT executed — ${exec.gate}`,
}));

import { chatGrounded, aoaiChatTurn, promisesExecution } from '../data-agent-client';

// ── Fixtures modelled on the LIVE estate from the issue ──────────────────────
const CASINO_CFG = {
  instructions: 'Answer questions about casino performance.',
  sources: [{ id: 'wh-1', type: 'warehouse' as const, name: 'loompool', tables: 'casino.fact_session,casino.dim_player' }],
};

/** The exact narration the live agent returned — fluent, confident, no data. */
const NARRATION =
  'To answer your question, I will query the `casino.fact_session` table joined to ' +
  '`casino.dim_player` to rank players by net win. Let me run the query.';

const RECOVERED_SQL =
  'SELECT TOP 5 p.player_name, SUM(f.net_win) AS net_win FROM casino.fact_session f ' +
  'JOIN casino.dim_player p ON p.player_id = f.player_id GROUP BY p.player_name ORDER BY net_win DESC';

const toolsJson = (query: string, source = 'loompool') =>
  '```json\n' + JSON.stringify({ toolsUsed: [{ source, type: 'warehouse', action: 'query', query }] }) + '\n```';

/** Build an AOAI chat-completions response. */
function aoaiResponse(content: string, finishReason = 'stop') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Queue the AOAI responses, in order, that the turn will consume. */
function queueAoai(...responses: Array<{ content: string; finishReason?: string }>) {
  fetchWithTimeout.mockReset();
  for (const r of responses) {
    fetchWithTimeout.mockResolvedValueOnce(aoaiResponse(r.content, r.finishReason ?? 'stop'));
  }
  // Any further call (there should be none) resolves to an empty answer rather
  // than an unhandled rejection, so an over-call shows up as a failed assertion
  // on the CALL COUNT — a clear signal — not as an opaque timeout.
  fetchWithTimeout.mockResolvedValue(aoaiResponse(''));
}

/** A real, executed warehouse result. */
const REAL_ROWS = {
  executed: true,
  columns: ['player_name', 'net_win'],
  rows: [['Ada Lovelace', 48210], ['Grace Hopper', 39115], ['Alan Turing', 27640]],
  rowCount: 3,
};

beforeEach(() => {
  fetchWithTimeout.mockReset();
  executeSourceQuery.mockReset();
  getToken.mockClear();
});

describe('#4091 — chatGrounded must never return a narration as a grounded answer', () => {
  it('RECOVERS a runnable query when the model narrates instead of emitting one, and EXECUTES it', async () => {
    // MUTATION RECEIPT: delete the "Phase 1b: RECOVERY" block in chatGrounded and
    // this fails — executeSourceQuery is never called, grounded is false, and the
    // answer is the bare narration (the exact #4091 behaviour).
    queueAoai(
      { content: NARRATION },                                   // phase 1 — narrates, no query
      { content: toolsJson(RECOVERED_SQL) },                    // phase 1b — query-only recovery
      { content: 'Ada Lovelace leads with a net win of 48,210, ahead of Grace Hopper at 39,115.' }, // phase 2 — re-ground
    );
    executeSourceQuery.mockResolvedValue(REAL_ROWS);

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    // The query actually reached the real backend.
    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][1]).toContain('SUM(f.net_win)');

    // …and the answer is grounded in the rows it returned.
    expect(ans.grounded).toBe(true);
    expect(ans.recoveredQuery).toBe(true);
    expect(ans.groundingGate).toBeUndefined();
    expect(ans.tools?.[0]?.executed).toBe(true);
    expect(ans.tools?.[0]?.rowCount).toBe(3);
    expect(ans.tools?.[0]?.query).toContain('casino.fact_session'); // SQL is VISIBLE
    expect(ans.answer).toContain('48,210');
    expect(ans.answer).not.toContain('Let me run the query');
  });

  it('RECOVERS when the trailing tools JSON was TRUNCATED off a long completion', async () => {
    // The reasoning-tier failure mode: prose is emitted, the cap is hit, and the
    // fenced JSON block is cut mid-object so it cannot be parsed.
    // MUTATION RECEIPT: delete the RECOVERY block → grounded:false, 0 executions.
    queueAoai(
      { content: `${NARRATION}\n\n\`\`\`json\n{"toolsUsed":[{"source":"loompool","type":"ware`, finishReason: 'length' },
      { content: toolsJson(RECOVERED_SQL) },
      { content: 'Ada Lovelace leads with a net win of 48,210.' },
    );
    executeSourceQuery.mockResolvedValue(REAL_ROWS);

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(ans.grounded).toBe(true);
    expect(ans.recoveredQuery).toBe(true);
    expect(ans.answer).toContain('48,210');
  });

  it('declares itself NOT GROUNDED when even the recovery turn produces no query', async () => {
    // The honest-gate path: we could not execute, so the answer must not read as
    // though we did. MUTATION RECEIPT: delete the "Honest post-condition" block →
    // groundingGate is undefined and the answer is the bare confident narration.
    queueAoai(
      { content: NARRATION },
      { content: 'I would need to look at the session table first.' }, // recovery also fails
    );

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(executeSourceQuery).not.toHaveBeenCalled();
    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toMatch(/no runnable query/i);
    // The confident promise is explicitly marked, so no surface can render it as
    // a working answer (no-vaporware.md).
    expect(ans.answer.startsWith('[Not grounded]')).toBe(true);
    expect(ans.answer).toContain(NARRATION);
  });

  it('surfaces the BACKEND gate when a query ran but the source was unreachable', async () => {
    // MUTATION RECEIPT: drop the `gates.length` branch of the post-condition and
    // the specific backend reason is replaced by the generic "no runnable query"
    // message — a false statement about what happened (deploy-integrity R7).
    queueAoai({ content: `Checking now.\n${toolsJson(RECOVERED_SQL)}` });
    executeSourceQuery.mockResolvedValue({
      executed: false,
      gate: 'Query did not run against loompool: Login failed for user.',
    });

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toContain('Login failed for user');
    expect(ans.groundingGate).not.toMatch(/no runnable query/i);
  });

  it('does NOT spend a recovery turn when the model emits a query first time', async () => {
    // The control. A compliant model must cost exactly 2 AOAI calls (propose +
    // re-ground) — the recovery must be conditional, not unconditional.
    // MUTATION RECEIPT: make the recovery unconditional (drop `!hasRunnableQuery`)
    // and this fails on the call count (3 instead of 2) and on recoveredQuery.
    queueAoai(
      { content: `Here are your top players.\n${toolsJson(RECOVERED_SQL)}` },
      { content: 'Ada Lovelace leads with 48,210.' },
    );
    executeSourceQuery.mockResolvedValue(REAL_ROWS);

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(ans.recoveredQuery).toBeUndefined();
    expect(ans.grounded).toBe(true);
  });

  it('binds a query to the ONLY attached source when the model names a table instead', async () => {
    // The model routinely writes the schema-qualified table as `source`. With one
    // source attached that is unambiguous, and throwing the query away over a
    // name mismatch is how a perfectly good SQL statement became "no data".
    // MUTATION RECEIPT: remove the `cfg.sources.length === 1` fallback in the
    // source-resolution chain → gate "Source not found on this agent.", 0 executions.
    queueAoai(
      { content: `Running now.\n${toolsJson(RECOVERED_SQL, 'casino.fact_session')}` },
      { content: 'Ada Lovelace leads with 48,210.' },
    );
    executeSourceQuery.mockResolvedValue(REAL_ROWS);

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    // Bound to the real typed source, so the executor picks the warehouse path.
    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ type: 'warehouse', name: 'loompool' });
    expect(ans.grounded).toBe(true);
  });

  it('leaves a SOURCELESS agent alone (no recovery turn, no false gate)', async () => {
    // A config with no sources has nothing to query — it must not be dragged
    // through recovery or labelled ungrounded.
    // MUTATION RECEIPT: drop `cfg.sources.length > 0` from either guard and this
    // fails (an extra AOAI call, and a groundingGate on a chat-only agent).
    queueAoai({ content: 'No sources are configured on this agent yet.' });

    const ans = await chatGrounded({ instructions: 'chat only', sources: [] }, [], 'hello');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(ans.groundingGate).toBeUndefined();
    expect(ans.answer.startsWith('[Not grounded]')).toBe(false);
  });
});

describe('#4091 — aoaiChatTurn must surface finish_reason', () => {
  const target = { endpoint: 'https://acct.openai.azure.com', deployment: 'gpt-5.6-sol', apiVersion: '2024-10-21' } as any;

  it('reports finish_reason:"length" so a TRUNCATED completion is distinguishable from an empty one', async () => {
    // Discarding finish_reason is what let "the completion hit its cap" be
    // reported as "the model produced no plan".
    // MUTATION RECEIPT: revert aoaiChatTurn to `return { content, usage }` and
    // finishReason is undefined → this fails.
    fetchWithTimeout.mockResolvedValueOnce(aoaiResponse('', 'length'));

    const r = await aoaiChatTurn(target, [{ role: 'user', content: 'plan this' }], { maxCompletionTokens: 900 });

    expect(r.content).toBe('');
    expect(r.finishReason).toBe('length');
  });

  it('reports finish_reason:"stop" on a complete answer', async () => {
    fetchWithTimeout.mockResolvedValueOnce(aoaiResponse('done', 'stop'));
    const r = await aoaiChatTurn(target, [{ role: 'user', content: 'hi' }]);
    expect(r.finishReason).toBe('stop');
  });
});

describe('#4091 — promisesExecution', () => {
  it('matches the LIVE failure text', () => {
    // MUTATION RECEIPT: neuter the regex (e.g. `return false`) → fails.
    expect(promisesExecution(NARRATION)).toBe(true);
  });

  it.each([
    'Let me run the query.',
    "I'll query the fact_session table.",
    'I will now execute the following SQL.',
    'Would you like me to run it?',
    'I am going to fetch the session rows.',
  ])('matches %j', (t) => {
    expect(promisesExecution(t)).toBe(true);
  });

  it.each([
    'Ada Lovelace leads with a net win of 48,210 across 1,204 sessions.',
    'The query returned 3 rows.',
    'I ran the query and found 12 players above the threshold.',
  ])('does NOT match a grounded answer: %j', (t) => {
    // The control — a false positive here would stamp "[Not grounded]" onto real
    // answers, so this half of the assertion matters as much as the other.
    expect(promisesExecution(t)).toBe(false);
  });
});
