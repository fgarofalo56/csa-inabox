/**
 * #4095 follow-up (PR #4116) — REGRESSION TEST for the null-type dereference.
 *
 * `chatGrounded` resolves a typed source for every tool the model emits. The
 * middle link of that resolution chain narrows the single-attached-source
 * fallback by TYPE, so that a `kql` tool can no longer land on the only
 * attached WAREHOUSE and report `grounded:true` for an answer the wrong
 * backend produced (the blocker-1 tests in data-agent-grounding-4091.test.ts).
 * That narrowing read the source's type with no guard:
 *
 *     || (only && (!toolType || toolType === only.type.toLowerCase()) ? only : undefined)
 *                                                    ^^^^^^^^^^^^^^^
 *
 * When the single attached source carries NO `type`, that throws
 *
 *     TypeError: Cannot read properties of undefined (reading 'toLowerCase')
 *
 * and nothing catches it. It escapes `chatGrounded` — the shared grounded path
 * behind roughly fifteen call sites (the data-agent chat / a2a / mcp /
 * evaluate / copilot / run-steps routes, /api/ask, aip-logic invoke, the agent
 * mesh and orchestrator, the ontology and semantic-model editors) — so every
 * AI feature on the estate answered HTTP 500.
 *
 * ── WHY NO EXISTING TEST CAUGHT IT, which is the reason this file exists ────
 *
 * The defect lives entirely inside a shape that no fixture modelled. Every
 * source fixture in the suite carries a `type`, so two independent adversarial
 * reviews, extensive mutation testing and 33 green checks all ran straight
 * past it. The fixtures below therefore lead with the SHAPE rather than the
 * scenario: type absent, type undefined, type empty, type padded, type
 * mis-cased, and the multi-source path where `only` is undefined.
 *
 * The shape is not hypothetical. Six API routes rehydrate a persisted Cosmos
 * document into a `DataAgentConfig`, and every one of them coerces the
 * siblings while passing the type through RAW:
 *
 *     id:   String(s.id || s.name || ''),
 *     type: s.type,                        // ← unvalidated, untyped at runtime
 *     name: String(s.name || ''),
 *
 * (`app/api/items/data-agent/[id]/{chat,a2a,mcp,evaluate,copilot}/route.ts`
 * and `app/api/data-agent/run-steps/route.ts`). A document written before
 * `type` existed, by a partial edit, or by an import path that never set it
 * produces exactly these shapes at runtime with the compiler none the wiser —
 * which is why the fixtures here deliberately violate `DataAgentSource`. A
 * fixture that satisfies the compiler cannot reach this bug.
 *
 * ── KNOWN RESIDUAL, deliberately not asserted here ─────────────────────────
 *
 * The shipped guard is `only.type?.trim()`, which handles a NULLISH type but
 * not a NON-STRING one: a persisted `type: 123` still throws on the same line
 * (`only.type?.trim is not a function`) and still surfaces as a 500. The tool
 * side cannot reach that — `parseAnswer` coerces with `String(t.type)` — but
 * the source side is raw, as shown above. Widening the guard is a change to
 * the fix itself and is out of scope for this test-only follow-up; it is
 * recorded here so the gap is visible rather than implied covered.
 *
 * Mocked at the FETCH layer, as in data-agent-grounding-4091.test.ts, so the
 * real request/response handling is exercised rather than stubbed.
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

const { executeSourceQuery } = vi.hoisted(() => ({ executeSourceQuery: vi.fn() }));
vi.mock('../data-agent-execute', () => ({
  executeSourceQuery,
  executionToText: (src: string, exec: any) =>
    exec.executed
      ? `Source "${src}" returned ${exec.rowCount} row(s):\n${(exec.columns || []).join(' | ')}\n${(exec.rows || []).map((r: any[]) => r.join(' | ')).join('\n')}`
      : `Source "${src}": NOT executed — ${exec.gate}`,
}));

import { chatGrounded, type DataAgentConfig } from '../data-agent-client';

// ── Fixtures: the SHAPE is the subject ───────────────────────────────────────

/**
 * Distinguishes a source document with NO `type` KEY from one that carries the
 * key holding `undefined`. They are identical to `?.` but not to `'type' in s`,
 * to `Object.keys`, or to a future guard written in terms of either — so they
 * are covered as two fixtures, not one.
 */
const ABSENT = Symbol('the type key is absent from the persisted document');

/** The real attached source, minus its type — the live shape from the estate. */
const ATTACHED = {
  id: 'wh-1',
  name: 'loompool',
  tables: 'casino.fact_session,casino.dim_player',
  description: 'Casino session facts and player dimension.',
};

/**
 * Build a config whose single attached source carries the given `type` VALUE,
 * including values TypeScript forbids. The cast is the point: this value does
 * not come from TypeScript, it comes from a persisted document (see the header),
 * and the compiler's belief that it is a `DataAgentSourceType` is exactly the
 * belief that let this ship.
 */
function cfgWithSourceType(type: unknown, extraSources: unknown[] = []): DataAgentConfig {
  const src: Record<string, unknown> = { ...ATTACHED };
  if (type !== ABSENT) src.type = type;
  return {
    instructions: 'Answer questions about casino performance.',
    sources: [src, ...extraSources],
  } as unknown as DataAgentConfig;
}

/** A second, typed source — used to push `cfg.sources.length` past one. */
const SECOND_SOURCE = { id: 'kql-2', type: 'kql', name: 'telemetry', tables: 'SessionEvents' };

/** Tools JSON whose declared `type` is the routing input under test. */
const typedToolsJson = (query: string, source: string, type?: string) =>
  '```json\n' +
  JSON.stringify({ toolsUsed: [{ source, ...(type ? { type } : {}), action: 'query', query }] }) +
  '\n```';

const SQL =
  'SELECT TOP 5 p.player_name, SUM(f.net_win) AS net_win FROM casino.fact_session f ' +
  'JOIN casino.dim_player p ON p.player_id = f.player_id GROUP BY p.player_name ORDER BY net_win DESC';
const KQL = 'SessionEvents | where Timestamp > ago(7d) | summarize NetWin=sum(Net) by Player';

const ADX_GATE = 'ADX is not configured in this deployment; set LOOM_ADX_CLUSTER.';

/** A real, executed result. */
const REAL_ROWS = {
  executed: true,
  columns: ['player_name', 'net_win'],
  rows: [['Ada Lovelace', 48210], ['Grace Hopper', 39115]],
  rowCount: 2,
};

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
function queueAoai(...contents: string[]) {
  fetchWithTimeout.mockReset();
  for (const c of contents) fetchWithTimeout.mockResolvedValueOnce(aoaiResponse(c));
  fetchWithTimeout.mockResolvedValue(aoaiResponse(''));
}

/**
 * An executor that answers ONLY for the REAL attached source, keyed by NAME.
 *
 * The direction of this mock is load-bearing. A naive "only the matching TYPE
 * answers" executor would let a mis-bind pass unnoticed: routing a `kql` tool
 * onto a typeless attached source gives `src.type === undefined`, which is not
 * `'kql'`, so such a mock gates — and the turn then looks correctly gated for
 * entirely the wrong reason, blessing the bind this suite exists to forbid.
 *
 * Keying on the NAME instead makes a mis-bind come back `executed:true` and
 * `grounded:true`, so binding the wrong backend fails loudly. That is the
 * defect #4095 existed to fix, and no test here may quietly permit it.
 */
function executorAnsweringAttachedSourceByName(gate = ADX_GATE) {
  executeSourceQuery.mockImplementation(async (src: any) =>
    src?.name === ATTACHED.name ? REAL_ROWS : { executed: false, gate });
}

/** The three shapes in which a persisted source carries no usable type. */
const TYPELESS_SHAPES: Array<[string, unknown]> = [
  ['the `type` KEY ABSENT from the document', ABSENT],
  ['`type: undefined`', undefined],
  ['`type: ""` (empty string)', ''],
];

beforeEach(() => {
  fetchWithTimeout.mockReset();
  executeSourceQuery.mockReset();
  getToken.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('#4095 — a single attached source with no usable `type` must not crash the shared path', () => {
  it.each(TYPELESS_SHAPES)(
    'RESOLVES rather than throwing when the only attached source has %s',
    async (_label, type) => {
      // MUTATION RECEIPT: restore the pre-fix `only.type.toLowerCase()` and the
      // first two cases REJECT with "Cannot read properties of undefined
      // (reading 'toLowerCase')" — the uncaught TypeError that surfaced as HTTP
      // 500 on every AI feature. The empty-string case survives the pre-fix
      // expression (`''.toLowerCase()` is legal), and is here to pin the shape
      // rather than to go red; a guard rewritten as a truthiness test would
      // break it.
      queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgWithSourceType(type), [], 'who led net win in the last 7 days?');

      expect(ans).toBeTruthy();
      expect(typeof ans.answer).toBe('string');
    },
  );

  it.each(TYPELESS_SHAPES)(
    'falls through to the DECLARED type and gates HONESTLY — it never binds the typeless source (%s)',
    async (_label, type) => {
      // Not merely "it did not throw". A source with no type agrees with no
      // declared type, so the only honest outcome is to fall through to the
      // synthesised declared type and gate on the backend that is genuinely
      // absent. Binding the attached source anyway would execute a KQL query
      // against a Synapse warehouse and report grounded:true — the wrong
      // backend answering, which is the whole reason the #4095 narrowing exists.
      //
      // MUTATION RECEIPT: restore `only.type.toLowerCase()` → the first two
      // cases reject outright. Separately, delete the type comparison so the
      // fallback binds unconditionally (`only ? only : undefined`) → the
      // executor is handed {name:'loompool'}, returns REAL_ROWS, and both the
      // routing and the `grounded` assertions below fail.
      queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgWithSourceType(type), [], 'who led net win in the last 7 days?');

      expect(executeSourceQuery).toHaveBeenCalledTimes(1);
      const routedTo = executeSourceQuery.mock.calls[0][0];
      // Routed to the tool's DECLARED type…
      expect(routedTo.type).toBe('kql');
      // …and emphatically NOT to the attached warehouse.
      expect(routedTo.name).not.toBe(ATTACHED.name);
      // The synthesised source carries none of the real source's typed config,
      // which is precisely why it is a last resort and not a preference.
      expect(routedTo.tables).toBeUndefined();

      // The turn declares itself ungrounded and names the real reason.
      expect(ans.grounded).toBe(false);
      expect(ans.groundingGate).toContain('ADX is not configured');
      expect(ans.tools?.[0]?.executed).toBe(false);
    },
  );
});

describe('#4095 — the narrowing must PRESERVE the #4091 single-source bind', () => {
  it('binds the ONLY attached source when the tool declares no type and the source IS typed', async () => {
    // The #4091 case the narrowing was written to keep working: the model wrote
    // the schema-qualified TABLE where the source name belongs. With one source
    // attached that is unambiguous, and throwing a perfectly runnable query away
    // over a name mismatch is how good SQL became "no data".
    //
    // MUTATION RECEIPT: drop the `!toolType ||` disjunct from the fallback and
    // this fails — `tool.type` is undefined so the third fallback yields nothing
    // either, `src` is undefined, and the tool gates with "Source not found on
    // this agent." having executed nothing.
    queueAoai(
      `Running now.\n${typedToolsJson(SQL, 'casino.fact_session')}`, // no `type` declared
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgWithSourceType('warehouse'), [], 'who are my top players by net win?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({
      type: 'warehouse',
      name: ATTACHED.name,
      tables: ATTACHED.tables, // the REAL source, with its config intact
    });
    expect(ans.grounded).toBe(true);
    expect(ans.groundingGate).toBeUndefined();
  });

  it.each(TYPELESS_SHAPES)(
    'still binds the ONLY attached source when the tool declares no type and the source has %s',
    async (_label, type) => {
      // The intersection of the two blind spots: an untyped tool AND an untyped
      // source. `!toolType` short-circuits before the source type is read, so
      // this binds — and must keep binding, or a typeless-source agent that
      // worked before #4095 would silently stop returning data.
      //
      // Green against the pre-fix expression too (`||` never evaluates the
      // right-hand side), so this is a no-regression control, not a red case.
      // MUTATION RECEIPT: drop `!toolType ||` → gate "Source not found on this
      // agent.", zero executions, grounded:false.
      queueAoai(
        `Running now.\n${typedToolsJson(SQL, 'casino.fact_session')}`,
        'Ada Lovelace leads with a net win of 48,210.',
      );
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgWithSourceType(type), [], 'who are my top players by net win?');

      expect(executeSourceQuery).toHaveBeenCalledTimes(1);
      expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ name: ATTACHED.name, tables: ATTACHED.tables });
      expect(ans.grounded).toBe(true);
    },
  );
});

describe('#4095 — the source type is compared NORMALIZED, not verbatim', () => {
  it('binds the real source when its persisted type carries surrounding WHITESPACE', async () => {
    // RED against the pre-fix expression, and NOT as a crash: `'  warehouse  '
    // .toLowerCase()` is `'  warehouse  '`, which never equals the normalized
    // tool type `'warehouse'`. The pre-fix code therefore fell through and
    // SYNTHESISED a source, silently discarding the real one's `tables` — and
    // for other source types its AI Search index, Graph scope, agent invoke URL
    // or semantic-model id. A quiet downgrade to a less-configured target, which
    // is why the assertion below is on the routed OBJECT and not just on
    // `grounded`.
    //
    // MUTATION RECEIPT: remove `.trim()` from the source side of the comparison
    // (`only.type?.toLowerCase()`) → routedTo.name is 'casino.fact_session',
    // routedTo.tables is undefined, and grounded comes back false.
    queueAoai(
      `Running now.\n${typedToolsJson(SQL, 'casino.fact_session', 'warehouse')}`,
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgWithSourceType('  warehouse  '), [], 'who are my top players?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ name: ATTACHED.name, tables: ATTACHED.tables });
    expect(ans.grounded).toBe(true);
    expect(ans.groundingGate).toBeUndefined();
  });

  it('binds the real source when its persisted type differs only in CASE', async () => {
    // Green against the pre-fix expression as well — that side already had
    // `.toLowerCase()`. Kept because the fixture set that only ever modelled a
    // clean lowercase type is what produced this incident: pinning the mis-cased
    // shape stops a later "simplification" to a bare `===` from passing.
    queueAoai(
      `Running now.\n${typedToolsJson(SQL, 'casino.fact_session', 'warehouse')}`,
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgWithSourceType('WAREHOUSE'), [], 'who are my top players?');

    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ name: ATTACHED.name });
    expect(ans.grounded).toBe(true);
  });

  it('binds when BOTH the persisted type and the declared type are padded and mis-cased', async () => {
    // Both halves normalized: the tool side by the pre-existing
    // `tool.type?.trim().toLowerCase()`, the source side by the #4116 fix.
    // MUTATION RECEIPT: remove `.trim()` from EITHER side and this fails —
    // the tool side leaves ' WareHouse ' unmatched, the source side leaves
    // '\tWAREHOUSE\n' unmatched. One test, both normalizations pinned.
    queueAoai(
      `Running now.\n${typedToolsJson(SQL, 'casino.fact_session', ' WareHouse ')}`,
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgWithSourceType('\tWAREHOUSE\n'), [], 'who are my top players?');

    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ name: ATTACHED.name, tables: ATTACHED.tables });
    expect(ans.grounded).toBe(true);
  });

  it('does NOT bind when the normalized types genuinely DIFFER, and gates instead', async () => {
    // The control for all three tests above: normalization must make matching
    // types match, not make every type match. A `kql` tool against a padded
    // warehouse still has to fall through and gate.
    // MUTATION RECEIPT: replace the comparison with `true` (or with a
    // startsWith/includes test) → the executor is handed the warehouse, returns
    // REAL_ROWS, and grounded comes back true for the wrong backend.
    queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgWithSourceType('  warehouse  '), [], 'who led net win last week?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][0].name).not.toBe(ATTACHED.name);
    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toContain('ADX is not configured');
  });
});

describe('#4095 — with MORE THAN ONE source attached the narrowing is not consulted at all', () => {
  it('does not throw and does not bind, even when one of several sources is typeless', async () => {
    // `only` is undefined once a second source is attached, so the fallback
    // short-circuits before the source type is read. The typeless source is
    // placed FIRST here deliberately, so that the mutation named below actually
    // reaches it.
    //
    // MUTATION RECEIPT: drop the `cfg.sources.length === 1` guard so `only`
    // becomes `cfg.sources[0]` — against the pre-fix expression this rejects
    // with the same TypeError (the crash is not confined to single-source
    // agents), and against the shipped fix it still gates, proving the guard and
    // the null-check are independent controls rather than one masking the other.
    queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
    executorAnsweringAttachedSourceByName();

    const cfg = cfgWithSourceType(ABSENT, [SECOND_SOURCE]);
    const ans = await chatGrounded(cfg, [], 'who led net win in the last 7 days?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    const routedTo = executeSourceQuery.mock.calls[0][0];
    // Neither attached source was adopted — a synthesised `kql` source was.
    expect(routedTo.name).not.toBe(ATTACHED.name);
    expect(routedTo.name).not.toBe(SECOND_SOURCE.name);
    expect(routedTo.type).toBe('kql');

    expect(ans.grounded).toBe(false);
    expect(ans.groundingGate).toContain('ADX is not configured');
  });

  it('leaves the exact-NAME match, which precedes any type consideration, untouched', async () => {
    // Name match is the FIRST link of the resolution chain and carries no type
    // check: the model was told to copy the source name, so an exact match is
    // the strongest routing signal available. #4095 narrowed only the SECOND
    // link (the single-source fallback), and this test exists to prove the
    // narrowing did not perturb the first — it takes no position on whether
    // name-over-type is the right precedence, which predates #4095 entirely.
    //
    // Asserted on the ROUTING only, deliberately: this suite must not be read as
    // blessing a `grounded:true` for a type that disagrees with its backend.
    //
    // MUTATION RECEIPT: move the name-match link after the single-source
    // fallback and this fails — with two sources attached `only` is undefined,
    // so resolution falls to the synthesised `kql` source and the named
    // warehouse is never reached.
    queueAoai(
      `Running now.\n${typedToolsJson(KQL, ATTACHED.name, 'kql')}`,
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const cfg = cfgWithSourceType('warehouse', [SECOND_SOURCE]);
    await chatGrounded(cfg, [], 'who are my top players?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({
      name: ATTACHED.name,
      tables: ATTACHED.tables,
    });
  });
});
