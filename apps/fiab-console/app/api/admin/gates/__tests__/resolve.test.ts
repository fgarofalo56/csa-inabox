/**
 * POST /api/admin/gates/[id]/resolve — validation + write-path tests.
 *
 * Asserts the Fix-it apply is (1) capability-gated, (2) scoped to the gate's
 * own settings (no side-channel env writes), and (3) delegates to the ONE
 * shared env-apply engine with the gate.resolve audit action — never a second
 * write path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'admin-1', upn: 'admin@contoso.com', tid: 'tenant-1' },
    exp: Date.now() / 1000 + 3600,
  })),
}));

const enforceCapability = vi.fn(async () => null);
vi.mock('@/lib/auth/feature-gate', () => ({
  enforceCapability: (...a: any[]) => enforceCapability(...a),
}));

vi.mock('@/lib/auth/pdp/enforce', () => ({
  pdpCheck: vi.fn(async () => null),
}));

const applyEnvChanges = vi.fn(async () => ({
  ok: true, status: 200, changedCount: 1, changed: ['LOOM_EVENTHUB_NAMESPACE'],
  secretsChanged: [], rejected: [], revision: 'Succeeded', platform: 'aca',
  updatedAt: new Date().toISOString(), driftWarning: 'roll pending',
  sync: { cliScript: 'az …', bicepEnvSnippet: '// …' },
}));
vi.mock('@/lib/admin/env-apply', () => ({
  applyEnvChanges: (...a: any[]) => applyEnvChanges(...a),
}));

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/gates/svc-eventhubs/resolve', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/admin/gates/[id]/resolve', () => {
  beforeEach(() => {
    enforceCapability.mockClear();
    applyEnvChanges.mockClear();
  });

  it('404s an unknown gate id', async () => {
    const { POST } = await import('../[id]/resolve/route');
    const res = await POST(req({ values: { X: '1' } }), ctx('no-such-gate'));
    expect(res.status).toBe(404);
  });

  it('400s when values is missing', async () => {
    const { POST } = await import('../[id]/resolve/route');
    const res = await POST(req({}), ctx('svc-eventhubs'));
    expect(res.status).toBe(400);
    expect(applyEnvChanges).not.toHaveBeenCalled();
  });

  it('rejects env keys outside the gate’s own settings (no side-channel writes)', async () => {
    const { POST } = await import('../[id]/resolve/route');
    const res = await POST(
      req({ values: { LOOM_AOAI_ENDPOINT: 'https://x' } }),
      ctx('svc-eventhubs'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('LOOM_AOAI_ENDPOINT');
    expect(applyEnvChanges).not.toHaveBeenCalled();
  });

  it('applies in-scope values through the shared env-apply engine with the gate.resolve action', async () => {
    const { POST } = await import('../[id]/resolve/route');
    const res = await POST(
      req({ values: { LOOM_EVENTHUB_NAMESPACE: 'loom-evhns' } }),
      ctx('svc-eventhubs'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.gateId).toBe('svc-eventhubs');
    expect(body.changed).toEqual(['LOOM_EVENTHUB_NAMESPACE']);
    // Honest latency: env not yet rolled → not resolved instantly.
    expect(body.resolvedNow).toBe(false);
    expect(body.driftWarning).toBeTruthy();
    expect(applyEnvChanges).toHaveBeenCalledTimes(1);
    const call = applyEnvChanges.mock.calls[0][0];
    expect(call.action).toBe('gate.resolve');
    expect(call.auditDetail).toEqual({ gateId: 'svc-eventhubs' });
    expect(call.values).toEqual({ LOOM_EVENTHUB_NAMESPACE: 'loom-evhns' });
    // Capability-gated with the SAME capability as env-config.
    expect(enforceCapability.mock.calls[0][1]).toBe('admin.env-config');
    expect(enforceCapability.mock.calls[0][2]).toBe('Admin');
  });

  it('returns the engine error status when the write path is unavailable', async () => {
    applyEnvChanges.mockResolvedValueOnce({
      ok: false, status: 503, changedCount: 0, changed: [], secretsChanged: [],
      rejected: [], platform: 'aca', error: 'Container Apps write path not configured',
    } as any);
    const { POST } = await import('../[id]/resolve/route');
    const res = await POST(
      req({ values: { LOOM_EVENTHUB_NAMESPACE: 'x' } }),
      ctx('svc-eventhubs'),
    );
    expect(res.status).toBe(503);
  });
});
