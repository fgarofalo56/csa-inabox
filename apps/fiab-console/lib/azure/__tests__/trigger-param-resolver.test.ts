/**
 * Unit tests for the F4 schedule-time parameter resolver.
 * Mocks @azure/identity (token) and global fetch (KV / App Config REST).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getToken } = vi.hoisted(() => ({
  getToken: vi.fn(async (scope: string) => ({ token: `tok:${scope}`, expiresOnTimestamp: Date.now() + 3_600_000 })),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(() => ({ getToken })),
  ManagedIdentityCredential: vi.fn(() => ({ getToken })),
  ChainedTokenCredential: vi.fn(() => ({ getToken })),
}));

import { resolveParamBindings, paramSourceAvailability, type ParamBinding } from '../trigger-param-resolver';

const direct = (v: string): ParamBinding => ({ source: 'direct', directValue: v, secretName: '', configKey: '', configLabel: '' });
const kv = (n: string): ParamBinding => ({ source: 'keyvault', directValue: '', secretName: n, configKey: '', configLabel: '' });
const ac = (k: string, l = ''): ParamBinding => ({ source: 'appconfig', directValue: '', secretName: '', configKey: k, configLabel: l });

describe('resolveParamBindings', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    getToken.mockClear();
    vi.unstubAllGlobals();
    delete process.env.LOOM_PARAM_KEYVAULT;
    delete process.env.LOOM_PARAM_APPCONFIG;
  });
  afterEach(() => { process.env = { ...origEnv }; });

  it('passes through direct values and skips empty ones', async () => {
    const out = await resolveParamBindings({ a: direct('1000'), b: direct('') });
    expect(out).toEqual({ a: '1000' });
  });

  it('returns {} for undefined bindings', async () => {
    expect(await resolveParamBindings(undefined)).toEqual({});
  });

  it('throws 503 when a keyvault binding has no LOOM_PARAM_KEYVAULT', async () => {
    await expect(resolveParamBindings({ a: kv('my-secret') })).rejects.toMatchObject({ status: 503 });
  });

  it('throws 503 when an appconfig binding has no LOOM_PARAM_APPCONFIG', async () => {
    await expect(resolveParamBindings({ a: ac('my:key') })).rejects.toMatchObject({ status: 503 });
  });

  it('resolves a Key Vault secret via the KV REST API (commercial scope)', async () => {
    process.env.LOOM_PARAM_KEYVAULT = 'https://kv-loom.vault.azure.net';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: 'bronze' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await resolveParamBindings({ inputContainer: kv('pipeline-input') });
    expect(out).toEqual({ inputContainer: 'bronze' });
    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain('https://kv-loom.vault.azure.net/secrets/pipeline-input');
    expect(getToken).toHaveBeenCalledWith('https://vault.azure.net/.default');
  });

  it('derives the gov KV scope from a usgovcloudapi vault URI', async () => {
    process.env.LOOM_PARAM_KEYVAULT = 'https://kv-loom.vault.usgovcloudapi.net';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 'g' }), { status: 200 })));
    await resolveParamBindings({ p: kv('s') });
    expect(getToken).toHaveBeenCalledWith('https://vault.usgovcloudapi.net/.default');
  });

  it('resolves an App Config key with a label (commercial scope)', async () => {
    process.env.LOOM_PARAM_APPCONFIG = 'https://ac-loom.azconfig.io';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: '5000' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await resolveParamBindings({ maxRows: ac('pipeline:maxRows', 'prod') });
    expect(out).toEqual({ maxRows: '5000' });
    const url = (fetchMock.mock.calls[0] as any[])[0] as string;
    expect(url).toContain('/kv/pipeline%3AmaxRows');
    expect(url).toContain('label=prod');
    expect(getToken).toHaveBeenCalledWith('https://azconfig.io/.default');
  });

  // Fixed by #1531: the App Config token scope is now derived from the
  // configured LOOM_PARAM_APPCONFIG endpoint HOSTNAME (acScope → endpoint-aware
  // getAppConfigScope), symmetric with the KV path (kvScope from the vault URI).
  // A Gov host (azconfig.azure.us) mints a Gov-audience token even when
  // LOOM_CLOUD is unset/Commercial, so it no longer 401s against the Gov store.
  it('derives the gov App Config scope from an azure.us endpoint', async () => {
    delete process.env.LOOM_CLOUD;
    delete process.env.AZURE_CLOUD;
    process.env.LOOM_PARAM_APPCONFIG = 'https://ac-loom.azconfig.azure.us';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 'x' }), { status: 200 })));
    await resolveParamBindings({ p: ac('k') });
    expect(getToken).toHaveBeenCalledWith('https://azconfig.azure.us/.default');
  });

  it('derives the commercial App Config scope from an azconfig.io endpoint even in a Gov boundary', async () => {
    // Endpoint host wins over the active cloud: a Commercial store reached from a
    // Gov-badged console must still mint a Commercial-audience token.
    process.env.LOOM_CLOUD = 'GCC-High';
    process.env.LOOM_PARAM_APPCONFIG = 'https://ac-loom.azconfig.io';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 'x' }), { status: 200 })));
    await resolveParamBindings({ p: ac('k') });
    expect(getToken).toHaveBeenCalledWith('https://azconfig.io/.default');
  });

  it('surfaces a real KV 403 verbatim with status', async () => {
    process.env.LOOM_PARAM_KEYVAULT = 'https://kv-loom.vault.azure.net';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));
    await expect(resolveParamBindings({ p: kv('s') })).rejects.toMatchObject({ status: 403 });
  });
});

describe('paramSourceAvailability', () => {
  const origEnv = { ...process.env };
  afterEach(() => { process.env = { ...origEnv }; });

  it('reflects which env vars are set', () => {
    delete process.env.LOOM_PARAM_KEYVAULT;
    delete process.env.LOOM_PARAM_APPCONFIG;
    expect(paramSourceAvailability()).toEqual({ kvAvailable: false, appConfigAvailable: false });
    process.env.LOOM_PARAM_KEYVAULT = 'https://v.vault.azure.net';
    expect(paramSourceAvailability().kvAvailable).toBe(true);
  });
});
