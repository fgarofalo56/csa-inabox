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

const realFetch = global.fetch;

afterEach(() => {
  delete process.env.LOOM_PURVIEW_ACCOUNT;
  global.fetch = realFetch;
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
    expect(r.hint?.followUp).toMatch(/did not resolve|classic Purview/i);
  });

  it('reports upstream_error on a 5xx', async () => {
    process.env.LOOM_PURVIEW_ACCOUNT = 'purview-test';
    global.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as any;
    const r = await probePurview();
    expect(r.reason).toBe('upstream_error');
    expect(r.configured).toBe(true);
  });
});
