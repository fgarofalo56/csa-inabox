/**
 * #4805 — operator decision 2026-09-30, "Guardrails in-product" (b): a session
 * minted by the CLI / VS Code device-code sign-in is refused on admin surfaces,
 * and an interactive (browser) session with the SAME claims is not.
 *
 * Everything below runs the REAL session crypto (encode → decode), the REAL
 * middleware, the REAL feature-gate and the REAL route-toolkit wrappers. Only
 * Cosmos (the grant store) and the `cookies()` store are faked.
 *
 * Each pair is built so the ONLY difference between the refused and the
 * admitted session is `authVia: 'device_code'` — same oid, same groups, same
 * tenant — so a refusal cannot come from anything but the marker.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0123456789';

let mockGrants: any[] = [];
let cosmosQueried = 0;
vi.mock('@/lib/azure/cosmos-client', () => ({
  featurePermissionsContainer: async () => ({
    items: {
      query: () => {
        cosmosQueried += 1;
        return { fetchAll: async () => ({ resources: mockGrants }) };
      },
    },
  }),
}));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: async () => null }));

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: () => ({ get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined) }),
}));

import { encodeSessionCookie, type SessionPayload } from '../session';
import { isTenantAdmin, requireTenantAdmin, enforceCapability, checkCapability } from '../feature-gate';
import { INTERACTIVE_SIGN_IN_REQUIRED_REASON, INTERACTIVE_SIGN_IN_HINT } from '../device-code-policy';
import { withTenantAdmin, withCapability } from '@/lib/api/route-toolkit';
import { middleware, config as middlewareConfig } from '@/middleware';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';

const ADMIN_OID = 'aaaaaaaa-0000-0000-0000-00000000ad01';
const TENANT = 'bbbbbbbb-0000-0000-0000-000000000002';
const claims = { oid: ADMIN_OID, tid: TENANT, name: 'Ada', upn: 'ada@contoso.com', groups: ['g-admin'] };
const exp = () => Math.floor(Date.now() / 1000) + 600;
const browser = (): SessionPayload => ({ claims: { ...claims }, exp: exp() });
const deviceCode = (): SessionPayload => ({ claims: { ...claims }, exp: exp(), authVia: 'device_code' });

const env0 = { ...process.env };
beforeEach(() => {
  mockGrants = [];
  cosmosQueried = 0;
  cookieValue = undefined;
  // The same principal is a tenant admin by oid, so the browser control is ADMITTED.
  process.env.LOOM_TENANT_ADMIN_OID = ADMIN_OID;
  delete process.env.LOOM_TENANT_ADMIN_GROUP_ID;
});
afterEach(() => {
  process.env = { ...env0 };
});

async function body(res: Response | null | undefined): Promise<any> {
  return res ? res.json() : null;
}

describe('#4805 (b) tenant-admin standing and gates', () => {
  it('isTenantAdmin: the same principal is an admin in the browser and NOT via device code', () => {
    // RED if isTenantAdmin ignores authVia (both would be true).
    expect(isTenantAdmin(browser())).toBe(true);
    expect(isTenantAdmin(deviceCode())).toBe(false);
  });

  it('requireTenantAdmin: device code gets 403 interactive_sign_in_required; the browser session passes', async () => {
    const refused = requireTenantAdmin(deviceCode());
    expect(refused?.status).toBe(403);
    const b = await body(refused);
    // RED if the device-code check is removed from requireTenantAdmin: the refusal
    // would still happen (isTenantAdmin is false) but as `admin_only`, which tells
    // the user to ask for a grant they already hold.
    expect(b.code).toBe('interactive_sign_in_required');
    expect(b.reason).toBe(INTERACTIVE_SIGN_IN_REQUIRED_REASON);
    expect(b.reason).toMatch(/Admin actions require an interactive browser sign-in/);
    expect(requireTenantAdmin(browser())).toBeNull();
  });

  it('enforceCapability at an admin tier refuses device code BEFORE any grant lookup, even with a matching grant', async () => {
    delete process.env.LOOM_TENANT_ADMIN_OID; // grants only, no bypass, so the grant is what admits the browser
    mockGrants = [{ id: 'g', tenantId: TENANT, capabilityId: 'admin.env-config', principalId: ADMIN_OID, principalType: 'user', role: 'Admin', grantedBy: 'x', grantedAt: 'x' }];
    const refused = await enforceCapability(deviceCode(), 'admin.env-config', 'Admin');
    expect(refused?.status).toBe(403);
    expect((await body(refused)).code).toBe('interactive_sign_in_required');
    expect(cosmosQueried, 'the device-code refusal consulted the grant store').toBe(0);
    // Control: the same grant admits the browser session.
    expect(await enforceCapability(browser(), 'admin.env-config', 'Admin')).toBeNull();
    // checkCapability itself refuses too (RED if only enforceCapability checks).
    const r = await checkCapability(deviceCode(), 'admin.permissions', 'Reader');
    expect(r.allow).toBe(false);
    expect(r.reason).toBe(INTERACTIVE_SIGN_IN_REQUIRED_REASON);
  });

  it('a NON-admin capability is still reachable by a device-code session that holds the grant', async () => {
    // Control for over-reach: RED if the policy refuses every capability check.
    delete process.env.LOOM_TENANT_ADMIN_OID;
    mockGrants = [{ id: 'g', tenantId: TENANT, capabilityId: 'item.share', principalId: ADMIN_OID, principalType: 'user', role: 'Contributor', grantedBy: 'x', grantedAt: 'x' }];
    expect(await enforceCapability(deviceCode(), 'item.share', 'Reader')).toBeNull();
  });
});

describe('#4805 (b) the route wrappers refuse device code on admin routes', () => {
  const handler = vi.fn(async () => Response.json({ ok: true, ran: true }));
  const ctx = { params: Promise.resolve({}) } as any;
  const req = new NextRequest('https://loom.example/api/admin/whatever');

  it('withTenantAdmin: 403 for device code, handler never runs; 200 for the browser session', async () => {
    const route = withTenantAdmin(handler);
    cookieValue = encodeSessionCookie(deviceCode());
    const res = await route(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('interactive_sign_in_required');
    expect(handler).not.toHaveBeenCalled();
    cookieValue = encodeSessionCookie(browser());
    const ok = await route(req, ctx);
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('withCapability at Admin: 403 for device code; the browser session (tenant admin) passes', async () => {
    handler.mockClear();
    const route = withCapability('admin.deploy-dlz', 'Admin', handler);
    cookieValue = encodeSessionCookie(deviceCode());
    expect((await route(req, ctx)).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    cookieValue = encodeSessionCookie(browser());
    expect((await route(req, ctx)).status).toBe(200);
  });
});

describe('#4805 (b) middleware.ts guards /admin/* and /api/admin/* for every helper', () => {
  const at = (path: string, s: SessionPayload | null) =>
    new NextRequest(`https://loom.example${path}`, s ? { headers: { cookie: `loom_session=${encodeSessionCookie(s)}` } } : undefined);

  it('a device-code session gets 403 on an admin API route and an admin page; the same claims in a browser session pass', async () => {
    for (const path of ['/api/admin/workspaces/w1/git', '/admin/permissions']) {
      const refused = middleware(at(path, deviceCode()));
      // RED if the middleware stops checking authVia (it would pass the request on).
      expect(refused.status, `${path} was not refused`).toBe(403);
      expect((await refused.json()).code).toBe('interactive_sign_in_required');
      const passed = middleware(at(path, browser()));
      expect(passed.headers.get('x-middleware-next'), `${path} did not pass the browser session on`).toBe('1');
    }
    // No cookie, or an undecodable one, passes through to the route's own 401.
    expect(middleware(at('/api/admin/x', null)).headers.get('x-middleware-next')).toBe('1');
    const garbage = new NextRequest('https://loom.example/api/admin/x', { headers: { cookie: 'loom_session=not-a-session' } });
    expect(middleware(garbage).headers.get('x-middleware-next')).toBe('1');
  });

  it('the matcher covers the admin trees by MEANING (Next evaluates it), on the Node runtime', () => {
    // Asserted through Next's own matcher rather than the literal strings, so an
    // equivalent rewrite passes and a dropped or narrowed tree is RED: removing
    // '/api/admin/:path*' fails the nested /api/admin URLs; '/admin/:path' (one
    // segment) fails /admin/a/b/c. The admin refusal body also carries the hint
    // both clients print.
    const match = (url: string) => unstable_doesMiddlewareMatch({ config: middlewareConfig, url });
    for (const url of ['/admin', '/admin/', '/admin/a/b/c?x=1', '/api/admin', '/api/admin/', '/api/admin/env-config?x=1&y=2', '/api/admin/domains/d1/networking/rules']) {
      expect(match(url), `${url} is not matched`).toBe(true);
    }
    for (const url of ['/administrator', '/api/administrator', '/_next/static/chunks/main.js', '/', '/api/auth/cli-session', '/ADMIN', '/API/ADMIN/env-config', '/workspaces']) {
      expect(match(url), `${url} is matched`).toBe(false);
    }
    expect(middlewareConfig.runtime).toBe('nodejs');
  });

  it('the admin refusal carries the browser hint the CLI and the extension print', async () => {
    const b = await middleware(at('/api/admin/policy-code', deviceCode())).json();
    // RED if `hint` is dropped: both clients read `hint`, not `remediation`.
    expect(b.hint).toBe(INTERACTIVE_SIGN_IN_HINT);
    expect(b.message).toBe(INTERACTIVE_SIGN_IN_REQUIRED_REASON);
  });
});
