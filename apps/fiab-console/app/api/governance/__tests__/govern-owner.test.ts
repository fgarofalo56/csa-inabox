/**
 * Contract tests for GET /api/governance/govern/owner (F3 data-owner view).
 *
 *   1. unauthenticated → 401
 *   2. cache fast-path → serves posture-aggregates doc verbatim
 *   3. live compute    → correct coverage math + owner-scoped action lists
 *   4. cross-owner isolation → the item query ALWAYS binds @upn to the session
 *      UPN (never a caller-supplied value); cache read is a point-read on the
 *      session OID partition. No `?owner=` path exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  workspacesContainer: vi.fn(),
  itemsContainer: vi.fn(),
  postureAggregatesContainer: vi.fn(),
  recommendedActionsContainer: vi.fn(),
}));

import { GET } from '../govern/owner/route';
import { getSession } from '@/lib/auth/session';
import {
  workspacesContainer,
  itemsContainer,
  postureAggregatesContainer,
  recommendedActionsContainer,
} from '@/lib/azure/cosmos-client';

const SESSION = { claims: { oid: 'owner-oid-1', upn: 'alice@contoso.com', name: 'Alice' } };

function fetchAll(resources: any[]) {
  return { fetchAll: vi.fn().mockResolvedValue({ resources }) };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('GET /api/governance/govern/owner', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('serves the cached posture-aggregates doc on the fast path', async () => {
    (getSession as any).mockReturnValue(SESSION);
    const pointRead = vi.fn();
    // posture-aggregates: cached
    pointRead.mockResolvedValueOnce({
      resource: {
        id: 'owner-oid-1', ownerId: 'owner-oid-1', totalItems: 4,
        labelCoveragePct: 50, descriptionCoveragePct: 75, endorsementCoveragePct: 25,
        computedAt: '2026-06-07T00:00:00Z',
      },
    });
    // recommended-actions: cached
    pointRead.mockResolvedValueOnce({ resource: { unlabeled: [{ id: 'i1' }], undescribed: [], unendorsed: [] } });
    (postureAggregatesContainer as any).mockResolvedValue({ item: () => ({ read: () => pointRead() }) });
    (recommendedActionsContainer as any).mockResolvedValue({ item: () => ({ read: () => pointRead() }) });

    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.source).toBe('cache');
    expect(j.kpis.totalItems).toBe(4);
    expect(j.kpis.labelCoveragePct).toBe(50);
    expect(j.unlabeled).toHaveLength(1);
    // cache point-read is keyed on the session OID, not any caller input
    expect(j.owner.upn).toBe('alice@contoso.com');
  });

  it('computes live coverage + binds @upn to the session UPN (no cross-owner leakage)', async () => {
    (getSession as any).mockReturnValue(SESSION);

    // No cache yet → both point reads reject.
    const reject = () => ({ read: vi.fn().mockRejectedValue(new Error('not found')) });
    const aggUpsert = vi.fn().mockResolvedValue({});
    const recUpsert = vi.fn().mockResolvedValue({});
    (postureAggregatesContainer as any).mockResolvedValue({ item: () => reject(), items: { upsert: aggUpsert } });
    (recommendedActionsContainer as any).mockResolvedValue({ item: () => reject(), items: { upsert: recUpsert } });

    (workspacesContainer as any).mockResolvedValue({
      items: { query: vi.fn().mockReturnValue(fetchAll([{ id: 'ws1' }])) },
    });

    let capturedItemQuery: any = null;
    (itemsContainer as any).mockResolvedValue({
      items: {
        query: vi.fn().mockImplementation((spec: any) => {
          capturedItemQuery = spec;
          return fetchAll([
            { id: 'a', itemType: 'lakehouse', displayName: 'Lake A', state: { sensitivityLabel: 'Confidential', description: 'd', endorsement: 'Certified' } },
            { id: 'b', itemType: 'warehouse', displayName: 'WH B', state: {} },
          ]);
        }),
      },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.source).toBe('live');
    // 1 of 2 labeled/described/endorsed → 50%
    expect(j.kpis.totalItems).toBe(2);
    expect(j.kpis.labelCoveragePct).toBe(50);
    expect(j.kpis.descriptionCoveragePct).toBe(50);
    expect(j.kpis.endorsementCoveragePct).toBe(50);
    // item 'b' is missing everything → appears in each action list
    expect(j.unlabeled.map((x: any) => x.id)).toEqual(['b']);
    expect(j.undescribed.map((x: any) => x.id)).toEqual(['b']);
    expect(j.unendorsed.map((x: any) => x.id)).toEqual(['b']);
    // ISOLATION: the @upn parameter is the session UPN, full stop.
    const upnParam = capturedItemQuery.parameters.find((p: any) => p.name === '@upn');
    expect(upnParam.value).toBe('alice@contoso.com');
    // cache warmed under the session OID partition only
    expect(aggUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner-oid-1', ownerId: 'owner-oid-1' }));
  });
});
