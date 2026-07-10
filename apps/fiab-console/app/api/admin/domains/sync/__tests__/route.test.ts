/**
 * BFF contract tests for /api/admin/domains/sync — the Purview/Unity-Catalog
 * domain reconciler route. Exercises the real handlers with the reconciler +
 * auth mocked: auth gate, GET last-status/dry-run passthrough, POST apply +
 * persistence. Per no-vaporware.md these pin status codes + payload shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

let sessionVal: any = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 };
let adminDenied: any = null;

vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionVal }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: () => adminDenied }));

const DRY = { applied: false, ranAt: 't', ranBy: 'admin@contoso.com', domainCount: 2, purview: { configured: true, mirrored: 2, created: 0, missing: 0, errors: 0 }, unity: { configured: false }, rows: [], drift: [] };
const APPLIED = { ...DRY, applied: true, purview: { configured: true, mirrored: 0, created: 2, missing: 0, errors: 0 } };

let lastStatus: any = null;
const saveMock = vi.fn(async () => {});
const runMock = vi.fn(async (_t: string, _w: string, opts: any) => (opts?.apply ? APPLIED : DRY));

vi.mock('@/lib/azure/domain-sync', () => ({
  runDomainSync: (t: string, w: string, o: any) => runMock(t, w, o),
  saveDomainSyncStatus: (t: string, r: any) => saveMock(t, r),
  loadDomainSyncStatus: async () => lastStatus,
}));

function req(body?: any) {
  return { json: async () => body ?? {} } as any;
}

describe('/api/admin/domains/sync', () => {
  beforeEach(() => {
    sessionVal = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com' }, exp: Date.now() / 1000 + 3600 };
    adminDenied = null;
    lastStatus = null;
    saveMock.mockClear();
    runMock.mockClear();
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('GET returns cached last-status when present', async () => {
    lastStatus = { ...APPLIED };
    const { GET } = await import('../route');
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.fromCache).toBe(true);
    expect(j.result.applied).toBe(true);
  });

  it('GET runs a dry run when nothing has run before', async () => {
    lastStatus = null;
    const { GET } = await import('../route');
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.fromCache).toBe(false);
    expect(j.result.applied).toBe(false);
    expect(runMock).toHaveBeenCalledWith('admin-oid', 'admin@contoso.com', { apply: false });
  });

  it('GET is 401 without a session', async () => {
    sessionVal = null;
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET is admin-gated', async () => {
    adminDenied = NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('POST apply:true runs the reconciler and persists the result', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({ apply: true }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.result.applied).toBe(true);
    expect(runMock).toHaveBeenCalledWith('admin-oid', 'admin@contoso.com', { apply: true });
    expect(saveMock).toHaveBeenCalledOnce();
  });

  it('POST defaults to a dry run when apply is omitted', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({}));
    const j = await res.json();
    expect(j.result.applied).toBe(false);
    expect(runMock).toHaveBeenCalledWith('admin-oid', 'admin@contoso.com', { apply: false });
  });
});
