/**
 * Vitest specs for the CLASSIC Data Map purview-client surface:
 *   - listDataSources / registerDataSource / deleteDataSource  (scan plane)
 *   - listScansForSource / triggerScanRun / listScanRuns       (scan plane)
 *   - listGlossaryTerms / createGlossaryTerm                   (Atlas v2)
 *   - business domains / data products / data-quality          (HONEST GATE)
 *
 * The CLASSIC account uses host `{account}.purview.azure.com` (NOT -api).
 * Business domains, data products and unified-catalog data-quality are
 * new-experience-only concepts → they throw PurviewUnifiedCatalogGateError.
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

describe('purview-client (classic Data Map)', () => {
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

  it('lists registered data sources from /scan/datasources on the classic host', async () => {
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
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).not.toContain('-api.purview.azure.com');
    expect(url).toContain('/scan/datasources');
    expect(url).toContain('api-version=2022-07-01-preview');
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

  // --- Deeper scan depth: custom classification rules + scan rule sets + scans ---

  it('upsertCustomClassificationRule PUTs kind=Custom with wrapped Regex patterns', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      name: 'Loom_AAAA_SSN', properties: { classificationName: 'LOOM.AAAA.PII', ruleStatus: 'Enabled' },
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const rule = await mod.upsertCustomClassificationRule({
      name: 'Loom_AAAA_SSN',
      classificationName: 'LOOM.AAAA.PII',
      columnPatterns: ['.*ssn.*'],
      dataPatterns: ['\\d{3}-\\d{2}-\\d{4}'],
      minimumPercentageMatch: 60,
    });
    expect(rule.classificationName).toBe('LOOM.AAAA.PII');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/scan/classificationrules/Loom_AAAA_SSN');
    expect(url).toContain('api-version=2022-07-01-preview');
    expect((init as any).method).toBe('PUT');
    const body = JSON.parse((init as any).body);
    expect(body.kind).toBe('Custom');
    expect(body.properties.classificationName).toBe('LOOM.AAAA.PII');
    expect(body.properties.ruleStatus).toBe('Enabled');
    expect(body.properties.columnPatterns).toEqual([{ kind: 'Regex', pattern: '.*ssn.*' }]);
    expect(body.properties.dataPatterns).toEqual([{ kind: 'Regex', pattern: '\\d{3}-\\d{2}-\\d{4}' }]);
    expect(body.properties.minimumPercentageMatch).toBe(60);
  });

  it('upsertCustomClassificationRule throws PurviewNotConfiguredError when unset', async () => {
    delete process.env.LOOM_PURVIEW_ACCOUNT;
    const mod = await import('../purview-client');
    await expect(mod.upsertCustomClassificationRule({ name: 'x', classificationName: 'y' }))
      .rejects.toBeInstanceOf(mod.PurviewNotConfiguredError);
  });

  it('upsertScanRuleset PUTs the kind + includedCustomClassificationRuleNames (de-duped)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      name: 'Loom_AAAA_AdlsGen2', kind: 'AdlsGen2',
      properties: { includedCustomClassificationRuleNames: ['Loom_AAAA_SSN'] },
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const rs = await mod.upsertScanRuleset({
      name: 'Loom_AAAA_AdlsGen2', kind: 'AdlsGen2',
      includedCustomClassificationRuleNames: ['Loom_AAAA_SSN', 'Loom_AAAA_SSN'],
    });
    expect(rs.kind).toBe('AdlsGen2');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/scan/scanrulesets/Loom_AAAA_AdlsGen2');
    expect((init as any).method).toBe('PUT');
    const body = JSON.parse((init as any).body);
    expect(body.kind).toBe('AdlsGen2');
    expect(body.properties.includedCustomClassificationRuleNames).toEqual(['Loom_AAAA_SSN']);
  });

  it('upsertScan PUTs the scan definition with scanRulesetName + type + collection', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      name: 'nightly', kind: 'AdlsGen2Msi', properties: { scanRulesetName: 'Loom_AAAA_AdlsGen2' },
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const scan = await mod.upsertScan({
      sourceName: 'lake-prod', scanName: 'nightly', kind: 'AdlsGen2Msi',
      scanRulesetName: 'Loom_AAAA_AdlsGen2', scanRulesetType: 'Custom', collectionRef: 'finance',
    });
    expect(scan.name).toBe('nightly');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/scan/datasources/lake-prod/scans/nightly');
    expect((init as any).method).toBe('PUT');
    const body = JSON.parse((init as any).body);
    expect(body.kind).toBe('AdlsGen2Msi');
    expect(body.properties.scanRulesetName).toBe('Loom_AAAA_AdlsGen2');
    expect(body.properties.scanRulesetType).toBe('Custom');
    expect(body.properties.collection).toEqual({ referenceName: 'finance', type: 'CollectionReference' });
  });

  it('deleteCustomClassificationRule returns false on 404', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const mod = await import('../purview-client');
    const ok = await mod.deleteCustomClassificationRule('does-not-exist');
    expect(ok).toBe(false);
  });

  it('listGlossaryTerms walks Atlas v2 glossaries → terms when no guid is provided', async () => {
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
    const [glossariesUrl] = fetchMock.mock.calls[0];
    // Live-verified: glossaries-list is the SINGULAR /glossary endpoint.
    expect(glossariesUrl).toContain('/datamap/api/atlas/v2/glossary?');
  });

  it('createGlossaryTerm posts an Atlas-shaped body to /datamap/api/atlas/v2', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      guid: 'new-term', name: 'PHI', status: 'Draft', longDescription: 'Protected health information',
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const term = await mod.createGlossaryTerm({ name: 'PHI', glossaryGuid: 'gloss-1', longDescription: 'Protected health information' });
    expect(term.name).toBe('PHI');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/datamap/api/atlas/v2/glossary/term');
    const body = JSON.parse((init as any).body);
    expect(body.anchor).toEqual({ glossaryGuid: 'gloss-1' });
    expect(body.name).toBe('PHI');
  });

  // --- Honest gates: unified-catalog-only concepts on a classic account ---

  it('listBusinessDomains maps non-root Purview collections to business domains', async () => {
    // Real behavior on a classic account: listBusinessDomains reads
    // /collections and surfaces every non-root collection as a mirrored domain.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      value: [
        { name: 'root', friendlyName: 'Root', parentCollection: null },
        { name: 'finance', friendlyName: 'Finance', description: 'Finance domain', parentCollection: { referenceName: 'root' } },
      ],
    }), { status: 200 }));
    const mod = await import('../purview-client');
    const domains = await mod.listBusinessDomains();
    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({ id: 'finance', name: 'Finance', description: 'Finance domain', parentId: 'root' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).toContain('/collections');
    expect(url).toContain('api-version=2019-11-01-preview');
  });

  it('listDataQualityRules throws the unified-catalog gate (no fabricated data)', async () => {
    const mod = await import('../purview-client');
    await expect(mod.listDataQualityRules()).rejects.toBeInstanceOf(mod.PurviewUnifiedCatalogGateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registerDataProduct / getDataProduct / listDataProducts gate when LOOM_DATAPRODUCTS_BACKEND=unified-catalog', async () => {
    // Opt-in unified-catalog backend → the legacy honest gate is preserved.
    process.env.LOOM_DATAPRODUCTS_BACKEND = 'unified-catalog';
    vi.resetModules();
    const mod = await import('../purview-client');
    await expect(mod.registerDataProduct({ displayName: 'X', domain: 'd' })).rejects.toBeInstanceOf(mod.PurviewUnifiedCatalogGateError);
    await expect(mod.getDataProduct('id')).rejects.toBeInstanceOf(mod.PurviewUnifiedCatalogGateError);
    await expect(mod.listDataProducts()).rejects.toBeInstanceOf(mod.PurviewUnifiedCatalogGateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the unified-catalog gate is a subclass of PurviewNotConfiguredError (BFF catch compatibility)', async () => {
    const mod = await import('../purview-client');
    await expect(mod.listDataQualityRules()).rejects.toBeInstanceOf(mod.PurviewNotConfiguredError);
  });

  it('with LOOM_DATAPRODUCTS_BACKEND UNSET, data products do NOT hit the unified-catalog gate (Azure-native Cosmos default)', async () => {
    // Default backend is the Azure-native Cosmos store. With LOOM_COSMOS_ENDPOINT
    // unset, the Cosmos client throws its own config error — which is NOT the
    // PurviewUnifiedCatalogGateError. That proves the default path no longer
    // gates on Purview / Fabric at all (no-fabric-dependency.md).
    delete process.env.LOOM_DATAPRODUCTS_BACKEND;
    delete process.env.LOOM_COSMOS_ENDPOINT;
    vi.resetModules();
    const mod = await import('../purview-client');
    await expect(mod.listDataProducts()).rejects.not.toBeInstanceOf(mod.PurviewUnifiedCatalogGateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
