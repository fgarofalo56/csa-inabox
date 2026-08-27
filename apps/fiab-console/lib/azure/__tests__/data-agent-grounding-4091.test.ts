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

// ─────────────────────────────────────────────────────────────────────────────
// PR #4095 review blockers.
//
// Both describe defects the #4091 fix ITSELF introduced, so every test below
// fails against the PR head and passes only after the follow-up. The tests that
// must stay GREEN throughout are the no-regression controls, and they already
// exist above:
//   · 'binds a query to the ONLY attached source when the model names a table
//      instead'  — the #4091 defect this PR exists to fix (type MATCHES, so the
//      blocker-1 narrowing must not disturb it).
//   · 'declares itself NOT GROUNDED when even the recovery turn produces no
//      query' — the genuinely model-attributed gate, which blocker 2 must keep
//      distinct from a transport failure rather than collapse into it.
// ─────────────────────────────────────────────────────────────────────────────

/** Tools JSON whose declared `type` is the routing input under test. */
const typedToolsJson = (query: string, source: string, type?: string) =>
  '```json\n' +
  JSON.stringify({ toolsUsed: [{ source, ...(type ? { type } : {}), action: 'query', query }] }) +
  '\n```';

const KQL_QUERY = 'SessionEvents | where Timestamp > ago(7d) | summarize NetWin=sum(Net) by Player';

/** One attached ADX source — the mirror image of CASINO_CFG. */
const ADX_CFG = {
  instructions: 'Answer questions about session telemetry.',
  sources: [{ id: 'kql-1', type: 'kql' as const, name: 'telemetry', tables: 'SessionEvents' }],
};

/**
 * A type-aware executor: only the backend whose type the source actually
 * carries answers; anything else returns its honest gate. This is what makes
 * the assertion discriminating — a mis-routed query does not merely land on the
 * wrong source, it comes back `executed:true` and is reported as grounded.
 */
function executorAnsweringOnly(type: string, gate: string) {
  executeSourceQuery.mockImplementation(async (src: any) =>
    src?.type === type ? REAL_ROWS : { executed: false, gate });
}

describe('#4095 blocker 1 — the single-attached-source fallback must respect tool.type', () => {
  it('does NOT hand a kql tool the only attached WAREHOUSE source, and does not call that grounded', async () => {
    // On the PR head the fallback ignores `tool.type` entirely: a `kql` tool
    // whose source name does not match is routed to whatever the single
    // attached source happens to be — here a Synapse warehouse. The warehouse
    // answers `executed:true`, so the turn reports `grounded:true` with NO gate
    // for a question answered by the WRONG backend. On `main` this could not
    // happen: with no single-source fallback the tool synthesised its DECLARED
    // type and gated honestly. That makes the PR head strictly worse than main.
    //
    // MUTATION RECEIPT: revert the `!tool.type || tool.type === …` narrowing in
    // the source-resolution chain and this fails — the executor is handed
    // {type:'warehouse', name:'loompool'} and `grounded` comes back true.
    queueAoai(
      { content: `Pulling the telemetry now.\n${typedToolsJson(KQL_QUERY, 'SessionEvents', 'kql')}` },
      { content: 'Ada Lovelace leads with 48,210.' }, // only consumed on the BROKEN path
    );
    executorAnsweringOnly('warehouse', 'ADX is not configured in this deployment; set LOOM_ADX_CLUSTER.');

    const ans = await chatGrounded(CASINO_CFG, [], 'who led net win in the last 7 days?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    const routedTo = executeSourceQuery.mock.calls[0][0];
    // The kql tool must never be given the warehouse's typed config.
    expect(routedTo.type).toBe('kql');
    expect(routedTo.name).not.toBe('loompool');

    // …and because no ADX source is attached, the turn is honestly gated.
    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toContain('ADX is not configured');
  });

  it('does NOT hand a warehouse tool the only attached KQL source either (the mirror case)', async () => {
    // The same defect in the other direction, so the guard cannot be satisfied
    // by special-casing one source type.
    // MUTATION RECEIPT: revert the narrowing → the executor is handed
    // {type:'kql', name:'telemetry'} and `grounded` comes back true.
    queueAoai(
      { content: `Querying the warehouse.\n${typedToolsJson(RECOVERED_SQL, 'casino.fact_session', 'warehouse')}` },
      { content: 'Ada Lovelace leads with 48,210.' },
    );
    executorAnsweringOnly('kql', 'Synapse dedicated SQL is not configured in this deployment.');

    const ans = await chatGrounded(ADX_CFG, [], 'who are my top players by net win?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    const routedTo = executeSourceQuery.mock.calls[0][0];
    expect(routedTo.type).toBe('warehouse');
    expect(routedTo.name).not.toBe('telemetry');

    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toContain('Synapse dedicated SQL is not configured');
  });
});

describe('#4095 blocker 2 — a recovery call that never completed is not a silent model', () => {
  it('attributes a THROWN recovery call to the transport, not to the model (deploy-integrity R7)', async () => {
    // The recovery turn is wrapped in a bare `catch {}`. When the recovery HTTP
    // call throws, `parsed.tools` carries no gate, `gates.length === 0`, and the
    // gate string blames the model for emitting no query — but the model was
    // never reached. That is a transport failure reported as a model failure:
    // exactly the shape R7 exists to prevent, inside the block whose own
    // comment cites R7.
    //
    // MUTATION RECEIPT: restore the bare `catch {}` (drop the captured failure
    // and the third gate branch) and this fails — the gate reads "The model
    // produced no runnable query…" and carries no mention of ECONNRESET.
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValueOnce(aoaiResponse(NARRATION)); // phase 1 — narrates
    fetchWithTimeout.mockRejectedValueOnce(new Error('fetch failed: ECONNRESET')); // phase 1b — never reaches the model
    fetchWithTimeout.mockResolvedValue(aoaiResponse(''));

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(executeSourceQuery).not.toHaveBeenCalled();
    expect(ans.grounded).toBe(false);

    // The gate states what was actually established: the call failed, with its reason.
    expect(ans.groundingGate).toMatch(/recovery/i);
    expect(ans.groundingGate).toContain('ECONNRESET');
    // …and explicitly does NOT assert a model behaviour the code never observed.
    expect(ans.groundingGate).not.toMatch(/model produced no runnable query/i);
    // The unknown is named as unknown rather than resolved against the model.
    expect(ans.groundingGate).toMatch(/unknown/i);
  });

  it('carries the QUOTA reason when the recovery call is rate-limited', async () => {
    // A 429 is the most common real cause of this path and is emphatically not
    // "the model declined to emit a query".
    // MUTATION RECEIPT: restore the bare `catch {}` → the gate blames the model
    // and the 429 disappears entirely.
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockResolvedValueOnce(aoaiResponse(NARRATION));
    fetchWithTimeout.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: '429', message: 'Requests to the ChatCompletions_Create Operation have exceeded the token rate limit.' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    fetchWithTimeout.mockResolvedValue(aoaiResponse(''));

    const ans = await chatGrounded(CASINO_CFG, [], 'who are my top players by net win?');

    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toMatch(/429|rate limit/i);
    expect(ans.groundingGate).not.toMatch(/model produced no runnable query/i);
  });
});
