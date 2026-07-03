/**
 * Unit tests for rel-T18 — resolveDataProductDataAccess (the data-product
 * DATA-access gate used by the preview route). loadOwnedItem and the two Cosmos
 * access containers are mocked so the test is hermetic and exercises the gate's
 * owner / approved-consumer / stranger branches.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/app/api/items/_lib/item-crud', () => ({ loadOwnedItem: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessRequestsContainer: vi.fn(),
  accessRequestWorkflowContainer: vi.fn(),
}));

import { resolveDataProductDataAccess } from '../_lib/access-gate';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { accessRequestsContainer, accessRequestWorkflowContainer } from '@/lib/azure/cosmos-client';

const SESSION = { claims: { oid: 'consumer-oid' } } as any;

/** Build a mock container whose query().fetchAll() resolves to `rows`. */
function containerReturning(rows: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources: rows }) }) } };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no approved requests in either container.
  (accessRequestsContainer as any).mockResolvedValue(containerReturning([]));
  (accessRequestWorkflowContainer as any).mockResolvedValue(containerReturning([]));
});

describe('resolveDataProductDataAccess (rel-T18)', () => {
  it('allows the owner / shared ACL member', async () => {
    (loadOwnedItem as any).mockResolvedValue({ id: 'dp1', itemType: 'data-product' });
    const d = await resolveDataProductDataAccess(SESSION, 'dp1');
    expect(d).toEqual({ allowed: true, via: 'owner' });
    // owner short-circuits — no access-request lookups needed
    expect(accessRequestsContainer).not.toHaveBeenCalled();
  });

  it('allows a consumer with an approved F15 access-request', async () => {
    (loadOwnedItem as any).mockResolvedValue(null);
    (accessRequestsContainer as any).mockResolvedValue(containerReturning([{ id: 'req1' }]));
    const d = await resolveDataProductDataAccess(SESSION, 'dp1');
    expect(d).toEqual({ allowed: true, via: 'access-request' });
  });

  it('allows a consumer with a completed F16 workflow request', async () => {
    (loadOwnedItem as any).mockResolvedValue(null);
    (accessRequestWorkflowContainer as any).mockResolvedValue(containerReturning([{ id: 'wf1' }]));
    const d = await resolveDataProductDataAccess(SESSION, 'dp1');
    expect(d).toEqual({ allowed: true, via: 'access-request' });
  });

  it('denies a stranger with no ownership and no approved request', async () => {
    (loadOwnedItem as any).mockResolvedValue(null);
    const d = await resolveDataProductDataAccess(SESSION, 'dp1');
    expect(d).toEqual({ allowed: false });
  });

  it('treats an unprovisioned access container as "no grant" (never throws)', async () => {
    (loadOwnedItem as any).mockResolvedValue(null);
    (accessRequestsContainer as any).mockRejectedValue(new Error('container missing'));
    (accessRequestWorkflowContainer as any).mockRejectedValue(new Error('container missing'));
    const d = await resolveDataProductDataAccess(SESSION, 'dp1');
    expect(d).toEqual({ allowed: false });
  });
});
