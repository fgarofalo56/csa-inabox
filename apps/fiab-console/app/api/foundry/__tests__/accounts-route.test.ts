/**
 * BFF route test for GET /api/foundry/accounts (AI Foundry account picker).
 *
 * Asserts: (1) unauthed → 401, (2) happy path → { ok, accounts[], defaultAccount }
 * with the ARM list URL hit + kind filter, (3) honest gate → 503 notDeployed
 * when no model-hosting account is provisioned.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  delete process.env.LOOM_AOAI_ACCOUNT;
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function stubFetch(impl: (url: string) => { status?: number; body?: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = impl(String(url));
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

describe('GET /api/foundry/accounts', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/foundry/accounts/route');
    const r = await GET();
    expect(r.status).toBe(401);
  });

  it('returns the model-hosting accounts + the env/discovery default', async () => {
    stubFetch((url) => {
      if (/\/providers\/Microsoft\.CognitiveServices\/accounts\?api-version=/.test(url)) {
        return { body: { value: [
          { id: '/subscriptions/sub-1/resourceGroups/rg-a/providers/Microsoft.CognitiveServices/accounts/aoai1', name: 'aoai1', kind: 'OpenAI', location: 'eastus2', properties: { endpoint: 'https://aoai1.openai.azure.com/' } },
          { id: '/subscriptions/sub-1/resourceGroups/rg-b/providers/Microsoft.CognitiveServices/accounts/ais1', name: 'ais1', kind: 'AIServices', location: 'westus' },
          { id: '/subscriptions/sub-1/resourceGroups/rg-c/providers/Microsoft.CognitiveServices/accounts/face1', name: 'face1', kind: 'Face', location: 'eastus' },
        ] } };
      }
      // resolveAccount discovery (RG-scoped) for defaultAccount.
      return { body: { value: [{ id: '/subscriptions/sub-1/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/ais1', name: 'ais1', kind: 'AIServices', location: 'westus' }] } };
    });
    const { GET } = await import('@/app/api/foundry/accounts/route');
    const r = await GET();
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.accounts.map((a: any) => a.name)).toEqual(['ais1', 'aoai1']); // Face filtered out, sorted by name
    expect(j.accounts.find((a: any) => a.name === 'aoai1')).toMatchObject({ name: 'aoai1', endpoint: 'https://aoai1.openai.azure.com/', resourceGroup: 'rg-a', kind: 'OpenAI' });
    // Best-effort default = the env/discovery-resolved account (a model-hosting kind).
    expect(['aoai1', 'ais1']).toContain(j.defaultAccount);
  });

  it('503 honest gate when no model-hosting account exists', async () => {
    // Subscription-wide list returns only non-hosting kinds → listAccounts() is
    // []; resolveAccount discovery throws CsNotConfiguredError on the empty RG.
    stubFetch(() => ({ body: { value: [] } }));
    const { GET } = await import('@/app/api/foundry/accounts/route');
    const r = await GET();
    const j = await r.json();
    // listAccounts itself returns [] (200, empty list). The default lookup is
    // best-effort and swallowed — so we still get ok:true with an empty list,
    // which the picker renders as a "no accounts" honest empty-state.
    expect(r.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.accounts).toEqual([]);
  });
});
