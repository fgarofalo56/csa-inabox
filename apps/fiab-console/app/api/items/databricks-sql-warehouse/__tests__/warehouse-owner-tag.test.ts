/**
 * #3669 — `databricks-sql-warehouse/[id]/create` links the new warehouse back to
 * its item with the custom tag `loom_item_id`, written server-side from the
 * AUTHORIZED item id. A caller cannot choose that owner: a `loom_item_id` key in
 * `body.tags`, in any case or padding, is a 400 and nothing is created.
 *
 * Every `it` names the value that would turn it red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  getSession: vi.fn(),
}));
vi.mock('@/lib/auth/workspace-guard', () => ({ authorizeItemWorkspace: vi.fn(async () => null) }));
const ITEMS = [{ id: 'sw-1', itemType: 'databricks-sql-warehouse', workspaceId: 'ws-1', state: {} }];
vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p: any) => p.name === '@id')?.value;
          const t = spec?.parameters?.find((p: any) => p.name === '@t')?.value;
          return { resources: ITEMS.filter((i) => (!id || i.id === id) && (!t || i.itemType === t)) };
        },
      }),
    },
  }),
}));
vi.mock('@/lib/azure/databricks-client', () => ({
  createWarehouse: vi.fn(),
  databricksConfigGate: vi.fn(() => null),
}));
vi.mock('@/lib/azure/synapse-dev-client', () => ({ createDedicatedSqlPool: vi.fn() }));
vi.mock('@/lib/azure/cloud-endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/azure/cloud-endpoints')>()),
  isGovCloud: vi.fn(() => false),
}));
vi.mock('@/lib/azure/topology', () => ({ prepareItemCreate: vi.fn(), isDeployTargetGate: vi.fn(() => false) }));

import { POST } from '../[id]/create/route';
import { getSession } from '@/lib/auth/session';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { createWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { createDedicatedSqlPool } from '@/lib/azure/synapse-dev-client';
import { prepareItemCreate, isDeployTargetGate } from '@/lib/azure/topology';

const SESSION = { claims: { upn: 'u@contoso.com', oid: 'oid-1', tid: 'tid-1' }, exp: 9_999_999_999 };
const req = (body: any) => {
  const url = new URL('http://x/');
  return { url: url.toString(), nextUrl: url, json: async () => body } as any;
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any;
const sentTags = () => (createWarehouse as any).mock.calls[0][0].tags?.custom_tags as Array<{ key: string; value: string }>;

beforeEach(() => {
  vi.resetAllMocks();
  (getSession as any).mockReturnValue(SESSION);
  (authorizeItemWorkspace as any).mockResolvedValue(null);
  (databricksConfigGate as any).mockReturnValue(null);
  (isGovCloud as any).mockReturnValue(false);
  (isDeployTargetGate as any).mockReturnValue(false);
  (createWarehouse as any).mockResolvedValue({ id: 'wh-new' });
});

describe('the owner tag', () => {
  // RED if the stamp is removed, or written from anything but the route item id.
  it('is stamped with the authorized item id when no tags are sent', async () => {
    const res = await POST(req({ name: 'wh' }), ctx('sw-1'));
    expect(res.status).toBe(200);
    expect(sentTags()).toEqual([{ key: 'loom_item_id', value: 'sw-1' }]);
  });

  // RED if the stamp replaces the user's tags instead of joining them.
  it('is added alongside the caller\'s own tags', async () => {
    await POST(req({ name: 'wh', tags: { env: 'dev', team: 'bi' } }), ctx('sw-1'));
    expect(sentTags()).toEqual([
      { key: 'env', value: 'dev' },
      { key: 'team', value: 'bi' },
      { key: 'loom_item_id', value: 'sw-1' },
    ]);
  });

  // RED if the reserved-key refusal is removed (the caller-chosen owner would be
  // sent), or if it matches only the exact lower-case spelling.
  it.each(['loom_item_id', 'LOOM_ITEM_ID', ' Loom_Item_Id '])(
    'refuses a caller-supplied %j key with 400 and creates nothing',
    async (key) => {
      const res = await POST(req({ name: 'wh', tags: { [key]: 'sw-other' } }), ctx('sw-1'));
      const j = await res.json();
      expect(res.status).toBe(400);
      expect(j.code).toBe('reserved_tag');
      expect(createWarehouse).not.toHaveBeenCalled();
    },
  );

  // Positive pair for the refusal: a near-miss key is an ordinary user tag.
  // RED if the reserved match becomes a substring/prefix match.
  it('keeps a near-miss key such as loom_item_ids as an ordinary tag', async () => {
    const res = await POST(req({ name: 'wh', tags: { loom_item_ids: 'x' } }), ctx('sw-1'));
    expect(res.status).toBe(200);
    expect(sentTags()).toContainEqual({ key: 'loom_item_ids', value: 'x' });
    expect(sentTags()).toContainEqual({ key: 'loom_item_id', value: 'sw-1' });
  });

  // Gov is unchanged: a Synapse dedicated pool takes no tags. RED if the
  // reserved-tag check is moved above the cloud branch and starts refusing Gov.
  it('Gov: the dedicated-pool path is unaffected by a loom_item_id key', async () => {
    (isGovCloud as any).mockReturnValue(true);
    vi.stubEnv('LOOM_SYNAPSE_WORKSPACE', 'syn');
    (prepareItemCreate as any).mockResolvedValue({ subscriptionId: 's', resourceGroup: 'rg', tier: 't', domainId: 'd' });
    (createDedicatedSqlPool as any).mockResolvedValue({ name: 'p' });
    const res = await POST(req({ name: 'p', gov_sku: 'DW100c', tags: { loom_item_id: 'x' } }), ctx('sw-1'));
    expect(res.status).toBe(200);
    expect(createDedicatedSqlPool).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
