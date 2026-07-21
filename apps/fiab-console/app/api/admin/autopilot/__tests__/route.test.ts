/**
 * WS-10.1 — BFF route tests for /api/admin/autopilot (+ /run, /apply).
 *
 * Pins: tenant-admin gate on GET, the propose+non-persist dry-run on GET (never
 * actuates), mode validation on PUT, run happy-path, and the self-executing
 * approval (POST /apply) success + 409 when the rec no longer applies. The loop
 * itself is unit-tested separately (lcu-autopilot.test.ts) — here the loop module
 * is mocked so the tests assert route wiring only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

const runLoopMock = vi.fn();
const loadStateMock = vi.fn();
const setModeMock = vi.fn();
const applyByIdMock = vi.fn();
vi.mock('@/lib/admin/lcu-autopilot-loop', () => ({
  runLcuAutopilotLoop: (o: any) => runLoopMock(o),
  loadAutopilotState: (t: string) => loadStateMock(t),
  setAutopilotMode: (o: any) => setModeMock(o),
  applyAutopilotRecommendationById: (o: any) => applyByIdMock(o),
}));

function req(path: string, init?: RequestInit) {
  return new NextRequest(`https://loom.test${path}`, init);
}

describe('/api/admin/autopilot', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tid-1' }, exp: Date.now() / 1000 + 3600 });
    process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid';
  });
  afterEach(() => { process.env = { ...ORIG }; vi.restoreAllMocks(); });

  it('GET 401s when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null);
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('GET returns the persisted mode + a non-persisting dry-run loop', async () => {
    loadStateMock.mockResolvedValue({ mode: 'auto' });
    runLoopMock.mockResolvedValue({ ok: true, mode: 'propose', recommendations: [], history: [], signals: { compute: [] } });
    const { GET } = await import('../route');
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // GET must run the loop in propose + non-persist so a page load never actuates
    expect(runLoopMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'propose', persist: false }));
    // and surfaces the PERSISTED mode, not the dry-run's
    expect(j.mode).toBe('auto');
  });

  it('PUT rejects an invalid mode', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(req('/api/admin/autopilot', { method: 'PUT', body: JSON.stringify({ mode: 'nonsense' }) }));
    expect(res.status).toBe(400);
    expect(setModeMock).not.toHaveBeenCalled();
  });

  it('PUT sets a valid mode', async () => {
    setModeMock.mockResolvedValue({ mode: 'auto' });
    const { PUT } = await import('../route');
    const res = await PUT(req('/api/admin/autopilot', { method: 'PUT', body: JSON.stringify({ mode: 'auto' }) }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.mode).toBe('auto');
    expect(setModeMock).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }));
  });
});

describe('POST /api/admin/autopilot/run', () => {
  const ORIG = { ...process.env };
  beforeEach(() => { vi.clearAllMocks(); getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'a@c.com', tid: 't' }, exp: Date.now() / 1000 + 3600 }); process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid'; });
  afterEach(() => { process.env = { ...ORIG }; });

  it('runs the loop and persists', async () => {
    runLoopMock.mockResolvedValue({ ok: true, mode: 'auto', actuated: [{ ok: true }], recommendations: [] });
    const { POST } = await import('../run/route');
    const res = await POST(req('/api/admin/autopilot/run', { method: 'POST', body: '{}' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(runLoopMock).toHaveBeenCalledWith(expect.objectContaining({ persist: true }));
  });
});

describe('POST /api/admin/autopilot/apply (self-executing on approval)', () => {
  const ORIG = { ...process.env };
  beforeEach(() => { vi.clearAllMocks(); getSessionMock.mockReturnValue({ claims: { oid: 'admin-oid', upn: 'a@c.com', tid: 't' }, exp: Date.now() / 1000 + 3600 }); process.env.LOOM_TENANT_ADMIN_OID = 'admin-oid'; });
  afterEach(() => { process.env = { ...ORIG }; });

  it('400s without a recommendationId', async () => {
    const { POST } = await import('../apply/route');
    const res = await POST(req('/api/admin/autopilot/apply', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
  });

  it('applies an approved recommendation for real', async () => {
    applyByIdMock.mockResolvedValue({ ok: true, receipt: { ok: true, backend: 'ARM POST .../pause' } });
    const { POST } = await import('../apply/route');
    const res = await POST(req('/api/admin/autopilot/apply', { method: 'POST', body: JSON.stringify({ recommendationId: 'pause-idle:warehouse:loompool' }) }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.receipt.backend).toContain('pause');
  });

  it('409s when the recommendation no longer applies', async () => {
    applyByIdMock.mockResolvedValue({ ok: false, error: 'recommendation no longer applies (state changed or cooled down)' });
    const { POST } = await import('../apply/route');
    const res = await POST(req('/api/admin/autopilot/apply', { method: 'POST', body: JSON.stringify({ recommendationId: 'x' }) }));
    expect(res.status).toBe(409);
  });
});
