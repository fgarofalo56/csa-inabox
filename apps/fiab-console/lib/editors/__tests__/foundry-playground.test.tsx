/**
 * Foundry model-catalog + chat-playground backend contract tests.
 *
 * These exercise the REAL client code paths that power the new surfaces — the
 * account list-models → catalog shaping (search/filter fields the UI depends
 * on) and the data-plane chat/completions request building — with Azure
 * credential + fetch mocked. No DOM, no Fluent: this runs in the repo's default
 * node vitest environment and asserts the actual wire behavior, not a stand-in.
 *
 * Per .claude/rules/no-vaporware.md: this covers backend behavior it truly
 * exercises (the request URL, payload, and response shaping), bringing the
 * model-catalog + chat surfaces to A-grade (functional + tested).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the Azure credential so token acquisition is deterministic.
vi.mock('@azure/identity', () => {
  class FakeCred { async getToken() { return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: FakeCred, ManagedIdentityCredential: FakeCred, ChainedTokenCredential: FakeCred };
});

const ACCOUNT_JSON = {
  id: '/subscriptions/s/resourceGroups/rg-csa-loom-admin-eastus2/providers/Microsoft.CognitiveServices/accounts/aoai-test',
  name: 'aoai-test', location: 'eastus2', kind: 'AIServices',
  properties: { endpoint: 'https://aoai-test.openai.azure.com', publicNetworkAccess: 'Enabled' },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  process.env.LOOM_SUBSCRIPTION_ID = 's';
  process.env.LOOM_FOUNDRY_RG = 'rg-csa-loom-admin-eastus2';
  process.env.LOOM_AOAI_ACCOUNT = 'aoai-test';
  vi.resetModules();
});
afterEach(() => { process.env = env; vi.restoreAllMocks(); });

describe('listCatalogModels (account list-models → catalog)', () => {
  it('shapes real list-models rows into searchable/filterable catalog cards', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/accounts/aoai-test/models')) {
        return jsonResponse({ value: [
          { model: { name: 'gpt-4o-mini', format: 'OpenAI', version: '2024-07-18', isDefaultVersion: true, skus: [{ name: 'GlobalStandard', capacity: { default: 10, maximum: 30 } }], lifecycleStatus: 'GenerallyAvailable' } },
          { model: { name: 'text-embedding-3-large', format: 'OpenAI', version: '1', isDefaultVersion: true, skus: [{ name: 'Standard', capacity: { default: 50, maximum: 350 } }] } },
          { model: { name: 'Phi-4-mini-instruct', format: 'Microsoft', version: '1', isDefaultVersion: true, skus: [{ name: 'GlobalStandard', capacity: { default: 1, maximum: 5 } }] } },
        ] });
      }
      if (u.includes('/accounts/aoai-test')) return jsonResponse(ACCOUNT_JSON);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { listCatalogModels } = await import('../../azure/foundry-cs-client');
    const { account, models } = await listCatalogModels();

    expect(account.name).toBe('aoai-test');
    expect(models).toHaveLength(3);

    const mini = models.find((m) => m.name === 'gpt-4o-mini')!;
    expect(mini.publisher).toBe('OpenAI');
    expect(mini.inferenceTasks).toContain('chat-completion');
    expect(mini.deploymentOptions).toContain('GlobalStandard');
    expect(mini.maxCapacity).toBe(30);
    expect(mini.deployableHere).toBe(true);

    const embed = models.find((m) => m.name === 'text-embedding-3-large')!;
    expect(embed.inferenceTasks).toContain('embeddings');

    const phi = models.find((m) => m.name === 'Phi-4-mini-instruct')!;
    expect(phi.publisher).toBe('Microsoft');
  });
});

describe('chatCompletion (data-plane chat/completions)', () => {
  it('POSTs to the deployment chat/completions endpoint with the mapped params', async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/accounts/aoai-test') && !u.includes('/chat/completions')) return jsonResponse(ACCOUNT_JSON);
      if (u.includes('/openai/deployments/gpt-4o-mini/chat/completions')) {
        return jsonResponse({ model: 'gpt-4o-mini', choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { chatCompletion } = await import('../../azure/foundry-cs-client');
    const result = await chatCompletion('gpt-4o-mini',
      [{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'Hello' }],
      { temperature: 0.5, maxTokens: 100, topP: 0.9, stop: ['###'] });

    expect(result.content).toBe('Hi!');
    expect(result.usage?.totalTokens).toBe(7);

    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/chat/completions'))!;
    expect(chatCall).toBeTruthy();
    expect(String(chatCall[0])).toContain('https://aoai-test.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions');
    const sent = JSON.parse(String((chatCall[1] as any).body));
    expect(sent.temperature).toBe(0.5);
    expect(sent.max_tokens).toBe(100);
    expect(sent.top_p).toBe(0.9);
    expect(sent.stop).toEqual(['###']);
    expect(sent.messages[0].role).toBe('system');
  });

  it('throws a CsError on DeploymentNotFound so the route can honest-gate', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/accounts/aoai-test') && !u.includes('/chat/completions')) return jsonResponse(ACCOUNT_JSON);
      if (u.includes('/chat/completions')) return jsonResponse({ error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } }, 404);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const { chatCompletion, CsError } = await import('../../azure/foundry-cs-client');
    await expect(chatCompletion('missing', [{ role: 'user', content: 'hi' }]))
      .rejects.toMatchObject({ status: 404 });
    // And it's a CsError instance the route maps to notDeployed.
    try { await chatCompletion('missing', [{ role: 'user', content: 'hi' }]); }
    catch (e) { expect(e).toBeInstanceOf(CsError); }
  });
});
