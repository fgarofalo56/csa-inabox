/**
 * Contract tests for the AI Foundry prompt-flow data-plane client.
 *
 * Locks the exact AML data-plane REST surface the visual builder round-trips
 * to (per .claude/rules/no-vaporware.md — real REST, no mocks pretending to be
 * a backend). Each test stubs `fetch` and asserts the URL / method / payload.
 *
 * Covered:
 *   - listPromptFlows   → GET  …/PromptFlows (404 → [])
 *   - getPromptFlow     → GET  …/PromptFlows/{id} (404 → null)
 *   - createPromptFlow  → POST …/PromptFlows  { flowName, flowType, flowDefinition }
 *   - updatePromptFlow  → PUT  …/PromptFlows/{id}  { flowDefinition }
 *   - submitFlowRun     → POST …/PromptFlows/{id}/submit  { inputs }
 *   - error surface     → FoundryError carries status + endpoint hint
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  process.env.LOOM_FOUNDRY_REGION = 'eastus2';
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

function captureFetch(impl: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = impl(String(url), init);
    const payload = r.text !== undefined ? r.text : JSON.stringify(r.body ?? {});
    return new Response(payload, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const DP = /eastus2\.api\.azureml\.ms\/flow\/api\/subscriptions\/sub-1\/resourceGroups\/rg-foundry\/providers\/Microsoft\.MachineLearningServices\/workspaces\/proj1/;

describe('foundry-client / listPromptFlows', () => {
  it('GETs the project data-plane PromptFlows endpoint and shapes rows', async () => {
    const calls = captureFetch(() => ({ body: { results: [{ flowId: 'f1', flowName: 'web-classify', flowType: 'standard', lastModifiedDate: '2026-05-01' }] } }));
    const { listPromptFlows } = await import('../foundry-client');
    const out = await listPromptFlows('proj1');
    expect(calls[0].url).toMatch(DP);
    expect(calls[0].url).toMatch(/\/PromptFlows\?pageSize=50/);
    expect(out[0]).toMatchObject({ flowId: 'f1', flowName: 'web-classify', flowType: 'standard' });
  });

  it('returns [] on 404 (no flows / data-plane reachable but empty)', async () => {
    captureFetch(() => ({ status: 404, text: '' }));
    const { listPromptFlows } = await import('../foundry-client');
    expect(await listPromptFlows('proj1')).toEqual([]);
  });

  it('throws FoundryError with endpoint + role hint on non-404 failure', async () => {
    captureFetch(() => ({ status: 403, text: 'forbidden' }));
    const mod = await import('../foundry-client');
    await expect(mod.listPromptFlows('proj1')).rejects.toBeInstanceOf(mod.FoundryError);
    await expect(mod.listPromptFlows('proj1')).rejects.toThrow(/AzureML Data Scientist|endpoint=/);
  });
});

describe('foundry-client / getPromptFlow', () => {
  it('GETs PromptFlows/{id} and returns flowDefinition', async () => {
    const calls = captureFetch(() => ({ body: { flowId: 'f1', flowName: 'web', flowType: 'standard', flowDefinition: 'inputs: {}\n' } }));
    const { getPromptFlow } = await import('../foundry-client');
    const out = await getPromptFlow('proj1', 'f1');
    expect(calls[0].url).toMatch(/\/PromptFlows\/f1\?api-version|\/PromptFlows\/f1$/);
    expect(out?.flowId).toBe('f1');
    expect(out?.flowDefinition).toBe('inputs: {}\n');
  });

  it('returns null on 404', async () => {
    captureFetch(() => ({ status: 404, text: '' }));
    const { getPromptFlow } = await import('../foundry-client');
    expect(await getPromptFlow('proj1', 'ghost')).toBeNull();
  });
});

describe('foundry-client / createPromptFlow', () => {
  it('POSTs name/type/definition to the PromptFlows endpoint', async () => {
    const calls = captureFetch(() => ({ body: { flowId: 'new1', flowName: 'my-flow' } }));
    const { createPromptFlow } = await import('../foundry-client');
    const out = await createPromptFlow('proj1', { flowName: 'my-flow', flowType: 'standard', flowDefinition: 'inputs: {}\n' });
    const c = calls[0];
    expect(c.url).toMatch(/\/PromptFlows(\?|$)/);
    expect(c.init?.method).toBe('POST');
    const body = JSON.parse(String(c.init?.body));
    expect(body).toMatchObject({ flowName: 'my-flow', flowType: 'standard', flowDefinition: 'inputs: {}\n' });
    expect(out).toMatchObject({ flowId: 'new1' });
  });
});

describe('foundry-client / updatePromptFlow', () => {
  it('PUTs { flowDefinition } to PromptFlows/{id}', async () => {
    const calls = captureFetch(() => ({ body: { flowId: 'f1' } }));
    const { updatePromptFlow } = await import('../foundry-client');
    await updatePromptFlow('proj1', 'f1', 'inputs:\n  q:\n    type: string\n');
    const c = calls[0];
    expect(c.url).toMatch(/\/PromptFlows\/f1/);
    expect(c.init?.method).toBe('PUT');
    expect(JSON.parse(String(c.init?.body))).toEqual({ flowDefinition: 'inputs:\n  q:\n    type: string\n' });
  });
});

describe('foundry-client / submitFlowRun', () => {
  it('POSTs { inputs } to PromptFlows/{id}/submit and returns the parsed run', async () => {
    const calls = captureFetch(() => ({ body: { flowRunId: 'run-1', node_runs: { answer: { output: 'Paris' } }, output: { answer: 'Paris' } } }));
    const { submitFlowRun } = await import('../foundry-client');
    const out = await submitFlowRun('proj1', 'f1', { question: 'capital of France?' });
    const c = calls[0];
    expect(c.url).toMatch(/\/PromptFlows\/f1\/submit/);
    expect(c.init?.method).toBe('POST');
    expect(JSON.parse(String(c.init?.body))).toEqual({ inputs: { question: 'capital of France?' } });
    expect(out).toMatchObject({ flowRunId: 'run-1' });
    expect(out.node_runs.answer.output).toBe('Paris');
  });

  it('throws FoundryError with status on run failure', async () => {
    captureFetch(() => ({ status: 500, text: 'compute session not started' }));
    const mod = await import('../foundry-client');
    await expect(mod.submitFlowRun('proj1', 'f1', {})).rejects.toBeInstanceOf(mod.FoundryError);
  });
});
