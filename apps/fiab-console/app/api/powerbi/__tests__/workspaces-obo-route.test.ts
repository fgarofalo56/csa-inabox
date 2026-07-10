/**
 * Route-level proof that a Power BI BFF route authenticates as the SIGNED-IN
 * USER (OBO passthrough), not the console service principal, when a session is
 * present. Mocks the OBO service to return a user token + the HTTP layer to
 * capture the outbound Authorization header, then drives GET /api/powerbi/workspaces
 * and asserts the real Power BI call carried the USER's bearer token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHeaders: Record<string, string>[] = [];

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'user-oid-1' }, exp: Date.now() / 1000 + 3600 }),
}));

vi.mock('@/lib/auth/obo', () => ({
  userPassthroughEnabled: () => true,
  getUserPbiToken: vi.fn(async () => ({ ok: true, token: 'USER_PBI_TOKEN', expiresOn: new Date(Date.now() + 3600_000) })),
  oboRemediation: (e: string) => `remediation:${e}`,
}));

vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: vi.fn(async (_url: string, init: any) => {
    capturedHeaders.push(init?.headers ?? {});
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ value: [{ id: 'ws-1', name: 'My Workspace' }] }),
      headers: { get: () => null },
    };
  }),
}));

beforeEach(() => {
  capturedHeaders.length = 0;
});

describe('GET /api/powerbi/workspaces — user-passthrough', () => {
  it('calls Power BI with the signed-in user OBO token, not the SP', async () => {
    const { GET } = await import('../workspaces/route');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.workspaces).toEqual([{ id: 'ws-1', name: 'My Workspace' }]);

    // The outbound Power BI REST call carried the USER's delegated bearer token.
    expect(capturedHeaders.length).toBeGreaterThan(0);
    expect(capturedHeaders[0].authorization).toBe('Bearer USER_PBI_TOKEN');

    // And it actually consulted the OBO service for the user token.
    const obo = await import('@/lib/auth/obo');
    expect(obo.getUserPbiToken).toHaveBeenCalled();
  });
});
