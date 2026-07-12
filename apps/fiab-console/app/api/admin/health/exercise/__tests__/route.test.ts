/**
 * BFF contract tests for /api/admin/health/exercise — the exercise-every-service
 * validation route. Real handlers with the probe engine + auth mocked: the
 * tenant-admin gate, the ?service filter + validation, the start/poll contract,
 * and the state aggregation payload. Per no-vaporware.md these pin status codes
 * + payload shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

let sessionVal: any = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: Date.now() / 1000 + 3600 };
let adminDenied: any = null;

vi.mock('@/lib/auth/session', () => ({ getSession: () => sessionVal }));
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: (s: any) => {
    if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
    return adminDenied;
  },
}));

const startMock = vi.fn(async (_base: any, _opts: any) => ({ runId: 'exr-1', alreadyRunning: false }));
const stateMock = vi.fn(async (_tenantId: string): Promise<any> => null);
vi.mock('@/lib/admin/service-probes', () => ({
  SERVICE_PROBES: [
    { service: 'spark', title: 'Spark', timeoutMs: 1, run: async () => ({ status: 'pass', detail: '' }) },
    { service: 'adx', title: 'ADX', timeoutMs: 1, run: async () => ({ status: 'pass', detail: '' }) },
  ],
  isKnownService: (s: string) => s === 'spark' || s === 'adx',
  isRunStale: (st: any) => st.status === 'running' && st.startedAt === 'STALE',
  startExerciseRun: (base: any, opts: any) => startMock(base, opts),
  getExerciseRunState: (t: string) => stateMock(t),
}));

function post(url: string, body?: any) {
  return {
    url: `https://loom.example${url}`,
    json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  } as any;
}

describe('/api/admin/health/exercise', () => {
  beforeEach(() => {
    sessionVal = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: Date.now() / 1000 + 3600 };
    adminDenied = null;
    startMock.mockClear().mockResolvedValue({ runId: 'exr-1', alreadyRunning: false });
    stateMock.mockClear().mockResolvedValue(null);
    vi.resetModules();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('GET is 401 without a session', async () => {
    sessionVal = null;
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET is tenant-admin gated', async () => {
    adminDenied = NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(403);
    expect(stateMock).not.toHaveBeenCalled();
  });

  it('GET returns null state + the probe catalog before any run', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.state).toBeNull();
    expect(j.stale).toBe(false);
    expect(j.services).toEqual([
      { service: 'spark', title: 'Spark' },
      { service: 'adx', title: 'ADX' },
    ]);
    expect(stateMock).toHaveBeenCalledWith('tenant-1'); // tid wins over oid
  });

  it('GET surfaces the completed report + stale flag', async () => {
    const report = { summary: { pass: 1, gate: 0, fail: 1, total: 2 }, results: [] };
    stateMock.mockResolvedValue({ runId: 'exr-9', tenantId: 'tenant-1', status: 'complete', startedAt: 't', report });
    const { GET } = await import('../route');
    const j = await (await GET()).json();
    expect(j.state.report.summary.fail).toBe(1);
    expect(j.stale).toBe(false);
  });

  it('GET marks a stale running state', async () => {
    stateMock.mockResolvedValue({ runId: 'exr-9', tenantId: 'tenant-1', status: 'running', startedAt: 'STALE' });
    const { GET } = await import('../route');
    const j = await (await GET()).json();
    expect(j.stale).toBe(true);
  });

  it('POST is 401 without a session and 403 for non-admin', async () => {
    const { POST } = await import('../route');
    sessionVal = null;
    expect((await POST(post('/api/admin/health/exercise'))).status).toBe(401);
    sessionVal = { claims: { oid: 'user-oid', upn: 'user@contoso.com' }, exp: 1 };
    adminDenied = NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    expect((await POST(post('/api/admin/health/exercise'))).status).toBe(403);
    expect(startMock).not.toHaveBeenCalled();
  });

  it('POST starts a full run (no filter) with the tenant/who context', async () => {
    const { POST } = await import('../route');
    const res = await POST(post('/api/admin/health/exercise'));
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, runId: 'exr-1', alreadyRunning: false, running: true });
    expect(startMock).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', who: 'admin@contoso.com' },
      { services: [] },
    );
  });

  it('POST ?service=spark scopes the run to one probe', async () => {
    const { POST } = await import('../route');
    const res = await POST(post('/api/admin/health/exercise?service=spark'));
    expect((await res.json()).ok).toBe(true);
    expect(startMock).toHaveBeenCalledWith(expect.anything(), { services: ['spark'] });
  });

  it('POST body { services } merges with the query filter', async () => {
    const { POST } = await import('../route');
    await POST(post('/api/admin/health/exercise?service=spark', { services: ['adx'] }));
    expect(startMock).toHaveBeenCalledWith(expect.anything(), { services: ['spark', 'adx'] });
  });

  it('POST rejects an unknown service with 400 naming the valid set', async () => {
    const { POST } = await import('../route');
    const res = await POST(post('/api/admin/health/exercise?service=fabric'));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.error).toContain('fabric');
    expect(j.error).toContain('spark');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('POST reports alreadyRunning when a run is in progress', async () => {
    startMock.mockResolvedValue({ runId: 'exr-live', alreadyRunning: true });
    const { POST } = await import('../route');
    const j = await (await POST(post('/api/admin/health/exercise'))).json();
    expect(j.alreadyRunning).toBe(true);
    expect(j.runId).toBe('exr-live');
  });
});
