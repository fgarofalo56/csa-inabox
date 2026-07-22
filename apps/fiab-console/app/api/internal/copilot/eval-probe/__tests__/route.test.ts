/**
 * BFF route tests for /api/internal/copilot/eval-probe (E2).
 *
 * Verifies the machine-to-machine contract the copilot-evaluator Function
 * depends on:
 *   - fail-closed internal-token auth (401 without/with a wrong token, and
 *     when LOOM_INTERNAL_TOKEN is unset);
 *   - POST runs the REAL searchDocs + one aoaiChat turn and returns
 *     {retrievedChunks(id/path/preview), backend, answer, tier, latencyMs};
 *   - honest 503 no_aoai gate when no AOAI deployment resolves;
 *   - GET returns the staged corpus-manifest probe.
 * searchDocs/aoaiChat are mocked at the module seam — the REAL data path is
 * exercised by the E2 live receipt (minted probe on the deployment), per G1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { NoAoaiDeploymentErrorMock, searchDocsMock, aoaiChatMock, resolveTargetMock } = vi.hoisted(() => {
  class NoAoaiDeploymentErrorMock extends Error {
    constructor() { super('no aoai'); this.name = 'NoAoaiDeploymentError'; }
  }
  return {
    NoAoaiDeploymentErrorMock,
    searchDocsMock: vi.fn(),
    aoaiChatMock: vi.fn(),
    resolveTargetMock: vi.fn(),
  };
});

vi.mock('@/lib/azure/loom-docs-index', () => ({ searchDocs: searchDocsMock }));
vi.mock('@/lib/azure/aoai-chat-client', () => ({
  aoaiChat: aoaiChatMock,
  NoAoaiDeploymentError: NoAoaiDeploymentErrorMock,
}));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({ resolveAoaiTarget: resolveTargetMock }));

import { POST, GET } from '../route';

const TOKEN = 'test-internal-token';

function post(body: unknown, token?: string): NextRequest {
  return new NextRequest('http://localhost/api/internal/copilot/eval-probe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-loom-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.LOOM_INTERNAL_TOKEN = TOKEN;
  searchDocsMock.mockReset().mockResolvedValue({
    backend: 'ai-search',
    hits: [
      {
        id: 'k1', kind: 'docs', path: 'docs/fiab/parity/lakehouse.md',
        heading: 'Azure-native default', content: 'ADLS Gen2 + Delta is the default…',
        touchedAt: '2026-07-22T00:00:00Z', score: 0.9,
      },
    ],
  });
  aoaiChatMock.mockReset().mockResolvedValue('Loom defaults to ADLS Gen2 + Delta.');
  resolveTargetMock.mockReset().mockResolvedValue({ endpoint: 'https://x.openai.azure.com', deployment: 'chat', apiVersion: '2024-08-01-preview' });
});

afterEach(() => {
  delete process.env.LOOM_INTERNAL_TOKEN;
});

describe('auth (fail closed)', () => {
  it('401 without a token', async () => {
    const res = await POST(post({ question: 'q?' }));
    expect(res.status).toBe(401);
  });
  it('401 with a wrong token', async () => {
    const res = await POST(post({ question: 'q?' }, 'wrong'));
    expect(res.status).toBe(401);
  });
  it('401 when LOOM_INTERNAL_TOKEN is unset (gate inert)', async () => {
    delete process.env.LOOM_INTERNAL_TOKEN;
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(401);
  });
});

describe('POST probe', () => {
  it('runs real retrieval + one Copilot turn and returns the probe shape', async () => {
    const res = await POST(post({ question: 'How do I bind a lakehouse?', surface: 'help' }, TOKEN));
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.backend).toBe('ai-search');
    expect(j.retrievedChunks).toHaveLength(1);
    expect(j.retrievedChunks[0].id).toBe('docs/fiab/parity/lakehouse.md#azure-native-default');
    expect(j.retrievedChunks[0].path).toBe('docs/fiab/parity/lakehouse.md');
    expect(j.retrievedChunks[0].preview).toContain('ADLS');
    expect(j.answer).toContain('ADLS');
    expect(['mini', 'standard', 'strong']).toContain(j.tier);
    expect(typeof j.latencyMs).toBe('number');
    // The turn was grounded on the retrieved excerpts (system prompt carries them).
    const call = aoaiChatMock.mock.calls[0][0];
    expect(call.messages[0].content).toContain('docs/fiab/parity/lakehouse.md');
    expect(call.messages[1].content).toBe('How do I bind a lakehouse?');
  });
  it('400 on a missing question', async () => {
    const res = await POST(post({}, TOKEN));
    expect(res.status).toBe(400);
  });
  it('503 no_aoai honest gate when no deployment resolves', async () => {
    resolveTargetMock.mockRejectedValue(new NoAoaiDeploymentErrorMock());
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(503);
    const j: any = await res.json();
    expect(j.code).toBe('no_aoai');
    expect(j.error).toContain('LOOM_AOAI_ENDPOINT');
  });
});

describe('GET manifest probe', () => {
  it('401 without a token, 200 with', async () => {
    const bare = new NextRequest('http://localhost/api/internal/copilot/eval-probe');
    expect((await GET(bare)).status).toBe(401);
    const authed = new NextRequest('http://localhost/api/internal/copilot/eval-probe', {
      headers: { 'x-loom-internal-token': TOKEN },
    });
    const res = await GET(authed);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.ready).toBe(true);
    expect(typeof j.corpusCommit).toBe('string');
  });
});
