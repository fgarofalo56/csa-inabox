/**
 * POST /api/help-copilot/chat — the gate codes, and the 401 prologue.
 *
 * WHY THIS FILE EXISTS. Two separate reviews landed on the same gap from
 * different directions:
 *
 *   1. This route emitted its AOAI gate as a CODELESS 503. A gate is only
 *      honest when it is DOCUMENTED (no-vaporware.md) — the `code` is what
 *      lets any consumer tell "not configured" from "the server broke", and
 *      without it the UAT classifier scores a real outage as an honest gate.
 *      The codes were added; nothing asserted them, so deleting one broke no
 *      test. Its sibling `orchestrate` route was covered and this one was not.
 *   2. `check-route-toolkit.mjs`'s boy-scout arm fires on any edit to a
 *      baselined hand-rolled route, and the codemod REFUSES this file
 *      (`SKIPPED (POST: streaming/SSE handler)`) because the handler returns a
 *      raw SSE `Response` rather than a JSON envelope. This suite is the
 *      COMPENSATING CONTROL recorded against that TOUCH_EXEMPT entry: the auth
 *      prologue and both gate codes are now pinned by merge-blocking tests
 *      rather than by the guard the exemption steps around.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@t.com' } }) as any,
);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadTenantCopilotConfig = vi.fn(async (..._a: any[]): Promise<any> => null);
vi.mock('@/lib/azure/copilot-config-store', () => ({
  loadTenantCopilotConfig: (...a: any[]) => loadTenantCopilotConfig(...a),
}));

const resolveAoaiTarget = vi.fn(async (..._a: any[]): Promise<any> => ({
  endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21',
}));
class NoAoaiDeploymentError extends Error {}
vi.mock('@/lib/azure/copilot-orchestrator', () => ({
  resolveAoaiTarget: (...a: any[]) => resolveAoaiTarget(...a),
  NoAoaiDeploymentError,
}));

vi.mock('@/lib/azure/help-copilot-orchestrator', () => ({
  orchestrateHelp: async function* () { /* never reached in these cases */ },
  newSessionId: () => 'sess-1',
}));

function post(body: unknown) {
  return new NextRequest('http://localhost/api/help-copilot/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('help-copilot/chat gate codes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'oid-1', tid: 'tid-1', upn: 'u@t.com' } } as any);
    resolveAoaiTarget.mockResolvedValue({
      endpoint: 'https://aoai.example.com', deployment: 'chat', apiVersion: '2024-10-21',
    });
  });

  it('401s before reading anything when there is no session', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const { POST } = await import('../chat/route');
    const res = await POST(post({ prompt: 'hi' }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: 'unauthenticated' });
    // The prologue must short-circuit — nothing downstream may be touched.
    expect(loadTenantCopilotConfig).not.toHaveBeenCalled();
    expect(resolveAoaiTarget).not.toHaveBeenCalled();
  });

  it('503s with the documented gate code when no AOAI deployment is wired', async () => {
    resolveAoaiTarget.mockRejectedValueOnce(new NoAoaiDeploymentError('no chat deployment chosen'));
    const { POST } = await import('../chat/route');
    const res = await POST(post({ prompt: 'hi' }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      code: 'no_aoai',
      error: 'no chat deployment chosen',
      // The widget's deep-link CTA keys on this; it predates `code` and stays.
      gate: 'aoai',
    });
  });

  it('502s with aoai_unreachable when resolution fails for any other reason', async () => {
    resolveAoaiTarget.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const { POST } = await import('../chat/route');
    const res = await POST(post({ prompt: 'hi' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, code: 'aoai_unreachable' });
    // The distinction itself. An account Loom deploys that cannot be reached is
    // a broken deployment; if these two codes ever collapse, a real outage
    // starts reading as "not configured" and the UAT scores it a pass.
    expect(body.code).not.toBe('no_aoai');
  });

  it('400s on an empty prompt without reaching AOAI', async () => {
    const { POST } = await import('../chat/route');
    const res = await POST(post({ prompt: '   ' }));
    expect(res.status).toBe(400);
    expect(resolveAoaiTarget).not.toHaveBeenCalled();
  });
});
