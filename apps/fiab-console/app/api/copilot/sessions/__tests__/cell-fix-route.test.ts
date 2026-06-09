/**
 * BFF route test for POST /api/copilot/sessions (mode:'cell-fix' — the
 * "Fix with Copilot" inline cell remediation).
 *
 * Asserts: (1) unauthed → 401, (2) wrong mode → 400, (3) missing cellSource →
 * 400, (4) missing error context → 400, (5) honest no_aoai gate → 503 with
 * code+hint, (6) happy path → structured { proposedCode, summary, rootCause }
 * (fences stripped) + sessionId persisted with summary/rootCause, (7) Cosmos
 * persist failure still returns 200 (soft-fail), (8) AOAI non-200 → 502,
 * (9) a non-JSON AOAI reply falls back to raw-code + parse-failure summary.
 *
 * AOAI, identity, tenant config, and Cosmos are all mocked — no live Azure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

class NoAoaiDeploymentError extends Error {
  constructor(m: string) { super(m); this.name = 'NoAoaiDeploymentError'; }
}
const resolveAoaiTargetMock = vi.fn(async () => ({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' }));
const listSessionsMock = vi.fn(async () => []);
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTargetMock(...a),
  NoAoaiDeploymentError,
  listSessions: () => listSessionsMock(),
}));

vi.mock('@/lib/azure/copilot-config-store', () => ({
  loadTenantCopilotConfig: vi.fn(async () => null),
}));

const createMock = vi.fn(async () => ({}));
vi.mock('@/lib/azure/cosmos-client', () => ({
  copilotSessionsContainer: vi.fn(async () => ({ items: { create: createMock } })),
}));

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/copilot/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stubAoai(content: string, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status, headers: { 'content-type': 'application/json' },
    }),
  ));
}

/** Build a structured cell-fix JSON reply, the shape the route now expects. */
function aoaiFix(proposedCode: string, summary = 'It broke.', rootCause = 'Bad column.') {
  return JSON.stringify({ summary, rootCause, proposedCode });
}

const ERR_CTX = { ename: 'NameError', evalue: "name 'undefined_var' is not defined", traceback: ['Traceback...', "NameError: name 'undefined_var' is not defined"] };

beforeEach(() => {
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 } as any);
  resolveAoaiTargetMock.mockResolvedValue({ endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21' });
  createMock.mockResolvedValue({});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('POST /api/copilot/sessions (cell-fix)', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(x)', errorContext: ERR_CTX }));
    expect(r.status).toBe(401);
  });

  it('400 on a non cell-fix mode', async () => {
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'generate', cellSource: 'print(x)', errorContext: ERR_CTX }));
    expect(r.status).toBe(400);
  });

  it('400 when cellSource is missing', async () => {
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', errorContext: ERR_CTX }));
    expect(r.status).toBe(400);
  });

  it('400 when error context is empty', async () => {
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(x)', errorContext: {} }));
    expect(r.status).toBe(400);
  });

  it('503 honest no_aoai gate when AOAI is unresolved', async () => {
    resolveAoaiTargetMock.mockRejectedValueOnce(new NoAoaiDeploymentError('No AOAI deployment on Foundry hub.'));
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.code).toBe('no_aoai');
    expect(j.hint).toMatch(/No AOAI deployment/);
  });

  it('happy path returns structured proposedCode+summary+rootCause + sessionId, persists', async () => {
    stubAoai(aoaiFix('undefined_var = "hello"\nprint(undefined_var)', 'Variable was undefined.', 'No prior assignment.'));
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.proposedCode).toBe('undefined_var = "hello"\nprint(undefined_var)');
    expect(j.proposedCode).not.toContain('```');
    expect(j.summary).toBe('Variable was undefined.');
    expect(j.rootCause).toBe('No prior assignment.');
    expect(typeof j.sessionId).toBe('string');
    expect(createMock).toHaveBeenCalledTimes(1);
    // The persisted record carries the structured summary + rootCause.
    const persisted = createMock.mock.calls[0][0];
    expect(persisted.summary).toBe('Variable was undefined.');
    expect(persisted.rootCause).toBe('No prior assignment.');
  });

  it('proposedCode embedded fences are stripped', async () => {
    stubAoai(aoaiFix('```python\nundefined_var = "hi"\n```'));
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.proposedCode).toBe('undefined_var = "hi"');
    expect(j.proposedCode).not.toContain('```');
  });

  it('falls back to raw-code when AOAI does not return JSON', async () => {
    stubAoai('```python\nundefined_var = 1\nprint(undefined_var)\n```');
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.proposedCode).toBe('undefined_var = 1\nprint(undefined_var)');
    expect(j.summary).toMatch(/could not be parsed/i);
  });

  it('still returns 200 when Cosmos persist fails (soft-fail)', async () => {
    createMock.mockRejectedValueOnce(new Error('cosmos down'));
    stubAoai('undefined_var = 1\nprint(undefined_var)');
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.proposedCode).toContain('print(undefined_var)');
  });

  it('502 when AOAI returns a non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream boom', { status: 500 })));
    const { POST } = await import('@/app/api/copilot/sessions/route');
    const r = await POST(postReq({ mode: 'cell-fix', cellSource: 'print(undefined_var)', lang: 'pyspark', errorContext: ERR_CTX }));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.ok).toBe(false);
  });
});
