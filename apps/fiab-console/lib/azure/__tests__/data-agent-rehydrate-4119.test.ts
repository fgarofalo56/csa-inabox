/**
 * #4119 — a NON-STRING persisted `type` crashed the shared LLM path, same line, same 500.
 *
 * #4116 shipped `only.type?.trim().toLowerCase()`. That is null-SAFE and not TYPE-safe: a
 * persisted `type: 123` throws
 *
 *     TypeError: only.type?.trim is not a function
 *
 * on exactly the same line, uncaught, HTTP 500. `chatGrounded` is the shared grounded path
 * behind roughly fifteen call sites, so that is every AI feature down again for one bad
 * document. `data-agent-source-type-4095.test.ts` names this residual in its own header
 * rather than implying coverage; this file is that coverage.
 *
 * ── WHY THE FIX IS AT THE BOUNDARY, NOT AT LINE 611 ─────────────────────────────────────
 *
 * Guarding that one expression fixes one expression and leaves the class. The actual
 * defect is that a DESERIALISATION BOUNDARY coerced some fields and not others: six API
 * routes rehydrate a persisted Cosmos document and every one of them wrote
 *
 *     id:   String(s.id || s.name || ''),
 *     type: s.type,                        // ← uncoerced
 *     name: String(s.name || ''),
 *
 * so the compiler believed `type: DataAgentSourceType` while the runtime got back whatever
 * Cosmos held. `rehydrateSource` / `rehydrateSources` is now the one boundary all six go
 * through, and this suite is keyed to that SHAPE — "a persisted field reaching the domain
 * object uncoerced" — not to the field name `type`, so a field added later inherits the
 * treatment instead of repeating this.
 *
 * `typeKey()` inside `chatGrounded` is defence in depth for the OTHER call sites, which
 * assemble a config some other way and are not covered by the boundary. Both arms are
 * asserted below, separately, so a regression in either is attributable.
 *
 * ── THE FIXTURES DELIBERATELY VIOLATE `DataAgentSource` ─────────────────────────────────
 *
 * They have to. Per #4118's finding, a fixture that satisfies the interface cannot reach
 * this bug — the values do not come from TypeScript, they come from a document. The casts
 * below are the point, not a shortcut.
 *
 * ── THE EXECUTOR MOCK KEYS ON NAME, NOT TYPE ────────────────────────────────────────────
 *
 * Established by #4118 and carried here deliberately. A type-keyed mock lets a mis-bind
 * pass by gating for the WRONG REASON: route a `kql` tool onto a `type:123` source and a
 * type-keyed mock gates because 123 is not kql, so the turn looks correctly gated while
 * the bind this suite exists to forbid went unnoticed. Keying on the NAME makes a mis-bind
 * come back `executed:true`, so it fails loudly.
 *
 * Mocked at the FETCH layer, as in data-agent-grounding-4091.test.ts, so the real
 * request/response handling is exercised rather than stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (all side-effecting deps) ───────────────────────────────────
// `vi.hoisted` because data-agent-client builds its credential and resolves its fetch
// import at MODULE scope — these have to exist before the import runs.
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

import {
  chatGrounded,
  rehydrateSource,
  rehydrateSources,
  typeKey,
  isKnownSourceType,
  type DataAgentConfig,
} from '../data-agent-client';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The real attached source as it sits in Cosmos, minus the `type` under test. */
const ATTACHED = {
  id: 'wh-1',
  name: 'loompool',
  tables: 'casino.fact_session,casino.dim_player',
  description: 'Casino session facts and player dimension.',
};

/**
 * Every NON-STRING shape a persisted `type` can hold. #4116 closed nullish and left these
 * open; the label is what the failure message will read, so it names the document value.
 */
const NON_STRING_TYPES: Array<[string, unknown, string]> = [
  ['`type: 123` (a number)', 123, '123'],
  ['`type: 0` (a falsy number)', 0, '0'],
  ['`type: true` (a boolean)', true, 'true'],
  ['`type: {}` (an object)', {}, '[object object]'],
  ['`type: []` (an array)', [], ''],
];

/** A persisted document as `state.sources` actually comes back from Cosmos. */
const persisted = (type: unknown) => [{ ...ATTACHED, type }];

const cfgFromPersisted = (type: unknown): DataAgentConfig => ({
  instructions: 'Answer questions about casino performance.',
  sources: rehydrateSources(persisted(type)),
});

/** The SAME document with NO boundary at all — what the other ~15 call sites can hand in. */
const cfgRaw = (type: unknown): DataAgentConfig => ({
  instructions: 'Answer questions about casino performance.',
  sources: persisted(type),
} as unknown as DataAgentConfig);

const typedToolsJson = (query: string, source: string, type?: string) =>
  '```json\n' +
  JSON.stringify({ toolsUsed: [{ source, ...(type ? { type } : {}), action: 'query', query }] }) +
  '\n```';

const SQL = 'SELECT TOP 5 player_name, SUM(net_win) AS net_win FROM casino.fact_session GROUP BY player_name';
const KQL = 'SessionEvents | where Timestamp > ago(7d) | summarize NetWin=sum(Net) by Player';
const ADX_GATE = 'ADX is not configured in this deployment; set LOOM_ADX_CLUSTER.';

const REAL_ROWS = {
  executed: true,
  columns: ['player_name', 'net_win'],
  rows: [['Ada Lovelace', 48210], ['Grace Hopper', 39115]],
  rowCount: 2,
};

function aoaiResponse(content: string, finishReason = 'stop') {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function queueAoai(...contents: string[]) {
  fetchWithTimeout.mockReset();
  for (const c of contents) fetchWithTimeout.mockResolvedValueOnce(aoaiResponse(c));
  fetchWithTimeout.mockResolvedValue(aoaiResponse(''));
}

/** See the header: NAME-keyed, so a mis-bind returns rows instead of gating politely. */
function executorAnsweringAttachedSourceByName(gate = ADX_GATE) {
  executeSourceQuery.mockImplementation(async (src: any) =>
    src?.name === ATTACHED.name ? REAL_ROWS : { executed: false, gate });
}

beforeEach(() => {
  fetchWithTimeout.mockReset();
  executeSourceQuery.mockReset();
  getToken.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────
// ARM 1 — the boundary itself
// ─────────────────────────────────────────────────────────────────────────────

describe('#4119 rehydrateSource — the deserialisation boundary coerces EVERY field', () => {
  it.each(NON_STRING_TYPES)('turns %s into a string', (_label, raw, expected) => {
    const s = rehydrateSource({ ...ATTACHED, type: raw });
    expect(typeof s.type).toBe('string');
    expect(String(s.type).toLowerCase()).toBe(expected);
    // The property that actually stops the 500: the crashing call is now legal.
    expect(() => (s.type as unknown as string).trim().toLowerCase()).not.toThrow();
  });

  it('leaves a KNOWN type exactly as persisted — coercion must not rewrite good data', () => {
    // The negative control. Without it every assertion above is satisfiable by a boundary
    // that blanks the field, which would silently break every correctly-typed agent.
    for (const t of ['warehouse', 'lakehouse', 'kql', 'semantic-model', 'metric-view',
      'ai-search', 'ontology', 'graph', 'microsoft-graph', 'agent']) {
      expect(rehydrateSource({ ...ATTACHED, type: t }).type).toBe(t);
      expect(isKnownSourceType(t)).toBe(true);
    }
  });

  it('coerces the SIBLING fields too, so the shape is closed rather than the field', () => {
    const s = rehydrateSource({ id: 7, name: 9, type: 'warehouse', tables: 5, description: 1 });
    expect(typeof s.id).toBe('string');
    expect(typeof s.name).toBe('string');
    expect(typeof s.tables).toBe('string');
    expect(typeof s.description).toBe('string');
  });

  it('survives a source that is not an object at all, and a sources value that is not an array', () => {
    expect(() => rehydrateSource(null)).not.toThrow();
    expect(rehydrateSource(null).type).toBe('');
    expect(rehydrateSources(undefined)).toEqual([]);
    expect(rehydrateSources('nope' as unknown)).toEqual([]);
  });

  it('typeKey is TOTAL — no runtime value can make it throw', () => {
    for (const v of [123, 0, true, false, {}, [], null, undefined, Symbol.iterator ? 'x' : 'x']) {
      expect(() => typeKey(v)).not.toThrow();
      expect(typeof typeKey(v)).toBe('string');
    }
    expect(typeKey(null)).toBe('');
    expect(typeKey(undefined)).toBe('');
    expect(typeKey('  KQL ')).toBe('kql');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ARM 2 — the shared path, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe('#4119 chatGrounded — a non-string persisted type must not 500 the shared path', () => {
  it('EMBEDDED CONTROL: a well-formed source still executes and grounds', async () => {
    // Without this, every "did not throw / did not bind" assertion below is satisfiable by
    // a harness where nothing ever executes at all.
    queueAoai(
      `Running now.\n${typedToolsJson(SQL, ATTACHED.name, 'warehouse')}`,
      'Ada Lovelace leads with a net win of 48,210.',
    );
    executorAnsweringAttachedSourceByName();

    const ans = await chatGrounded(cfgFromPersisted('warehouse'), [], 'who are my top players?');

    expect(executeSourceQuery).toHaveBeenCalledTimes(1);
    expect(executeSourceQuery.mock.calls[0][0]).toMatchObject({ type: 'warehouse', name: ATTACHED.name });
    expect(ans.grounded).toBe(true);
  });

  it.each(NON_STRING_TYPES)(
    'RESOLVES rather than throwing when the rehydrated source carries %s',
    async (_label, raw) => {
      // MUTATION RECEIPT: revert `rehydrateSource` to `type: s.type` AND `typeKey(...)` to
      // `only.type?.trim().toLowerCase()`, and this rejects with
      // "only.type?.trim is not a function" — the uncaught TypeError that surfaced as a
      // 500 on every AI feature.
      queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgFromPersisted(raw), [], 'who led net win in the last 7 days?');

      expect(ans).toBeTruthy();
      expect(typeof ans.answer).toBe('string');
    },
  );

  it.each(NON_STRING_TYPES)(
    'gates HONESTLY instead of binding the wrong backend when the source carries %s',
    async (_label, raw) => {
      // Not merely "it did not throw". A source whose type is `123` agrees with no declared
      // type, so the only honest outcome is to fall through to the synthesised declared
      // type and gate on the backend that is genuinely absent. Binding the attached
      // warehouse anyway would run a KQL query against Synapse and report grounded:true.
      //
      // The NAME-keyed executor is what makes this assertable: a mis-bind returns REAL_ROWS
      // and fails here, where a type-keyed mock would have gated for the wrong reason.
      queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgFromPersisted(raw), [], 'who led net win in the last 7 days?');

      expect(executeSourceQuery).toHaveBeenCalledTimes(1);
      const routedTo = executeSourceQuery.mock.calls[0][0];
      expect(routedTo.type).toBe('kql');
      expect(routedTo.name).not.toBe(ATTACHED.name);
      expect(ans.grounded).toBe(false);
      expect(ans.groundingGate).toContain('ADX is not configured');
    },
  );

  it.each(NON_STRING_TYPES)(
    'the OTHER ~15 call sites are covered too — a RAW, un-rehydrated config with %s does not throw',
    async (_label, raw) => {
      // `chatGrounded` is exported and most of its callers do not go through the six
      // rehydration routes. The boundary cannot help them; `typeKey()` inside the routing
      // expression is what does.
      //
      // MUTATION RECEIPT: revert ONLY `typeKey(only.type)` to `only.type?.trim()...` —
      // leaving `rehydrateSource` fixed — and this arm rejects while the arm above stays
      // green, which is how the two defences are told apart.
      queueAoai(`Pulling the telemetry now.\n${typedToolsJson(KQL, 'SessionEvents', 'kql')}`);
      executorAnsweringAttachedSourceByName();

      const ans = await chatGrounded(cfgRaw(raw), [], 'who led net win in the last 7 days?');

      expect(ans).toBeTruthy();
      expect(typeof ans.answer).toBe('string');
    },
  );
});
