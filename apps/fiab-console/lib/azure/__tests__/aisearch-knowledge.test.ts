/**
 * Contract tests for the agentic-retrieval (Knowledge Sources + Knowledge Bases)
 * AI Search client. Locks the exact REST surface Loom's "Knowledge Bases" pane
 * round-trips to (per no-vaporware.md — real REST, no mocks pretending to be a
 * backend). Each test stubs `fetch` and asserts URL / api-version / method /
 * payload against the 2026-04-01 GA (and 2026-05-01-preview) contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_AI_SEARCH_SERVICE = 'svc-test';
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();
  delete process.env.LOOM_AI_SEARCH_SERVICE; delete process.env.LOOM_CLOUD; delete process.env.AZURE_CLOUD;
});

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string; contentType?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    const payload = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
    return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': r.contentType ?? 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const HOST = /^https:\/\/svc-test\.search\.windows\.net\//;

describe('knowledge sources', () => {
  it('listKnowledgeSources GETs /knowledgesources with $select and summarizes rows', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'ks1', kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'idx1' } },
    ] } }));
    const { listKnowledgeSources } = await import('../aisearch-knowledge');
    const out = await listKnowledgeSources();
    expect(calls[0].url).toMatch(HOST);
    expect(calls[0].url).toMatch(/\/knowledgesources\?api-version=2026-04-01/);
    expect(out[0]).toMatchObject({ name: 'ks1', kind: 'searchIndex', searchIndexName: 'idx1' });
  });

  it('createKnowledgeSource PUTs /knowledgesources/{name} with kind searchIndex + params', async () => {
    const calls = captureFetch(() => ({ body: { name: 'ks1' } }));
    const { createKnowledgeSource } = await import('../aisearch-knowledge');
    await createKnowledgeSource({ name: 'ks1', searchIndexName: 'idx1', semanticConfigurationName: 'sem', sourceDataFields: ['title', 'content'], searchFields: ['content'] });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toMatch(/\/knowledgesources\/ks1\?api-version=2026-04-01/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ name: 'ks1', kind: 'searchIndex' });
    expect(body.searchIndexParameters.searchIndexName).toBe('idx1');
    expect(body.searchIndexParameters.semanticConfigurationName).toBe('sem');
    expect(body.searchIndexParameters.sourceDataFields).toEqual([{ name: 'title' }, { name: 'content' }]);
    expect(body.searchIndexParameters.searchFields).toEqual([{ name: 'content' }]);
  });

  it('createKnowledgeSource rejects a missing index name', async () => {
    captureFetch(() => ({ body: {} }));
    const mod = await import('../aisearch-knowledge');
    await expect(mod.createKnowledgeSource({ name: 'ks', searchIndexName: '' })).rejects.toBeInstanceOf(mod.SearchDataError);
  });

  it('deleteKnowledgeSource DELETEs and tolerates 404', async () => {
    const calls = captureFetch(() => ({ status: 404, text: '' }));
    const { deleteKnowledgeSource } = await import('../aisearch-knowledge');
    await deleteKnowledgeSource('ks1');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toMatch(/\/knowledgesources\/ks1\?api-version=/);
  });
});

describe('knowledge bases', () => {
  it('listKnowledgeBases GETs /knowledgebases and normalizes source refs to names', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'kb1', knowledgeSources: [{ name: 'ks1' }, { name: 'ks2' }], outputMode: { kind: 'extractiveData' }, retrievalReasoningEffort: { kind: 'low' } },
    ] } }));
    const { listKnowledgeBases } = await import('../aisearch-knowledge');
    const out = await listKnowledgeBases();
    expect(calls[0].url).toMatch(/\/knowledgebases\?api-version=2026-04-01/);
    expect(out[0]).toMatchObject({ name: 'kb1', knowledgeSources: ['ks1', 'ks2'], outputMode: 'extractiveData', reasoningEffort: 'low' });
  });

  it('createKnowledgeBase PUTs with source refs, extractive default, empty models', async () => {
    const calls = captureFetch(() => ({ body: { name: 'kb1' } }));
    const { createKnowledgeBase } = await import('../aisearch-knowledge');
    await createKnowledgeBase({ name: 'kb1', knowledgeSources: ['ks1', 'ks2'], reasoningEffort: 'medium', description: 'd' });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toMatch(/\/knowledgebases\/kb1\?api-version=2026-04-01/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.knowledgeSources).toEqual([{ name: 'ks1' }, { name: 'ks2' }]);
    expect(body.outputMode).toEqual({ kind: 'extractiveData' });
    expect(body.models).toEqual([]);
    expect(body.retrievalReasoningEffort).toEqual({ kind: 'medium' });
  });

  it('createKnowledgeBase rejects an empty knowledgeSources list', async () => {
    captureFetch(() => ({ body: {} }));
    const mod = await import('../aisearch-knowledge');
    await expect(mod.createKnowledgeBase({ name: 'kb', knowledgeSources: [] })).rejects.toThrow(/at least one knowledge source/);
  });

  it('createKnowledgeBase rejects answerSynthesis without a model (no vaporware)', async () => {
    captureFetch(() => ({ body: {} }));
    const mod = await import('../aisearch-knowledge');
    await expect(mod.createKnowledgeBase({ name: 'kb', knowledgeSources: ['ks1'], outputMode: 'answerSynthesis' })).rejects.toThrow(/requires a model/);
  });

  it('createKnowledgeBase with answerSynthesis + a model targets the preview api-version', async () => {
    const calls = captureFetch(() => ({ body: { name: 'kb' } }));
    const { createKnowledgeBase } = await import('../aisearch-knowledge');
    await createKnowledgeBase({
      name: 'kb', knowledgeSources: ['ks1'], outputMode: 'answerSynthesis',
      models: [{ kind: 'azureOpenAI', azureOpenAIParameters: { resourceUri: 'https://a', deploymentId: 'gpt', modelName: 'gpt-4o' } }],
    });
    expect(calls[0].url).toMatch(/\/knowledgebases\/kb\?api-version=2026-05-01-preview/);
  });
});

describe('retrieve', () => {
  it('GA extractive path POSTs /retrieve with an intents body + 2026-04-01', async () => {
    const calls = captureFetch(() => ({ body: {
      response: [{ role: 'assistant', content: [{ type: 'text', text: '[{"ref_id":"0"}]' }] }],
      activity: [
        { type: 'searchIndex', id: 1, knowledgeSourceName: 'ks1', count: 3, elapsedMs: 42, searchIndexArguments: { search: 'sub query' } },
      ],
      references: [{ type: 'searchIndex', id: '0', docKey: 'doc-1', activitySource: 1 }],
    } }));
    const { retrieveKnowledge } = await import('../aisearch-knowledge');
    const out = await retrieveKnowledge('kb1', { query: 'why is X', knowledgeSourceNames: ['ks1'] });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/knowledgebases\/kb1\/retrieve\?api-version=2026-04-01/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.intents).toEqual([{ type: 'semantic', search: 'why is X' }]);
    expect(body.knowledgeSourceParams).toEqual([{ knowledgeSourceName: 'ks1', kind: 'searchIndex' }]);
    expect(out.answerIsExtractive).toBe(true);
    expect(out.answer).toContain('ref_id');
    expect(out.subqueries[0]).toMatchObject({ source: 'ks1', search: 'sub query', count: 3, elapsedMs: 42 });
    expect(out.citations[0]).toMatchObject({ id: '0', docKey: 'doc-1' });
    expect(out.apiVersion).toBe('2026-04-01');
  });

  it('synthesize path POSTs a messages body against the preview api-version', async () => {
    const calls = captureFetch(() => ({ body: { response: [{ role: 'assistant', content: [{ type: 'text', text: 'A synthesized answer.' }] }], activity: [], references: [] } }));
    const { retrieveKnowledge } = await import('../aisearch-knowledge');
    const out = await retrieveKnowledge('kb1', { query: 'compare A and B', history: [{ role: 'user', text: 'earlier' }], synthesize: true });
    expect(calls[0].url).toMatch(/\/retrieve\?api-version=2026-05-01-preview/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'earlier' }] });
    expect(body.messages[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'compare A and B' }] });
    expect(out.answerIsExtractive).toBe(false);
    expect(out.answer).toBe('A synthesized answer.');
  });

  it('flags a 206 Partial Content as partial (a success, not an error)', async () => {
    captureFetch(() => ({ status: 206, body: { response: [], activity: [], references: [] } }));
    const { retrieveKnowledge } = await import('../aisearch-knowledge');
    const out = await retrieveKnowledge('kb1', { query: 'q' });
    expect(out.partial).toBe(true);
  });

  it('rejects an empty query', async () => {
    captureFetch(() => ({ body: {} }));
    const mod = await import('../aisearch-knowledge');
    await expect(mod.retrieveKnowledge('kb1', { query: '   ' })).rejects.toThrow(/non-empty query/);
  });
});

describe('gov gate + honest-gate types', () => {
  it('knowledgeGovGate is null in Commercial and GCC', async () => {
    const mod = await import('../aisearch-knowledge');
    expect(mod.knowledgeGovGate()).toBeNull();
    process.env.LOOM_CLOUD = 'gcc';
    vi.resetModules();
    const mod2 = await import('../aisearch-knowledge');
    expect(mod2.knowledgeGovGate()).toBeNull();
  });

  it('knowledgeGovGate honest-gates GCC-High and DoD naming the api-version', async () => {
    process.env.LOOM_CLOUD = 'gcc-high';
    const mod = await import('../aisearch-knowledge');
    const g = mod.knowledgeGovGate();
    expect(g?.cloud).toBe('GCC-High');
    expect(g?.reason).toContain('2026-04-01');
  });

  it('surfaces SearchDataError with status + message on a JSON error body', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'Forbidden: Search Service Contributor missing' } } }));
    const mod = await import('../aisearch-knowledge');
    await expect(mod.listKnowledgeBases()).rejects.toBeInstanceOf(mod.SearchDataError);
    await expect(mod.listKnowledgeBases()).rejects.toThrow(/Forbidden/);
  });
});
