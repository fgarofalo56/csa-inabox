/**
 * Unit tests for callAiFnBatch (FGC-16 per-column AI apply): bounded-concurrency
 * mapping over the real callAiFn chat path, per-row error capture, empty-cell
 * passthrough, aggregate token usage, and honest-gate rethrow. AOAI is mocked at
 * the fetch + target-resolution boundary — no live Azure calls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3_600_000 }; } }
  return { AcaManagedIdentityCredential: Cred };
});

class NoAoaiDeploymentError extends Error {
  constructor(m: string) { super(m); this.name = 'NoAoaiDeploymentError'; }
}
const resolveAoaiTargetMock = vi.fn(async () => ({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' }));
vi.mock('@/lib/azure/copilot-orchestrator', async (importOriginal) => ({
  ...(await importOriginal() as any),
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTargetMock(...(a as [])),
  NoAoaiDeploymentError,
}));

/** Stub chat-completions: echoes `S:<input>` and reports usage; `boom` → 500. */
function stubAoai() {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const input = String(body?.messages?.[1]?.content ?? '');
    if (input === 'boom') return new Response('rate limited', { status: 500 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `S:${input}` } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
}

beforeEach(() => {
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
  stubAoai();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('callAiFnBatch', () => {
  it('maps a function over every row and sums usage', async () => {
    const { callAiFnBatch } = await import('@/lib/azure/ai-functions-client');
    const res = await callAiFnBatch('summarize', ['a', 'b', 'c']);
    expect(res.rows.map((r) => r.result)).toEqual(['S:a', 'S:b', 'S:c']);
    expect(res.rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(res.failed).toBe(0);
    expect(res.usage.totalTokens).toBe(15); // 3 rows × 5
    expect(res.model).toBe('chat');
  });

  it('passes empty cells through without an AOAI call', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch as any);
    const { callAiFnBatch } = await import('@/lib/azure/ai-functions-client');
    const res = await callAiFnBatch('summarize', ['', '   ', 'x']);
    expect(res.rows[0].result).toBe('');
    expect(res.rows[1].result).toBe('');
    expect(res.rows[2].result).toBe('S:x');
    // Only the one non-empty cell hit the model.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('captures a per-row failure without aborting the batch', async () => {
    const { callAiFnBatch } = await import('@/lib/azure/ai-functions-client');
    const res = await callAiFnBatch('summarize', ['a', 'boom', 'c']);
    expect(res.failed).toBe(1);
    expect(res.rows[1].error).toBeTruthy();
    expect(res.rows[1].result).toBe('');
    expect(res.rows[0].result).toBe('S:a');
    expect(res.rows[2].result).toBe('S:c');
  });

  it('preserves input order under concurrency', async () => {
    const { callAiFnBatch } = await import('@/lib/azure/ai-functions-client');
    const inputs = Array.from({ length: 20 }, (_v, i) => `row${i}`);
    const res = await callAiFnBatch('summarize', inputs, {}, 4);
    expect(res.rows.map((r) => r.result)).toEqual(inputs.map((i) => `S:${i}`));
  });

  it('rethrows NoAoaiDeploymentError (honest gate) instead of per-row errors', async () => {
    resolveAoaiTargetMock.mockRejectedValue(new NoAoaiDeploymentError('no model deployed'));
    const { callAiFnBatch } = await import('@/lib/azure/ai-functions-client');
    await expect(callAiFnBatch('summarize', ['a', 'b'])).rejects.toThrow(/no model deployed/);
  });
});
