/**
 * BFF contract test for GET /api/data-products/my-access-requests — the Data
 * Marketplace "My data access" sub-tab.
 *
 * Guards the regression that every row was hard-coded `status:'pending'`: the
 * route must reflect the REAL lifecycle from both authoritative backends — the
 * F16 `access-request-workflow` container (open|denied|completed → pending|
 * rejected|completed, with the current tier on open requests) and the F15
 * `access-requests` container (pass-through status) — merged newest-first.
 * Cosmos containers are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  accessRequestWorkflowContainer: vi.fn(),
  accessRequestsContainer: vi.fn(),
}));

import { GET } from '../my-access-requests/route';
import { getSession } from '@/lib/auth/session';
import {
  accessRequestWorkflowContainer,
  accessRequestsContainer,
} from '@/lib/azure/cosmos-client';

const CONSUMER_OID = 'consumer-oid-222';

/** A container stub whose query() returns the given resources. */
function queryContainer(resources: any[]) {
  return { items: { query: () => ({ fetchAll: async () => ({ resources }) }) } };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/data-products/my-access-requests', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('reflects the REAL F16 workflow status (not a hard-coded pending)', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (accessRequestWorkflowContainer as any).mockResolvedValue(queryContainer([
      { id: 'w-completed', kind: 'access-request', itemType: 'data-product', assetId: 'dp-1', assetName: 'Sales Mart', permission: 'read', requestedAt: '2026-07-03T00:00:00Z', tier: 'access-provider', status: 'completed' },
      { id: 'w-denied', kind: 'access-request', itemType: 'data-product', assetId: 'dp-2', assetName: 'HR Data', permission: 'write', requestedAt: '2026-07-02T00:00:00Z', tier: 'privacy', status: 'denied' },
      { id: 'w-open', kind: 'access-request', itemType: 'data-product', assetId: 'dp-3', assetName: 'Ops Feed', permission: 'read', requestedAt: '2026-07-01T00:00:00Z', tier: 'approver', status: 'open' },
    ]));
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([]));

    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);

    const byId = Object.fromEntries(j.requests.map((r: any) => [r.id, r]));
    expect(byId['w-completed'].status).toBe('completed');
    expect(byId['w-denied'].status).toBe('rejected');
    expect(byId['w-open'].status).toBe('pending');
    // The current approval tier is surfaced only while the request is in-flight.
    expect(byId['w-open'].tier).toBe('approver');
    expect(byId['w-completed'].tier).toBeUndefined();
    // Real permission comes from the doc, not a regex over summary text.
    expect(byId['w-denied'].permission).toBe('write');
    // Not everything is 'pending' anymore.
    expect(j.requests.every((r: any) => r.status === 'pending')).toBe(false);
  });

  it('includes F15 purpose-bound requests and passes their status through', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (accessRequestWorkflowContainer as any).mockResolvedValue(queryContainer([]));
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([
      { id: 'f15-approved', dataProductId: 'dp-9', dataProductName: 'Finance', status: 'approved', createdAt: '2026-07-05T00:00:00Z' },
      { id: 'f15-completed', dataProductId: 'dp-8', dataProductName: 'Marketing', status: 'completed', createdAt: '2026-07-04T00:00:00Z' },
    ]));

    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    const byId = Object.fromEntries(j.requests.map((r: any) => [r.id, r]));
    expect(byId['f15-approved'].status).toBe('approved');
    expect(byId['f15-approved'].productId).toBe('dp-9');
    expect(byId['f15-approved'].summary).toBe('Finance');
    expect(byId['f15-completed'].status).toBe('completed');
  });

  it('merges both sources newest-first', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: CONSUMER_OID } });
    (accessRequestWorkflowContainer as any).mockResolvedValue(queryContainer([
      { id: 'wf-mid', kind: 'access-request', itemType: 'data-product', assetId: 'dp-1', assetName: 'A', permission: 'read', requestedAt: '2026-07-10T00:00:00Z', status: 'open', tier: 'manager' },
    ]));
    (accessRequestsContainer as any).mockResolvedValue(queryContainer([
      { id: 'f15-new', dataProductId: 'dp-2', dataProductName: 'B', status: 'pending', createdAt: '2026-07-20T00:00:00Z' },
      { id: 'f15-old', dataProductId: 'dp-3', dataProductName: 'C', status: 'completed', createdAt: '2026-07-01T00:00:00Z' },
    ]));

    const res = await GET();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.requests.map((r: any) => r.id)).toEqual(['f15-new', 'wf-mid', 'f15-old']);
  });
});
