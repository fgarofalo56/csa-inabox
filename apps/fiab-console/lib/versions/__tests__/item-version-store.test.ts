/**
 * Unit tests for the item version-history store (Wave-2 W6):
 *  - versionsToPrune (pure cap logic)
 *  - recordItemVersion baseline-seeding, append, cap enforcement, best-effort
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkspaceItem } from '@/lib/types/workspace';

// --- In-memory item-versions container -------------------------------------
interface Doc { id: string; itemId: string; savedAt: string; [k: string]: unknown }
let store: Doc[] = [];
let throwOnContainer = false;

const container = {
  items: {
    query: (_spec: any, _opts: any) => ({
      fetchAll: async () => ({ resources: store.filter((d) => d.itemId === _spec.parameters[0].value) }),
    }),
    create: async (doc: Doc) => { store.push(doc); return { resource: doc }; },
  },
  item: (id: string, itemId: string) => ({
    read: async () => {
      const r = store.find((d) => d.id === id && d.itemId === itemId);
      if (!r) { const e: any = new Error('not found'); e.code = 404; throw e; }
      return { resource: r };
    },
    delete: async () => {
      const i = store.findIndex((d) => d.id === id && d.itemId === itemId);
      if (i >= 0) store.splice(i, 1);
      return { resource: undefined };
    },
  }),
};

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemVersionsContainer: async () => {
    if (throwOnContainer) throw new Error('cosmos down');
    return container;
  },
}));

import {
  versionsToPrune,
  recordItemVersion,
  listItemVersions,
  getItemVersion,
  itemVersionCap,
  DEFAULT_ITEM_VERSION_CAP,
} from '../item-version-store';

const mkItem = (over: Partial<WorkspaceItem> = {}): WorkspaceItem => ({
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'warehouse',
  displayName: 'WH',
  state: { content: { n: 1 } },
  createdBy: 'creator-oid',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => { store = []; throwOnContainer = false; delete process.env.LOOM_ITEM_VERSION_CAP; });
afterEach(() => { vi.clearAllMocks(); });

describe('versionsToPrune', () => {
  const v = (id: string, savedAt: string) => ({ id, savedAt });
  it('returns nothing when under or at the cap', () => {
    expect(versionsToPrune([], 50)).toEqual([]);
    expect(versionsToPrune([v('a', '1'), v('b', '2')], 2)).toEqual([]);
  });
  it('evicts the oldest beyond the cap', () => {
    const all = [v('c', '2026-03'), v('a', '2026-01'), v('b', '2026-02')];
    expect(versionsToPrune(all, 2)).toEqual(['a']); // oldest by savedAt
  });
  it('evicts multiple oldest, tie-broken by id', () => {
    const all = [v('a', 't'), v('b', 't'), v('c', 'u')];
    expect(versionsToPrune(all, 1)).toEqual(['a', 'b']);
  });
  it('treats cap<1 as 1', () => {
    expect(versionsToPrune([v('a', '1'), v('b', '2')], 0)).toEqual(['a']);
  });
});

describe('itemVersionCap', () => {
  it('defaults to 50', () => { expect(itemVersionCap()).toBe(DEFAULT_ITEM_VERSION_CAP); });
  it('honors a valid env override', () => { process.env.LOOM_ITEM_VERSION_CAP = '3'; expect(itemVersionCap()).toBe(3); });
  it('ignores an invalid env override', () => { process.env.LOOM_ITEM_VERSION_CAP = 'nope'; expect(itemVersionCap()).toBe(50); });
});

describe('recordItemVersion', () => {
  it('seeds a baseline from prev + records new on the first save', async () => {
    const prev = mkItem({ updatedAt: '2026-01-01T00:00:00.000Z', state: { content: { n: 1 } } });
    const next = mkItem({ updatedAt: '2026-02-01T00:00:00.000Z', state: { content: { n: 2 } } });
    const written = await recordItemVersion(prev, next, { oid: 'editor-oid', name: 'Ed' });
    expect(written).toBe(2);
    const all = await listItemVersions('item-1');
    expect(all).toHaveLength(2);
    const baseline = all.find((d) => d.baseline);
    expect(baseline).toBeTruthy();
    expect(baseline?.content.state).toEqual({ content: { n: 1 } });
    expect(baseline?.savedBy).toBe('creator-oid'); // seeded from prev.createdBy
    const head = all.find((d) => !d.baseline);
    expect(head?.savedBy).toBe('editor-oid');
    expect(head?.savedByName).toBe('Ed');
    expect(head?.content.state).toEqual({ content: { n: 2 } });
  });

  it('does not re-seed a baseline on subsequent saves', async () => {
    const prev = mkItem({ updatedAt: '2026-01-01T00:00:00.000Z' });
    const next1 = mkItem({ updatedAt: '2026-02-01T00:00:00.000Z', state: { content: { n: 2 } } });
    await recordItemVersion(prev, next1, { oid: 'e' });
    const next2 = mkItem({ updatedAt: '2026-03-01T00:00:00.000Z', state: { content: { n: 3 } } });
    const written = await recordItemVersion(next1, next2, { oid: 'e' });
    expect(written).toBe(1);
    const all = await listItemVersions('item-1');
    expect(all).toHaveLength(3);
    expect(all.filter((d) => d.baseline)).toHaveLength(1);
  });

  it('enforces the cap by evicting the oldest', async () => {
    process.env.LOOM_ITEM_VERSION_CAP = '2';
    let prev = mkItem({ updatedAt: '2026-01-01T00:00:00.000Z', state: { content: { n: 0 } } });
    // 4 saves → without a cap that would be baseline + 4 = 5 versions.
    for (let i = 1; i <= 4; i++) {
      const next = mkItem({ updatedAt: `2026-0${i + 1}-01T00:00:00.000Z`, state: { content: { n: i } } });
      await recordItemVersion(prev, next, { oid: 'e' });
      prev = next;
    }
    const all = await listItemVersions('item-1');
    expect(all).toHaveLength(2); // capped
    // The two newest survive.
    const sorted = [...all].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    expect(sorted[0].content.state).toEqual({ content: { n: 4 } });
  });

  it('is best-effort: a Cosmos failure returns 0 and never throws', async () => {
    throwOnContainer = true;
    const written = await recordItemVersion(mkItem(), mkItem(), { oid: 'e' });
    expect(written).toBe(0);
  });
});

describe('getItemVersion', () => {
  it('returns a version by id within the item partition', async () => {
    await recordItemVersion(mkItem({ state: { content: { n: 1 } } }), mkItem({ updatedAt: '2026-02-01T00:00:00.000Z', state: { content: { n: 2 } } }), { oid: 'e' });
    const all = await listItemVersions('item-1');
    const got = await getItemVersion('item-1', all[0].id);
    expect(got?.id).toBe(all[0].id);
  });
  it('returns null for a missing version', async () => {
    expect(await getItemVersion('item-1', 'ver:item-1:nope')).toBeNull();
  });
});
