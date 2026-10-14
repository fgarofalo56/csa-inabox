/**
 * withSession records HUMAN activity for idle auto-pause (PRP-02 #4876), at the
 * seam. Each `it` names the input that breaks it. Real withSession and real
 * recordHumanActivity; only the session and Cosmos are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
vi.mock('@/lib/auth/feature-gate', () => ({ requireTenantAdmin: vi.fn(), enforceCapability: vi.fn() }));
vi.mock('@/lib/auth/dlz-gate', () => ({ denyIfNoDlzAccess: vi.fn() }));
vi.mock('@/lib/access/approval-authority', () => ({ resolveApprovalAuthority: vi.fn(), approvalAuthorityDenied: vi.fn() }));
vi.mock('@/lib/gates/registry', () => ({ getGate: vi.fn(), gateStatus: vi.fn() }));

const upsert = vi.fn(async (d: unknown) => ({ resource: d }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  maintenanceJobsContainer: vi.fn(async () => ({ items: { upsert } })),
}));

import { withSession } from '../route-toolkit';
import { apiOk } from '../respond';
import { __resetEstateActivityThrottleForTest } from '@/lib/estate/estate-activity';

const human = { claims: { tid: 'tenant-1', oid: 'u1' }, exp: 9_999_999_999 };
const req = (path: string) => ({ method: 'GET', nextUrl: new URL(`http://x${path}`) }) as never;
const ctx = { params: Promise.resolve({}) } as never;
const handler = withSession(async () => apiOk({ hello: 'world' }));
const drain = () => new Promise<void>((r) => setTimeout(r, 40));

beforeEach(() => {
  vi.clearAllMocks();
  __resetEstateActivityThrottleForTest();
  getSession.mockReturnValue(human);
});

describe('withSession activity seam', () => {
  it('a human GET writes exactly once; a second inside the window writes none (breaks if unwired: 0, if unthrottled: 2)', async () => {
    expect((await handler(req('/api/items/lakehouse/1'), ctx)).status).toBe(200);
    await handler(req('/api/items/lakehouse/2'), ctx);
    await drain();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({ id: 'estate-activity:current', tenantId: 'tenant-1' });
  });

  it('a PAT session writes none (breaks if `pat` is ignored: 1), and the handler still runs', async () => {
    getSession.mockReturnValue({ ...human, pat: { tokenId: 't', scope: 'read-only' } });
    const res = await handler(req('/api/items/lakehouse/1'), ctx);
    await drain();
    expect(res.status).toBe(200);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a rejecting Cosmos write changes neither status nor body (positive control: 200 + payload)', async () => {
    upsert.mockRejectedValueOnce(new Error('cosmos down'));
    const res = await handler(req('/api/items/lakehouse/1'), ctx);
    await drain();
    expect(upsert).toHaveBeenCalledTimes(1); // the write really was attempted and rejected
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hello: 'world' });
  });

  it.each(['/api/estate/power', '/api/admin/estate/state', '/api/health', '/api/auth/refresh', '/api/internal/x'])(
    '%s does not count as activity (breaks if its exclusion is removed: 1 write)',
    async (path) => {
      await handler(req(path), ctx);
      await drain();
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it('an unauthenticated request records nothing and is still 401', async () => {
    getSession.mockReturnValue(null);
    const res = await handler(req('/api/items/lakehouse/1'), ctx);
    await drain();
    expect(res.status).toBe(401);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('a request with no nextUrl does not throw into the request', async () => {
    const res = await handler({ method: 'GET' } as never, ctx);
    expect(res.status).toBe(200);
  });
});
