/**
 * pin-store — persistence-verification coverage (node env, mocked transport).
 *
 * The E2E pin bug: `persist` was fire-and-forget with a swallowing catch, so a
 * failed POST left the optimistic UI showing a pin that never saved — it
 * vanished on the next load. Locks in the fixed behavior:
 *   - a successful toggle POSTs the LATEST pin list to /api/user-prefs
 *   - a failed persist re-syncs pin state from the server (no optimistic lie)
 *   - rapid toggles are serialized: stale snapshots are dropped, the final
 *     state is what gets persisted (exactly one POST, latest value)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));

const A = { id: 'workspace:ws-1', label: 'Sales', href: '/workspaces/ws-1', type: 'workspace' };
const B = { id: 'item:lakehouse:l-9', label: 'bronze', href: '/items/lakehouse/l-9', type: 'lakehouse' };

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fresh module registry per test — pin-store keeps module-level state. The
 *  mocked clientFetch instance is CACHED across resetModules, so reset it too. */
async function freshStore() {
  vi.resetModules();
  const store = await import('../pin-store');
  const { clientFetch } = await import('@/lib/client-fetch');
  const cf = clientFetch as unknown as ReturnType<typeof vi.fn>;
  cf.mockReset();
  return { store, cf };
}

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failResponse = (status = 500) => ({ ok: false, status, json: async () => ({ ok: false, error: 'boom' }) });

describe('pin-store persistence', () => {
  it('POSTs the latest pin list on toggle and does not re-sync on success', async () => {
    const { store, cf } = await freshStore();
    cf.mockResolvedValue(okResponse({ ok: true }));

    store.togglePin(A);
    await flush(); await flush();

    const posts = cf.mock.calls.filter(([, init]: any[]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0][1].body);
    expect(body.key).toBe('pinnedItems');
    expect(body.value).toEqual([A]);
    // No GET re-sync when the write verified fine.
    const gets = cf.mock.calls.filter(([url, init]: any[]) => !init?.method && String(url).includes('key=pinnedItems'));
    expect(gets).toHaveLength(0);
  });

  it('re-syncs from the server when the persist fails (UI never lies)', async () => {
    const { store, cf } = await freshStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cf.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? failResponse() : okResponse({ ok: true, value: [B] }),
    );

    store.togglePin(A); // optimistic [A], but the POST will fail
    await flush(); await flush(); await flush();

    // Server truth ([B]) replaced the optimistic state that never saved.
    expect(store.getPins()).toEqual([B]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('serializes rapid toggles: stale snapshots dropped, ONE POST with the final list', async () => {
    const { store, cf } = await freshStore();
    cf.mockResolvedValue(okResponse({ ok: true }));

    store.togglePin(A);
    store.togglePin(B); // before the first persist ran
    await flush(); await flush();

    const posts = cf.mock.calls.filter(([, init]: any[]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body).value).toEqual([A, B]);
  });
});
