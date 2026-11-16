/**
 * DELETE /api/workspaces/[id]/items/[itemId] - a health-tenant item must destroy
 * its control-plane tenant BEFORE the Cosmos item goes (otherwise the Event Hub,
 * storage, identity and Key Vault keys leak and keep billing).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
  foldersContainer: vi.fn(),
}));
vi.mock('@/lib/azure/loom-search', () => ({ deleteLoomDoc: vi.fn(), docForItem: vi.fn(), upsertLoomDoc: vi.fn() }));
vi.mock('@/lib/azure/lineage-gc', () => ({ cleanupItemMetadata: vi.fn() }));
vi.mock('@/app/api/health/tenants/_lib/cp-client', async (orig) => {
  const actual = await orig<typeof import('@/app/api/health/tenants/_lib/cp-client')>();
  return { ...actual, cp: { ...actual.cp, submitJob: vi.fn() } };
});

import { DELETE } from '../route';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { cp, CpError, CpNotConfiguredError } from '@/app/api/health/tenants/_lib/cp-client';

const submitJob = cp.submitJob as unknown as ReturnType<typeof vi.fn>;
const ctx = { params: Promise.resolve({ id: 'ws-1', itemId: 'it-1' }) };
const del = vi.fn();

function arrange(item: Record<string, unknown>) {
  del.mockReset().mockResolvedValue({});
  (workspacesContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: 'oid-1' } }) }),
  });
  (itemsContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'it-1', workspaceId: 'ws-1', ...item } }), delete: del }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  });
}
const bound = { itemType: 'health-tenant', state: { healthTenant: { tenantId: 'acme-clinic', stampId: 's1', status: 'bound' } } };

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: 'oid-1' } });
});

describe('DELETE item: health-tenant teardown', () => {
  it('submits tenant.destroy for the bound tenantId, then deletes the item, and returns the job id', async () => {
    arrange(bound);
    submitJob.mockResolvedValue({ id: 'job-9' });
    const res = await DELETE({} as any, ctx);
    expect(submitJob).toHaveBeenCalledTimes(1);
    // Fails if the destroy call is removed, targets another kind/tenant, or confirm differs from tenantId.
    expect(submitJob).toHaveBeenCalledWith({
      kind: 'tenant.destroy',
      subjectType: 'tenant',
      subjectId: 'acme-clinic',
      idempotencyKey: 'destroy-it-1',
      input: { confirmTenantId: 'acme-clinic' },
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(submitJob.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, destroyJobId: 'job-9' });
  });

  it('control-plane error -> item NOT deleted, 502 ok:false naming the real cause', async () => {
    arrange(bound);
    submitJob.mockRejectedValue(new CpError(500, 'cp_internal', 'boom'));
    const res = await DELETE({} as any, ctx);
    expect(del).not.toHaveBeenCalled();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('cp_internal: boom');
    expect(body.error).toContain('NOT deleted');
  });

  it('control plane not configured -> item NOT deleted, 503 naming the missing env', async () => {
    arrange(bound);
    submitJob.mockRejectedValue(new CpNotConfiguredError(['LOOM_HEALTH_CP_URL']));
    const res = await DELETE({} as any, ctx);
    expect(del).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('LOOM_HEALTH_CP_URL');
  });

  it('health-tenant with no binding -> no control-plane call, item deleted', async () => {
    arrange({ itemType: 'health-tenant', state: {} });
    const res = await DELETE({} as any, ctx);
    expect(submitJob).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('non-health item (even carrying a healthTenant-shaped state) -> no control-plane call, item deleted', async () => {
    arrange({ itemType: 'lakehouse', state: bound.state });
    const res = await DELETE({} as any, ctx);
    expect(submitJob).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});
