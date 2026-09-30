/**
 * A NEW lakehouse starts without the state keys that say where an item's files
 * are. Several create paths copy `state` from somewhere else, and those keys
 * describe the SOURCE item's location, not the new item's:
 *
 *   caller                                   state it passes
 *   promotion  (deployment-pipelines promote) { ...src.state, content }
 *   branch-out (admin git branch-out)         { ...it.state }
 *   Copilot    `item_create` tool             the tool's `state` argument
 *   bundle import, create arm                 the bundle's `doc.state`
 *   POST /api/cosmos-items/[type]             the request body's `state`
 *
 * The first three all go through `createOwnedItem`, so they are covered HERE at
 * that shared chokepoint, one arm per caller's state SHAPE. No arm drives the
 * caller's own route; a caller that stopped calling `createOwnedItem` would not
 * be seen by this file. The bundle arm drives `executeWorkspaceImport` itself,
 * and the POST arm drives the real route handler with the REAL auto-bind hook.
 *
 * WHAT IS OBSERVED. The document that reached the Cosmos mock (`created`, a deep
 * copy taken at write time, so a later in-memory edit cannot rewrite it), the
 * stored document after the write (`DOCS`), and the returned item. A status or
 * return value alone would pass for code that cleared the key only in memory.
 *
 * Auto-bind runs for real with an EMPTY provider list, so it reaches its
 * `unsupported` answer without calling any Azure control plane. That keeps the
 * create hook `clearServerOwnedLakehouseKeysOnCreate` in the path under test
 * instead of mocking it away.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const OID = 'owner-1';
const WS = 'ws-1';

const created: any[] = [];
const replaced: any[] = [];
const DOCS = new Map<string, any>();

vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => ({ claims: { oid: 'owner-1', upn: 'owner@contoso.com' } })),
  tenantScopeId: vi.fn(() => 'owner-1'),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(async () => ({
    items: {
      create: async (doc: any) => {
        created.push(structuredClone(doc));
        DOCS.set(`${doc.workspaceId}::${doc.id}`, structuredClone(doc));
        return { resource: doc };
      },
      query: () => ({ fetchAll: async () => ({ resources: [] }) }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: structuredClone(DOCS.get(`${pk}::${id}`)) }),
      replace: async (doc: any) => {
        replaced.push(structuredClone(doc));
        DOCS.set(`${doc.workspaceId}::${doc.id}`, structuredClone(doc));
        return { resource: doc };
      },
    }),
  })),
  // `createOwnedItem` reads the workspace in the caller's partition and accepts
  // it when `tenantId` equals the caller's oid; the mock echoes the partition.
  workspacesContainer: vi.fn(async () => ({
    item: (id: string, pk: string) => ({ read: async () => ({ resource: { id, tenantId: pk } }) }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
  foldersContainer: vi.fn(async () => ({ items: { create: vi.fn(async () => ({})) } })),
}));

vi.mock('@/lib/auth/workspace-access', () => ({
  resolveWorkspaceAccessByOid: vi.fn(async () => ({ canWrite: true, role: 'Owner' })),
  ambientAccessOptsFor: vi.fn(async () => ({})),
}));

// No provider matches, so `ensureAutoBinding` answers `unsupported` and never
// reaches Azure. The create hook runs BEFORE that lookup either way.
vi.mock('@/lib/azure/auto-bind-providers', () => ({ AUTO_BIND_PROVIDERS: [] }));

// The REAL `autoBindOnCreate`, wrapped so a test can see which items it was
// called for. Every call still runs the real hook.
vi.mock('@/lib/azure/auto-bind', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/azure/auto-bind')>();
  return { ...real, autoBindOnCreate: vi.fn(real.autoBindOnCreate) };
});

vi.mock('@/lib/azure/loom-search', () => ({
  upsertLoomDoc: vi.fn(async () => undefined),
  deleteLoomDoc: vi.fn(async () => undefined),
  docForItem: vi.fn(() => ({})),
}));
vi.mock('@/lib/azure/loom-data-products-search', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/loom-data-products-search')),
  upsertDataProductDoc: vi.fn(async () => undefined),
}));
vi.mock('@/lib/azure/governance-catalog-index', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/governance-catalog-index')),
  upsertGovernanceItem: vi.fn(async () => undefined),
}));
vi.mock('@/lib/azure/purview-autoonboard', async () => ({
  ...(await vi.importActual<any>('@/lib/azure/purview-autoonboard')),
  autoOnboardToPurview: vi.fn(async () => undefined),
}));
vi.mock('@/lib/events/webhook-emitter', async () => ({
  ...(await vi.importActual<any>('@/lib/events/webhook-emitter')),
  emitLoomEvent: vi.fn(() => undefined),
}));

import { createOwnedItem } from '../item-crud';
import { clearServerOwnedLakehouseKeysOnCreate, AUTO_BIND_STATE_KEY, autoBindOnCreate } from '@/lib/azure/auto-bind';
import { LAKEHOUSE_CREATE_CLEARED_STATE_KEYS } from '@/lib/azure/backing-name';
import { executeWorkspaceImport } from '@/lib/workspace/workspace-bundle-io';
import { POST as COSMOS_ITEM_CREATE } from '@/app/api/cosmos-items/[type]/route';

/** Every key a new lakehouse must not keep, lifted from the source constants. */
const CLEARED = [...LAKEHOUSE_CREATE_CLEARED_STATE_KEYS, AUTO_BIND_STATE_KEY];

/**
 * A lakehouse's state as another item carries it: every location key set, plus
 * two ordinary keys that must SURVIVE (so "state was emptied" cannot pass).
 */
function sourceLakehouseState(): Record<string, unknown> {
  return {
    lakehouseRoot: 'lakehouses/Sales--src-1',
    adlsContainer: 'gold',
    ownedContainers: ['gold'],
    provisioning: { status: 'created', secondaryIds: { container: 'gold', rootPath: 'lakehouses/Sales--src-1' } },
    storageAccount: 'dlzacct',
    autoBind: { provider: 'adls', backingName: 'Sales--src-1' },
    notes: 'kept',
    tables: ['orders'],
  };
}

function keysPresent(state: Record<string, unknown> | undefined): string[] {
  return CLEARED.filter((k) => Object.prototype.hasOwnProperty.call(state || {}, k));
}

const session = { claims: { oid: OID, upn: 'owner@contoso.com' } } as any;

beforeEach(() => {
  created.length = 0;
  replaced.length = 0;
  DOCS.clear();
  vi.mocked(autoBindOnCreate).mockClear();
});

describe('the cleared-key list', () => {
  // FAILS IF a key is dropped from `LAKEHOUSE_CREATE_CLEARED_STATE_KEYS` or the
  // auto-bind record key is renamed: every other arm lifts its expectation from
  // these constants, so this literal list is what stops them all shrinking
  // together.
  it('names the location keys, the installer receipt, the account and the auto-bind record', () => {
    expect([...CLEARED].sort()).toEqual(
      ['adlsContainer', 'autoBind', 'lakehouseRoot', 'ownedContainers', 'provisioning', 'storageAccount'],
    );
    expect(keysPresent(sourceLakehouseState()).sort(), 'the fixture must carry every cleared key').toEqual([...CLEARED].sort());
  });
});

describe('createOwnedItem, lakehouse', () => {
  const shapes: Array<[string, () => Record<string, unknown>]> = [
    ['promotion copies the source state and adds content', () => ({ ...sourceLakehouseState(), content: 'promoted' })],
    ['branch-out copies the source state', () => ({ ...sourceLakehouseState() })],
    ['the Copilot tool passes its state argument', () => sourceLakehouseState()],
  ];

  // FAILS IF `createOwnedItem` writes a lakehouse's copied state as given: the
  // written document (`created[0]`) then carries all six keys. It is the WRITTEN
  // document that is read, so a strip applied only after the write (the create
  // hook) does not satisfy this arm. The ordinary keys are the positive half:
  // an implementation that wrote `{}` fails on them.
  it.each(shapes)('%s: the written item has none of the location keys', async (_label, shape) => {
    const state = shape();
    const res = await createOwnedItem(session, 'lakehouse', { workspaceId: WS, displayName: 'Sales', state });
    expect(res.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(keysPresent(created[0].state)).toEqual([]);
    expect(created[0].state).toMatchObject({ notes: 'kept', tables: ['orders'] });
    if ('content' in state) expect(created[0].state.content).toBe('promoted');
    expect(keysPresent((res as any).item.state)).toEqual([]);
    // The caller's object is not edited in place.
    expect(keysPresent(state).sort()).toEqual([...CLEARED].sort());
  });

  // POSITIVE CONTROL for the type check. FAILS IF the strip runs for every item
  // type: a warehouse's state is not a lakehouse location and must be written
  // as given, key for key.
  it('writes another item type\'s state unchanged', async () => {
    const res = await createOwnedItem(session, 'warehouse', {
      workspaceId: WS, displayName: 'Sales WH', state: sourceLakehouseState(),
    });
    expect(res.ok).toBe(true);
    expect(created[0].state).toEqual(sourceLakehouseState());
    expect(replaced).toEqual([]);
  });
});

describe('bundle import, create arm', () => {
  const target = { id: WS, tenantId: OID } as any;
  const plan = (docs: any[]) => ({
    strategy: 'skip-existing',
    foldersToCreate: [],
    foldersReused: 0,
    idMap: {},
    refsRemapped: 0,
    items: docs.map((doc) => ({ action: 'create', doc })),
  }) as any;

  // FAILS IF the create arm writes `planned.doc` as exported: the written
  // lakehouse then carries the bundle source's six keys. The warehouse beside it
  // is the positive twin and FAILS IF the strip is applied regardless of type.
  it('writes a bundled lakehouse without the location keys and other types unchanged', async () => {
    const now = '2026-09-29T12:00:00.000Z';
    await executeWorkspaceImport(plan([
      { id: 'lh-new', workspaceId: WS, itemType: 'lakehouse', displayName: 'Sales', state: sourceLakehouseState(), createdAt: now, updatedAt: now },
      { id: 'wh-new', workspaceId: WS, itemType: 'warehouse', displayName: 'Sales WH', state: sourceLakehouseState(), createdAt: now, updatedAt: now },
    ]), target);
    expect(created.map((d) => d.id)).toEqual(['lh-new', 'wh-new']);
    expect(keysPresent(created[0].state)).toEqual([]);
    expect(created[0].state).toMatchObject({ notes: 'kept', tables: ['orders'] });
    expect(created[1].state).toEqual(sourceLakehouseState());
  });

  // FAILS IF the create arm does not bind the imported lakehouse (0 calls: its
  // root would wait for a first open), or binds every imported type (2 calls,
  // the warehouse too). The item bound is the one written, with no location
  // keys, so the bind starts from this item and not the bundle's source.
  it('binds the imported lakehouse, and only the lakehouse, once it is written', async () => {
    const now = '2026-09-29T12:00:00.000Z';
    await executeWorkspaceImport(plan([
      { id: 'lh-new', workspaceId: WS, itemType: 'lakehouse', displayName: 'Sales', state: sourceLakehouseState(), createdAt: now, updatedAt: now },
      { id: 'wh-new', workspaceId: WS, itemType: 'warehouse', displayName: 'Sales WH', state: sourceLakehouseState(), createdAt: now, updatedAt: now },
    ]), target);
    const calls = vi.mocked(autoBindOnCreate).mock.calls;
    expect(calls.map(([item]) => item.id)).toEqual(['lh-new']);
    expect(keysPresent(calls[0][0].state as Record<string, unknown>)).toEqual([]);
  });
});

describe('clearServerOwnedLakehouseKeysOnCreate', () => {
  function stored(state: Record<string, unknown>) {
    const doc = { id: 'lh-9', workspaceId: WS, itemType: 'lakehouse', displayName: 'Sales', state };
    DOCS.set(`${WS}::lh-9`, structuredClone(doc));
    return doc as any;
  }

  // FAILS IF the helper returns early or skips the write: `replaced` is then
  // empty and the stored doc keeps its keys. FAILS IF it edits only the stored
  // doc: the returned item keeps them. `notes` is the positive half on both.
  it('removes the keys from the returned item AND the stored document', async () => {
    const item = stored(sourceLakehouseState());
    const out = await clearServerOwnedLakehouseKeysOnCreate(item);
    expect(out).toBe(true);
    expect(keysPresent(item.state)).toEqual([]);
    expect(item.state).toMatchObject({ notes: 'kept', tables: ['orders'] });
    expect(replaced).toHaveLength(1);
    const after = DOCS.get(`${WS}::lh-9`);
    expect(keysPresent(after.state)).toEqual([]);
    expect(after.state).toMatchObject({ notes: 'kept', tables: ['orders'] });
  });

  // FAILS IF the helper writes even when it removed nothing (a replace per
  // create), or acts on a non-lakehouse.
  it('writes nothing when there is nothing to remove, or for another type', async () => {
    const clean = stored({ notes: 'kept' });
    expect(await clearServerOwnedLakehouseKeysOnCreate(clean)).toBe(false);
    const wh = { ...stored(sourceLakehouseState()), itemType: 'warehouse' };
    expect(await clearServerOwnedLakehouseKeysOnCreate(wh)).toBe(false);
    expect(replaced).toEqual([]);
    expect(keysPresent(wh.state).sort()).toEqual([...CLEARED].sort());
  });
});

describe('POST /api/cosmos-items/lakehouse', () => {
  const post = (body: unknown) => COSMOS_ITEM_CREATE(
    new Request('http://x/api/cosmos-items/lakehouse', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as any,
    { params: Promise.resolve({ type: 'lakehouse' }) } as any,
  );

  // The route refuses the five location keys in a create body with a 400 before
  // anything is written (`assertNoServerDerivedScopeChange`), so the only
  // cleared key a body can still carry to the write is `autoBind`.
  //
  // FAILS IF the route stops refusing: a 200 and a written document.
  it('refuses a create body that names a location key, and writes nothing', async () => {
    const res = await post({ workspaceId: WS, displayName: 'Sales', state: { lakehouseRoot: 'lakehouses/x', notes: 'kept' } });
    expect(res.status).toBe(400);
    expect(created).toEqual([]);
  });

  // FAILS IF `autoBindOnCreate` no longer runs the create hook: the route writes
  // the body's state as given (`created[0]` DOES carry `autoBind`, which is
  // asserted, so the arm cannot pass vacuously), and then neither the response
  // nor the stored document is cleaned.
  it('answers with, and stores, a lakehouse without the auto-bind record the body carried', async () => {
    const { autoBind, notes, tables } = sourceLakehouseState();
    const res = await post({ workspaceId: WS, displayName: 'Sales', state: { autoBind, notes, tables } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(keysPresent(created[0].state), 'the route writes the body state first').toEqual(['autoBind']);
    expect(keysPresent(body.item.state)).toEqual([]);
    expect(body.item.state).toMatchObject({ notes: 'kept', tables: ['orders'] });
    const after = DOCS.get(`${WS}::${body.item.id}`);
    expect(keysPresent(after.state)).toEqual([]);
    expect(after.state).toMatchObject({ notes: 'kept', tables: ['orders'] });
  });
});
