/**
 * Unit tests for the canvas-presence store (W5) against an in-memory container:
 *  - recordPresence: UPSERTs ONE deterministic row per (item, canvas, oid) and
 *    stamps a TTL (self-evicting beacon), refreshing lastSeen on re-heartbeat
 *  - listPresence: single-canvas read within the item partition
 *  - clearPresence: best-effort leave (never throws on 404)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CanvasPresenceDoc } from '@/lib/collab/canvas-presence-model';

let store: CanvasPresenceDoc[] = [];

const container = {
  items: {
    upsert: async (doc: CanvasPresenceDoc) => {
      const i = store.findIndex((d) => d.id === doc.id);
      if (i >= 0) store[i] = doc; else store.push(doc);
      return { resource: doc };
    },
    query: (spec: any, _opts: any) => ({
      fetchAll: async () => {
        const itemId = spec.parameters[0].value;
        const canvasKey = spec.parameters[1].value;
        return { resources: store.filter((d) => d.itemId === itemId && d.canvasKey === canvasKey) };
      },
    }),
  },
  item: (id: string, _itemId: string) => ({
    delete: async () => {
      const i = store.findIndex((d) => d.id === id);
      if (i < 0) { const e: any = new Error('not found'); e.code = 404; throw e; }
      store.splice(i, 1);
      return {};
    },
  }),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  canvasPresenceContainer: async () => container,
}));

import { recordPresence, listPresence, clearPresence } from '@/lib/collab/canvas-presence-store';
import { presenceDocId, presenceTtlSeconds } from '@/lib/collab/canvas-presence-model';

beforeEach(() => { store = []; delete process.env.LOOM_CANVAS_PRESENCE_TTL_MS; });

describe('recordPresence', () => {
  it('upserts one deterministic row per peer and stamps a TTL', async () => {
    const d1 = await recordPresence('i1', 'default', { oid: 'oid-a', name: 'Ann' });
    expect(d1.id).toBe(presenceDocId('i1', 'default', 'oid-a'));
    expect(d1.ttl).toBe(presenceTtlSeconds());
    expect(d1.ttl).toBeGreaterThanOrEqual(10);

    const firstSeen = d1.lastSeen;
    await new Promise((r) => setTimeout(r, 3));
    const d2 = await recordPresence('i1', 'default', { oid: 'oid-a', name: 'Ann', cursor: { x: 5, y: 6 } });
    // same row (upsert), refreshed lastSeen + cursor
    expect(store).toHaveLength(1);
    expect(d2.lastSeen >= firstSeen).toBe(true);
    expect(d2.cursor).toEqual({ x: 5, y: 6 });
  });
});

describe('listPresence', () => {
  it('reads only the requested canvas within the item', async () => {
    await recordPresence('i1', 'default', { oid: 'a' });
    await recordPresence('i1', 'default', { oid: 'b' });
    await recordPresence('i1', 'other', { oid: 'c' });
    expect(await listPresence('i1', 'default')).toHaveLength(2);
    expect(await listPresence('i1', 'other')).toHaveLength(1);
  });
});

describe('clearPresence', () => {
  it('removes a peer beacon and no-ops on a missing one', async () => {
    await recordPresence('i1', 'default', { oid: 'a' });
    await clearPresence('i1', 'default', 'a');
    expect(store).toHaveLength(0);
    // second call (already gone) must not throw
    await expect(clearPresence('i1', 'default', 'a')).resolves.toBeUndefined();
  });
});
