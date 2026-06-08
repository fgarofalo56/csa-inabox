import { describe, it, expect, afterEach } from 'vitest';
import { adfStudioBase, adfFactoryDeepLinkId } from '../cloud-endpoints';

/**
 * Tests for the "Get data" ribbon → ADF Studio deep-link primitives:
 *  - adfStudioBase() picks the right ADF Studio host per sovereign cloud.
 *  - adfFactoryDeepLinkId() formats the bare ARM resource ID used as the
 *    `factory=` query param, and is URL-encodable into a valid deep-link.
 *
 * These are pure (no Azure SDK / credential chain), so they run on the bare
 * node pool. adf-client.factoryResourceId() delegates to adfFactoryDeepLinkId,
 * so this covers the deep-link contract the BFF route emits.
 */

const ORIG = {
  LOOM_CLOUD: process.env.LOOM_CLOUD,
  AZURE_CLOUD: process.env.AZURE_CLOUD,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('adfStudioBase — sovereign-cloud aware ADF Studio host', () => {
  it('returns global ADF Studio for Commercial and GCC', () => {
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_CLOUD = 'Commercial';
    expect(adfStudioBase()).toBe('https://adf.azure.com');
    process.env.LOOM_CLOUD = 'GCC';
    expect(adfStudioBase()).toBe('https://adf.azure.com');
  });

  it('returns Azure Government ADF Studio for GCC-High and DoD', () => {
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_CLOUD = 'GCC-High';
    expect(adfStudioBase()).toBe('https://adf.azure.us');
    process.env.LOOM_CLOUD = 'DoD';
    expect(adfStudioBase()).toBe('https://adf.azure.us');
  });
});

describe('adfFactoryDeepLinkId — bare ARM id for the factory= deep-link param', () => {
  it('formats /subscriptions/.../factories/<name>', () => {
    expect(adfFactoryDeepLinkId('11111111-2222-3333-4444-555555555555', 'rg-loom-dlz', 'adf-loom-default-eastus2')).toBe(
      '/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-loom-dlz' +
        '/providers/Microsoft.DataFactory/factories/adf-loom-default-eastus2',
    );
  });

  it('builds a valid encoded copy-data deep-link', () => {
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_CLOUD = 'Commercial';
    const url = `${adfStudioBase()}/copyDataTool?factory=${encodeURIComponent(adfFactoryDeepLinkId('sub', 'rg', 'adf1'))}`;
    expect(url).toBe(
      'https://adf.azure.com/copyDataTool?factory=' +
        '%2Fsubscriptions%2Fsub%2FresourceGroups%2Frg%2Fproviders%2FMicrosoft.DataFactory%2Ffactories%2Fadf1',
    );
  });

  it('builds the GCC-High pipeline authoring deep-link on adf.azure.us', () => {
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_CLOUD = 'GCC-High';
    const url = `${adfStudioBase()}/authoring/pipeline/${encodeURIComponent('loom_ingest_db_20260608')}?factory=${encodeURIComponent(adfFactoryDeepLinkId('s', 'r', 'f'))}`;
    expect(url.startsWith('https://adf.azure.us/authoring/pipeline/loom_ingest_db_20260608?factory=')).toBe(true);
  });
});
