/**
 * #3611 (review round 2) — the SECOND enforcement point.
 *
 * `assertNoServerOwnedStateChange` is called from TWO places:
 *   1. the generic PATCH  — `app/api/items/[type]/[id]/route.ts`
 *   2. `updateOwnedItem`  — `app/api/items/_lib/item-crud.ts`
 *
 * Only (1) had tests. Removing the call from (2) therefore left the whole suite
 * green at RC=0 — and (2) is the wider surface: it is the shared per-type save
 * chokepoint behind 132 call sites, so every editor that persists through
 * `updateOwnedItem` was unguarded with nothing failing.
 *
 * This file pins (2) directly, at the helper rather than through a route, so it
 * cannot be satisfied by whatever a particular route happens to do first.
 *
 * A NOTE ON WHAT IS ASSERTED. `updateOwnedItem` does not catch
 * `ServerOwnedStateError`; it propagates. So the observable contract here is
 * "throws, AND does not call replace()" — the second half matters at least as
 * much as the first, because a guard that threw after persisting would leave the
 * sink armed while looking correct from the caller's side.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ITEM = {
  id: 'item-1',
  workspaceId: 'ws-1',
  itemType: 'lakehouse-shortcut',
  displayName: 'sc',
  state: {
    sourceType: 's3',
    secretRef: 'loom-shortcut-item-1',
    engine: 'synapse',
    engineObject: 'loom_lakehouse.shortcuts.sc_a',
  },
  createdAt: 'a',
  updatedAt: 'a',
};

/** Every `replace()` the code under test performs. A refusal must produce ZERO. */
const replaced: any[] = [];

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [ITEM] }) }) },
    item: () => ({
      read: async () => ({ resource: ITEM }),
      replace: async (doc: any) => { replaced.push(doc); return { resource: doc }; },
      delete: async () => ({}),
    }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  // Mocked so the best-effort version snapshot on the ALLOW cases stays silent.
  // It is caught and logged either way, but an unmocked export prints an error
  // per passing test — noise a REAL failure could then hide inside.
  itemVersionsContainer: vi.fn(async () => ({
    items: { create: vi.fn(async () => ({})), query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

import { updateOwnedItem, SERVER_OWNED_STATE_KEYS, ServerOwnedStateError } from '../item-crud';

const TENANT = 'ws-1';
const PLATFORM_SECRET = 'loom-msal-client-secret';

beforeEach(() => {
  replaced.length = 0;
  vi.clearAllMocks();
});

describe('#3611 — updateOwnedItem enforces server-owned state too', () => {
  it('refuses to repoint secretRef at a platform secret, and writes NOTHING', async () => {
    await expect(updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
      state: { sourceType: 's3', secretRef: PLATFORM_SECRET },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
  });

  it('refuses to repoint engineObject outside the minted name-space', async () => {
    await expect(updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
      state: { sourceType: 's3', engine: 'synapse', engineObject: 'finance_db.dbo.payroll' },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
  });

  it('refuses a NESTED server-owned key — a top-level-only scan is not enough', async () => {
    await expect(updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
      state: { appRuntime: { gitAuth: { secretName: PLATFORM_SECRET } } },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
  });

  it('refuses a prototype-polluting key', async () => {
    const state = JSON.parse('{"code":"x","__proto__":{"pollutedViaUpdateOwnedItem":true}}');

    await expect(updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, { state }))
      .rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
    expect(({} as any).pollutedViaUpdateOwnedItem).toBeUndefined();
  });

  /**
   * EVERY key, driven off the exported list rather than a hand-written copy.
   *
   * A hand-written list is the failure this repo keeps re-finding: it drifts
   * behind the real one, and the test still passes. Deriving the cases from
   * `SERVER_OWNED_STATE_KEYS` means adding a seventh key without a test is
   * impossible — the loop grows with it.
   */
  it('refuses a change to EVERY key in SERVER_OWNED_STATE_KEYS', async () => {
    // Positive control on the POPULATION itself: an empty or truncated list
    // would make the loop below assert nothing while passing.
    expect(SERVER_OWNED_STATE_KEYS.length).toBeGreaterThanOrEqual(6);

    for (const key of SERVER_OWNED_STATE_KEYS) {
      await expect(
        updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
          state: { [key]: { forgedBy: 'the-caller' } },
        }),
        `state.${key} must be refused by updateOwnedItem`,
      ).rejects.toBeInstanceOf(ServerOwnedStateError);
    }

    expect(replaced).toHaveLength(0);
  });

  // ── The guard must not break ordinary saves ───────────────────────────────

  it('ALLOWS a round-trip that carries the same server-owned values through', async () => {
    // Without this, "throw on any state at all" satisfies every case above and
    // breaks all 132 call sites.
    const res = await updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
      state: {
        sourceType: 's3',
        secretRef: 'loom-shortcut-item-1',
        engine: 'synapse',
        engineObject: 'loom_lakehouse.shortcuts.sc_a',
        path: 'changed',
      },
    });

    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.path).toBe('changed');
    expect(replaced[0].state.secretRef).toBe('loom-shortcut-item-1');
  });

  it('ALLOWS omitting a server-owned key (fail-safe: orphans, never deletes)', async () => {
    const res = await updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, {
      state: { sourceType: 's3' },
    });

    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
  });

  it('ALLOWS a rename with no state at all', async () => {
    const res = await updateOwnedItem(ITEM.id, ITEM.itemType, TENANT, { displayName: 'Renamed' });

    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].displayName).toBe('Renamed');
  });
});
