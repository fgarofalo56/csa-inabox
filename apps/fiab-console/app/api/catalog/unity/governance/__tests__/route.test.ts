/**
 * LU-5 — BFF tests for the governance-overlay + governed-tag routes.
 *
 * Bugs these catch:
 *   1. an unauthenticated caller reading or writing another tenant's governance.
 *   2. the route bypassing the vocabulary gate (400 must come from the model,
 *      and NOTHING may be persisted when it fires).
 *   3. a Gov/Databricks-style gate creeping back onto the Azure-native default
 *      path (this surface must work on the OSS backend with no warehouse).
 *   4. a tenant-scoped write landing under the wrong partition key.
 *   5. an emptied overlay being persisted as a hollow row instead of deleted.
 *   6. `syncPurview` silently succeeding when Purview is unconfigured.
 *   7. a non-admin editing the tenant governed-tag vocabulary.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await orig<typeof import('@/lib/auth/session')>();
  return { ...actual, getSession: vi.fn(), tenantScopeId: (s: any) => s.claims.tid || s.claims.oid };
});
vi.mock('@/lib/governance/uc-overlay/store', () => ({
  readGovernedTags: vi.fn(),
  writeGovernedTags: vi.fn(),
  readAttributeGroups: vi.fn(),
  readOverlay: vi.fn(),
  listOverlays: vi.fn(),
  listColumnOverlays: vi.fn(),
  writeOverlay: vi.fn(),
  deleteOverlay: vi.fn(),
  isEmptyOverlay: (o: any) => (o.tags || []).length === 0
    && (o.certification?.rung || 'none') === 'none'
    && Object.keys(o.attributes || {}).length === 0,
}));
vi.mock('@/lib/governance/uc-overlay/purview-sync', () => ({
  syncOverlayToPurview: vi.fn(),
  provenanceFromSync: vi.fn(() => undefined),
}));

import { GET, POST } from '../route';
import { GET as TAGS_GET, POST as TAGS_POST } from '../../governed-tags/route';
import { getSession } from '@/lib/auth/session';
import {
  readGovernedTags, readAttributeGroups, readOverlay, listOverlays, listColumnOverlays,
  writeOverlay, deleteOverlay, writeGovernedTags,
} from '@/lib/governance/uc-overlay/store';
import { syncOverlayToPurview } from '@/lib/governance/uc-overlay/purview-sync';
import { emptyOverlay } from '@/lib/governance/uc-overlay/model';

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

const SESSION = { claims: { upn: 'ana@contoso.com', oid: 'oid-1', tid: 'tenant-1', groups: [] }, exp: 9_999_999_999 };
/** Tenant-admin is env-driven (LOOM_TENANT_ADMIN_OID) — see lib/auth/feature-gate.isTenantAdmin. */
function asTenantAdmin() { process.env.LOOM_TENANT_ADMIN_OID = 'oid-1'; }

function getReq(qs = '') {
  return { nextUrl: new URL(`http://x/api/catalog/unity/governance${qs}`) } as never;
}
function postReq(body: unknown) {
  return { json: async () => body } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.LOOM_TENANT_ADMIN_OID;
  mock(getSession).mockReturnValue(SESSION);
  mock(readGovernedTags).mockResolvedValue([
    { key: 'pii', allowedValues: ['yes', 'no'] },
  ]);
  mock(readAttributeGroups).mockResolvedValue([]);
  mock(listOverlays).mockResolvedValue([]);
  mock(listColumnOverlays).mockResolvedValue([]);
  mock(readOverlay).mockImplementation(async (tenantId: string, p: { fullName: string; column?: string }) =>
    emptyOverlay({ tenantId, fullName: p.fullName, column: p.column }));
  mock(writeOverlay).mockImplementation(async (o: unknown) => o);
});

describe('GET /api/catalog/unity/governance', () => {
  it('401 without a session', async () => {
    mock(getSession).mockReturnValue(null);
    expect((await GET(getReq('?fullName=main.sales.orders'), undefined as never)).status).toBe(401);
  });

  it('400 without fullName or prefix', async () => {
    const res = await GET(getReq(''), undefined as never);
    expect(res.status).toBe(400);
  });

  it('returns the overlay + vocabulary + attribute groups on the DEFAULT path (no gate)', async () => {
    const res = await GET(getReq('?fullName=main.sales.orders'), undefined as never);
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.gated).toBeUndefined();
    expect(j.overlay.identity).toBe('uc:main.sales.orders');
    expect(j.vocabulary).toHaveLength(1);
  });

  it('reads within the CALLER tenant partition', async () => {
    await GET(getReq('?fullName=main.sales.orders'), undefined as never);
    expect(readOverlay).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ fullName: 'main.sales.orders' }));
  });

  it('prefix listing does not point-read a securable', async () => {
    const res = await GET(getReq('?prefix=main.sales'), undefined as never);
    expect((await res.json()).ok).toBe(true);
    expect(listOverlays).toHaveBeenCalledWith('tenant-1', 'main.sales');
    expect(readOverlay).not.toHaveBeenCalled();
  });
});

describe('POST /api/catalog/unity/governance', () => {
  it('401 without a session', async () => {
    mock(getSession).mockReturnValue(null);
    expect((await POST(postReq({ fullName: 'a.b.c' }), undefined as never)).status).toBe(401);
  });

  it('400 with nothing to apply', async () => {
    const res = await POST(postReq({ fullName: 'main.sales.orders' }), undefined as never);
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('400 — and NO write — when a governed value is outside the vocabulary', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'maybe' }] }),
      undefined as never,
    );
    const j = await res.json();
    expect(res.status).toBe(400);
    expect(j.error).toMatch(/not an allowed value for governed tag "pii"/);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('persists a valid governed tag with the governed flag set', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'yes' }] }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.overlay.tags).toEqual([{ key: 'pii', value: 'yes', governed: true }]);
    expect(mock(writeOverlay).mock.calls[0][0]).toMatchObject({ tenantId: 'tenant-1', id: 'uc:main.sales.orders' });
  });

  it('400 on an unknown securableType instead of persisting junk', async () => {
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', securableType: 'wormhole', setTags: [{ key: 'x', value: 'y' }] }),
      undefined as never,
    );
    expect(res.status).toBe(400);
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('deletes the row instead of persisting an empty overlay', async () => {
    mock(readOverlay).mockResolvedValue({
      ...emptyOverlay({ tenantId: 'tenant-1', fullName: 'main.sales.orders' }),
      tags: [{ key: 'pii', value: 'yes', governed: true }],
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', removeTagKeys: ['pii'] }),
      undefined as never,
    );
    expect((await res.json()).deleted).toBe(true);
    expect(deleteOverlay).toHaveBeenCalledWith('tenant-1', 'uc:main.sales.orders');
    expect(writeOverlay).not.toHaveBeenCalled();
  });

  it('surfaces an unsynced Purview result honestly while still saving the overlay', async () => {
    mock(syncOverlayToPurview).mockResolvedValue({
      synced: false, reason: 'Microsoft Purview is not configured … LOOM_PURVIEW_ACCOUNT',
      classifications: [], businessMetadataKeys: [],
    });
    const res = await POST(
      postReq({ fullName: 'main.sales.orders', setTags: [{ key: 'pii', value: 'no' }], syncPurview: true }),
      undefined as never,
    );
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.purview.synced).toBe(false);
    expect(j.purview.reason).toMatch(/LOOM_PURVIEW_ACCOUNT/);
    expect(writeOverlay).toHaveBeenCalled();
  });
});

describe('governed-tag vocabulary route', () => {
  function tagsPost(body: unknown) { return { json: async () => body } as never; }

  it('GET returns the tenant vocabulary', async () => {
    const res = await TAGS_GET({} as never, undefined as never);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.tags).toHaveLength(1);
    expect(readGovernedTags).toHaveBeenCalledWith('tenant-1');
  });

  it('POST is refused for a non-admin (the vocabulary is tenant-wide)', async () => {
    const res = await TAGS_POST(tagsPost({ tags: [{ key: 'pii', allowedValues: ['yes'] }] }), undefined as never);
    expect(res.status).toBe(403);
    expect(writeGovernedTags).not.toHaveBeenCalled();
  });

  it('POST 400s on a definition with no allowed values', async () => {
    asTenantAdmin();
    const res = await TAGS_POST(tagsPost({ tags: [{ key: 'pii', allowedValues: [] }] }), undefined as never);
    expect(res.status).toBe(400);
    expect(writeGovernedTags).not.toHaveBeenCalled();
  });

  it('POST saves a valid vocabulary for an admin', async () => {
    asTenantAdmin();
    mock(writeGovernedTags).mockResolvedValue({ tags: [{ key: 'pii', allowedValues: ['yes', 'no'] }], updatedAt: 'now' });
    const res = await TAGS_POST(tagsPost({ tags: [{ key: 'pii', allowedValues: ['yes', 'no'] }] }), undefined as never);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(writeGovernedTags).toHaveBeenCalledWith('tenant-1', expect.any(Array), 'ana@contoso.com');
  });
});
