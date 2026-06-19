/**
 * Contract tests for the ADF + Synapse pipeline REST clients — the surfaces
 * the bound editor calls. Each test stubs `fetch` and asserts the exact URL,
 * method, and body so a regression in the wire format is caught.
 *
 * Grounded in Microsoft Learn:
 *   - ADF pipelines createOrUpdate / createRun / queryPipelineRuns (api 2018-06-01)
 *   - Synapse dev pipelines + createRun + queryPipelineRuns (api 2020-12-01)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_DLZ_RG = 'rg-dlz';
  process.env.LOOM_ADF_NAME = 'adf-loom';
  process.env.LOOM_SYNAPSE_WORKSPACE = 'syn-loom';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('adf-client REST shapes', () => {
  // First dynamic import of adf-client compiles its module graph (cold), which
  // can take >1.5s under load. The REST call itself is a stubbed fetch; give the
  // cold import headroom so this isn't a flaky timeout.
  it('listPipelines hits factories/{f}/pipelines with api-version', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: 'p1', properties: {} }] } }));
    const { listPipelines } = await import('../adf-client');
    const out = await listPipelines();
    expect(calls[0].url).toMatch(/Microsoft\.DataFactory\/factories\/adf-loom\/pipelines\?api-version=2018-06-01/);
    expect(out[0].name).toBe('p1');
  }, 20000);

  it('upsertPipeline PUTs name+properties to the named pipeline', async () => {
    const calls = captureFetch(() => ({ body: { name: 'ingest', properties: { activities: [] } } }));
    const { upsertPipeline } = await import('../adf-client');
    await upsertPipeline('ingest', { name: 'ingest', properties: { activities: [{ name: 'Copy1', type: 'Copy' }] } });
    expect(calls[0].url).toMatch(/\/pipelines\/ingest\?api-version=2018-06-01/);
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.name).toBe('ingest');
    expect(body.properties.activities[0].name).toBe('Copy1');
  });

  it('runPipeline POSTs createRun on the bound pipeline name', async () => {
    const calls = captureFetch(() => ({ body: { runId: 'run-123' } }));
    const { runPipeline } = await import('../adf-client');
    const res = await runPipeline('ingest', { foo: 'bar' });
    expect(calls[0].url).toMatch(/\/pipelines\/ingest\/createRun\?api-version=2018-06-01/);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ foo: 'bar' });
    expect(res.runId).toBe('run-123');
  });

  it('listPipelineRuns POSTs queryPipelineRuns filtered by PipelineName', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ runId: 'r1', pipelineName: 'ingest', status: 'Succeeded' }] } }));
    const { listPipelineRuns } = await import('../adf-client');
    const out = await listPipelineRuns('ingest', 7);
    expect(calls[0].url).toMatch(/\/queryPipelineRuns\?api-version=2018-06-01/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.filters[0]).toEqual({ operand: 'PipelineName', operator: 'Equals', values: ['ingest'] });
    expect(out[0].runId).toBe('r1');
  });
});

describe('synapse-dev-client REST shapes', () => {
  it('listPipelines hits the dev endpoint /pipelines', async () => {
    const calls = captureFetch(() => ({ body: { value: [{ name: 'sp1', properties: {} }] } }));
    const { listPipelines } = await import('../synapse-dev-client');
    await listPipelines();
    expect(calls[0].url).toMatch(/syn-loom\.dev\.azuresynapse\.net\/pipelines\?api-version=2020-12-01/);
  });

  it('upsertPipeline PUTs to the dev endpoint named pipeline', async () => {
    const calls = captureFetch(() => ({ body: { name: 'sp1', properties: {} } }));
    const { upsertPipeline } = await import('../synapse-dev-client');
    await upsertPipeline('sp1', { name: 'sp1', properties: { activities: [] } });
    expect(calls[0].url).toMatch(/syn-loom\.dev\.azuresynapse\.net\/pipelines\/sp1\?api-version=2020-12-01/);
    expect(calls[0].init?.method).toBe('PUT');
  });

  it('runPipeline POSTs createRun on the dev endpoint', async () => {
    const calls = captureFetch(() => ({ body: { runId: 'syn-run-1' } }));
    const { runPipeline } = await import('../synapse-dev-client');
    const res = await runPipeline('sp1');
    expect(calls[0].url).toMatch(/\/pipelines\/sp1\/createRun\?api-version=2020-12-01/);
    expect(res.runId).toBe('syn-run-1');
  });

  it('queryPipelineRuns POSTs to /queryPipelineRuns with a time window', async () => {
    const calls = captureFetch(() => ({ body: { value: [] } }));
    const { queryPipelineRuns } = await import('../synapse-dev-client');
    await queryPipelineRuns({ filters: [{ operand: 'PipelineName', operator: 'Equals', values: ['sp1'] }] });
    expect(calls[0].url).toMatch(/\/queryPipelineRuns\?api-version=2020-12-01/);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.lastUpdatedAfter).toBeTruthy();
    expect(body.lastUpdatedBefore).toBeTruthy();
    expect(body.filters[0].values).toEqual(['sp1']);
  });
});
