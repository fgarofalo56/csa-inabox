/**
 * Tests for the agentic-retrieval Copilot tools (Foundry IQ). Verifies the two
 * tools register with valid JSON-schema params, that knowledge_base_retrieve
 * calls the REAL client and returns grounding + citations, and that the honest
 * preflight fires (no fake answer) when AI Search is unconfigured.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
