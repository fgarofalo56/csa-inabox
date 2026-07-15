/**
 * Contract for GET /api/items/recent — the read half of the "Recent" section.
 *
 * Joins the caller's newest audit-log events onto the items container. Locks in:
 *   - {ok, items} shape with the fields RecentItems renders
 *   - dedup to the NEWEST event per item, capped at `top`
 *   - `?n=` accepted as an alias for `?top=` (the RecentItems client sends n)
 *   - deleted items (join miss) are skipped, not errored
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/cosmos-client', () => ({
  auditLogContainer: vi.fn(),
  itemsContainer: vi.fn(),
}));

import { GET } from '../route';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, itemsContainer } from '@/lib/azure/cosmos-client';

const OID = 'user-1';

const EVENTS = [
  { itemId: 'i-1', itemType: 'lakehouse', workspaceId: 'ws-1', _ts: 400 },
  { itemId: 'i-2', itemType: 'notebook', workspaceId: 'ws-1', _ts: 300 },
  { itemId: 'i-1', itemType: 'lakehouse', workspaceId: 'ws-1', _ts: 200 }, // older dup of i-1
  { itemId: 'i-gone', itemType: 'report', workspaceId: 'ws-2', _ts: 100 }, // deleted item
];

const ITEMS: Record<string, any> = {
  'i-1': { id: 'i-1', itemType: 'lakehouse', displayName: 'bronze', workspaceId: 'ws-1' },
  'i-2': { id: 'i-2', itemType: 'notebook', displayName: 'explore', workspaceId: 'ws-1' },
};

function req(qs = '') {
  return { url: `http://x/api/items/recent${qs}` } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (getSession as any).mockReturnValue({ claims: { oid: OID } });
  (auditLogContainer as any).mockResolvedValue({
    items: {
      query: (spec: any) => ({
        fetchAll: async () => {
          expect(spec.parameters.find((p: any) => p.name === '@u')?.value).toBe(OID);
          return { resources: EVENTS };
        },
      }),
    },
  });
  (itemsContainer as any).mockResolvedValue({
    item: (id: string) => ({
      read: async () => {
        if (!ITEMS[id]) {
          const e: any = new Error('NotFound');
          e.code = 404;
          throw e;
        }
        return { resource: ITEMS[id] };
      },
    }),
  });
});

describe('GET /api/items/recent', () => {
  it('401 without a session', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('returns deduped, joined recents in newest-first order with the render fields', async () => {
    const j = await (await GET(req('?top=10'))).json();
    expect(j.ok).toBe(true);
    expect(j.items.map((i: any) => i.id)).toEqual(['i-1', 'i-2']); // i-1 once, i-gone skipped
    expect(j.items[0]).toMatchObject({
      id: 'i-1',
      type: 'lakehouse',
      displayName: 'bronze',
      workspaceId: 'ws-1',
    });
    // lastTouchedAt comes from the NEWEST event (_ts 400, not the older dup).
    expect(j.items[0].lastTouchedAt).toBe(new Date(400 * 1000).toISOString());
  });

  it('accepts ?n= as an alias for ?top= (the RecentItems client contract)', async () => {
    const j = await (await GET(req('?n=1'))).json();
    expect(j.ok).toBe(true);
    expect(j.items).toHaveLength(1);
    expect(j.items[0].id).toBe('i-1');
  });
});
