/**
 * Contract tests for the AI Foundry account picker backend.
 *
 * Covers:
 *   - listAccounts()          → subscription-wide CognitiveServices list, ARM URL
 *                               + kind filter (AIServices/OpenAI/CognitiveServices)
 *   - resolveAccount(selector)→ targets the SELECTED account (name + rg) instead
 *                               of the env-var default, and gates honestly when
 *                               the selected account is missing.
 *
 * Each test stubs `fetch` and asserts the exact ARM path / shape, per
 * .claude/rules/no-vaporware.md (real REST, no mocks pretending to be backends).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  delete process.env.LOOM_AOAI_ACCOUNT;
  delete process.env.LOOM_AOAI_RG;
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

describe('foundry-cs-client / listAccounts', () => {
  it('lists subscription-wide CognitiveServices accounts and filters to model-hosting kinds', async () => {
    const calls = captureFetch(() => ({
      body: {
        value: [
          { id: '/subscriptions/sub-1/resourceGroups/rg-a/providers/Microsoft.CognitiveServices/accounts/aoai1', name: 'aoai1', kind: 'OpenAI', location: 'eastus2', properties: { endpoint: 'https://aoai1.openai.azure.com/' } },
          { id: '/subscriptions/sub-1/resourceGroups/rg-b/providers/Microsoft.CognitiveServices/accounts/ais1', name: 'ais1', kind: 'AIServices', location: 'westus' },
          { id: '/subscriptions/sub-1/resourceGroups/rg-c/providers/Microsoft.CognitiveServices/accounts/vision1', name: 'vision1', kind: 'ComputerVision', location: 'eastus' },
        ],
      },
    }));
    const { listAccounts } = await import('../foundry-cs-client');
    const out = await listAccounts();

    // listAccounts now enumerates accessible subscriptions (GET /subscriptions)
    // BEFORE listing accounts per-sub, so the account-list call is no longer
    // calls[0]. Assert order-independently that the per-sub ARM list path +
    // api-version was hit.
    expect(
      calls.some((c) => /\/subscriptions\/sub-1\/providers\/Microsoft\.CognitiveServices\/accounts\?api-version=/.test(c.url)),
    ).toBe(true);
    // ComputerVision is filtered out; AIServices/OpenAI kept and sorted by name (ais1 < aoai1).
    expect(out.map((a) => a.name)).toEqual(['ais1', 'aoai1']);
    expect(out.find((a) => a.name === 'aoai1')).toMatchObject({ name: 'aoai1', kind: 'OpenAI', location: 'eastus2', rg: 'rg-a', endpoint: 'https://aoai1.openai.azure.com/' });
  });

  it('returns [] when the subscription has no model-hosting accounts', async () => {
    captureFetch(() => ({ body: { value: [{ name: 'speech1', kind: 'SpeechServices' }] } }));
    const { listAccounts } = await import('../foundry-cs-client');
    expect(await listAccounts()).toEqual([]);
  });
});

describe('foundry-cs-client / resolveAccount(selector)', () => {
  it('targets the SELECTED account by name + rg (not the env default)', async () => {
    const calls = captureFetch(() => ({
      body: { id: '/subscriptions/sub-1/resourceGroups/rg-pick/providers/Microsoft.CognitiveServices/accounts/picked', name: 'picked', kind: 'AIServices', location: 'eastus2', properties: { endpoint: 'https://picked.openai.azure.com/' } },
    }));
    const { resolveAccount } = await import('../foundry-cs-client');
    const acct = await resolveAccount(false, { name: 'picked', rg: 'rg-pick' });

    expect(calls[0].url).toMatch(/\/resourceGroups\/rg-pick\/providers\/Microsoft\.CognitiveServices\/accounts\/picked\?api-version=/);
    expect(acct).toMatchObject({ name: 'picked', rg: 'rg-pick', location: 'eastus2' });
  });

  it('falls back to the Foundry RG when the selector omits rg', async () => {
    const calls = captureFetch(() => ({ body: { id: '/subscriptions/sub-1/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/picked', name: 'picked', kind: 'AIServices', location: 'eastus2' } }));
    const { resolveAccount } = await import('../foundry-cs-client');
    await resolveAccount(false, { name: 'picked' });
    expect(calls[0].url).toMatch(/\/resourceGroups\/rg-foundry\/providers\/Microsoft\.CognitiveServices\/accounts\/picked/);
  });

  it('gates honestly (CsNotConfiguredError) when the selected account is missing', async () => {
    captureFetch(() => ({ status: 404, body: '' }));
    const mod = await import('../foundry-cs-client');
    await expect(mod.resolveAccount(false, { name: 'ghost', rg: 'rg-pick' }))
      .rejects.toBeInstanceOf(mod.CsNotConfiguredError);
  });
});

describe('foundry-cs-client / account-scoped reads honour the selector', () => {
  it('listModelDeployments targets the selected account path', async () => {
    const calls = captureFetch((url) => {
      // First call resolves the selected account; second lists deployments.
      if (url.includes('/accounts/picked?')) {
        return { body: { id: '/subscriptions/sub-1/resourceGroups/rg-pick/providers/Microsoft.CognitiveServices/accounts/picked', name: 'picked', kind: 'AIServices', location: 'eastus2' } };
      }
      return { body: { value: [] } };
    });
    const { listModelDeployments } = await import('../foundry-cs-client');
    const out = await listModelDeployments({ name: 'picked', rg: 'rg-pick' });
    expect(out.account.name).toBe('picked');
    // The deployments list call is scoped to the selected account.
    expect(calls.some((c) => /\/accounts\/picked\/deployments\?api-version=/.test(c.url))).toBe(true);
  });
});
