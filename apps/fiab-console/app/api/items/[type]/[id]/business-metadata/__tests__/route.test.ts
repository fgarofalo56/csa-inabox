/**
 * BFF route tests for /api/items/[type]/[id]/business-metadata — issue #2633.
 *
 * THE DEFECT: an Atlas BUSINESS-METADATA typedef is ACCOUNT-GLOBAL, while a
 * Loom tenant is only a Cosmos partition. This route wrote the bare
 * `LoomCustomTags` bag with `isOverwrite=true`, which REPLACES the entire bag
 * on that entity — so on a Purview account shared by two Loom tenants, tenant
 * B's save destroyed tenant A's tags on the same asset and permanently grew the
 * shared typedef with B's key names.
 *
 * TEST CLASSES (the labels are load-bearing — see the PR's mutation receipt):
 *   ATTACK   — must FAIL without the per-tenant bag. The security property.
 *   CONTROL  — must PASS BOTH WITH AND WITHOUT the fix. These catch an
 *              over-broad fix: a bare rename that drops the legacy read-fallback
 *              silently orphans every tag written before this change, and a
 *              rename that forgets the delete tombstone makes "remove tag"
 *              appear to work and then resurrect the tag on the next read.
 *
 * The Purview fake models Atlas honestly: `businessAttributes` is BAG NAME →
 * attributes, and `setBusinessMetadata` REPLACES the named bag. Its `bmName`
 * defaults to `LOOM_BUSINESS_METADATA_NAME` exactly as the shipped client used
 * to, so reverting the route reproduces the OLD behaviour rather than a test
 * artefact. Key normalisation is the REAL `businessMetadataAttrName` (via
 * `importOriginal`) — the test does not re-implement its subject.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class FakeCred {
    async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 60_000 }; }
  }
  return {
    ManagedIdentityCredential: FakeCred,
    DefaultAzureCredential: FakeCred,
    ChainedTokenCredential: class { constructor(..._c: any[]) {} async getToken() { return { token: 't', expiresOnTimestamp: Date.now() + 60_000 }; } },
  };
});

const getSessionMock = vi.fn();
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: () => getSessionMock(),
}));

/** The shared Atlas entity: bag name → attributes. ONE entity, TWO tenants. */
let atlasBags: Record<string, Record<string, string>> = {};

const ensureDefMock = vi.fn();
const setBmMock = vi.fn();

vi.mock('@/lib/azure/purview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/azure/purview-client')>();
  const attr = actual.businessMetadataAttrName;
  const DEFAULT_BAG = actual.LOOM_BUSINESS_METADATA_NAME;
  return {
    ...actual,
    isPurviewConfigured: () => true,
    getAssetDetail: async (_guid: string) => ({
      entity: { businessAttributes: JSON.parse(JSON.stringify(atlasBags)) },
    }),
    ensureBusinessMetadataDef: async (keys: string[], bmName: string = DEFAULT_BAG) => {
      ensureDefMock(keys, bmName);
    },
    setBusinessMetadata: async (guid: string, tags: Record<string, string>, bmName: string = DEFAULT_BAG) => {
      setBmMock(guid, tags, bmName);
      const entries = Object.entries(tags || {})
        .map(([k, v]) => [attr(k), String(v ?? '')] as const)
        .filter(([k]) => !!k);
      if (!entries.length) return; // Atlas no-op on an empty body (shipped behaviour)
      // isOverwrite=true → the named bag is REPLACED wholesale, not merged.
      atlasBags[bmName] = Object.fromEntries(entries);
    },
  };
});

/** Mutable so a test can exercise the "not cataloged yet" honest gate. */
let itemState: Record<string, unknown> = { purviewAssetGuid: 'guid-shared' };

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: () => ({
        fetchAll: async () => ({
          resources: [{ id: 'item-1', workspaceId: 'ws-1', itemType: 'lakehouse', state: itemState }],
        }),
      }),
    },
  }),
  // Each tenant owns its OWN workspace partition; both items point at the SAME
  // Atlas entity, which is the shared-Purview-account case #2633 is about.
  workspacesContainer: async () => ({
    item: (_id: string, pk: string) => ({ read: async () => ({ resource: { id: 'ws-1', tenantId: pk } }) }),
  }),
  auditLogContainer: async () => ({ items: { create: async () => ({}) } }),
}));

import { GET, POST } from '../route';
import { loomTenantBusinessMetadataName } from '@/lib/azure/purview-typedef-namespace';
import { LOOM_BUSINESS_METADATA_NAME } from '@/lib/azure/purview-client';

const TENANT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const TENANT_B = 'bbbbbbbb-5555-6666-7777-888888888888';

function asTenant(tid: string) {
  getSessionMock.mockReturnValue({
    claims: { oid: `oid-${tid}`, tid, upn: `u@${tid}`, name: 'U' },
    exp: Date.now() / 1000 + 3600,
  });
}

const ctx = { params: Promise.resolve({ type: 'lakehouse', id: 'item-1' }) } as any;
const get = async () => (await GET({} as any, ctx)).json();
const post = async (attributes: Record<string, string>) =>
  (await POST({ json: async () => ({ attributes }) } as any, ctx)).json();

beforeEach(() => {
  atlasBags = {};
  itemState = { purviewAssetGuid: 'guid-shared' };
  ensureDefMock.mockClear();
  setBmMock.mockClear();
});

describe('business-metadata — cross-tenant Atlas bag isolation (#2633)', () => {
  it('ATTACK: tenant B saving custom tags does NOT appear in tenant A\'s read', async () => {
    asTenant(TENANT_A);
    expect((await post({ cost_center: 'A-1000' })).ok).toBe(true);

    asTenant(TENANT_B);
    expect((await post({ cost_center: 'B-9999' })).ok).toBe(true);

    asTenant(TENANT_A);
    expect((await get()).attributes.cost_center).toBe('A-1000');

    asTenant(TENANT_B);
    expect((await get()).attributes.cost_center).toBe('B-9999');
  });

  it('ATTACK: tenant B never grows or overwrites the ACCOUNT-GLOBAL bag', async () => {
    asTenant(TENANT_B);
    await post({ 'b only secret project': 'x' });

    for (const [, bag] of ensureDefMock.mock.calls) expect(bag).not.toBe(LOOM_BUSINESS_METADATA_NAME);
    for (const [, , bag] of setBmMock.mock.calls) expect(bag).not.toBe(LOOM_BUSINESS_METADATA_NAME);
    expect(atlasBags[LOOM_BUSINESS_METADATA_NAME]).toBeUndefined();
    expect(Object.keys(atlasBags)).toEqual([loomTenantBusinessMetadataName(TENANT_B)]);
  });

  it('ATTACK: a pre-migration bag is never REWRITTEN, only read', async () => {
    atlasBags[LOOM_BUSINESS_METADATA_NAME] = { legacy_owner: 'alice', cost_center: 'OLD' };
    asTenant(TENANT_A);
    await post({ legacy_owner: 'alice', cost_center: 'NEW' });
    expect(atlasBags[LOOM_BUSINESS_METADATA_NAME]).toEqual({ legacy_owner: 'alice', cost_center: 'OLD' });
  });

  it('writes the same bag `model.tenantBusinessMetadataName` gives the LU-5 overlay', async () => {
    asTenant(TENANT_A);
    await post({ owner: 'alice' });
    expect(setBmMock).toHaveBeenCalledWith('guid-shared', expect.anything(), loomTenantBusinessMetadataName(TENANT_A));
    expect((await get()).name).toBe(loomTenantBusinessMetadataName(TENANT_A));
  });

  // ── CONTROL — these must be GREEN with and without the fix ────────────────

  it('CONTROL: pre-migration values in the bare bag still surface on read', async () => {
    atlasBags[LOOM_BUSINESS_METADATA_NAME] = { legacy_owner: 'alice', cost_center: 'OLD' };
    asTenant(TENANT_A);
    const r = await get();
    expect(r.attributes.legacy_owner).toBe('alice');
    expect(r.attributes.cost_center).toBe('OLD');
  });

  it('CONTROL: a re-saved pre-migration key keeps its NEW value on the next read', async () => {
    atlasBags[LOOM_BUSINESS_METADATA_NAME] = { legacy_owner: 'alice', cost_center: 'OLD' };
    asTenant(TENANT_A);
    await post({ legacy_owner: 'alice', cost_center: 'NEW' });
    const r = await get();
    expect(r.attributes.cost_center).toBe('NEW');
    expect(r.attributes.legacy_owner).toBe('alice');
  });

  it('CONTROL: deleting a pre-migration tag actually deletes it (no resurrection)', async () => {
    atlasBags[LOOM_BUSINESS_METADATA_NAME] = { legacy_owner: 'alice', keep_me: 'yes' };
    asTenant(TENANT_A);

    // The UI POSTs the FULL desired set, so dropping a row drops the key.
    expect((await post({ keep_me: 'yes' })).attributes.legacy_owner).toBeUndefined();
    const r = await get();
    expect(r.attributes.legacy_owner).toBeUndefined();
    expect(r.attributes.keep_me).toBe('yes');
  });

  it('CONTROL: honest gate — an item with no Atlas GUID reads empty and writes nothing', async () => {
    itemState = {};
    asTenant(TENANT_A);
    const r = await get();
    expect(r).toMatchObject({ ok: true, configured: true, hasAsset: false, attributes: {} });
    expect((await post({ x: 'y' })).hasAsset).toBe(false);
    expect(setBmMock).not.toHaveBeenCalled();
  });

  it('CONTROL: a free-form key is normalised to an Atlas attribute name', async () => {
    asTenant(TENANT_A);
    await post({ 'cost center': '1000' });
    expect((await get()).attributes.cost_center).toBe('1000');
  });
});
