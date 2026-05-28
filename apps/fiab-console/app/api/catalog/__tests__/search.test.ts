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
  return { ...actual, searchPurview: vi.fn() };
});
vi.mock('@/lib/azure/unity-catalog-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/unity-catalog-client');
  return { ...actual, searchUnity: vi.fn() };
});
vi.mock('@/lib/azure/onelake-catalog-client', async () => {
  const actual: any = await vi.importActual('@/lib/azure/onelake-catalog-client');
  return { ...actual, searchOneLake: vi.fn() };
});

import { GET } from '../search/route';
import { getSession } from '@/lib/auth/session';
import { searchPurview, PurviewNotConfiguredError } from '@/lib/azure/purview-client';
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
    (searchPurview as any).mockResolvedValue([{ id: 'p1', name: 'p', entityType: 'Table' }]);
    (searchUnity as any).mockResolvedValue([{ source: 'unity-catalog', workspace_hostname: 'h.x', type: 'table', full_name: 'c.s.t', name: 't' }]);
    (searchOneLake as any).mockResolvedValue([{ source: 'onelake', workspace_id: 'w', workspace_name: 'W', item_id: 'i', type: 'Lakehouse', display_name: 'lh' }]);

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
    (searchPurview as any).mockResolvedValue([]);
    (searchUnity as any).mockResolvedValue([{ source: 'unity-catalog', workspace_hostname: 'h.x', type: 'table', full_name: 'c.s.t', name: 't' }]);
    (searchOneLake as any).mockResolvedValue([]);

    const res = await GET(req('http://x/api/catalog/search?q=foo&source=unity-catalog') as any);
    const j = await res.json();
    expect(j.hits).toHaveLength(1);
    expect(searchPurview).not.toHaveBeenCalled();
    expect(searchOneLake).not.toHaveBeenCalled();
  });

  it('surfaces NotConfigured hint without failing the overall response', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    (searchPurview as any).mockRejectedValue(new PurviewNotConfiguredError({
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
