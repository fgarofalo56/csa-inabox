/**
 * Vitest specs for the Phase-2 extensions to purview-client:
 *   - listDataSources / registerDataSource / deleteDataSource
 *   - listScansForSource / triggerScanRun / listScanRuns
 *   - listGlossaryTerms / createGlossaryTerm
 *   - listBusinessDomains / createBusinessDomain
 *   - listDataQualityRules
 *
 * Phase 1 (registerDataProduct/getDataProduct/listDataProducts) is
 * exercised by the items/data-product/register-purview route tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._creds: any[]) {} async getToken() { return { token: 'fake-token-purview', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

describe('purview-client (Phase-2 extensions)', () => {
  const ORIG_ENV = { ...process.env };
  let fetchMock: any;

  beforeEach(() => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    process.env.LOOM_UAMI_CLIENT_ID = 'test-uami';
    fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    vi.restoreAllMocks();
  });

  it('throws PurviewNotConfiguredError when LOOM_PURVIEW_ACCOUNT is unset (listDataSources)', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const mod = await import('../purview-client');
    await expect(mod.listDataSources()).rejects.toBeInstanceOf(mod.PurviewNotConfiguredError);
  });

  it('lists registered data sources and shapes the response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'ds1', name: 'finance-sql', kind: 'AzureSqlDatabase', properties: { endpoint: 'https://x.database.windows.net', collection: { referenceName: 'finance' } } },
        { name: 'lake-prod', kind: 'AzureDataLakeStorageGen2', properties: { endpoint: 'https://lake.dfs.core.windows.net' } },
      ],
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const sources = await mod.listDataSources();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ id: 'ds1', name: 'finance-sql', kind: 'AzureSqlDatabase', endpoint: 'https://x.database.windows.net', collectionId: 'finance' });
    expect(sources[1]).toMatchObject({ name: 'lake-prod', kind: 'AzureDataLakeStorageGen2' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('purview-test-api.purview.azure.com');
    expect(url).toContain('/scan/datasources');
    expect(url).toContain('api-version=');
  });

  it('PUTs a new data source and shapes the response on registerDataSource', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'ds-new', name: 'lake-new', kind: 'AzureDataLakeStorageGen2',
      properties: { endpoint: 'https://lake-new.dfs.core.windows.net' },
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const ds = await mod.registerDataSource({
      name: 'lake-new',
      kind: 'AzureDataLakeStorageGen2',
      properties: { endpoint: 'https://lake-new.dfs.core.windows.net' },
    });
    expect(ds).toMatchObject({ name: 'lake-new', kind: 'AzureDataLakeStorageGen2' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/scan/datasources/lake-new');
    expect((init as any).method).toBe('PUT');
    expect(JSON.parse((init as any).body)).toMatchObject({ kind: 'AzureDataLakeStorageGen2' });
  });

  it('DELETE returns false when the source 404s', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../purview-client');
    const ok = await mod.deleteDataSource('does-not-exist');
    expect(ok).toBe(false);
  });

  it('triggerScanRun PUTs with a generated runId', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ runId: 'override-run-id' }), { status: 202 }));
    const mod = await import('../purview-client');
    const result = await mod.triggerScanRun('finance-sql', 'weekly-scan');
    expect(result.runId).toBe('override-run-id');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/scan/datasources/finance-sql/scans/weekly-scan/runs/');
    expect((init as any).method).toBe('PUT');
  });

  it('listGlossaryTerms walks glossaries → terms when no guid is provided', async () => {
    // First call: list glossaries
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { guid: 'gloss-1', name: 'Enterprise' },
    ]), { status: 200 }));
    // Second call: list terms in that glossary
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([
      { guid: 't1', name: 'PII', status: 'Approved', longDescription: 'Personally identifiable information' },
    ]), { status: 200 }));

    const mod = await import('../purview-client');
    const terms = await mod.listGlossaryTerms();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(terms).toHaveLength(1);
    expect(terms[0]).toMatchObject({ guid: 't1', name: 'PII', status: 'Approved', glossaryGuid: 'gloss-1' });
  });

  it('createGlossaryTerm posts an Atlas-shaped body', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      guid: 'new-term', name: 'PHI', status: 'Draft', longDescription: 'Protected health information',
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const term = await mod.createGlossaryTerm({ name: 'PHI', glossaryGuid: 'gloss-1', longDescription: 'Protected health information' });
    expect(term.name).toBe('PHI');
    const [_url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as any).body);
    expect(body.anchor).toEqual({ glossaryGuid: 'gloss-1' });
    expect(body.name).toBe('PHI');
  });

  it('listBusinessDomains shapes the unified-catalog response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { id: 'dom-1', name: 'Finance', type: 'Functional', description: 'Finance domain' },
      ],
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const domains = await mod.listBusinessDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({ id: 'dom-1', name: 'Finance', type: 'Functional' });
  });

  it('listDataQualityRules returns [] on 404 (preview not enabled)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../purview-client');
    const rules = await mod.listDataQualityRules();
    expect(rules).toEqual([]);
  });
});
