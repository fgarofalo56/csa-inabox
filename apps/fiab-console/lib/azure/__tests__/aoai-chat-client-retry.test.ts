/**
 * aoai-chat-client — 429 retry wiring across ALL FIVE call sites.
 *
 * The unified client throws `AoaiResponseError` from five separate places
 * (`aoaiChat`, `aoaiChatJson`, `aoaiChatRaw`, `aoaiEmbed`, `aoaiChatStream`).
 * Historically a fix applied at one site silently left the other four broken —
 * so this suite exercises every one of them through the REAL client code,
 * asserting a 429 is retried and a 400 is not.
 *
 * Mocks: copilot-orchestrator (target + token, no Foundry/ARM), token-budget
 * (isolate the N13 budget subsystem), and global fetch (the transport).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/azure/copilot-orchestrator', async () => {
  const actual = await vi.importActual<any>('@/lib/azure/copilot-orchestrator');
  return {
    ...actual,
    resolveAoaiTarget: vi.fn(async () => ({
      endpoint: 'https://fake-aoai.openai.azure.com',
      deployment: 'gpt-4o-test',
      apiVersion: '2024-10-21',
    })),
    aoaiToken: vi.fn(async () => 'stub-token'),
  };
});

vi.mock('@/lib/copilot/token-budget', () => ({
  enforceTokenBudget: vi.fn(async () => {}),
  recordTurnSpend: vi.fn(async () => {}),
  resolveAttribution: vi.fn(() => undefined),
  usageFromResponse: vi.fn(() => undefined),
}));

import {
  aoaiChat,
  aoaiChatJson,
  aoaiChatRaw,
  aoaiEmbed,
  aoaiChatStream,
} from '../aoai-chat-client';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const throttled = () => new Response('{"error":{"code":"429"}}', { status: 429, headers: { 'retry-after': '0' } });

const CHAT_OK = { choices: [{ message: { content: 'hello' } }] };
const JSON_OK = { choices: [{ message: { content: '{"answer":42}' } }] };
const EMBED_OK = { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1, total_tokens: 1 } };

const messages = [{ role: 'user' as const, content: 'hi' }];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Keep the real backoff, but make every sleep ~1ms so the suite stays instant.
  process.env.LOOM_AOAI_RETRY_BASE_MS = '1';
  process.env.LOOM_AOAI_RETRY_MAX_DELAY_MS = '1';
  process.env.LOOM_AOAI_ENDPOINT = 'https://fake-aoai.openai.azure.com';
  process.env.LOOM_AOAI_DEPLOYMENT = 'gpt-4o-test';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LOOM_AOAI_RETRY_BASE_MS;
  delete process.env.LOOM_AOAI_RETRY_MAX_DELAY_MS;
});

describe('429 is retried at every AOAI call site', () => {
  it('site 1/5 — aoaiChat', async () => {
    fetchMock.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(json(CHAT_OK));

    await expect(aoaiChat({ messages })).resolves.toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('site 2/5 — aoaiChatJson', async () => {
    fetchMock.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(json(JSON_OK));

    await expect(aoaiChatJson({ messages })).resolves.toEqual({ answer: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('site 3/5 — aoaiChatRaw (the tool loop)', async () => {
    fetchMock.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(json(CHAT_OK));

    const out = await aoaiChatRaw({ messages });
    expect(out.choices[0].message.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('site 4/5 — aoaiEmbed', async () => {
    fetchMock.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(json(EMBED_OK));

    const out = await aoaiEmbed({ input: 'text' });
    expect(out.vectors).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('site 5/5 — aoaiChatStream (body must survive the retry)', async () => {
    fetchMock
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(new Response('data: {"x":1}\n\n', { status: 200 }));

    const out = await aoaiChatStream({ messages });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.status).toBe(200);
    // The returned stream must be UNREAD — the route pipes it to the browser.
    expect(out.bodyUsed).toBe(false);
    expect(await out.text()).toContain('data:');
  });
});

describe('a PERMANENT 429 still surfaces the original error text', () => {
  it('aoaiChat exhausts retries then throws the unchanged AOAI 429 error', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled()));

    await expect(aoaiChat({ messages })).rejects.toThrow(/AOAI 429/);
    // Default 3 attempts — bounded, not infinite.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('aoaiChatRaw keeps its own distinct error text', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled()));

    await expect(aoaiChatRaw({ messages })).rejects.toThrow(/AOAI chat-completions failed 429/);
  });

  it('aoaiChatStream keeps its own distinct error text', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled()));

    await expect(aoaiChatStream({ messages })).rejects.toThrow(/AOAI stream 429/);
  });

  it('aoaiEmbed keeps its own distinct error text', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(throttled()));

    await expect(aoaiEmbed({ input: 'x' })).rejects.toThrow(/AOAI embeddings 429/);
  });
});

describe('CONTROLS — non-retryable statuses still fail fast at every site', () => {
  it('a 400 is not retried by aoaiChat', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 400 }));

    await expect(aoaiChat({ messages })).rejects.toThrow(/AOAI 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 401 is not retried by aoaiChatJson', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));

    await expect(aoaiChatJson({ messages })).rejects.toThrow(/AOAI 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 embeddings gate is not retried and keeps its remediation text', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    await expect(aoaiEmbed({ input: 'x' })).rejects.toThrow(/LOOM_AOAI_EMBED_DEPLOYMENT/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a happy-path 200 still makes exactly ONE call', async () => {
    fetchMock.mockResolvedValueOnce(json(CHAT_OK));

    await expect(aoaiChat({ messages })).resolves.toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
