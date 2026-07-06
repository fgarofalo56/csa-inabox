/**
 * Unit tests for the AI Functions client (callAiFn).
 *
 * Mocks: copilot-orchestrator (resolveAoaiTarget — forces a known AOAI target,
 * no Foundry), @azure/identity (token always succeeds), and global fetch
 * (captures the request body so we can assert the right system prompt per fn).
 * Asserts each of the five functions sends its distinguishing system-prompt
 * keyword, that options thread through (labels/fields/targetLang), and that the
 * NoAoaiDeploymentError honest gate propagates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/azure/copilot-orchestrator', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/copilot-orchestrator');
  return {
    ...actual,
    resolveAoaiTarget: vi.fn(async () => ({
      endpoint: 'https://fake-aoai.openai.azure.com',
      deployment: 'gpt-4o-test',
      apiVersion: '2024-10-21',
    })),
    NoAoaiDeploymentError: actual.NoAoaiDeploymentError,
  };
});

vi.mock('@azure/identity', async () => {
  const real = await vi.importActual<any>('@azure/identity');
  class StubCred {
    async getToken() { return { token: 'stub-token', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ...real,
    DefaultAzureCredential: StubCred,
    ManagedIdentityCredential: StubCred,
    ChainedTokenCredential: class { async getToken() { return { token: 'stub-token', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

// aoaiEmbed is the unified-client collaborator (it has its own aoai-chat-client
// tests). Here we mock it at the module boundary so callAiFn's embed/similarity
// orchestration (dimension summary + server-side cosine) is what's under test,
// without threading the real AOAI target resolver. The mock still POSTs through
// the stubbed global fetch, so `lastBody.input` assertions keep working.
vi.mock('@/lib/azure/aoai-chat-client', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/aoai-chat-client');
  return {
    ...actual,
    aoaiEmbed: vi.fn(async (opts: any) => {
      const res: any = await (globalThis.fetch as any)(
        'https://fake-aoai.openai.azure.com/embeddings',
        { method: 'POST', body: JSON.stringify({ input: opts.input }) },
      );
      const j = await res.json();
      return {
        vectors: (j.data || []).map((d: any) => d.embedding),
        model: opts.deployment || 'text-embedding-3-large',
        usage: j.usage
          ? { promptTokens: j.usage.prompt_tokens, totalTokens: j.usage.total_tokens }
          : undefined,
      };
    }),
  };
});

import { callAiFn, isAiFn, AI_FN_NAMES, NoAoaiDeploymentError } from '../ai-functions-client';
import { resolveAoaiTarget } from '@/lib/azure/copilot-orchestrator';

// Capture the most recent request body the client POSTed.
let lastBody: any = null;

function mockFetchOnce(content: string) {
  lastBody = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    } as any;
  }));
}

/** Stub the embeddings data-plane: one vector per `input` entry. */
function mockEmbedOnce(vectors: number[][]) {
  lastBody = null;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: vectors.map((embedding, index) => ({ embedding, index })),
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    } as any;
  }));
}

function systemPrompt(): string {
  return lastBody?.messages?.find((m: any) => m.role === 'system')?.content || '';
}

beforeEach(() => {
  lastBody = null;
  (resolveAoaiTarget as any).mockClear?.();
});

describe('isAiFn / AI_FN_NAMES', () => {
  it('accepts the nine valid names and rejects others', () => {
    expect([...AI_FN_NAMES].sort()).toEqual(
      ['classify', 'embed', 'extract', 'fix_grammar', 'generate_response', 'sentiment', 'similarity', 'summarize', 'translate'].sort(),
    );
    for (const n of AI_FN_NAMES) expect(isAiFn(n)).toBe(true);
    expect(isAiFn('embed')).toBe(true);
    expect(isAiFn('similarity')).toBe(true);
    expect(isAiFn('nope')).toBe(false);
    expect(isAiFn('')).toBe(false);
    expect(isAiFn(42)).toBe(false);
  });
});

describe('callAiFn system prompts', () => {
  it('summarize → uses a summarize prompt', async () => {
    mockFetchOnce('A short summary.');
    const r = await callAiFn('summarize', 'long text here');
    expect(systemPrompt().toLowerCase()).toContain('summarize');
    expect(r.result).toBe('A short summary.');
    expect(r.model).toBe('gpt-4o-test');
    expect(r.usage).toEqual({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
  });

  it('classify → embeds the provided labels', async () => {
    mockFetchOnce('urgent');
    await callAiFn('classify', 'ticket text', { labels: ['urgent', 'normal', 'low'] });
    const sp = systemPrompt().toLowerCase();
    expect(sp).toContain('classify');
    expect(sp).toContain('urgent');
    expect(sp).toContain('normal');
  });

  it('sentiment → uses a sentiment prompt', async () => {
    mockFetchOnce('positive');
    await callAiFn('sentiment', 'I love it');
    expect(systemPrompt().toLowerCase()).toContain('sentiment');
  });

  it('extract → embeds the requested fields and asks for JSON', async () => {
    mockFetchOnce('{"name":"Acme","amount":100}');
    const r = await callAiFn('extract', 'invoice text', { fields: ['name', 'amount'] });
    const sp = systemPrompt().toLowerCase();
    expect(sp).toContain('json');
    expect(sp).toContain('name');
    expect(sp).toContain('amount');
    expect(r.result).toBe('{"name":"Acme","amount":100}');
  });

  it('translate → embeds the target language', async () => {
    mockFetchOnce('Hola mundo');
    await callAiFn('translate', 'Hello world', { targetLang: 'Spanish' });
    const sp = systemPrompt().toLowerCase();
    expect(sp).toContain('translate');
    expect(sp).toContain('spanish');
  });

  it('fix_grammar → uses a grammar-correction prompt', async () => {
    mockFetchOnce('This sentence is correct.');
    const r = await callAiFn('fix_grammar', 'this sentance are wrong');
    expect(systemPrompt().toLowerCase()).toContain('grammar');
    expect(r.result).toBe('This sentence is correct.');
  });

  it('generate_response → uses a response-generation prompt', async () => {
    mockFetchOnce('Thanks for reaching out!');
    const r = await callAiFn('generate_response', 'How do I reset my password?');
    expect(systemPrompt().toLowerCase()).toContain('response');
    expect(r.result).toBe('Thanks for reaching out!');
  });
});

describe('callAiFn embeddings functions', () => {
  it('embed → returns the vector and dimension summary', async () => {
    mockEmbedOnce([[0.1, 0.2, 0.3, 0.4]]);
    const r = await callAiFn('embed', 'some text');
    expect(r.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(r.result).toContain('4');
    expect(lastBody.input).toBe('some text');
  });

  it('similarity → cosine of two embeddings; identical vectors → 1', async () => {
    mockEmbedOnce([[1, 0, 0], [1, 0, 0]]);
    const r = await callAiFn('similarity', 'a', { compareTo: 'b' });
    expect(r.similarity).toBeCloseTo(1, 5);
    expect(r.result).toBe('1.0000');
    expect(lastBody.input).toEqual(['a', 'b']);
  });

  it('similarity → orthogonal vectors → 0', async () => {
    mockEmbedOnce([[1, 0], [0, 1]]);
    const r = await callAiFn('similarity', 'a', { compareTo: 'b' });
    expect(r.similarity).toBeCloseTo(0, 5);
  });

  it('similarity → throws without a second text', async () => {
    mockEmbedOnce([[1, 0]]);
    await expect(callAiFn('similarity', 'a')).rejects.toThrow(/compareTo/);
  });
});

describe('callAiFn behavior', () => {
  it('strips markdown code fences from the result', async () => {
    mockFetchOnce('```json\n{"a":1}\n```');
    const r = await callAiFn('extract', 'x', { fields: ['a'] });
    expect(r.result).toBe('{"a":1}');
  });

  it('honors options.maxTokens', async () => {
    mockFetchOnce('ok');
    await callAiFn('summarize', 'x', { maxTokens: 123 });
    expect(lastBody.max_completion_tokens).toBe(123);
  });

  it('retries without temperature on a reasoning-model 400', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      call += 1;
      lastBody = JSON.parse(init.body);
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => 'unsupported_value: temperature does not support 0',
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'done' } }], usage: {} }),
      } as any;
    }));
    const r = await callAiFn('summarize', 'x');
    expect(call).toBe(2);
    expect(lastBody.temperature).toBeUndefined();
    expect(r.result).toBe('done');
  });

  it('propagates NoAoaiDeploymentError as the honest gate', async () => {
    (resolveAoaiTarget as any).mockImplementationOnce(async () => {
      throw new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.');
    });
    await expect(callAiFn('summarize', 'x')).rejects.toBeInstanceOf(NoAoaiDeploymentError);
  });
});
