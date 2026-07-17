/**
 * Contract tests for the Purview connection probe helpers:
 *   - isPurviewConfigured
 *   - getPurviewAccountName  (account-name normalization)
 *   - probePurview           (live / not_configured / role_missing / upstream_error)
 *
 * These back the /api/governance/purview/status route + the PurviewGate so the
 * honest infra gate reflects the REAL deployment state of the CLASSIC Data Map
 * account (host {account}.purview.azure.com, Atlas typedefs probe).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

import { isPurviewConfigured, getPurviewAccountName, probePurview } from '../purview-client';
import { __clearPurviewEndpointCache } from '../purview-endpoints';

const realFetch = global.fetch;

afterEach(() => {
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  delete process.env.LOOM_PURVIEW_ENDPOINT;
  delete process.env.AZURE_CLOUD;
  delete process.env.LOOM_CLOUD;
  global.fetch = realFetch;
  __clearPurviewEndpointCache();
  vi.restoreAllMocks();
});

describe('isPurviewConfigured', () => {
  it('false when the env var is unset', () => {
    expect(isPurviewConfigured()).toBe(false);
  });
  it('true when the env var is set', () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    expect(isPurviewConfigured()).toBe(true);
  });
});

describe('getPurviewAccountName', () => {
  it('returns null when unset', () => {
    expect(getPurviewAccountName()).toBeNull();
  });
  it('normalizes a full classic URL down to the short account name', () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'https://purview-csa-loom-eastus2.purview.azure.com';
    expect(getPurviewAccountName()).toBe('purview-csa-loom-eastus2');
  });
  it('also tolerates a pasted -api host and normalizes it', () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'https://purview-csa-loom-eastus2-api.purview.azure.com';
    expect(getPurviewAccountName()).toBe('purview-csa-loom-eastus2');
  });
  it('accepts a bare account name', () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-csa-loom-eastus2';
    expect(getPurviewAccountName()).toBe('purview-csa-loom-eastus2');
  });
});

describe('probePurview', () => {
  it('returns not_configured + hint when the env var is missing', async () => {
    const r = await probePurview();
    expect(r.configured).toBe(false);
    expect(r.reason).toBe('not_configured');
    expect(r.account).toBeNull();
    expect(r.hint?.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
    expect(r.hint?.rolesRequired?.length).toBeGreaterThan(0);
  });

  it('reports live when the classic Data Map typedefs endpoint answers 200', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    let url = '';
    global.fetch = vi.fn(async (u: any) => {
      url = String(u);
      return new Response('{}', { status: 200 });
    }) as any;
    const r = await probePurview();
    // CLASSIC host (NOT -api) and an Atlas v2 typedefs probe.
    expect(url).toContain('purview-test.purview.azure.com');
    expect(url).not.toContain('-api.purview.azure.com');
    expect(url).toContain('/datamap/api/atlas/v2/types/typedefs/headers');
    expect(r.configured).toBe(true);
    expect(r.reason).toBe('live');
    expect(r.account).toBe('purview-test');
  });

  it('reports role_missing on 401/403 (host reachable, UAMI lacks a Data Map role)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    global.fetch = vi.fn(async () => new Response('', { status: 403 })) as any;
    const r = await probePurview();
    expect(r.configured).toBe(true);
    expect(r.reason).toBe('role_missing');
    expect(r.hint?.followUp).toMatch(/Data Curator|Data Reader|grant-purview-datamap-role/i);
  });

  it('reports not_configured on a DNS / network failure (account does not resolve as classic Purview)', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-bogus';
    global.fetch = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND purview-bogus.purview.azure.com'); }) as any;
    const r = await probePurview();
    expect(r.configured).toBe(true);
    expect(r.reason).toBe('not_configured');
    expect(r.account).toBe('purview-bogus');
    expect(r.hint?.followUp).toMatch(/did not answer|classic Purview/i);
    // The gate names the EXACT endpoint that was probed (Gov-incident fix) +
    // whether the ARM properties.endpoints lookup succeeded.
    expect(r.hint?.followUp).toContain('https://purview-bogus.purview.azure.com');
    expect(r.hint?.followUp).toMatch(/ARM lookup FAILED/i);
    expect(r.endpoint).toBe('https://purview-bogus.purview.azure.com');
    expect(r.endpointSource).toBe('convention');
  });

  it('CLOUD MATRIX — probes (and reports) the *.purview.azure.us host in Azure Government', async () => {
    process.env.AZURE_CLOUD = 'AzureUSGovernment';
    process.env.LOOM_PURVIEW_ACCOUNT = 'dmlz-dev-purview001';
    const urls: string[] = [];
    global.fetch = vi.fn(async (u: any) => {
      urls.push(String(u));
      throw new Error('fetch failed');
    }) as any;
    const r = await probePurview();
    expect(r.reason).toBe('not_configured');
    // The probe target is the GOV data-plane host — never .purview.azure.com.
    const probeUrl = urls.find((u) => u.includes('/datamap/api/atlas/v2/types/typedefs/headers'));
    expect(probeUrl).toContain('dmlz-dev-purview001.purview.azure.us');
    expect(probeUrl).not.toContain('.purview.azure.com');
    // And the gate message names the Gov host it actually tried.
    expect(r.hint?.followUp).toContain('https://dmlz-dev-purview001.purview.azure.us');
    expect(r.endpoint).toBe('https://dmlz-dev-purview001.purview.azure.us');
  });

  it('probes the ARM-derived endpoint when Resource Graph resolves properties.endpoints', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-arm';
    const urls: string[] = [];
    global.fetch = vi.fn(async (u: any) => {
      const url = String(u);
      urls.push(url);
      if (url.includes('Microsoft.ResourceGraph')) {
        return new Response(JSON.stringify({
          data: [{
            name: 'purview-arm', subscriptionId: 'sub1', resourceGroup: 'rg1',
            properties: { endpoints: {
              catalog: 'https://purview-arm.purview.azure.us/catalog',
              scan: 'https://purview-arm.purview.azure.us/scan',
              guardian: 'https://purview-arm.purview.azure.us/guardian',
            } },
          }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as any;
    const r = await probePurview();
    expect(r.reason).toBe('live');
    expect(r.endpoint).toBe('https://purview-arm.purview.azure.us');
    expect(r.endpointSource).toBe('arm');
    const probeUrl = urls.find((u) => u.includes('/datamap/api/atlas/v2/types/typedefs/headers'));
    expect(probeUrl).toContain('purview-arm.purview.azure.us');
  });

  it('reports upstream_error on a 5xx', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    global.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as any;
    const r = await probePurview();
    expect(r.reason).toBe('upstream_error');
    expect(r.configured).toBe(true);
  });
});
