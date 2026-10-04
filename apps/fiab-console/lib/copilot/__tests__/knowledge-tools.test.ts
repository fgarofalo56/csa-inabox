/**
 * Tests for the agentic-retrieval Copilot tools (Foundry IQ). Verifies the two
 * tools register with valid JSON-schema params, that knowledge_base_retrieve
 * calls the REAL client and returns grounding + citations, and that the honest
 * preflight fires (no fake answer) when AI Search is unconfigured.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const isConfiguredMock = vi.fn(() => true);
const govGateMock = vi.fn(() => null as any);
const listBasesMock = vi.fn();
const retrieveMock = vi.fn();

vi.mock('../../azure/aisearch-knowledge', () => ({
  isSearchConfigured: () => isConfiguredMock(),
  knowledgeGovGate: () => govGateMock(),
  listKnowledgeBases: (...a: unknown[]) => listBasesMock(...a),
  retrieveKnowledge: (...a: unknown[]) => retrieveMock(...a),
}));

import { registerKnowledgeTools } from '../knowledge-tools';

function collect() {
  const registered: any[] = [];
  const fakeRegistry = { register: (t: any) => registered.push(t) } as any;
  registerKnowledgeTools(fakeRegistry);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
  isConfiguredMock.mockReturnValue(true);
  govGateMock.mockReturnValue(null);
});

describe('registerKnowledgeTools', () => {
  it('registers knowledge_base_list + knowledge_base_retrieve with valid schemas', () => {
    const tools = collect();
    const names = tools.map((t) => t.name);
    expect(names).toContain('knowledge_base_list');
    expect(names).toContain('knowledge_base_retrieve');
    const retrieve = tools.find((t) => t.name === 'knowledge_base_retrieve');
    expect(retrieve.parameters.required).toEqual(['knowledgeBase', 'query']);
    expect(retrieve.parameters.properties).toHaveProperty('knowledgeBase');
    expect(retrieve.parameters.properties).toHaveProperty('query');
  });

  it('knowledge_base_retrieve calls the real client and returns grounding + citations', async () => {
    retrieveMock.mockResolvedValue({
      answer: 'grounding-json', answerIsExtractive: true, partial: false,
      subqueries: [{ source: 'ks1', search: 'sub' }],
      citations: [{ id: '0', docKey: 'doc-1', source: 'searchIndex' }],
    });
    const retrieve = collect().find((t) => t.name === 'knowledge_base_retrieve');
    const out: any = await retrieve.handler({ knowledgeBase: 'kb1', query: 'why is X' });
    expect(retrieveMock).toHaveBeenCalledWith('kb1', { query: 'why is X' });
    expect(out.grounded).toBe(true);
    expect(out.grounding).toBe('grounding-json');
    expect(out.citations[0]).toMatchObject({ docKey: 'doc-1' });
  });

  it('returns an honest message (never a fake answer) when AI Search is unconfigured', async () => {
    isConfiguredMock.mockReturnValue(false);
    const retrieve = collect().find((t) => t.name === 'knowledge_base_retrieve');
    const out: any = await retrieve.handler({ knowledgeBase: 'kb1', query: 'q' });
    expect(out.grounded).toBe(false);
    expect(out.message).toContain('LOOM_AI_SEARCH_SERVICE');
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('surfaces the sovereign-cloud honest gate instead of retrieving', async () => {
    govGateMock.mockReturnValue({ cloud: 'GCC-High', reason: 'not GA in GCC-High' });
    const retrieve = collect().find((t) => t.name === 'knowledge_base_retrieve');
    const out: any = await retrieve.handler({ knowledgeBase: 'kb1', query: 'q' });
    expect(out.grounded).toBe(false);
    expect(out.message).toContain('GCC-High');
    expect(retrieveMock).not.toHaveBeenCalled();
  });
});

/**
 * R7 + cloud-parity — the AI-Search-unavailable message must not ROUTE the model
 * to a backend that cannot answer (review blocker on #3400/#3351).
 *
 * The hint used to read "Cosmos DB vector search IS configured in this
 * deployment — call vector_store_retrieve instead to ground this answer" on the
 * strength of ONE fact: LOOM_COSMOS_VCORE_CONNECTION_STRING being non-empty.
 * That is not the fact the sentence asserts. `vcoreVectorSearch` still has to
 * resolve the `mongodb` driver, which is not a dependency of this app, so the
 * tool's only reachable answer is CosmosVcoreDriverError.
 *
 * The estate this fires on is real: `.github/workflows/gov-provision-mongo.yml`
 * sets that connection string on the Gov console, and Gov is precisely where AI
 * Search agentic retrieval may be unavailable. So the model was told a falsehood
 * and sent to a dead end, in the boundary the feature exists for.
 *
 * `mongodb` is now a real `apps/fiab-console/package.json` dependency (#3351
 * driver fix), so in CI (which runs `pnpm install` before vitest) the plain
 * dynamic `import('mongodb')` these specs used to rely on resolving SUCCEEDS —
 * the "driver cannot load" branch is no longer the environment's natural
 * state and a spec that merely imported knowledge-tools statically would
 * silently stop exercising it. Each spec below now DRIVES the outcome with an
 * explicit `vi.doMock('mongodb', …)` + `vi.resetModules()` + a fresh dynamic
 * `import('../knowledge-tools')`, so both branches stay genuinely reachable
 * regardless of whether the real driver is installed in node_modules.
 */
describe('AI-Search-unavailable routing hint (R7)', () => {
  let savedConn: string | undefined;

  beforeEach(() => {
    savedConn = process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    isConfiguredMock.mockReturnValue(false); // AI Search is not deployed here
    vi.resetModules();
  });

  afterEach(() => {
    if (savedConn === undefined) delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    else process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = savedConn;
    vi.doUnmock('mongodb');
  });

  /**
   * Re-imports `../knowledge-tools` fresh (after `vi.resetModules()` +
   * `vi.doMock('mongodb', …)`) so its module-level `_mongoDriverResolves`
   * memo starts unset every time — a driver outcome forced in one test can
   * never leak into the next.
   */
  async function hint(driverResolves: boolean): Promise<string> {
    if (driverResolves) {
      vi.doMock('mongodb', () => ({ MongoClient: class {} }));
    } else {
      vi.doMock('mongodb', () => { throw new Error("Cannot find module 'mongodb'"); });
    }
    const { registerKnowledgeTools: freshRegister } = await import('../knowledge-tools');
    const registered: any[] = [];
    freshRegister({ register: (t: any) => registered.push(t) } as any);
    const retrieve = registered.find((t: any) => t.name === 'knowledge_base_retrieve');
    const out: any = await retrieve.handler({ knowledgeBase: 'kb1', query: 'q' });
    expect(out.grounded).toBe(false);
    return String(out.message);
  }

  /**
   * THE BLOCKER (pre-fix wording, still a live regression risk post-driver-fix).
   *   MUTATION: `vectorFallbackState()` returning 'ready' on the gate alone
   *   (i.e. dropping the `vcoreDriverResolves()` conjunction) → red here, since
   *   the driver is forced to fail resolution for this spec regardless of what
   *   is actually installed.
   */
  it('does NOT tell the model to call vector_store_retrieve when the driver cannot load', async () => {
    process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = 'mongodb+srv://loom.invalid/?tls=true';
    const msg = await hint(false);

    expect(msg).toContain('LOOM_AI_SEARCH_SERVICE');
    // The routing instruction is the thing that must not appear.
    expect(msg).not.toMatch(/call vector_store_retrieve/i);
    expect(msg).not.toMatch(/IS configured in this deployment/);
    // And it must name what it DID establish: configured, but no driver.
    expect(msg).toContain('mongodb');
    expect(msg).toMatch(/not installed in this Console image/i);
    expect(msg).toMatch(/say so honestly/i);
  });

  /**
   * THE FIX THIS PR ADDS (#3351 driver dependency). Connection string set AND
   * the driver resolves — the routing hint must now point at
   * vector_store_retrieve, not report a dependency gap that no longer exists.
   *   MUTATION: `vectorFallbackState()` never reaching 'ready' (e.g. an `&&
   * false` tacked onto the `vcoreDriverResolves()` branch) → red here, since
   * this is the only spec in the file that forces the driver to resolve.
   */
  it('DOES tell the model to call vector_store_retrieve once the driver resolves', async () => {
    process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = 'mongodb+srv://loom.invalid/?tls=true';
    const msg = await hint(true);

    expect(msg).toMatch(/call vector_store_retrieve/i);
    expect(msg).not.toMatch(/not installed in this Console image/i);
  });

  /** Neither backend wired: unchanged, and still the honest "no backend" answer. */
  it('names the unset connection string when the vector backend is not configured at all', async () => {
    delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    // Driver resolution is irrelevant here — cosmosVcoreGate() short-circuits
    // vectorFallbackState() before vcoreDriverResolves() is ever called — but
    // forcing failure keeps this spec deterministic either way.
    const msg = await hint(false);

    expect(msg).toContain('LOOM_COSMOS_VCORE_CONNECTION_STRING');
    expect(msg).not.toMatch(/call vector_store_retrieve/i);
    expect(msg).toMatch(/say so honestly/i);
    // The two unavailable causes must read differently — a missing driver is not
    // a missing connection string.
    expect(msg).not.toMatch(/not installed in this Console image/i);
  });

  /** The sovereign gate path appends the same hint, so it carries the same fix. */
  it('applies the corrected hint to the sovereign-cloud gate too', async () => {
    isConfiguredMock.mockReturnValue(true);
    govGateMock.mockReturnValue({ cloud: 'GCC-High', reason: 'not GA in GCC-High.' });
    process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = 'mongodb+srv://loom.invalid/?tls=true';

    const msg = await hint(false);
    expect(msg).toContain('GCC-High');
    expect(msg).not.toMatch(/call vector_store_retrieve/i);
    expect(msg).toMatch(/not installed in this Console image/i);
  });
});
