/**
 * Contract tests for purview-endpoints — the single source of truth for the
 * classic Purview Data Map data-plane base URL in every sovereign cloud.
 *
 * Gov incident 2026-07-14: the governance gate probed/reported the Commercial
 * `.purview.azure.com` host in Azure Government (where the data plane is
 * `{account}.purview.azure.us` — Microsoft Learn, data-map-integration-
 * runtime-self-hosted networking table). These tests pin:
 *   - the cloud-aware convention suffix (Commercial vs Gov),
 *   - account-name normalization across pasted .com/.us/-api URLs,
 *   - ARM-authoritative resolution from properties.endpoints (via ARG),
 *   - the ARM-GET fallback when ARG returns a row without endpoints,
 *   - the convention fallback (with armError) when the ARM read fails,
 *   - the LOOM_PURVIEW_ENDPOINT explicit override,
 *   - purviewBaseSync serving the warmed ARM cache to sync callers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import {
  purviewDataPlaneSuffix,
  normalizePurviewAccountName,
  purviewConventionBase,
  purviewPortalAssetLink,
  purviewBaseSync,
  resolvePurviewEndpoints,
  __clearPurviewEndpointCache,
} from '../purview-endpoints';

const realFetch = global.fetch;

afterEach(() => {
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  delete process.env.LOOM_PURVIEW_ENDPOINT;
  global.fetch = realFetch;
  __clearPurviewEndpointCache();
  vi.restoreAllMocks();
});

describe('purviewDataPlaneSuffix (cloud matrix)', () => {
  it('Commercial → purview.azure.com', () => {
    expect(purviewDataPlaneSuffix()).toBe('purview.azure.com');
  });
  it('Azure Government → purview.azure.us', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(purviewDataPlaneSuffix()).toBe('purview.azure.us');
  });
});

describe('normalizePurviewAccountName', () => {
  it('passes a bare name through', () => {
    expect(normalizePurviewAccountName('pv-acct')).toBe('pv-acct');
  });
  it('strips a pasted Commercial URL', () => {
    expect(normalizePurviewAccountName('https://pv-acct.purview.azure.com/')).toBe('pv-acct');
  });
  it('strips a pasted Gov URL', () => {
    expect(normalizePurviewAccountName('https://dmlz-dev-purview001.purview.azure.us')).toBe('dmlz-dev-purview001');
  });
  it('strips a pasted -api host', () => {
    expect(normalizePurviewAccountName('https://pv-acct-api.purview.azure.us/x')).toBe('pv-acct');
  });
});

describe('purviewConventionBase / purviewPortalAssetLink', () => {
  it('builds the Commercial host by default', () => {
    expect(purviewConventionBase('pv-acct')).toBe('https://pv-acct.purview.azure.com');
  });
  it('builds the Gov host in AzureUSGovernment', () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    expect(purviewConventionBase('dmlz-dev-purview001')).toBe('https://dmlz-dev-purview001.purview.azure.us');
    expect(purviewPortalAssetLink('dmlz-dev-purview001', 'g1')).toBe(
      'https://dmlz-dev-purview001.purview.azure.us/main.html#/asset/g1',
    );
  });
});

describe('resolvePurviewEndpoints', () => {
  it('LOOM_PURVIEW_ENDPOINT override wins outright', async () => {
    process.env.LOOM_PURVIEW_ENDPOINT = 'https://custom.example.gov/';
    const r = await resolvePurviewEndpoints('pv-acct');
    expect(r.base).toBe('https://custom.example.gov');
    expect(r.source).toBe('env');
  });

  it('resolves the ARM properties.endpoints.catalog origin via Resource Graph', async () => {
    global.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      expect(url).toContain('providers/Microsoft.ResourceGraph/resources');
      return new Response(JSON.stringify({
        data: [{
          name: 'pv-acct', subscriptionId: 's', resourceGroup: 'r',
          properties: { endpoints: {
            catalog: 'https://pv-acct.purview.azure.us/catalog',
            scan: 'https://pv-acct.purview.azure.us/scan',
          } },
        }],
      }), { status: 200 });
    }) as any;
    const r = await resolvePurviewEndpoints('pv-acct');
    expect(r.source).toBe('arm');
    expect(r.base).toBe('https://pv-acct.purview.azure.us');
    expect(r.scan).toBe('https://pv-acct.purview.azure.us/scan');
    // …and the warmed cache serves sync callers the ARM-derived base.
    expect(purviewBaseSync('pv-acct')).toBe('https://pv-acct.purview.azure.us');
    // Cached — no second ARG call.
    expect((global.fetch as any).mock.calls.length).toBe(1);
    await resolvePurviewEndpoints('pv-acct');
    expect((global.fetch as any).mock.calls.length).toBe(1);
  });

  it('falls back to ARM GET when ARG returns a row without endpoints', async () => {
    global.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      if (url.includes('Microsoft.ResourceGraph')) {
        return new Response(JSON.stringify({
          data: [{ name: 'pv-acct', subscriptionId: 'sub1', resourceGroup: 'rg1', properties: {} }],
        }), { status: 200 });
      }
      expect(url).toContain('/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Purview/accounts/pv-acct');
      return new Response(JSON.stringify({
        properties: { endpoints: { catalog: 'https://pv-acct.purview.azure.com/catalog' } },
      }), { status: 200 });
    }) as any;
    const r = await resolvePurviewEndpoints('pv-acct');
    expect(r.source).toBe('arm');
    expect(r.base).toBe('https://pv-acct.purview.azure.com');
  });

  it('falls back to the CLOUD-AWARE convention host (with armError) when ARM fails', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    global.fetch = vi.fn(async () => { throw new Error('ENOTFOUND management.usgovcloudapi.net'); }) as any;
    const r = await resolvePurviewEndpoints('dmlz-dev-purview001');
    expect(r.source).toBe('convention');
    expect(r.base).toBe('https://dmlz-dev-purview001.purview.azure.us');
    expect(r.armError).toContain('ENOTFOUND');
  });

  it('reports "not found" as the armError when ARG answers with no rows', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as any;
    const r = await resolvePurviewEndpoints('pv-missing');
    expect(r.source).toBe('convention');
    expect(r.armError).toMatch(/was found via Azure Resource Graph|no Microsoft.Purview\/accounts/i);
  });

  it('never serves a cross-cloud cached base (cache key is cloud-aware)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom'); }) as any;
    const commercial = await resolvePurviewEndpoints('pv-acct');
    expect(commercial.base).toBe('https://pv-acct.purview.azure.com');
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    const gov = await resolvePurviewEndpoints('pv-acct');
    expect(gov.base).toBe('https://pv-acct.purview.azure.us');
  });
});
