/**
 * GET /api/azure/function-apps/functions — the function picker's list for the
 * health-check Azure Function receiver (#4740), at the ROUTE seam: the real
 * `function-receiver` lister runs against a stubbed ARM `fetch`.
 *
 * The security property under test: this route LISTS functions and nothing
 * else. It reads no key and returns no URL — the key-bearing trigger URL is
 * minted only at save, server-side, by the action-group route.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • The fixture answers BOTH `listkeys` actions with unique keys
 *     (`FNKEY-list-4q`, `HOSTKEY-list-8w`). A route that enriched a row with its
 *     callable URL (the obvious "helpful" change) would POST listkeys — the
 *     recorded-call pin (`['GET']`) goes red — and would carry the key into the
 *     body — the `not.toContain` pins go red. The absence pins are paired with
 *     an exact `toEqual` on the rows, so deleting the list cannot satisfy them.
 *   • The rows are pinned with `toEqual`, not `toMatchObject`: returning the raw
 *     FunctionEnvelope, or re-adding `invokeUrlTemplate`, adds a field and fails.
 *   • Usability is per function: the fixture has one usable HTTP function, one
 *     timer, one admin-level and one disabled. Each unusable row must carry its
 *     reason — the editor renders those as DISABLED options, which is how the
 *     picker avoids offering a choice the save cannot honour.
 *   • The GET carries `Bearer USER-ARM-f2` (caller RBAC), never `UAMI-tk`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'UAMI-tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/auth/session', () => ({ getSession: () => ({ claims: { oid: 'oid-1' } }) }));
const getUserArmTokenMock = vi.fn(async (_oid: string) => 'USER-ARM-f2' as string | null);
vi.mock('@/lib/azure/user-token-store', () => ({
  getUserArmToken: (oid: string) => getUserArmTokenMock(oid),
  saveUserToken: vi.fn(async () => true),
}));
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({ getTokenCache: () => ({ getAllAccounts: async () => [] }), acquireTokenSilent: vi.fn() }),
}));

import { GET } from '../route';

const SITE = '/subscriptions/sub-1/resourceGroups/rg-fn/providers/Microsoft.Web/sites/alerts-fn';
const env = (name: string, bindings: unknown[], extra: Record<string, unknown> = {}) => ({
  id: `${SITE}/functions/${name}`,
  name: `alerts-fn/${name}`,
  properties: {
    config: { bindings },
    invoke_url_template: `https://alerts-fn.azurewebsites.net/api/${name.toLowerCase()}`,
    href: `https://alerts-fn.scm.azurewebsites.net/api/functions/${name}`,
    isDisabled: false,
    ...extra,
  },
});
const ENVELOPES = [
  env('OnAlert', [{ type: 'httpTrigger', authLevel: 'function' }, { type: 'http', direction: 'out' }]),
  env('Nightly', [{ type: 'timerTrigger', schedule: '0 0 * * * *' }]),
  env('Admin', [{ type: 'httpTrigger', authLevel: 'admin' }]),
  env('Old', [{ type: 'httpTrigger', authLevel: 'function' }], { isDisabled: true }),
];

const calls: { method: string; url: string; auth: string }[] = [];
function stubArm(opts: { listStatus?: number } = {}) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url); const m = String(init?.method || 'GET');
    calls.push({ method: m, url: u, auth: String((init?.headers as any)?.authorization || '') });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (m === 'POST' && /\/functions\/[^/]+\/listkeys/.test(u)) return json({ properties: { default: 'FNKEY-list-4q' } });
    if (m === 'POST' && /\/host\/default\/listkeys/.test(u)) return json({ masterKey: 'MASTER-list-0z', functionKeys: { default: 'HOSTKEY-list-8w' } });
    if (m === 'GET' && /\/sites\/alerts-fn\/functions\?api-version=/.test(u)) {
      if (opts.listStatus && opts.listStatus >= 400) return json({ error: { code: 'AuthorizationFailed', message: 'denied' } }, opts.listStatus);
      return json({ value: ENVELOPES });
    }
    return json({ error: { code: 'NotFound', message: `unexpected ${m} ${u}` } }, 404);
  }));
}

function get(siteId: string) {
  return GET(new NextRequest(`http://localhost/api/azure/function-apps/functions?siteId=${encodeURIComponent(siteId)}`), { params: Promise.resolve({}) } as any);
}

beforeEach(() => {
  getUserArmTokenMock.mockReset().mockResolvedValue('USER-ARM-f2');
  stubArm();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('GET /api/azure/function-apps/functions (#4740)', () => {
  it('lists every function with its usability, and reads NO key and returns NO URL', async () => {
    const res = await get(SITE);
    const text = await res.clone().text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      functions: [
        { name: 'OnAlert', httpTrigger: true, authLevel: 'function', isDisabled: false, usable: true },
        { name: 'Nightly', httpTrigger: false, authLevel: 'function', isDisabled: false, usable: false, reason: 'not HTTP-triggered' },
        { name: 'Admin', httpTrigger: true, authLevel: 'admin', isDisabled: false, usable: false, reason: 'admin-level auth (would require the host master key)' },
        { name: 'Old', httpTrigger: true, authLevel: 'function', isDisabled: true, usable: false, reason: 'disabled' },
      ],
    });
    // One read, under the caller's token — no listkeys of any kind.
    expect(calls.map((c) => [c.method, c.auth])).toEqual([['GET', 'Bearer USER-ARM-f2']]);
    for (const secret of ['FNKEY-list-4q', 'HOSTKEY-list-8w', 'MASTER-list-0z', 'code=']) expect(text).not.toContain(secret);
    expect(text).not.toContain('azurewebsites.net');
  });

  it('ARM 403 on the list: a 403 gate naming the role that also covers the save', async () => {
    stubArm({ listStatus: 403 });
    const res = await get(SITE);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.gate.remediation).toContain('"Website Contributor"');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('no caller ARM token: 401 gate, and ARM is never called', async () => {
    getUserArmTokenMock.mockResolvedValue(null);
    const res = await get(SITE);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('a non-site id (here a Logic App) is refused 400 before any ARM call', async () => {
    const res = await get('/subscriptions/s/resourceGroups/r/providers/Microsoft.Logic/workflows/wf');
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
