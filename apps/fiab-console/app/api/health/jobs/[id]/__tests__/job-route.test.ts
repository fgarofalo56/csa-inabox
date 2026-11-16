/**
 * GET /api/health/jobs/[id] - authorization and error-truth contract.
 * The REAL health.tenant-admin gate runs; only the grants store and the control-plane client are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const grants = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  featurePermissionsContainer: async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: grants.rows }) }) },
  }),
}));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
  ChainedTokenCredential: class {},
}));
vi.mock('@/lib/azure/aca-managed-identity', () => ({ AcaManagedIdentityCredential: class {} }));
vi.mock('@/lib/auth/session', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/session')>()), getSession: vi.fn() }));
vi.mock('@/app/api/health/tenants/_lib/cp-client', async (orig) => {
  const actual = await orig<typeof import('@/app/api/health/tenants/_lib/cp-client')>();
  return { ...actual, cp: { ...actual.cp, getJob: vi.fn() } };
});

import { getSession } from '@/lib/auth/session';
import { cp, CpError } from '@/app/api/health/tenants/_lib/cp-client';
import { GET } from '../route';

const getJob = cp.getJob as unknown as ReturnType<typeof vi.fn>;
const SESSION = { claims: { oid: 'oid-1', tid: 'tid-1', upn: 'a@b.c', groups: [] } };
const req = () => ({ nextUrl: { pathname: '/api/health/jobs/job-9' } }) as any;
const ctx = { params: Promise.resolve({ id: 'job-9' }) } as any;

beforeEach(() => {
  vi.mocked(getSession).mockReturnValue(SESSION as any);
  grants.rows = [{ capabilityId: 'health.tenant-admin', principalId: 'oid-1', role: 'Reader', tenantId: 'tid-1' }];
});
afterEach(() => { vi.clearAllMocks(); });

describe('GET /api/health/jobs/[id]', () => {
  it('refuses a caller with no health grant, and never asks the control plane', async () => {
    grants.rows = [];
    const res = await GET(req(), ctx);
    // Dropping the gate makes this 200 and getJob runs.
    expect(res.status).toBe(403);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('returns the job with its receipts verbatim for a Reader', async () => {
    const job = { id: 'job-9', kind: 'tenant.destroy', state: 'succeeded', receipts: [{ at: 't', step: 'resource.deleted', detail: 'kv id=/subscriptions/x' }] };
    getJob.mockResolvedValue(job);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    // Breaks if the route drops receipts or wraps them differently (the G1 spec reads body.job.receipts).
    expect(await res.json()).toEqual({ ok: true, job });
    expect(getJob).toHaveBeenCalledWith('job-9');
  });

  it('a control-plane 404 is a 404, any other control-plane failure is a 502 carrying its code', async () => {
    getJob.mockRejectedValueOnce(new CpError(404, 'not_found', 'no such job'));
    expect((await GET(req(), ctx)).status).toBe(404);
    getJob.mockRejectedValueOnce(new CpError(500, 'cp_internal', 'boom'));
    const res = await GET(req(), ctx);
    // Mapping everything to 404 would hide an outage as "job gone".
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('cp_internal');
  });
});
