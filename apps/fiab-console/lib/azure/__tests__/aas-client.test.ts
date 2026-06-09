/**
 * Contract tests for the Azure Analysis Services XMLA + async-refresh client.
 *
 * Each test stubs `fetch` and asserts the real XMLA SOAP / REST shapes the
 * semantic-model incremental-refresh surface depends on — not mocks of our own
 * logic (per no-vaporware.md):
 *   - aasConfigGate honest-gate signal
 *   - setIncrementalRefreshPolicy → TMSL Alter SOAP envelope w/ refreshPolicy
 *   - applyRefreshPolicy → TMSL Refresh w/ applyRefreshPolicy:true
 *   - listPartitions → TMSCHEMA_PARTITIONS Discover + Import/DirectQuery mapping
 *   - asyncRefresh → POST /refreshes returns requestId from Location header
 *   - aasXmlaScope per-cloud audience
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const ENDPOINT = 'https://eastus2.asazure.windows.net/servers/loom-aas/models/FiabModel';

beforeEach(() => {
  process.env.LOOM_AAS_XMLA_ENDPOINT = ENDPOINT;
  delete process.env.LOOM_AAS_DATABASE;
  delete process.env.LOOM_CLOUD;
  delete process.env.AZURE_CLOUD;
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    return new Response(r.body ?? '<root/>', {
      status: r.status ?? 200,
      headers: { 'content-type': 'text/xml', ...(r.headers || {}) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('aasConfigGate', () => {
  it('returns missing LOOM_AAS_XMLA_ENDPOINT when unset', async () => {
    delete process.env.LOOM_AAS_XMLA_ENDPOINT;
    const { aasConfigGate } = await import('../aas-client');
    expect(aasConfigGate()).toEqual({ missing: 'LOOM_AAS_XMLA_ENDPOINT' });
  });
  it('returns null when configured', async () => {
    const { aasConfigGate } = await import('../aas-client');
    expect(aasConfigGate()).toBeNull();
  });
});

describe('setIncrementalRefreshPolicy', () => {
  it('POSTs an Alter SOAP envelope with the refreshPolicy to {endpoint}/xmla', async () => {
    const calls = captureFetch(() => ({ body: '<return/>' }));
    const { setIncrementalRefreshPolicy } = await import('../aas-client');
    await setIncrementalRefreshPolicy('FactSales', {
      rollingWindowGranularity: 'year', rollingWindowPeriods: 3,
      incrementalGranularity: 'day', incrementalPeriods: 10,
      mode: 'Hybrid', pollingExpression: 'Table.Max(FactSales,"LM")[LM]',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ENDPOINT}/xmla`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/xml');
    expect(headers['authorization']).toBe('Bearer tk');
    const soap = String(calls[0].init?.body);
    expect(soap).toContain('<Execute');
    expect(soap).toContain('<Catalog>FiabModel</Catalog>');
    // The TMSL JSON sits inside <Statement>; only &/</> are escaped, so the
    // JSON double-quotes appear literally (valid in XML element content).
    expect(soap).toContain('"refreshPolicy"');
    expect(soap).toContain('"rollingWindowPeriods":3');
    expect(soap).toContain('"incrementalPeriods":10');
    expect(soap).toContain('"mode":"Hybrid"');
    expect(soap).toContain('"table":"FactSales"');
  });
});

describe('applyRefreshPolicy', () => {
  it('POSTs a Refresh command with applyRefreshPolicy:true and effectiveDate', async () => {
    const calls = captureFetch(() => ({ body: '<return/>' }));
    const { applyRefreshPolicy } = await import('../aas-client');
    await applyRefreshPolicy('FactSales', { effectiveDate: '2025-06-08' });
    const soap = String(calls[0].init?.body);
    expect(soap).toContain('"refresh"');
    expect(soap).toContain('"applyRefreshPolicy":true');
    expect(soap).toContain('"effectiveDate":"2025-06-08"');
  });
});

describe('listPartitions', () => {
  it('sends TMSCHEMA_PARTITIONS Discover and maps Import/DirectQuery modes', async () => {
    const xml =
      '<root><row><Name>FactSales_2024</Name><Mode>0</Mode><QueryDefinition>let S=...</QueryDefinition></row>' +
      '<row><Name>FactSales_DirectQuery</Name><Mode>1</Mode><QueryDefinition>let DQ=...</QueryDefinition></row>' +
      '<row><Name>OtherTable_2024</Name><Mode>0</Mode></row></root>';
    const calls = captureFetch(() => ({ body: xml }));
    const { listPartitions } = await import('../aas-client');
    const parts = await listPartitions('FactSales');
    expect(String(calls[0].init?.body)).toContain('TMSCHEMA_PARTITIONS');
    expect(parts).toHaveLength(2); // OtherTable filtered out by tableName prefix
    expect(parts[0]).toMatchObject({ name: 'FactSales_2024', storageMode: 'Import' });
    expect(parts[1]).toMatchObject({ name: 'FactSales_DirectQuery', storageMode: 'DirectQuery' });
  });
});

describe('asyncRefresh', () => {
  it('POSTs JSON to {endpoint}/refreshes and parses requestId from Location', async () => {
    const calls = captureFetch((url) => {
      if (url.endsWith('/refreshes')) {
        return { status: 202, headers: { location: `${ENDPOINT}/refreshes/req-abc-123` }, body: '' };
      }
      return { body: '<root/>' };
    });
    const { asyncRefresh } = await import('../aas-client');
    const res = await asyncRefresh({ applyRefreshPolicy: true, commitMode: 'transactional' });
    expect(calls[0].url).toBe(`${ENDPOINT}/refreshes`);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.applyRefreshPolicy).toBe(true);
    expect(body.commitMode).toBe('transactional');
    expect(res.requestId).toBe('req-abc-123');
  });
  it('throws AasError on non-202', async () => {
    captureFetch(() => ({ status: 400, body: 'bad' }));
    const { asyncRefresh, AasError } = await import('../aas-client');
    await expect(asyncRefresh({})).rejects.toBeInstanceOf(AasError);
  });
});

describe('aasXmlaScope (via cloud-endpoints)', () => {
  it('uses the commercial analysis audience by default', async () => {
    const { aasXmlaScope } = await import('../cloud-endpoints');
    expect(aasXmlaScope()).toBe('https://analysis.windows.net/powerbi/api/.default');
  });
  it('uses the usgovcloudapi analysis audience in GCC-High', async () => {
    process.env.LOOM_CLOUD = 'GCC-High';
    const { aasXmlaScope, aasSuffix } = await import('../cloud-endpoints');
    expect(aasXmlaScope()).toBe('https://analysis.usgovcloudapi.net/.default');
    expect(aasSuffix()).toBe('asazure.usgovcloudapi.net');
  });
});
