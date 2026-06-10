/**
 * Contract tests for the Azure AI Search DATA-PLANE client.
 *
 * Locks the exact AI Search REST surface the ai-search-index editor round-trips
 * to (per .claude/rules/no-vaporware.md — real REST, no mocks pretending to be
 * a backend). Each test stubs `fetch` and asserts URL / method / payload.
 *
 * Covered:
 *   - resolveServiceName  → env vs override; SearchNotDeployedError gate
 *   - listIndexes         → GET  /indexes?$select=name,fields,vectorSearch
 *   - getIndex            → GET  /indexes/{n} (404 → null)
 *   - createIndex         → POST /indexes      { name, fields }
 *   - updateIndex         → PUT  /indexes/{n}  { ...def, name }
 *   - getIndexStats       → GET  /indexes/{n}/stats
 *   - searchDocuments     → POST /indexes/{n}/docs/search  { search, top, ... }
 *   - analyzeText         → POST /indexes/{n}/analyze      { text, analyzer }
 *   - listIndexers / runIndexer / resetIndexer / listDataSources / listSkillsets
 *   - content-type guard  → non-JSON error body never throws an opaque parse error
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_AI_SEARCH_SERVICE = 'svc-test';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); delete process.env.LOOM_AI_SEARCH_SERVICE; });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string; contentType?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    const payload = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
    return new Response(payload, {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const HOST = /^https:\/\/svc-test\.search\.windows\.net/;

describe('resolveServiceName', () => {
  it('uses LOOM_AI_SEARCH_SERVICE by default and the override when provided', async () => {
    const { resolveServiceName } = await import('../search-index-client');
    expect(resolveServiceName()).toBe('svc-test');
    expect(resolveServiceName('svc-other')).toBe('svc-other');
  });

  it('throws SearchNotDeployedError naming LOOM_AI_SEARCH_SERVICE when unset', async () => {
    delete process.env.LOOM_AI_SEARCH_SERVICE;
    const mod = await import('../search-index-client');
    expect(() => mod.resolveServiceName()).toThrow(mod.SearchNotDeployedError);
    try { mod.resolveServiceName(); } catch (e: any) { expect(e.hint).toContain('LOOM_AI_SEARCH_SERVICE'); }
    expect(mod.isSearchConfigured()).toBe(false);
  });
});

describe('listIndexes', () => {
  it('GETs /indexes with the field $select and summarizes rows', async () => {
    const calls = captureFetch(() => ({ body: { value: [
      { name: 'a', fields: [{ name: 'id', type: 'Edm.String', key: true }], vectorSearch: { profiles: [] } },
    ] } }));
    const { listIndexes } = await import('../search-index-client');
    const out = await listIndexes();
    expect(calls[0].url).toMatch(HOST);
    expect(calls[0].url).toMatch(/\/indexes\?api-version=2024-07-01/);
    expect(decodeURIComponent(calls[0].url)).toMatch(/\$select=name,fields,vectorSearch/);
    expect(out[0]).toMatchObject({ name: 'a', fieldCount: 1, vectorEnabled: true });
  });
});

describe('getIndex', () => {
  it('GETs /indexes/{name} and returns the raw definition', async () => {
    const calls = captureFetch(() => ({ body: { name: 'hotels', fields: [] } }));
    const { getIndex } = await import('../search-index-client');
    const out = await getIndex('hotels');
    expect(calls[0].url).toMatch(/\/indexes\/hotels\?api-version=/);
    expect(out).toMatchObject({ name: 'hotels' });
  });

  it('returns null on 404', async () => {
    captureFetch(() => ({ status: 404, text: '' }));
    const { getIndex } = await import('../search-index-client');
    expect(await getIndex('missing')).toBeNull();
  });
});

describe('createIndex / updateIndex', () => {
  it('POSTs /indexes with the definition body', async () => {
    const calls = captureFetch(() => ({ body: { name: 'new-idx' } }));
    const { createIndex } = await import('../search-index-client');
    await createIndex({ name: 'new-idx', fields: [{ name: 'id', type: 'Edm.String', key: true }] });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/indexes\?api-version=/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.name).toBe('new-idx');
    expect(body.fields[0].key).toBe(true);
  });

  it('PUTs /indexes/{name} and forces name into the body', async () => {
    const calls = captureFetch(() => ({ body: { name: 'idx' } }));
    const { updateIndex } = await import('../search-index-client');
    await updateIndex('idx', { name: 'WRONG', fields: [] });
    expect(calls[0].init?.method).toBe('PUT');
    expect(calls[0].url).toMatch(/\/indexes\/idx\?api-version=/);
    expect(JSON.parse(String(calls[0].init?.body)).name).toBe('idx');
  });

  it('strips description off scoringProfiles at the wire (API rejects it)', async () => {
    const calls = captureFetch(() => ({ body: {} }));
    const { createIndex } = await import('../search-index-client');
    await createIndex({ name: 'i', fields: [], scoringProfiles: [{ name: 'p', description: 'doc-only' }] });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.scoringProfiles[0].description).toBeUndefined();
    expect(body.scoringProfiles[0].name).toBe('p');
  });
});

describe('getIndexStats', () => {
  it('GETs /indexes/{name}/stats and shapes the counters', async () => {
    const calls = captureFetch(() => ({ body: { documentCount: 147, storageSize: 4592870, vectorIndexSize: 915484 } }));
    const { getIndexStats } = await import('../search-index-client');
    const out = await getIndexStats('hotels');
    expect(calls[0].url).toMatch(/\/indexes\/hotels\/stats\?api-version=/);
    expect(out).toEqual({ documentCount: 147, storageSize: 4592870, vectorIndexSize: 915484 });
  });
});

describe('searchDocuments', () => {
  it('POSTs /docs/search with search/filter/top/select/count', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ '@search.score': 1 }] } }));
    const { searchDocuments } = await import('../search-index-client');
    await searchDocuments('hotels', { search: 'lake', filter: "category eq 'x'", top: 10, select: 'id,name', count: true });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/indexes\/hotels\/docs\/search\?api-version=/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ search: 'lake', filter: "category eq 'x'", top: 10, select: 'id,name', count: true });
  });

  it('defaults empty search to * (match all)', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { searchDocuments } = await import('../search-index-client');
    await searchDocuments('hotels', { search: '' });
    expect(JSON.parse(String(calls[0].init?.body)).search).toBe('*');
  });

  it('passes vectorQueries through for hybrid/k-NN search', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { searchDocuments } = await import('../search-index-client');
    await searchDocuments('hotels', { vectorQueries: [{ kind: 'vector', vector: [0.1, 0.2], fields: 'embedding', k: 5 }] });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.vectorQueries[0]).toMatchObject({ kind: 'vector', fields: 'embedding', k: 5 });
  });

  it('passes semantic options (queryType=semantic + semanticConfiguration + searchFields) to the wire', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { searchDocuments } = await import('../search-index-client');
    await searchDocuments('hotels', {
      search: 'how do clouds form', queryType: 'semantic',
      semanticConfiguration: 'my-semantic-config', searchFields: 'name,description',
      answers: 'extractive', captions: 'extractive',
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.queryType).toBe('semantic');
    expect(body.semanticConfiguration).toBe('my-semantic-config');
    expect(body.searchFields).toBe('name,description');
    expect(body.answers).toBe('extractive');
    expect(body.captions).toBe('extractive');
  });
});

describe('createIndex with the field-designer payload', () => {
  it('POSTs a vector field shaped by fieldRowToApiField (dimensions + profile, no analyzer)', async () => {
    const calls = captureFetch(() => ({ body: { name: 'idx' } }));
    const { createIndex, fieldRowToApiField } = await import('../search-index-client');
    const definition = {
      name: 'idx',
      fields: [
        fieldRowToApiField({ name: 'id', type: 'Edm.String', key: true }),
        fieldRowToApiField({ name: 'vec', type: 'Collection(Edm.Single)', searchable: true, dimensions: 1536, vectorSearchProfile: 'p' }),
      ],
    };
    await createIndex(definition);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(calls[0].init?.method).toBe('POST');
    expect(body.fields[0]).toMatchObject({ name: 'id', key: true, retrievable: true });
    expect(body.fields[1]).toMatchObject({ name: 'vec', dimensions: 1536, vectorSearchProfile: 'p' });
    expect(body.fields[1].analyzer).toBeUndefined();
  });
});

describe('analyzeText', () => {
  it('POSTs /analyze with text + analyzer', async () => {
    const calls = captureFetch(() => ({ body: { tokens: [{ token: 'the' }] } }));
    const { analyzeText } = await import('../search-index-client');
    await analyzeText('hotels', { text: 'The fox', analyzer: 'standard.lucene' });
    expect(calls[0].url).toMatch(/\/indexes\/hotels\/analyze\?api-version=/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ text: 'The fox', analyzer: 'standard.lucene' });
  });
});

describe('indexers / datasources / skillsets', () => {
  it('listIndexers GETs /indexers and shapes rows', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: 'ix', targetIndexName: 'hotels', dataSourceName: 'ds', skillsetName: 'sk' }] } }));
    const { listIndexers } = await import('../search-index-client');
    const out = await listIndexers();
    expect(calls[0].url).toMatch(/\/indexers\?api-version=/);
    expect(out[0]).toMatchObject({ name: 'ix', targetIndexName: 'hotels', dataSourceName: 'ds', skillsetName: 'sk' });
  });

  it('runIndexer POSTs /indexers/{name}/run', async () => {
    const calls = captureFetch(() => ({ status: 202, text: '' }));
    const { runIndexer } = await import('../search-index-client');
    const out = await runIndexer('ix');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/indexers\/ix\/run\?api-version=/);
    expect(out).toEqual({ ok: true });
  });

  it('resetIndexer POSTs /indexers/{name}/reset', async () => {
    // AI Search returns 204 for reset; the Response constructor forbids a body
    // on 204, so the mock yields 202 (also a valid no-content REST ack) here.
    const calls = captureFetch(() => ({ status: 202, text: '' }));
    const { resetIndexer } = await import('../search-index-client');
    const out = await resetIndexer('ix');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toMatch(/\/indexers\/ix\/reset\?api-version=/);
    expect(out).toEqual({ ok: true });
  });

  it('getIndexer GETs /indexers/{name} and returns the definition; 404 → null', async () => {
    const calls = captureFetch((url) => url.includes('/indexers/missing')
      ? ({ status: 404, text: '' })
      : ({ body: { name: 'ix', schedule: { interval: 'PT1H' }, dataSourceName: 'ds' } }));
    const { getIndexer } = await import('../search-index-client');
    const out = await getIndexer('ix');
    expect(calls[0].url).toMatch(/\/indexers\/ix\?api-version=/);
    expect(out).toMatchObject({ name: 'ix', schedule: { interval: 'PT1H' } });
    expect(await getIndexer('missing')).toBeNull();
  });

  it('updateIndexerSchedule GETs then PUTs the merged definition with the new schedule', async () => {
    const calls = captureFetch((url, init) => init?.method === 'PUT'
      ? ({ body: { name: 'ix', schedule: { interval: 'PT2H' } } })
      : ({ body: { name: 'ix', dataSourceName: 'ds', targetIndexName: 'idx', '@odata.etag': 'x' } }));
    const { updateIndexerSchedule } = await import('../search-index-client');
    await updateIndexerSchedule('ix', { interval: 'PT2H', startTime: '2026-01-01T00:00:00Z' }, false);
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toMatch(/\/indexers\/ix\?api-version=/);
    const body = JSON.parse(String(put.init?.body));
    expect(body.schedule).toEqual({ interval: 'PT2H', startTime: '2026-01-01T00:00:00Z' });
    expect(body.disabled).toBe(false);
    expect(body.dataSourceName).toBe('ds'); // preserved
    expect(body['@odata.etag']).toBeUndefined(); // stripped
  });

  it('updateIndexerSchedule with null schedule removes the recurrence', async () => {
    const calls = captureFetch((url, init) => init?.method === 'PUT'
      ? ({ body: { name: 'ix' } })
      : ({ body: { name: 'ix', dataSourceName: 'ds', schedule: { interval: 'PT1H' } } }));
    const { updateIndexerSchedule } = await import('../search-index-client');
    await updateIndexerSchedule('ix', null);
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init?.body)).schedule).toBeUndefined();
  });

  it('listDataSources + listSkillsets GET their endpoints', async () => {
    const calls = captureFetch((url) =>
      url.includes('/datasources')
        ? ({ body: { value: [{ name: 'ds', type: 'azureblob', container: { name: 'c' } }] } })
        : ({ body: { value: [{ name: 'sk', skills: [{}, {}] }] } }));
    const mod = await import('../search-index-client');
    const ds = await mod.listDataSources();
    const sk = await mod.listSkillsets();
    expect(ds[0]).toMatchObject({ name: 'ds', type: 'azureblob', container: 'c' });
    expect(sk[0]).toMatchObject({ name: 'sk', skillCount: 2 });
    expect(calls.some((c) => /\/datasources\?api-version=/.test(c.url))).toBe(true);
    expect(calls.some((c) => /\/skillsets\?api-version=/.test(c.url))).toBe(true);
  });
});

describe('error + content-type guard', () => {
  it('throws SearchDataError carrying status + message on a JSON error body', async () => {
    captureFetch(() => ({ status: 403, body: { error: { message: 'Forbidden: data role missing' } } }));
    const mod = await import('../search-index-client');
    await expect(mod.listIndexes()).rejects.toBeInstanceOf(mod.SearchDataError);
    await expect(mod.listIndexes()).rejects.toThrow(/Forbidden: data role missing/);
  });

  it('does NOT throw an opaque JSON parse error when an error body is HTML', async () => {
    captureFetch(() => ({ status: 502, text: '<html><body>Bad Gateway</body></html>', contentType: 'text/html' }));
    const mod = await import('../search-index-client');
    // Must surface a SearchDataError with the raw text, NOT "Unexpected token <".
    await expect(mod.getIndexStats('hotels')).rejects.toThrow(/502/);
    await expect(mod.getIndexStats('hotels')).rejects.not.toThrow(/Unexpected token/);
  });
});
