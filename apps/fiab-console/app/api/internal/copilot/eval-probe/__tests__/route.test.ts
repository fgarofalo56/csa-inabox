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

vi.mock('@/lib/azure/loom-docs-index', () => ({
  searchDocs: searchDocsMock,
  DEFAULT_DOC_RETRIEVAL_TOP: 8,
}));
vi.mock('@/lib/azure/aoai-chat-client', () => ({
  aoaiChat: aoaiChatMock,
  NoAoaiDeploymentError: NoAoaiDeploymentErrorMock,
}));
vi.mock('@/lib/azure/copilot-orchestrator', () => ({ resolveAoaiTarget: resolveTargetMock }));

import { POST, GET, EVIDENCE_CHARS } from '../route';

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

  // Catches the #2585 P1b defect: `surface` was accepted, echoed back, and
  // never used for retrieval, so every surface competed against the whole
  // corpus. An echo-only implementation passes the old assertion and fails this
  // one.
  it('APPLIES the surface to retrieval instead of only echoing it', async () => {
    const res = await POST(post({ question: 'How do I share?', surface: 'lakehouse' }, TOKEN));
    expect(res.status).toBe(200);
    expect((await res.json()).surface).toBe('lakehouse');
    expect(searchDocsMock).toHaveBeenCalledWith(
      'How do I share?',
      expect.any(Number),
      undefined,
      { surface: 'lakehouse' },
    );
  });

  it('passes no surface when the caller sends none', async () => {
    await POST(post({ question: 'q?' }, TOKEN));
    expect(searchDocsMock.mock.calls[0][3]).toEqual({ surface: null });
  });

  // Catches the #2585 P3 defect: the judge graded grounding on a 300-character
  // preview while the model answered from 1500 characters of the SAME chunk, so
  // any claim drawn from characters 301-1500 looked ungrounded. `preview` is the
  // evaluator's only view of the evidence — it must be the slice the model saw.
  it('gives the judge the same evidence slice the model answered from', async () => {
    const long = 'A'.repeat(4000);
    searchDocsMock.mockResolvedValue({
      backend: 'cosmos',
      hits: [{
        id: 'k1', kind: 'docs', path: 'docs/fiab/parity/lakehouse.md',
        heading: 'H', content: long, touchedAt: '2026-07-22T00:00:00Z', score: 1,
      }],
    });
    const res = await POST(post({ question: 'q?' }, TOKEN));
    const preview: string = (await res.json()).retrievedChunks[0].preview;
    const prompt: string = aoaiChatMock.mock.calls[0][0].messages[0].content;
    expect(preview).toHaveLength(EVIDENCE_CHARS);
    expect(prompt).toContain(preview);
  });

  // Catches a silent narrowing of the retrieval window back to 5.
  it('defaults to the shared retrieval window and clamps an explicit top to 10', async () => {
    await POST(post({ question: 'q?' }, TOKEN));
    expect(searchDocsMock.mock.calls[0][1]).toBe(8);
    await POST(post({ question: 'q?', top: 99 }, TOKEN));
    expect(searchDocsMock.mock.calls[1][1]).toBe(10);
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

/**
 * #3083 / deploy-integrity R7 — the probe must not assert a cause it did not
 * establish, and it must not launder a THROTTLE into a defect.
 *
 * Measured 2026-08-07: `aoaiChat` threw on an AOAI 429, this route returned
 * `500 {"error":"eval probe failed","code":"eval_probe_failed"}`, and the
 * evaluator — seeing an unretryable 500 — silently dropped the row. Pass-rates
 * were then computed over the survivors, so `rbac 0.38` was 3 of 8 and a green
 * main run measured 123 of 153.
 */
describe('upstream AOAI failures are surfaced with their cause (#3083)', () => {
  /** The shape `AoaiResponseError` carries since #3083. */
  const aoaiError = (message: string, status?: number, retryAfterSeconds?: number) =>
    Object.assign(new Error(message), { name: 'AoaiResponseError', status, retryAfterSeconds });

  it('a 429 stays a 429 — never a causeless 500', async () => {
    aoaiChatMock.mockRejectedValue(aoaiError('AOAI 429: {"code":"rate_limit_exceeded"}', 429, 8));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(429);
    const j: any = await res.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('aoai_throttled');
    expect(j.upstreamStatus).toBe(429);
    expect(j.retryable).toBe(true);
    // The message NAMES the cause instead of the old 'eval probe failed'.
    expect(j.error).toContain('THROTTLED');
    expect(j.error).toContain('429');
    expect(j.error).not.toContain('eval probe failed');
  });

  it('honours Retry-After — echoed as a header AND a field', async () => {
    aoaiChatMock.mockRejectedValue(aoaiError('AOAI 429: throttled', 429, 8));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.headers.get('retry-after')).toBe('8');
    expect((await res.json()).retryAfterSeconds).toBe(8);
  });

  it('omits Retry-After when the server sent none (never invents a delay)', async () => {
    aoaiChatMock.mockRejectedValue(aoaiError('AOAI 429: throttled', 429));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.headers.get('retry-after')).toBeNull();
    expect((await res.json()).retryAfterSeconds).toBeUndefined();
  });

  it('a 503 from AOAI becomes a 502 that NAMES the upstream status (not an impersonation)', async () => {
    aoaiChatMock.mockRejectedValue(aoaiError('AOAI 503: overloaded', 503));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(502);
    const j: any = await res.json();
    expect(j.code).toBe('aoai_upstream_error');
    expect(j.upstreamStatus).toBe(503);
    expect(j.retryable).toBe(true);
  });

  it('a 401 from AOAI is reported as NON-retryable, and never as our own 401', async () => {
    aoaiChatMock.mockRejectedValue(aoaiError('AOAI 401: bad token', 401));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    // 401 here would be indistinguishable from "bad internal token".
    expect(res.status).toBe(502);
    const j: any = await res.json();
    expect(j.code).toBe('aoai_request_error');
    expect(j.upstreamStatus).toBe(401);
    expect(j.retryable).toBe(false);
  });

  it('an error with NO status says the cause is NOT KNOWN — it does not guess one', async () => {
    aoaiChatMock.mockRejectedValue(new Error('socket hang up'));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(500);
    const j: any = await res.json();
    expect(j.code).toBe('eval_probe_unclassified');
    expect(j.error).toContain('could NOT classify');
    expect(j.error).toContain('NOT established');
    expect(j.upstreamStatus).toBeUndefined();
  });

  it('does NOT infer a status from prose — a message containing "429" is still unknown', async () => {
    // R7: inferring a cause from an error string is the defect, not the fix.
    aoaiChatMock.mockRejectedValue(new Error('retrieval returned 429 documents'));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('eval_probe_unclassified');
  });

  it('a retrieval failure is NOT laundered into an AOAI verdict', async () => {
    searchDocsMock.mockRejectedValue(new Error('AI Search index missing'));
    const res = await POST(post({ question: 'q?' }, TOKEN));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('eval_probe_unclassified');
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
