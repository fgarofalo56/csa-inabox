/**
 * GET /api/estate/paused - uses the REAL withSession; only the session, the admin
 * verdict and the snapshot read are mocked. Each `it` names the input that breaks it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', async () => ({
  ...(await vi.importActual<typeof import('@/lib/auth/session')>('@/lib/auth/session')),
  getSession: () => getSession(),
}));
const isTenantAdmin = vi.fn(() => false);
vi.mock('@/lib/auth/feature-gate', () => ({ isTenantAdmin: (...a: unknown[]) => isTenantAdmin(...(a as [])) }));
const loadPauseSnapshot = vi.fn();
vi.mock('@/lib/estate/pause-orchestrator', () => ({ loadPauseSnapshot: (...a: unknown[]) => loadPauseSnapshot(...a) }));

const USER = { claims: { oid: 'u-oid', upn: 'user@contoso.com', tid: 'tenant-1' }, exp: 9_999_999_999 };
const ctx = { params: Promise.resolve({}) } as never;
const req = () => ({ nextUrl: { pathname: '/api/estate/paused' } }) as never;

const entry = (name: string) => ({
  resourceId: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/${name}`,
  resourceType: 'microsoft.app/containerapps', name, prePausePowerState: 'Online',
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  state: 'PAUSED', resources: [entry('loom-udf-runtime'), entry('loom-dab-preview')],
  createdAt: '2026-10-22T01:00:00.000Z', pausedAt: '2026-10-22T01:04:00.000Z', createdBy: 'admin@contoso.com', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReturnValue(USER);
  isTenantAdmin.mockReturnValue(false);
  loadPauseSnapshot.mockResolvedValue(null);
});

describe('GET /api/estate/paused', () => {
  // Breaks if: the route is anonymous.
  it('unauthenticated -> 401 and the snapshot is never read', async () => {
    getSession.mockReturnValue(null);
    const { GET } = await import('../route');
    expect((await GET(req(), ctx)).status).toBe(401);
    expect(loadPauseSnapshot).not.toHaveBeenCalled();
  });

  // Breaks if: a never-paused estate reports paused.
  it('no snapshot -> { paused:false }', async () => {
    const { GET } = await import('../route');
    const j = await (await GET(req(), ctx)).json();
    expect(j).toMatchObject({ ok: true, paused: false, canResume: false });
  });

  // Breaks if: the count/names are not taken from the snapshot, or canResume is granted to a non-admin.
  it('PAUSED snapshot, non-admin -> count 2, names, canResume false, identity withheld', async () => {
    loadPauseSnapshot.mockResolvedValue(snapshot());
    const { GET } = await import('../route');
    const j = await (await GET(req(), ctx)).json();
    expect(j).toMatchObject({ paused: true, state: 'PAUSED', count: 2, names: ['loom-udf-runtime', 'loom-dab-preview'], canResume: false, pausedBy: null, pausedByKind: 'person' });
    expect(JSON.stringify(j)).not.toContain('admin@contoso.com');
    expect(JSON.stringify(j)).not.toContain('/subscriptions/');
  });

  // Breaks if: admin standing is not consulted -> the Resume button never appears (or appears for everyone).
  it('admin -> canResume true and the pausing identity is shown', async () => {
    isTenantAdmin.mockReturnValue(true);
    loadPauseSnapshot.mockResolvedValue(snapshot());
    const { GET } = await import('../route');
    const j = await (await GET(req(), ctx)).json();
    expect(j).toMatchObject({ paused: true, canResume: true, pausedBy: 'admin@contoso.com' });
  });

  // Breaks if: the snapshot is read under the wrong partition (oid instead of tenant id).
  it('reads the snapshot in the tenant partition (tid), the key the pause wrote it under', async () => {
    const { GET } = await import('../route');
    await GET(req(), ctx);
    expect(loadPauseSnapshot).toHaveBeenCalledWith('tenant-1');
  });

  // Breaks if: a Cosmos failure is reported as "nothing is paused" (R7: do not assert what was not established).
  it('a snapshot read failure is a 503, NOT { paused:false }', async () => {
    loadPauseSnapshot.mockRejectedValue(new Error('cosmos down'));
    const { GET } = await import('../route');
    const res = await GET(req(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).paused).toBeUndefined();
  });
});
