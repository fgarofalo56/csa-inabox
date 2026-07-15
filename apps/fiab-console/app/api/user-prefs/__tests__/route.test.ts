/**
 * Round-trip contract for /api/user-prefs — the Cosmos-backed key/value store
 * behind pinned items (pin-store), tab state, and other per-user prefs.
 *
 * Locks in the exact contract the pin-store depends on end-to-end:
 *   - GET before any write → { ok: true, value: null } (honest empty)
 *   - POST { key:'pinnedItems', value:[…] } → upserts into the user's partition
 *   - GET after the write → returns the SAME array (pins survive a reload)
 *   - values are namespaced per user (user A never reads user B's pins)
 *   - DELETE removes the key
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));

// In-memory Cosmos user-prefs container: id + partition-key (userId) addressing,
// like the real `mk('user-prefs', '/userId')` container.
const store = new Map<string, any>();
const keyOf = (id: string, pk: string) => `${id}|${pk}`;

vi.mock('@/lib/azure/cosmos-client', () => ({
  userPrefsContainer: vi.fn(async () => ({
    items: {
      upsert: async (doc: any) => {
        store.set(keyOf(doc.id, doc.userId), { ...doc });
        return { resource: doc };
      },
      query: (spec: any) => ({
        fetchAll: async () => {
          const u = spec.parameters.find((p: any) => p.name === '@u')?.value;
          return { resources: [...store.values()].filter((d) => d.userId === u) };
        },
      }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: store.get(keyOf(id, pk)) }),
      delete: async () => {
        if (!store.has(keyOf(id, pk))) {
          const e: any = new Error('NotFound');
          e.code = 404;
          throw e;
        }
        store.delete(keyOf(id, pk));
      },
    }),
  })),
}));

import { GET, POST, DELETE } from '../route';
import { getSession } from '@/lib/auth/session';

const sessionFor = (oid: string) => ({ claims: { oid } });

function getReq(key?: string) {
  return { url: `http://x/api/user-prefs${key ? `?key=${key}` : ''}` } as any;
}
function postReq(body: unknown) {
  return { url: 'http://x/api/user-prefs', json: async () => body } as any;
}

const PINS = [
  { id: 'workspace:ws-1', label: 'Demo — Sales', href: '/workspaces/ws-1', type: 'workspace' },
  { id: 'item:lakehouse:l-9', label: 'bronze', href: '/items/lakehouse/l-9', type: 'lakehouse' },
];

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  (getSession as any).mockReturnValue(sessionFor('user-1'));
});

describe('/api/user-prefs — pinnedItems round trip', () => {
  it('401s unauthenticated on every verb', async () => {
    (getSession as any).mockReturnValue(null);
    expect((await GET(getReq('pinnedItems'))).status).toBe(401);
    expect((await POST(postReq({ key: 'pinnedItems', value: [] }))).status).toBe(401);
    expect((await DELETE(getReq('pinnedItems'))).status).toBe(401);
  });

  it('GET before any write returns an honest null value', async () => {
    const j = await (await GET(getReq('pinnedItems'))).json();
    expect(j).toEqual({ ok: true, value: null });
  });

  it('POST → GET round-trips the pinned-items array (pins survive a reload)', async () => {
    const p = await (await POST(postReq({ key: 'pinnedItems', value: PINS }))).json();
    expect(p.ok).toBe(true);
    const j = await (await GET(getReq('pinnedItems'))).json();
    expect(j.ok).toBe(true);
    expect(j.value).toEqual(PINS); // the exact array, not [], not undefined
  });

  it('pins are per-user: another oid reads null, not user-1 pins', async () => {
    await POST(postReq({ key: 'pinnedItems', value: PINS }));
    (getSession as any).mockReturnValue(sessionFor('user-2'));
    const j = await (await GET(getReq('pinnedItems'))).json();
    expect(j.value).toBeNull();
  });

  it('DELETE removes the key and a re-read is null again', async () => {
    await POST(postReq({ key: 'pinnedItems', value: PINS }));
    const d = await (await DELETE(getReq('pinnedItems'))).json();
    expect(d.ok).toBe(true);
    const j = await (await GET(getReq('pinnedItems'))).json();
    expect(j.value).toBeNull();
  });

  it('POST without a key 400s', async () => {
    expect((await POST(postReq({ value: [] }))).status).toBe(400);
  });
});
