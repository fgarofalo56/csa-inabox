/**
 * /api/admin/estate/autopause — cookie-admin GET/PUT of the idle auto-pause setting.
 * Uses the REAL withTenantAdmin (only the session + the admin verdict are mocked),
 * like estate-pause-routes.test.ts, so deleting the admin gate turns these red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
const requireTenantAdmin = vi.fn(() => null as unknown);
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: () => getSession(),
}));
vi.mock('@/lib/auth/feature-gate', () => ({
  requireTenantAdmin: (...a: unknown[]) => requireTenantAdmin(...(a as [])),
  enforceCapability: vi.fn(async () => null),
}));

const auditCreate = vi.fn(async (doc: unknown) => ({ resource: doc }));
const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
const read = vi.fn(async () => ({ resource: undefined as unknown }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(async () => ({ items: { create: auditCreate } })),
  maintenanceJobsContainer: vi.fn(async () => ({ items: { upsert }, item: () => ({ read }) })),
}));
const emitAuditEvent = vi.fn();
vi.mock('@/lib/admin/audit-stream', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));

const ADMIN = { claims: { oid: 'admin-oid', upn: 'admin@contoso.com', tid: 'tenant-1' }, exp: 9_999_999_999 };
const ctx = { params: Promise.resolve({}) } as never;
const put = (body: unknown) => ({ json: async () => body }) as never;
const get = () => ({}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(ADMIN);
  requireTenantAdmin.mockReturnValue(null);
  read.mockResolvedValue({ resource: undefined });
});

describe('authorization', () => {
  it('a NON-admin PUT is refused 403 and nothing is written (breaks if the wrapper gate is deleted: 200 + upsert)', async () => {
    requireTenantAdmin.mockReturnValue(new Response('{}', { status: 403 }));
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 4 }), ctx);
    expect(res.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('an unauthenticated GET is 401', async () => {
    getSession.mockReturnValue(null);
    const { GET } = await import('../autopause/route');
    expect((await GET(get(), ctx)).status).toBe(401);
  });
});

describe('GET', () => {
  it('first open: the armed default, source "default", no error', async () => {
    const { GET } = await import('../autopause/route');
    const j = await (await GET(get(), ctx)).json();
    expect(j.ok).toBe(true);
    expect(j.autoPause).toMatchObject({ enabled: true, idleHours: 2, source: 'default' });
  });
});

describe('PUT', () => {
  it('a valid body is stored in the caller tenant partition and audited with before and after', async () => {
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: false, idleHours: 6 }), ctx);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1', enabled: false, idleHours: 6 }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'estate-autopause.updated',
      before: { enabled: true, idleHours: 2, containerApps: { enabled: true, exempt: [] }, source: 'default' },
      after: { enabled: false, idleHours: 6, containerApps: { enabled: true, exempt: [] } },
    }));
    expect(emitAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform.estate-autopause', outcome: 'success' }));
  });

  const STORED = {
    kind: 'estate-autopause', enabled: true, idleHours: 2, updatedAt: 'T', updatedBy: 'u',
    containerApps: { enabled: false, exempt: ['loom-udf-runtime'] },
  };

  it('a PUT that OMITS containerApps (the idle-hours form, the CLI) keeps the stored opt-outs -- breaks if it resets them to the default', async () => {
    read.mockResolvedValue({ resource: STORED });
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 5 }), ctx);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      idleHours: 5, containerApps: { enabled: false, exempt: ['loom-udf-runtime'] },
    }));
  });

  it('a PUT carrying containerApps stores it and audits before AND after (the opt-out is never silent)', async () => {
    read.mockResolvedValue({ resource: STORED });
    const { PUT } = await import('../autopause/route');
    const next = { enabled: true, exempt: ['loom-dab-preview'] };
    const res = await PUT(put({ enabled: true, idleHours: 2, containerApps: next }), ctx);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ containerApps: next }));
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      before: expect.objectContaining({ containerApps: { enabled: false, exempt: ['loom-udf-runtime'] } }),
      after: expect.objectContaining({ containerApps: next }),
    }));
  });

  it('a malformed containerApps (exempt name "loom_mcp") -> 400 and NOTHING written or audited', async () => {
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 2, containerApps: { enabled: true, exempt: ['loom_mcp'] } }), ctx);
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  // Breaks if: a transient Cosmos READ failure lets an omitted-containerApps PUT write the default and erase a global opt-out (N2).
  it('PUT omitting containerApps while the stored setting is UNREADABLE -> 503, nothing written, true message', async () => {
    read.mockRejectedValue(new Error('cosmos down'));
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 3 }), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/could not be read/);
    expect(upsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  // The deliberate overwrite path (the panel's Reset to defaults) still works when the body carries the policy.
  it('PUT WITH containerApps while the stored setting is unreadable overwrites explicitly (Reset to defaults)', async () => {
    read.mockRejectedValue(new Error('cosmos down'));
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 2, containerApps: { enabled: true, exempt: [] } }), ctx);
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ containerApps: { enabled: true, exempt: [] } }));
  });

  it.each([[0], [169], [NaN], ['4']])('idleHours %s -> 400 and NOTHING written or audited', async (idleHours) => {
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours }), ctx);
    expect(res.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('a Cosmos write failure is an honest 503, not a fake success, and no audit row claims an update', async () => {
    upsert.mockRejectedValueOnce(new Error('cosmos down'));
    const { PUT } = await import('../autopause/route');
    const res = await PUT(put({ enabled: true, idleHours: 4 }), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('invalid JSON body -> 400', async () => {
    const { PUT } = await import('../autopause/route');
    const res = await PUT({ json: async () => { throw new Error('x'); } } as never, ctx);
    expect(res.status).toBe(400);
  });
});
