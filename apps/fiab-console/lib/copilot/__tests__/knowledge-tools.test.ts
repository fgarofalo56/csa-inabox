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
 * These specs run in an environment where `mongodb` genuinely does not resolve —
 * the same condition as the shipped image — so they measure the real branch.
 */
describe('AI-Search-unavailable routing hint (R7)', () => {
  let savedConn: string | undefined;

  beforeEach(() => {
    savedConn = process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    isConfiguredMock.mockReturnValue(false); // AI Search is not deployed here
  });

  afterEach(() => {
    if (savedConn === undefined) delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    else process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = savedConn;
  });

  async function hint(): Promise<string> {
    const retrieve = collect().find((t) => t.name === 'knowledge_base_retrieve');
    const out: any = await retrieve.handler({ knowledgeBase: 'kb1', query: 'q' });
    expect(out.grounded).toBe(false);
    return String(out.message);
  }

  /**
   * THE BLOCKER. Connection string set, driver absent — the pre-fix wording.
   *   MUTATION: `vectorFallbackState()` returning 'ready' on the gate alone
   *   (i.e. dropping the `vcoreDriverResolves()` conjunction) → red here.
   */
  it('does NOT tell the model to call vector_store_retrieve when the driver cannot load', async () => {
    process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING = 'mongodb+srv://loom.invalid/?tls=true';
    const msg = await hint();

    expect(msg).toContain('LOOM_AI_SEARCH_SERVICE');
    // The routing instruction is the thing that must not appear.
    expect(msg).not.toMatch(/call vector_store_retrieve/i);
    expect(msg).not.toMatch(/IS configured in this deployment/);
    // And it must name what it DID establish: configured, but no driver.
    expect(msg).toContain('mongodb');
    expect(msg).toMatch(/not installed in this Console image/i);
    expect(msg).toMatch(/say so honestly/i);
  });

  /** Neither backend wired: unchanged, and still the honest "no backend" answer. */
  it('names the unset connection string when the vector backend is not configured at all', async () => {
    delete process.env.LOOM_COSMOS_VCORE_CONNECTION_STRING;
    const msg = await hint();

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

    const msg = await hint();
    expect(msg).toContain('GCC-High');
    expect(msg).not.toMatch(/call vector_store_retrieve/i);
    expect(msg).toMatch(/not installed in this Console image/i);
  });
});
