/**
 * #4619 — SERVER-DERIVED SCOPE is not writable through the generic item-state
 * write paths.
 *
 * WHAT IS UNDER TEST. `state.provisioning` is the receipt the provisioning
 * engine stamps after it creates an item's backing Azure object, and
 * `state.storageAccount` names the account a lakehouse is bound to. Other code
 * derives a security-relevant SCOPE from both — `resolveLakehouseAbfss`
 * (`lib/azure/lakehouse-abfss.ts`) is the reader exercised here. Four routes
 * wrote `state` WHOLESALE from a request body with no schema validation:
 *
 *   PATCH  /api/items/[type]/[id]          → via assertNoServerOwnedStateChange
 *   PATCH  /api/cosmos-items/[type]/[id]   → new call site
 *   POST   /api/cosmos-items/[type]        → new call site (create)
 *   updateOwnedItem()                      → via assertNoServerOwnedStateChange
 *
 * WHAT EACH ASSERTION IS PINNED TO, and the value that makes it FAIL — the bar
 * `.claude/rules/assertion-design.md` sets. These specs assert the MECHANISM,
 * i.e. the documents that actually reached the Cosmos mock (`replaced`,
 * `created`, and the resolver's own later read), NOT a returned status code. A
 * guard that threw after persisting would pass a status-only spec while leaving
 * the scope rewritten, so the status is only ever the SECOND half of a pair.
 *
 * THE INSTRUMENT HAS A POSITIVE CONTROL. `resolveLakehouseAbfss` is shown, in
 * `the resolver is not blind`, to REPORT a rewritten root when one is written
 * straight into the store the way the provisioner's own path writes it
 * (`app/api/apps/[id]/install/route.ts` and `persistAutoBindPatch` both call
 * `items.item().replace()` directly and are deliberately NOT guarded). Without
 * that control, every "still returns the server scope" assertion below could be
 * satisfied by a resolver that cannot see the field at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TENANT = 'ws-1';
const WS = 'ws-1';
const LH_ID = 'lh-1';

/** Every document that reached Cosmos, by route of arrival. */
const replaced: any[] = [];
const created: any[] = [];
/** The store the mock containers read from AND write to, so a read after a
 *  write observes what the write actually did. */
const DOCS = new Map<string, any>();
const dkey = (id: string, pk: string) => `${pk}::${id}`;

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({
    claims: { oid: 'ws-1', upn: 'alice@contoso.com', email: 'alice@contoso.com', name: 'Alice' },
  })),
  tenantScopeId: vi.fn(() => 'ws-1'),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: {
      create: async (doc: any) => {
        created.push(doc);
        DOCS.set(`${doc.workspaceId}::${doc.id}`, doc);
        return { resource: doc };
      },
      // `loadOwnedItem` selects `WHERE c.id = @id AND c.itemType = @t`
      // (item-crud.ts:705). The mock HONOURS both parameters: a query mock that
      // returned every document would hand `updateOwnedItem` the first doc in
      // the store whatever id it was asked for, so a spec aimed at a second
      // fixture would silently exercise the first one instead.
      query: (spec: any) => ({
        fetchAll: async () => {
          const p = new Map<string, any>((spec?.parameters || []).map((x: any) => [x.name, x.value]));
          const resources = [...DOCS.values()].filter((d) =>
            (!p.has('@id') || d.id === p.get('@id'))
            && (!p.has('@t') || d.itemType === p.get('@t')));
          return { resources };
        },
      }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: DOCS.get(`${pk}::${id}`) }),
      replace: async (doc: any) => {
        replaced.push(doc);
        DOCS.set(`${doc.workspaceId}::${doc.id}`, doc);
        return { resource: doc };
      },
      delete: async () => ({}),
    }),
  })),
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  auditLogContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
  // Mocked so the best-effort version snapshot and webhook fan-out on the ALLOW
  // cases stay silent. Both are caught and logged either way, but an unmocked
  // export prints an error per PASSING test — noise a REAL failure could then
  // hide inside.
  itemVersionsContainer: vi.fn(async () => ({
    items: { create: vi.fn(async () => ({})), query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  webhookSubscriptionsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

vi.mock('@/lib/auth/item-access', () => ({
  resolveItemAccessByOid: vi.fn(async (_s: any, id: string, _t: string) => {
    const item = DOCS.get(`ws-1::${id}`);
    return item ? { item, canWrite: true, via: 'owner' } : null;
  }),
}));

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: vi.fn(async () => ({ canWrite: true, role: 'Owner' })),
  ambientAccessOptsFor: vi.fn(async () => ({})),
}));

vi.mock('@/lib/azure/auto-bind', () => ({ autoBindOnCreate: vi.fn(async () => undefined) }));
vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(async () => undefined),
  deleteLoomDoc: vi.fn(async () => undefined),
  docForItem: vi.fn(() => ({})),
}));

import {
  updateOwnedItem,
  assertNoServerDerivedScopeChange,
  carryServerDerivedScope,
  SERVER_DERIVED_SCOPE_KEYS,
  ServerOwnedStateError,
} from '../item-crud';
import { resolveLakehouseAbfss } from '@/lib/azure/lakehouse-abfss';
import { PATCH as COSMOS_ITEM_PATCH } from '@/app/api/cosmos-items/[type]/[id]/route';
import { POST as COSMOS_ITEM_CREATE } from '@/app/api/cosmos-items/[type]/route';

/** What the lakehouse provisioner recorded. `lakehouse.ts:831-835` is the shape. */
const SERVER_SCOPE = {
  status: 'created',
  resourceId: 'gold/lakehouses/sales-lh',
  secondaryIds: {
    backend: 'azure-native-adls',
    container: 'gold',
    rootPath: 'lakehouses/sales-lh',
    adlsRoot: 'abfss://gold@dlzacct.dfs.core.windows.net/lakehouses/sales-lh',
  },
  at: '2026-09-01T00:00:00.000Z',
};

/** The same shape naming a root the provisioner never recorded. */
const REWRITTEN_SCOPE = {
  ...SERVER_SCOPE,
  secondaryIds: {
    ...SERVER_SCOPE.secondaryIds,
    container: 'bronze',
    rootPath: 'lakehouses/not-this-one',
    adlsRoot: 'abfss://bronze@dlzacct.dfs.core.windows.net/lakehouses/not-this-one',
  },
};

function lakehouseDoc() {
  return {
    id: LH_ID,
    workspaceId: WS,
    itemType: 'lakehouse',
    displayName: 'Sales LH',
    state: {
      ownedContainers: ['gold'],
      notes: 'authored by the user',
      provisioning: structuredClone(SERVER_SCOPE),
      storageAccount: 'dlzacct',
    },
    createdAt: 'a',
    updatedAt: 'a',
  };
}

function patchReq(body: unknown) {
  return { json: async () => body } as any;
}
const patchCtx = { params: Promise.resolve({ type: 'lakehouse', id: LH_ID }) };

beforeEach(() => {
  replaced.length = 0;
  created.length = 0;
  DOCS.clear();
  DOCS.set(dkey(LH_ID, WS), lakehouseDoc());
});

// ───────────────────────────────────────────────────────────────────────────
// The instrument's positive control. Run this FIRST: every "still returns the
// server scope" assertion below is worthless if the resolver cannot see the
// field, and a resolver that always returned SERVER_SCOPE would satisfy them
// all. This is also the paired positive for "provisioning still persists":
// the provisioner's own path is a DIRECT items.item().replace(), and it is
// shown here to land and to be observed.
// ───────────────────────────────────────────────────────────────────────────
describe('#4619 — the resolver is not blind, and the provisioner path still persists', () => {
  it('REPORTS a rewritten root when one is written the way the provisioner writes it', async () => {
    // FAILS IF: resolveLakehouseAbfss ignores state.provisioning.secondaryIds
    // .adlsRoot, or the direct replace() path has been guarded too (which would
    // break `app/api/apps/[id]/install/route.ts:404` and `persistAutoBindPatch`).
    const { itemsContainer } = await import('@/lib/azure/cosmos-client');
    const items = await itemsContainer();
    const cur = DOCS.get(dkey(LH_ID, WS));
    await items.item(LH_ID, WS).replace({
      ...cur,
      state: { ...cur.state, provisioning: structuredClone(REWRITTEN_SCOPE) },
    });

    expect(replaced).toHaveLength(1);
    const resolved = await resolveLakehouseAbfss(LH_ID, WS);
    expect(resolved?.abfss).toBe(REWRITTEN_SCOPE.secondaryIds.adlsRoot);
    expect(resolved?.container).toBe('bronze');
  });

  it('reads the SERVER scope from an untouched item', async () => {
    // FAILS IF: the fixture does not actually reach branch 1 of the resolver —
    // e.g. a typo in `secondaryIds`, which would silently fall through to the
    // convention branch and make every comparison below meaningless.
    const resolved = await resolveLakehouseAbfss(LH_ID, WS);
    expect(resolved?.abfss).toBe(SERVER_SCOPE.secondaryIds.adlsRoot);
    expect(resolved?.container).toBe('gold');
    expect(resolved?.root).toBe('lakehouses/sales-lh');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// REFUSALS — one per write path. Each asserts ZERO documents reached Cosmos.
// ───────────────────────────────────────────────────────────────────────────
describe('#4619 — updateOwnedItem refuses a rewritten server-derived scope', () => {
  it('refuses state.provisioning, and writes NOTHING', async () => {
    // FAILS IF: 'provisioning' leaves SERVER_DERIVED_SCOPE_KEYS, or the
    // assertNoServerDerivedScopeChange call is removed from
    // assertNoServerOwnedStateChange — the replace() then lands and this is 1.
    await expect(updateOwnedItem(LH_ID, 'lakehouse', TENANT, {
      state: { ...lakehouseDoc().state, provisioning: structuredClone(REWRITTEN_SCOPE) },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
    expect(DOCS.get(dkey(LH_ID, WS)).state.provisioning).toEqual(SERVER_SCOPE);
  });

  it('refuses state.storageAccount, and writes NOTHING', async () => {
    // FAILS IF: 'storageAccount' leaves SERVER_DERIVED_SCOPE_KEYS. It is the T3
    // grant coordinate in `app/api/storage/_lib/authorize.ts:120`.
    await expect(updateOwnedItem(LH_ID, 'lakehouse', TENANT, {
      state: { ...lakehouseDoc().state, storageAccount: 'someotheraccount' },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
    expect(DOCS.get(dkey(LH_ID, WS)).state.storageAccount).toBe('dlzacct');
  });

  it('refuses a change to EVERY key in SERVER_DERIVED_SCOPE_KEYS', async () => {
    // Positive control on the POPULATION: an emptied or truncated list would
    // make the loop below assert nothing while still passing.
    expect(SERVER_DERIVED_SCOPE_KEYS).toEqual(['provisioning', 'storageAccount']);

    for (const key of SERVER_DERIVED_SCOPE_KEYS) {
      await expect(
        updateOwnedItem(LH_ID, 'lakehouse', TENANT, {
          state: { ...lakehouseDoc().state, [key]: { rewrittenBy: 'the-request-body' } },
        }),
        `state.${key} must be refused by updateOwnedItem`,
      ).rejects.toBeInstanceOf(ServerOwnedStateError);
    }
    expect(replaced).toHaveLength(0);
  });

  it('refuses INTRODUCING a scope onto an item that carries none', async () => {
    // Reject-on-change must also reject an INTRODUCTION, or an item whose
    // provisioner has not run yet is writable. FAILS IF the comparison treats
    // "absent on the current item" as "anything is allowed".
    DOCS.set(dkey('plain-1', WS), {
      id: 'plain-1', workspaceId: WS, itemType: 'lakehouse', displayName: 'Plain',
      state: { notes: 'x' }, createdAt: 'a', updatedAt: 'a',
    });
    await expect(updateOwnedItem('plain-1', 'lakehouse', TENANT, {
      state: { notes: 'x', provisioning: structuredClone(SERVER_SCOPE) },
    })).rejects.toBeInstanceOf(ServerOwnedStateError);

    expect(replaced).toHaveLength(0);
  });
});

describe('#4619 — PATCH /api/cosmos-items/[type]/[id] refuses it too', () => {
  it('answers 400 server_owned_state AND writes NOTHING', async () => {
    // This route had NO server-owned-state guard of any kind before #4619, and
    // it is the one `lib/api/workspaces.ts:272` puts generic editor saves
    // through. FAILS IF the new call site is removed: status becomes 200 and
    // `replaced` becomes 1.
    const res = await COSMOS_ITEM_PATCH(
      patchReq({ state: { ...lakehouseDoc().state, provisioning: structuredClone(REWRITTEN_SCOPE) } }),
      patchCtx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('server_owned_state');

    expect(replaced).toHaveLength(0);
    // The MECHANISM, not the status: the stored scope is still the server's, and
    // the reader still derives from it.
    expect(DOCS.get(dkey(LH_ID, WS)).state.provisioning).toEqual(SERVER_SCOPE);
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.abfss).toBe(SERVER_SCOPE.secondaryIds.adlsRoot);
  });
});

describe('#4619 — POST /api/cosmos-items/[type] refuses it at CREATE', () => {
  it('answers 400 and creates NOTHING', async () => {
    // Covering create is load-bearing: a rule that bound only the UPDATE paths
    // is satisfied by making a fresh item instead. FAILS IF the create-side call
    // is removed — `created` becomes 1 with the supplied scope on it.
    const res = await COSMOS_ITEM_CREATE(
      patchReq({
        workspaceId: WS,
        displayName: 'New LH',
        state: { provisioning: structuredClone(REWRITTEN_SCOPE) },
      }) as any,
      { params: Promise.resolve({ type: 'lakehouse' }) } as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('server_owned_state');
    expect(created).toHaveLength(0);
  });

  it('creates normally when the body carries ordinary state', async () => {
    // PAIRED POSITIVE. Without it, "refuse every create that has any state"
    // satisfies the spec above and breaks the create path for everyone.
    const res = await COSMOS_ITEM_CREATE(
      patchReq({ workspaceId: WS, displayName: 'New LH', state: { notes: 'hello' } }) as any,
      { params: Promise.resolve({ type: 'lakehouse' }) } as any,
    );
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    expect(created[0].state).toEqual({ notes: 'hello' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PAIRED POSITIVES — the guard must not break the ordinary save.
// ───────────────────────────────────────────────────────────────────────────
describe('#4619 — ordinary item-state updates still succeed', () => {
  it('ALLOWS a save that round-trips the scope unchanged, and lands the real edit', async () => {
    // This is the `{ ...item.state, oneField: x }` pattern behind every editor.
    // FAILS IF the rule becomes reject-on-PRESENCE rather than reject-on-CHANGE:
    // `replaced` goes to 0 and every one of ~400 updateOwnedItem call sites that
    // touches a provisioned item breaks.
    const res = await updateOwnedItem(LH_ID, 'lakehouse', TENANT, {
      state: { ...lakehouseDoc().state, notes: 'edited by the user' },
    });

    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.notes).toBe('edited by the user');
    expect(replaced[0].state.provisioning).toEqual(SERVER_SCOPE);
    // Round-trip: the reader still derives the SERVER scope after a caller write.
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.abfss).toBe(SERVER_SCOPE.secondaryIds.adlsRoot);
  });

  it('ALLOWS a save whose scope object is KEY-REORDERED but value-identical', async () => {
    // FAILS IF the comparison is JSON.stringify rather than stableStringify: a
    // client that re-serialises state would be refused for changing nothing.
    const { adlsRoot, rootPath, container, backend } = SERVER_SCOPE.secondaryIds;
    const res = await updateOwnedItem(LH_ID, 'lakehouse', TENANT, {
      state: {
        ...lakehouseDoc().state,
        provisioning: {
          at: SERVER_SCOPE.at,
          resourceId: SERVER_SCOPE.resourceId,
          status: SERVER_SCOPE.status,
          secondaryIds: { rootPath, adlsRoot, backend, container },
        },
      },
    });
    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
  });

  it('ALLOWS omitting the scope entirely (fail-safe: narrows, never widens)', async () => {
    // Omission is permitted by design. FAILS IF omission is made an error — that
    // would break every caller that builds a fresh state object.
    const res = await updateOwnedItem(LH_ID, 'lakehouse', TENANT, { state: { notes: 'fresh' } });
    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.provisioning).toBeUndefined();
    // And the resolver degrades to its deterministic branch, never to the
    // omitted-but-remembered value.
    expect(await resolveLakehouseAbfss(LH_ID, WS)).toBeNull(); // no LOOM_*_URL in this env
  });

  it('ALLOWS a NESTED storageAccount / container — the eventstream sink shape', async () => {
    // The measured collision that ruled out extending the depth-blind
    // SERVER_OWNED_STATE_KEYS instead: `app-direct-lake-replacement.ts:120-137`
    // puts both names inside an eventstream source's `config`, and
    // `eventstream-editor.tsx:1634` is the input a user types them into.
    // FAILS IF the rule is written by key NAME at any depth rather than at the
    // top level — `replaced` goes to 0 and that editor stops saving.
    DOCS.set(dkey('es-1', WS), {
      id: 'es-1', workspaceId: WS, itemType: 'eventstream', displayName: 'ES',
      state: { sources: [{ config: { storageAccount: 'acct-a', container: 'gold' } }] },
      createdAt: 'a', updatedAt: 'a',
    });
    const res = await updateOwnedItem('es-1', 'eventstream', TENANT, {
      state: { sources: [{ config: { storageAccount: 'acct-b', container: 'landing' } }] },
    });

    expect(res).not.toBeNull();
    expect(replaced).toHaveLength(1);
    expect(replaced[0].state.sources[0].config.storageAccount).toBe('acct-b');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PROMOTION — the path that WOULD have broken. `promote.ts` builds its patch
// from the SOURCE item and applies it to a DIFFERENT target.
// ───────────────────────────────────────────────────────────────────────────
describe('#4619 — carryServerDerivedScope keeps deployment-pipeline promotion working', () => {
  const sourceState = { notes: 'promoted definition', provisioning: structuredClone(SERVER_SCOPE), storageAccount: 'dlzacct' };
  const targetState = { notes: 'old', provisioning: structuredClone(REWRITTEN_SCOPE), storageAccount: 'targetacct' };

  it('the RAW source state would be refused against the target (the regression)', () => {
    // The arm that proves the exemption is needed rather than decorative. FAILS
    // IF the rule stops refusing a cross-item scope copy — at which point
    // carryServerDerivedScope is dead weight and should be deleted, not kept.
    expect(() => assertNoServerDerivedScopeChange(sourceState, targetState))
      .toThrow(ServerOwnedStateError);
  });

  it('the REBASED state is accepted and keeps the TARGET own scope', () => {
    // FAILS IF carryServerDerivedScope copies the source's value through, or
    // misses a key: the assert below throws.
    const rebased = carryServerDerivedScope(sourceState, targetState);
    expect(() => assertNoServerDerivedScopeChange(rebased, targetState)).not.toThrow();
    expect(rebased.provisioning).toEqual(REWRITTEN_SCOPE);   // the TARGET's own
    expect(rebased.storageAccount).toBe('targetacct');
    expect(rebased.notes).toBe('promoted definition');        // the promotion still happens
  });

  it('REMOVES the key when the target carries none', () => {
    // A freshly-created promotion target has no scope of its own; rebasing must
    // DELETE rather than leave the source's. FAILS IF the else-branch is dropped
    // — the assert then throws on an introduction.
    const rebased = carryServerDerivedScope(sourceState, { notes: 'brand new' });
    expect('provisioning' in rebased).toBe(false);
    expect('storageAccount' in rebased).toBe(false);
    expect(() => assertNoServerDerivedScopeChange(rebased, { notes: 'brand new' })).not.toThrow();
  });
});
