/**
 * Contract tests for GET /api/items/[type]/[id]/impact — the Wave-2 W8
 * cross-catalog impact-analysis route.
 *
 *   - 401 unauthenticated
 *   - resolves an item's UC lineage key from Cosmos state, calls the REAL
 *     unified-lineage store, and returns downstream dependents grouped by kind
 *     with direct/transitive severity + counts
 *   - degraded:true (honest gate) when NO lineage source was reachable
 *
 * getUnifiedLineage + getSession + the Cosmos clients are mocked so the real
 * @azure/identity + Cosmos ESM graphs never load under vitest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: vi.fn(),
}));
vi.mock('@/lib/azure/unified-lineage', () => ({ getUnifiedLineage: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', () => ({ detectLoomCloud: vi.fn(() => 'Commercial') }));

import { GET } from '../[id]/impact/route';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { getUnifiedLineage } from '@/lib/azure/unified-lineage';

const TENANT = 'tenant-oid';

function ctx(type: string, id: string) {
  return { params: Promise.resolve({ type, id }) };
}
function req() {
  return { nextUrl: { searchParams: new URLSearchParams() } } as any;
}

/** Cosmos item + workspace fakes: item resolves + tenant owns its workspace. */
function wireCosmos(itemState: Record<string, unknown> = {}) {
  (itemsContainer as any).mockResolvedValue({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [{
            id: 'lake-1', itemType: 'lakehouse', workspaceId: 'ws-1',
            displayName: 'Gold sales', state: itemState,
          }],
        }),
      }),
    },
  });
  (workspacesContainer as any).mockResolvedValue({
    item: () => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: TENANT } }) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: TENANT } });
});

describe('GET /api/items/[type]/[id]/impact', () => {
  it('401 when unauthenticated', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req(), ctx('lakehouse', 'lake-1'));
    expect(res.status).toBe(401);
    const j = await res.json();
    expect(j.ok).toBe(false);
  });

  it('returns grouped downstream dependents from the real lineage store', async () => {
    wireCosmos({ ucFullName: 'main.sales.gold' });
    (getUnifiedLineage as any).mockResolvedValue({
      ok: true,
      focusId: 'lake-1',
      nodes: [
        { id: 'lake-1', label: 'Gold sales', type: 'lakehouse', source: 'weave', focus: true },
        { id: 'report-1', label: 'Exec report', type: 'report', source: 'weave', openHref: '/items/report/report-1' },
        { id: 'pipe-1', label: 'Nightly ETL', type: 'data-pipeline', source: 'weave' },
      ],
      edges: [
        { from: 'lake-1', to: 'report-1' },
        { from: 'lake-1', to: 'pipe-1' },
      ],
      sources: [{ source: 'weave', ok: true, nodeCount: 3 }],
    });

    const res = await GET(req(), ctx('lakehouse', 'lake-1'));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.degraded).toBe(false);
    expect(j.counts).toEqual({ total: 2, direct: 2, transitive: 0 });
    const kinds = j.groups.map((g: any) => g.kind).sort();
    expect(kinds).toEqual(['Pipeline', 'Report']);
    const report = j.dependents.find((d: any) => d.id === 'report-1');
    expect(report.severity).toBe('direct');
    expect(report.openHref).toBe('/items/report/report-1');

    // The item's UC lineage key resolved from Cosmos state was passed through.
    expect((getUnifiedLineage as any).mock.calls[0][0]).toMatchObject({
      itemId: 'lake-1', itemType: 'lakehouse', ucFullName: 'main.sales.gold',
    });
  });

  it('flags degraded when no lineage source was reachable', async () => {
    wireCosmos({});
    (getUnifiedLineage as any).mockResolvedValue({
      ok: true,
      focusId: 'lake-1',
      nodes: [],
      edges: [],
      sources: [{ source: 'weave', ok: false, gate: 'cosmos unreachable', nodeCount: 0 }],
    });
    const res = await GET(req(), ctx('lakehouse', 'lake-1'));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.degraded).toBe(true);
    expect(j.counts.total).toBe(0);
  });
});
