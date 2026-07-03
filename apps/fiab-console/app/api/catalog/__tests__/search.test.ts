/**
 * Unit tests for /api/catalog/search BFF route.
 *
 * We stub the three client modules and assert:
 *   1. unauthenticated → 401
 *   2. all three sources called when no source filter is passed
 *   3. source filter restricts the calls
 *   4. per-source failures surface as { ok: false, error, hint } inside `sources`
 *      WITHOUT failing the overall response (partial-success is core to no-vaporware)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/azure/purview-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/purview-client');
  return { ...actual, searchDataMapWithFacets: vi.fn() };
});
vi.mock('@/lib/azure/unity-catalog-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/unity-catalog-client');
  return { ...actual, searchUnity: vi.fn() };
});
vi.mock('@/lib/azure/onelake-catalog-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/onelake-catalog-client');
  return { ...actual, searchOneLake: vi.fn() };
});

// The "onelake" source is Azure-native by DEFAULT (no-fabric-dependency rule):
// it lists the caller's OWN Loom workspace items from Cosmos via item-crud, and
// only falls through to real Fabric OneLake when LOOM_LAKEHOUSE_BACKEND=fabric.
// The route lazily imports this module, so stub it for the default path.
const listAllOwnedItemsMock = vi.fn();
const listOwnedWorkspacesMock = vi.fn();
vi.mock('../../items/_lib/item-crud', () => ({
  listAllOwnedItems: (...a: any[]) => listAllOwnedItemsMock(...a),
  listOwnedWorkspaces: (...a: any[]) => listOwnedWorkspacesMock(...a),
}));

import { GET } from '../search/route';
import { getSession } from '@/lib/auth/session';
import { searchDataMapWithFacets, PurviewNotConfiguredError } from '@/lib/azure/purview-client';

// Empty facet rail returned by the mocked faceted search (the route reads
// `.facets` off the result; these tests assert hits/sources, not the rail).
const EMPTY_FACETS = { classifications: [], terms: [] };
import { searchUnity } from '@/lib/azure/unity-catalog-client';
import { searchOneLake } from '@/lib/azure/onelake-catalog-client';

function req(url: string) {
  // NextRequest's `nextUrl` is just a URL with searchParams; shimming is fine
  // because the route only reads `req.nextUrl.searchParams`.
  const u = new URL(url);
  return { nextUrl: u, url } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('GET /api/catalog/search', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await GET(req('http://x/api/catalog/search?q=foo') as any);
    expect(res.status).toBe(401);
  });

  it('calls all three back-ends by default', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (searchDataMapWithFacets as any).mockResolvedValue({ hits: [{ id: 'p1', name: 'p', entityType: 'Table' }], facets: EMPTY_FACETS });
    (searchUnity as any).mockResolvedValue([{ source: 'unity-catalog', workspace_hostname: 'h.x', type: 'table', full_name: 'c.s.t', name: 't' }]);
    // Default "onelake" source = the caller's own Loom items from Cosmos.
    listAllOwnedItemsMock.mockResolvedValue([
      { id: 'i', displayName: 'foo-lakehouse', itemType: 'lakehouse', workspaceId: 'w', updatedAt: '2026-05-01T00:00:00Z' },
    ]);
    listOwnedWorkspacesMock.mockResolvedValue([{ id: 'w', name: 'W' }]);

    const res = await GET(req('http://x/api/catalog/search?q=foo') as any);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.hits.length).toBe(3);
    expect(j.sources).toHaveProperty('purview');
    expect(j.sources).toHaveProperty('unity-catalog');
    expect(j.sources).toHaveProperty('onelake');
  });

  it('respects ?source filter', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (searchDataMapWithFacets as any).mockResolvedValue({ hits: [], facets: EMPTY_FACETS });
    (searchUnity as any).mockResolvedValue([{ source: 'unity-catalog', workspace_hostname: 'h.x', type: 'table', full_name: 'c.s.t', name: 't' }]);
    (searchOneLake as any).mockResolvedValue([]);

    const res = await GET(req('http://x/api/catalog/search?q=foo&source=unity-catalog') as any);
    const j = await res.json();
    expect(j.hits).toHaveLength(1);
    expect(searchDataMapWithFacets).not.toHaveBeenCalled();
    expect(searchOneLake).not.toHaveBeenCalled();
  });

  it('surfaces NotConfigured hint without failing the overall response', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (searchDataMapWithFacets as any).mockRejectedValue(new PurviewNotConfiguredError({
      missingEnvVar: 'LOOM_PURVIEW_ACCOUNT',
      bicepModule: 'platform/...', bicepStatus: 's', rolesRequired: [], followUp: 'set env',
    }));
    (searchUnity as any).mockResolvedValue([]);
    (searchOneLake as any).mockResolvedValue([]);

    const res = await GET(req('http://x/api/catalog/search?q=foo') as any);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.sources.purview.ok).toBe(false);
    expect(j.sources.purview.hint.missingEnvVar).toBe('LOOM_PURVIEW_ACCOUNT');
  });
});
