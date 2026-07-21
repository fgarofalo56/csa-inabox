/**
 * WS-7 — /api/admin/model-fabric route tests.
 *
 * Asserts (1) GET runs the loop in a NON-actuating propose+dry-run and returns
 * the snapshot, (2) PUT validates + sets the approval mode, (3) the run route
 * threads the requested mode through to the loop. The loop itself is mocked —
 * its behavior is covered by lib/admin/__tests__/model-fabric-loop.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: vi.fn(() => null),
  enforceCapability: vi.fn(async () => null),
}));

const runModelFabricLoop = vi.fn(async (opts: any) => ({
  ok: true, mode: opts.mode || 'propose', ranAt: '2026-07-20T00:00:00Z',
  sloBreaching: false, endpoints: [], tier: { reasoningConfigured: false, changed: false, actuated: false, reason: 'held', candidates: [] }, history: [],
}));
const setFabricMode = vi.fn(async (opts: any) => ({ mode: opts.mode }));
const loadFabricState = vi.fn(async () => ({ id: 't', tenantId: 't', mode: 'propose', lastActuatedAt: {}, history: [], updatedAt: '', updatedBy: '' }));
vi.mock('@/lib/admin/model-fabric-loop', () => ({
  runModelFabricLoop: (...a: any[]) => runModelFabricLoop(...a),
  setFabricMode: (...a: any[]) => setFabricMode(...a),
  loadFabricState: (...a: any[]) => loadFabricState(...a),
}));

function put(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/model-fabric', {
    method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}
function runReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/model-fabric/run', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

describe('/api/admin/model-fabric', () => {
  beforeEach(() => { runModelFabricLoop.mockClear(); setFabricMode.mockClear(); loadFabricState.mockClear(); });

  it('GET returns the snapshot from a NON-actuating dry run (propose + persist:false)', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(runModelFabricLoop).toHaveBeenCalledTimes(1);
    const opts = runModelFabricLoop.mock.calls[0][0];
    expect(opts.mode).toBe('propose');
    expect(opts.persist).toBe(false);
  });

  it('PUT rejects an invalid mode', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(put({ mode: 'sideways' }));
    expect(res.status).toBe(400);
    expect(setFabricMode).not.toHaveBeenCalled();
  });

  it('PUT sets a valid approval mode', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(put({ mode: 'auto' }));
    expect(res.status).toBe(200);
    expect(setFabricMode).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto' }));
  });

  it('run route threads the requested mode + persists', async () => {
    const { POST } = await import('../run/route');
    const res = await POST(runReq({ mode: 'auto' }));
    expect(res.status).toBe(200);
    const opts = runModelFabricLoop.mock.calls[0][0];
    expect(opts.mode).toBe('auto');
    expect(opts.persist).toBe(true);
  });

  it('run route 400s an invalid mode', async () => {
    const { POST } = await import('../run/route');
    const res = await POST(runReq({ mode: 'nope' }));
    expect(res.status).toBe(400);
  });
});
