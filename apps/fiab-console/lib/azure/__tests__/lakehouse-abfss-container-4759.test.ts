/**
 * #4759 — a lakehouse created via New item is rooted in the container AUTO-BIND
 * chose, and `resolveLakehouseAbfss` must answer that same container.
 *
 * THE DEFECT. `lakehouseAutoBind.preflight` created the root in `landing`
 * (preferred since 2026-08-22), while the resolver never read the binding
 * auto-bind persisted (`state.adlsContainer` / `state.lakehouseRoot`) and fell
 * back to the first configured container in `KNOWN_CONTAINERS` order —
 * `bronze`. `/api/lakehouse/paths` therefore listed `bronze/lakehouses/<name>`
 * and every first open 404'd. Live receipt on the issue: 102 CreatePathDir in
 * `landing`, 139 ListFilesystemDir 404s in `bronze`, zero listings in `landing`.
 *
 * Later sections pin how a found or recorded root is checked against this item:
 * each lakehouse keeps its own directory (`lakehouses/<name>--<id>`), marked
 * with its id, and an older item's name-only root is used only when no other
 * item records or could derive the same location.
 *
 * WHAT EACH TEST PINS, AND THE VALUE THAT BREAKS IT — stated per `it` below.
 *
 * Instrument: the REAL `lakehouseAutoBind` provider and the REAL resolver.
 * Only Cosmos (an in-memory doc map) and the storage account (directory
 * properties, create and metadata) are faked; `configuredContainerNames` and
 * `resolveAbfssRoot` are the real ones and read the LOOM_*_URL env this file
 * sets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const DOCS = new Map<string, any>();
const replaced: Array<{ doc: any; opts: any }> = [];
const dkey = (id: string, pk: string) => `${pk}::${id}`;
/** When set, the other-lakehouses read (`listLakehouseRootFacts`) rejects. */
let QUERY_FAILS = false;
/** The text of every other-lakehouses query run. */
const QUERIES: string[] = [];
/** The filter `listLakehouseRootFacts` adds when recycled items are left out. */
const RECYCLED_FILTER = 'c.state._recycled = null';

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    // `listLakehouseRootFacts`: every lakehouse's root facts, projected the way
    // its SELECT projects them. Recycled items are left out only when the query
    // text carries the recycled filter, so a query that drops them is seen.
    items: {
      query: (spec: { query: string } | string) => ({
        fetchAll: async () => {
          const text = typeof spec === 'string' ? spec : spec.query;
          QUERIES.push(text);
          if (QUERY_FAILS) throw Object.assign(new Error('cosmos unavailable'), { code: 503 });
          const resources = [...DOCS.values()]
            .filter((d) => d.itemType === 'lakehouse')
            .filter((d) => !(text.includes(RECYCLED_FILTER) && d.state?._recycled))
            .map((d) => ({
              id: d.id,
              workspaceId: d.workspaceId,
              displayName: d.displayName,
              createdAt: d.createdAt,
              lakehouseRoot: d.state?.lakehouseRoot,
              adlsContainer: d.state?.adlsContainer,
              storageAccount: d.state?.storageAccount,
              provAdlsRoot: d.state?.provisioning?.secondaryIds?.adlsRoot,
              provContainer: d.state?.provisioning?.secondaryIds?.container,
              provRootPath: d.state?.provisioning?.secondaryIds?.rootPath,
              recycled: d.state?._recycled,
            }));
          return { resources };
        },
      }),
    },
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: DOCS.has(dkey(id, pk)) ? structuredClone(DOCS.get(dkey(id, pk))) : undefined }),
      replace: async (doc: any, opts?: any) => {
        replaced.push({ doc: structuredClone(doc), opts });
        DOCS.set(dkey(id, pk), structuredClone(doc));
        return { resource: doc };
      },
    }),
  }),
}));

/** `<container>/<path>` pairs the fake storage account holds. */
const EXISTING = new Set<string>();
/** `<container>/<path>` → the ownership marker that directory carries. */
const OWNERS = new Map<string, string>();
/** Containers whose probe fails with a non-404 status. */
const FAILING = new Map<string, number>();
/** Containers whose probe never answers — it settles only when its signal aborts. */
const HANGING = new Set<string>();
/** Every probe made: `<container>/<path>` and the abort signal it carried. */
const PROBES: Array<{ at: string; signal: unknown }> = [];
/** When non-zero, every directory create is refused with this status. */
let CREATE_FAILS = 0;
/** The etag every existing directory reports; a stamp must carry it. */
const DIR_ETAG = '"dir-etag"';

/**
 * Every directory create: `[container, path, marker]` (marker null when none is
 * written). A create over an existing directory with `ifNoneMatch: '*'` is
 * refused with 409, as ADLS refuses it.
 */
const CREATES: Array<[string, string, string | null]> = [];
/** Every marker written onto an existing directory: `[container, path, marker, ifMatch]`. */
const STAMPS: Array<[string, string, string | null, string | undefined]> = [];

function fakeCreate(container: string, path: string, marker: string | null, ifNoneMatch: boolean) {
  CREATES.push([container, path, marker]);
  if (CREATE_FAILS) {
    return Promise.reject(Object.assign(new Error('storage unavailable'), { statusCode: CREATE_FAILS }));
  }
  const at = `${container}/${path}`;
  if (EXISTING.has(at) && ifNoneMatch) {
    return Promise.reject(Object.assign(new Error('PathAlreadyExists'), { statusCode: 409 }));
  }
  EXISTING.add(at);
  if (marker) OWNERS.set(at, marker);
  return Promise.resolve({});
}

vi.mock('@/lib/azure/adls-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/azure/adls-client')>();
  return {
    ...real,
    getMetadata: async (container: string, path: string) => ({ exists: EXISTING.has(`${container}/${path}`) }),
    createDirectory: async (container: string, path: string) => {
      await fakeCreate(container, path, null, false);
      return { ok: true };
    },
    getServiceClient: () => ({
      getFileSystemClient: (container: string) => ({
        getDirectoryClient: (path: string) => ({
          create: (opts?: { metadata?: Record<string, string>; conditions?: { ifNoneMatch?: string } }) =>
            fakeCreate(container, path, opts?.metadata?.loomitemid ?? null, opts?.conditions?.ifNoneMatch === '*'),
          // The marker write: refused unless the directory exists and the
          // caller names the etag it read, as ADLS refuses a stale If-Match.
          setMetadata: (md: Record<string, string>, opts?: { conditions?: { ifMatch?: string } }) => {
            const at = `${container}/${path}`;
            const ifMatch = opts?.conditions?.ifMatch;
            STAMPS.push([container, path, md?.loomitemid ?? null, ifMatch]);
            if (!EXISTING.has(at) || ifMatch !== DIR_ETAG) {
              return Promise.reject(Object.assign(new Error('ConditionNotMet'), { statusCode: 412 }));
            }
            if (md?.loomitemid) OWNERS.set(at, md.loomitemid);
            return Promise.resolve({});
          },
        }),
        getFileClient: (path: string) => ({
          getProperties: (opts?: { abortSignal?: AbortSignal }) => {
            PROBES.push({ at: `${container}/${path}`, signal: opts?.abortSignal });
            const status = FAILING.get(container);
            if (status) return Promise.reject(Object.assign(new Error('denied'), { statusCode: status }));
            if (HANGING.has(container)) {
              return new Promise((_resolve, reject) => {
                const s = opts?.abortSignal;
                if (!s) return; // no signal: hangs forever — exactly the defect
                s.addEventListener('abort', () =>
                  reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
              });
            }
            const at = `${container}/${path}`;
            return EXISTING.has(at)
              ? Promise.resolve({ metadata: OWNERS.has(at) ? { loomitemid: OWNERS.get(at) } : {}, etag: DIR_ETAG })
              : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
          },
        }),
      }),
    }),
  };
});

import {
  resolveLakehouseAbfss,
  resolveLakehouseStorage,
  lakehouseStorageWithheldMessage,
  listLakehouseRootFacts,
  PROBE_TIMEOUT_MS,
} from '@/lib/azure/lakehouse-abfss';
import { lakehouseAutoBind } from '@/lib/azure/auto-bind-providers';
import { ensureAutoBinding, type AutoBindContext } from '@/lib/azure/auto-bind';
import { LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE } from '@/lib/admin/env-checks/lakehouse-shared-roots';

const ENV: Record<string, string> = {
  bronze: 'LOOM_BRONZE_URL',
  silver: 'LOOM_SILVER_URL',
  gold: 'LOOM_GOLD_URL',
  landing: 'LOOM_LANDING_URL',
  'csv-imports': 'LOOM_CSV_IMPORTS_URL',
};
const ALL_FIVE = Object.keys(ENV);
const SAVED: Record<string, string | undefined> = {};

function configure(containers: string[]) {
  for (const [c, v] of Object.entries(ENV)) {
    if (containers.includes(c)) process.env[v] = `https://dlzacct.dfs.core.windows.net/${c}`;
    else delete process.env[v];
  }
}

const LH_ID = 'lh-4759';
const WS = 'ws-4759';
const NAME = 'Sales Lake';
/** `lakehouseRootPath('Sales Lake', id)` — written literally, not recomputed.
 *  The name-only root an item created BEFORE `LAKEHOUSE_ITEM_ROOT_SINCE` used. */
const ROOT = 'lakehouses/Sales Lake';
/** `lakehouseItemRootPath('Sales Lake', id)`, literally — the item's own root. */
const ITEM_ROOT = 'lakehouses/Sales Lake--lh-4759';
/** A `createdAt` before the cutover and one after it. */
const BEFORE_CUTOVER = '2026-09-01T00:00:00.000Z';
const AFTER_CUTOVER = '2026-09-29T12:00:00.000Z';
const PERSIST = { persist: true } as const;
/** The probe list for a pre-cutover item: its item root, then its name root, per container. */
const both = (...containers: string[]) => containers.flatMap((c) => [`${c}/${ITEM_ROOT}`, `${c}/${ROOT}`]);

function putItem(state: Record<string, unknown>, createdAt = BEFORE_CUTOVER) {
  DOCS.set(dkey(LH_ID, WS), {
    id: LH_ID, workspaceId: WS, itemType: 'lakehouse', displayName: NAME, state,
    createdAt, updatedAt: createdAt, _etag: '"etag-1"',
  });
}

function ctx(state: Record<string, unknown> = {}): AutoBindContext {
  return { itemId: LH_ID, itemType: 'lakehouse', displayName: NAME, workspaceId: WS, state };
}

const probes = () => PROBES.map((p) => p.at);

beforeEach(() => {
  for (const v of Object.values(ENV)) SAVED[v] = process.env[v];
  DOCS.clear();
  replaced.length = 0;
  EXISTING.clear();
  OWNERS.clear();
  CREATES.length = 0;
  STAMPS.length = 0;
  QUERIES.length = 0;
  QUERY_FAILS = false;
  CREATE_FAILS = 0;
  FAILING.clear();
  HANGING.clear();
  PROBES.length = 0;
  configure(ALL_FIVE);
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('#4759 — the resolver reads the container auto-bind created in', () => {
  it('resolves the persisted auto-bind binding, with no storage read', async () => {
    // The item exactly as New item leaves it: preflight picks the container,
    // create makes the root there, stateKeys is what gets persisted.
    const pre = await lakehouseAutoBind.preflight(ctx());
    if (!pre.ok) throw new Error('fixture: preflight refused with all five containers configured');
    const created = pre.coords.container;
    const name = lakehouseAutoBind.backingNameFor(ctx()).name;
    // Fixture arithmetic, asserted: the defect only shows when these differ
    // from the legacy fallback (`bronze`), so pin that they do.
    expect(created).toBe('landing');
    expect(name).toBe(ITEM_ROOT);
    EXISTING.add(`${created}/${name}`);
    putItem({ ...lakehouseAutoBind.stateKeys(name, pre.coords) }, AFTER_CUTOVER);

    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    // FAILS IF step 2c is not read: 'bronze' (the pre-#4759 fallback).
    expect(r?.container).toBe(created);
    expect(r?.root).toBe(ITEM_ROOT);
    expect(r?.abfss).toBe('abfss://landing@dlzacct.dfs.core.windows.net/lakehouses/Sales Lake--lh-4759');
    // FAILS IF the recorded item root is probed or checked against other items.
    expect(probes()).toEqual([]);
    expect(QUERIES).toEqual([]);
    expect(replaced).toEqual([]);
  });

  it.each([
    [['bronze', 'silver'], 'bronze'],
    [['gold'], 'gold'],
    [['silver', 'landing'], 'landing'],
    [ALL_FIVE, 'landing'],
  ])('with only %j configured, create and resolve agree on %s for a root-less item', async (configured, expected) => {
    configure(configured);
    const pre = await lakehouseAutoBind.preflight(ctx());
    if (!pre.ok) throw new Error('fixture: preflight refused');
    // Pin preflight's own answer literally, so this cannot pass by both sides
    // drifting together.
    expect(pre.coords.container).toBe(expected);
    putItem({}, AFTER_CUTOVER);
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    // FAILS for ['silver','landing'] if the resolver answers first-configured
    // ('silver'), and for all five if it answers 'bronze'.
    expect(r?.container).toBe(pre.coords.container);
    expect(r?.root).toBe(ITEM_ROOT);
  });
});

describe('#4759 — an item with NO persisted binding is found, not guessed', () => {
  it('finds a pre-cutover name root in landing and, when the caller opts in, marks and records it', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    // FAILS IF the walk stops at the legacy container: 'bronze'.
    expect(r?.container).toBe('landing');
    expect(r?.root).toBe(ROOT);
    // Legacy container probed FIRST, then auto-bind's order; item root before
    // name root in each.
    expect(probes()).toEqual(both('bronze', 'landing'));
    // The unmarked root is marked for this item, conditional on the etag read.
    // FAILS IF the persisting resolve does not stamp it (STAMPS empty).
    expect(STAMPS).toEqual([['landing', ROOT, LH_ID, DIR_ETAG]]);
    expect(OWNERS.get(`landing/${ROOT}`)).toBe(LH_ID);
    // What was found is recorded, so the next resolve takes step 2c ...
    expect(replaced).toHaveLength(1);
    expect(replaced[0].doc.state).toMatchObject({ adlsContainer: 'landing', lakehouseRoot: ROOT });
    // ... conditionally on the item not having changed since it was read.
    // FAILS IF the write drops its IfMatch (a concurrent edit would be lost).
    expect(replaced[0].opts).toEqual({ accessCondition: { type: 'IfMatch', condition: '"etag-1"' } });
    // The next resolve reads the marker of the recorded root and nothing else.
    // FAILS IF a marked recorded root still reads the other items (QUERIES grows).
    PROBES.length = 0;
    const queriesBefore = QUERIES.length;
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('landing');
    expect(probes()).toEqual([`landing/${ROOT}`]);
    expect(QUERIES.length).toBe(queriesBefore);
  });

  it('a DEFAULT call writes nothing, even when it finds the root', async () => {
    // FAILS IF `persist` defaults to true: the resolver is reached from read
    // routes and must not write unless the caller opts in.
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    // Paired positive — the answer is still right; only the writes are withheld.
    expect(r?.container).toBe('landing');
    expect(replaced).toEqual([]);
    expect(STAMPS).toEqual([]);
    expect(CREATES).toEqual([]);
    // Nothing was recorded, so the next resolve probes again.
    PROBES.length = 0;
    await resolveLakehouseAbfss(LH_ID, WS);
    expect(probes()).toEqual(both('bronze', 'landing'));
  });

  it('with no root anywhere, a persisting open creates the item\'s own root where auto-bind would', async () => {
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    // FAILS IF the resolver answers the legacy container when nothing is found
    // ('bronze'), or the name root for a pre-cutover item.
    expect(r?.container).toBe('landing');
    expect(r?.root).toBe(ITEM_ROOT);
    expect(probes()).toHaveLength(2 * ALL_FIVE.length);
    // FAILS IF the first open only answers: no create, nothing recorded, and
    // the item's first write lands in a directory nobody marked.
    expect(CREATES).toEqual([['landing', ITEM_ROOT, LH_ID]]);
    expect(replaced.map((x) => [x.doc.state.adlsContainer, x.doc.state.lakehouseRoot])).toEqual([['landing', ITEM_ROOT]]);
    // The next resolve takes the recorded item root with no storage read.
    PROBES.length = 0;
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.root).toBe(ITEM_ROOT);
    expect(probes()).toEqual([]);
  });

  it('with no root anywhere, a DEFAULT call answers the same place and creates nothing', async () => {
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect([r?.container, r?.root]).toEqual(['landing', ITEM_ROOT]);
    // FAILS IF the create runs without `persist`.
    expect(CREATES).toEqual([]);
    expect(replaced).toEqual([]);
  });

  // Auto-bind at create can end in `retry` (a transient storage error). FAILS
  // IF the resolver's first open does not create the root the retry left
  // missing: CREATES would hold only the refused attempt, and nothing is
  // recorded or marked.
  it('an auto-bind that ends in retry leaves no root, and the first open creates it', async () => {
    CREATE_FAILS = 503;
    const out = await ensureAutoBinding(ctx());
    expect(out.status).toBe('retry');
    expect(EXISTING.size).toBe(0);
    putItem({}, AFTER_CUTOVER);
    CREATE_FAILS = 0;
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect([r?.container, r?.root]).toEqual(['landing', ITEM_ROOT]);
    expect(CREATES).toEqual([['landing', ITEM_ROOT, LH_ID], ['landing', ITEM_ROOT, LH_ID]]);
    expect(EXISTING.has(`landing/${ITEM_ROOT}`)).toBe(true);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe(LH_ID);
    expect(replaced.map((x) => x.doc.state.lakehouseRoot)).toEqual([ITEM_ROOT]);
  });

  it('GUARD: a legacy bronze-rooted lakehouse still resolves to bronze', async () => {
    // FAILS IF the fallback is flipped to landing-first without probing, which
    // would answer 'landing' here and orphan the item's data.
    EXISTING.add(`bronze/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('bronze');
    expect(r?.abfss).toBe('abfss://bronze@dlzacct.dfs.core.windows.net/lakehouses/Sales Lake');
    expect(probes()).toEqual(both('bronze'));
    expect(replaced[0].doc.state).toMatchObject({ adlsContainer: 'bronze', lakehouseRoot: ROOT });
  });

  it('GUARD: the legacy container is probed before auto-bind\'s order', async () => {
    // FAILS IF the probe walks auto-bind's order (landing first) before the
    // legacy container: the answer would be 'landing'.
    EXISTING.add(`bronze/${ROOT}`);
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('bronze');
    expect(probes()).toEqual(both('bronze'));
  });

  it('GUARD: a FAILED probe returns the legacy answer and persists nothing', async () => {
    // FAILS IF a 403 is treated as "absent": the walk would find landing and
    // answer (and persist) 'landing' on evidence it never had.
    FAILING.set('bronze', 403);
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    expect((await resolveLakehouseAbfss(LH_ID, WS, PERSIST))?.container).toBe('bronze');
    expect(probes()).toEqual([`bronze/${ITEM_ROOT}`]);
    expect(replaced).toEqual([]);
    expect(CREATES).toEqual([]);
  });

  it('every probe carries an abort signal', async () => {
    // FAILS IF the signal is dropped from the probe: an unreachable account
    // then retries with backoff and the caller hangs (see the next test).
    putItem({});
    await resolveLakehouseAbfss(LH_ID, WS);
    expect(PROBES).toHaveLength(2 * ALL_FIVE.length);
    for (const p of PROBES) expect(p.signal).toBeInstanceOf(AbortSignal);
  });

  it(`a HANGING probe is cut off at PROBE_TIMEOUT_MS and treated as failed`, async () => {
    // Real timers, deliberately: this is the bound itself, not a mock of it.
    // FAILS (test times out) if the probe carries no signal, and answers
    // 'landing' if a timed-out probe is treated as "absent".
    expect(PROBE_TIMEOUT_MS).toBe(6000);
    HANGING.add('bronze');
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const t0 = Date.now();
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    const took = Date.now() - t0;
    expect(r?.container).toBe('bronze');
    expect(probes()).toEqual([`bronze/${ITEM_ROOT}`]);
    expect(replaced).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 250);
    expect(took).toBeLessThan(PROBE_TIMEOUT_MS + 4000);
  }, 20_000);

  it('keeps the declared ownedContainers order when nothing is found', async () => {
    // FAILS IF the owned list is re-ordered through auto-bind's preference
    // (the answer would be 'bronze').
    putItem({ ownedContainers: ['gold', 'bronze'] });
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect([r?.container, r?.root]).toEqual(['gold', ITEM_ROOT]);
    expect(probes()).toEqual(both('gold', 'bronze'));
  });

  it('returns null, and probes nothing, when no LOOM_*_URL is configured', async () => {
    configure([]);
    putItem({});
    expect(await resolveLakehouseAbfss(LH_ID, WS)).toBeNull();
    expect(probes()).toEqual([]);
  });
});

describe('#4759 — step 2c accepts only the binding shape auto-bind writes', () => {
  // The paired POSITIVE for the refusals below, and the record-over-date rule:
  // a recorded name-only root is used whatever the item's createdAt. FAILS for
  // the AFTER_CUTOVER row IF the item's age decides whether a recorded root is
  // used: that item would be answered its item root in `landing`.
  it.each([
    ['before', BEFORE_CUTOVER],
    ['after', AFTER_CUTOVER],
  ])('honours a well-formed recorded name root for an item created %s the cutover', async (_label, createdAt) => {
    EXISTING.add('gold/lakehouses/Old Name');
    putItem({ adlsContainer: 'gold', lakehouseRoot: 'lakehouses/Old Name' }, createdAt);
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r).toEqual({
      ok: true,
      bound: { abfss: 'abfss://gold@dlzacct.dfs.core.windows.net/lakehouses/Old Name', container: 'gold', root: 'lakehouses/Old Name' },
    });
    // Only the recorded root's marker is read; no walk.
    expect(probes()).toEqual(['gold/lakehouses/Old Name']);
  });

  it.each([
    ['gold', 'finance/reports'],          // outside lakehouses/
    ['gold', 'lakehouses/'],              // the whole lakehouses/ tree
    ['gold', 'lakehouses/../finance'],    // traversal
    ['gold', 'lakehouses//x'],            // not a sanitiser fixpoint
    ['not-a-container', 'lakehouses/x'],  // unknown container
  ])('ignores adlsContainer=%s lakehouseRoot=%s and falls back to the item root', async (c, root) => {
    // FAILS IF the shape check (or the known-container check) is removed:
    // the resolver would answer `${c}/${root}` instead.
    putItem({ adlsContainer: c, lakehouseRoot: root });
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect(r?.root).toBe(ITEM_ROOT);
    expect(r?.container).toBe('landing');
  });
});

describe('#4759 — preflight still honours an item\'s pinned container', () => {
  it('pins gold when gold is configured, and ignores an unconfigured pin', async () => {
    // FAILS IF `pinned` is dropped from lakehouseContainerOrder: 'landing'.
    const pinned = await lakehouseAutoBind.preflight(ctx({ adlsContainer: 'gold' }));
    expect(pinned.ok && pinned.coords.container).toBe('gold');
    configure(['bronze', 'landing']);
    const unconfigured = await lakehouseAutoBind.preflight(ctx({ adlsContainer: 'gold' }));
    expect(unconfigured.ok && unconfigured.coords.container).toBe('landing');
  });

  it('reports unavailable when no container is configured', async () => {
    configure([]);
    const pre = await lakehouseAutoBind.preflight(ctx());
    expect(pre.ok).toBe(false);
  });
});

describe('the lakehouse provider attaches only a root this item owns', () => {
  const OTHER = 'lh-someone-else';

  // Direct probe arms. Each pair differs in ONE value: the marker, or the record.
  it('probe: a root marked for another item is reported absent; one marked for this item is present', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, OTHER);
    // FAILS IF the probe is existence-only: true.
    expect(await lakehouseAutoBind.probe(ITEM_ROOT, { container: 'landing' }, ctx())).toBe(false);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    // FAILS IF the probe refuses its own marker: false.
    expect(await lakehouseAutoBind.probe(ITEM_ROOT, { container: 'landing' }, ctx())).toBe(true);
  });

  it('probe: an unmarked name root is present only when it is the root this item has on record', async () => {
    EXISTING.add(`landing/${ROOT}`);
    // FAILS IF an unmarked name root is adopted without a record (true here).
    expect(await lakehouseAutoBind.probe(ROOT, { container: 'landing' }, ctx())).toBe(false);
    // FAILS IF an existing item's unmarked recorded root is no longer
    // recognised (false here): the item would be given a new, empty root.
    expect(await lakehouseAutoBind.probe(ROOT, { container: 'landing' }, ctx({ lakehouseRoot: ROOT }))).toBe(true);
    // Neither answer marks the name root.
    expect(STAMPS).toEqual([]);
  });

  // The item's OWN id-bearing root, unmarked (an older build created it without
  // a marker). FAILS IF the probe refuses it (false: auto-bind then tries to
  // create over it and ends in retry), or does not mark it (OWNERS unset).
  // The second arm FAILS IF adoption accepts any `--<id>` shaped root: another
  // item's unmarked item root is not this item's.
  it('probe: this item\'s own unmarked item root is present and gets marked; another item\'s is not', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    expect(await lakehouseAutoBind.probe(ITEM_ROOT, { container: 'landing' }, ctx())).toBe(true);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe(LH_ID);
    expect(STAMPS).toEqual([['landing', ITEM_ROOT, LH_ID, DIR_ETAG]]);
    const otherRoot = 'lakehouses/Sales Lake--lh-other';
    EXISTING.add(`landing/${otherRoot}`);
    expect(await lakehouseAutoBind.probe(otherRoot, { container: 'landing' }, ctx())).toBe(false);
    expect(OWNERS.has(`landing/${otherRoot}`)).toBe(false);
  });

  // Through the engine. FAILS IF a recorded root marked for another item is
  // kept: the answer would be via 'existing' at ROOT with no create.
  it('a recorded root marked for another item is not kept; this item gets its own root', async () => {
    EXISTING.add(`landing/${ROOT}`);
    OWNERS.set(`landing/${ROOT}`, OTHER);
    const out = await ensureAutoBinding(ctx({ adlsContainer: 'landing', lakehouseRoot: ROOT }));
    expect(out.status).toBe('bound');
    if (out.status !== 'bound') return;
    expect(out.record.backingName).toBe(ITEM_ROOT);
    expect(out.record.via).toBe('recreated');
    expect(CREATES).toEqual([['landing', ITEM_ROOT, LH_ID]]);
    expect(out.statePatch).toMatchObject({ adlsContainer: 'landing', lakehouseRoot: ITEM_ROOT });
    // The other item's directory is untouched.
    expect(OWNERS.get(`landing/${ROOT}`)).toBe(OTHER);
  });

  // Positive control for the arm above, differing only in the marker. FAILS IF
  // the marker rule also refuses an unmarked recorded root (via 'recreated'
  // and one create).
  it('a recorded unmarked root is kept, with no create', async () => {
    EXISTING.add(`landing/${ROOT}`);
    const out = await ensureAutoBinding(ctx({ adlsContainer: 'landing', lakehouseRoot: ROOT }));
    expect(out.status === 'bound' && [out.record.backingName, out.record.via]).toEqual([ROOT, 'existing']);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF the provider targets the name root: it would probe
  // `lakehouses/Sales Lake`, find nothing and create it (via 'created').
  it('an item root marked for this item is attached, with no create', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    const out = await ensureAutoBinding(ctx());
    expect(out.status === 'bound' && [out.record.backingName, out.record.via]).toEqual([ITEM_ROOT, 'attached']);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF this item's own unmarked item root is refused: the conditional
  // create is then refused with 409 and the outcome is not 'bound'. FAILS IF it
  // is attached without being marked (OWNERS unset).
  it('an unmarked directory at this item\'s own item root is attached and marked, with no create', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    const out = await ensureAutoBinding(ctx());
    expect(out.status === 'bound' && [out.record.backingName, out.record.via]).toEqual([ITEM_ROOT, 'attached']);
    expect(CREATES).toEqual([]);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe(LH_ID);
  });
});

describe('the resolver adopts a found root only when this item may use it', () => {
  /** Another lakehouse with this item's display name, in another workspace. */
  function putTwin(displayName = NAME, state: Record<string, unknown> = {}, createdAt = BEFORE_CUTOVER) {
    DOCS.set(dkey('lh-twin', 'ws-twin'), {
      id: 'lh-twin', workspaceId: 'ws-twin', itemType: 'lakehouse', displayName, state, createdAt,
    });
  }

  // FAILS IF an item root marked for another item is adopted: the answer would
  // be 'landing' (where that directory is). The resolver skips it, answers the
  // next preferred container, and a persisting open creates the root there.
  it('an item root marked for another item is skipped', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, 'lh-someone-else');
    putItem({}, AFTER_CUTOVER);
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('bronze');
    expect(r?.root).toBe(ITEM_ROOT);
    expect(CREATES).toEqual([['bronze', ITEM_ROOT, LH_ID]]);
    expect(replaced.map((x) => [x.doc.state.adlsContainer, x.doc.state.lakehouseRoot])).toEqual([['bronze', ITEM_ROOT]]);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe('lh-someone-else');
  });

  // Positive twin, differing only in the marker. FAILS IF the resolver refuses
  // its own marker (answer 'bronze').
  it('an item root marked for this item is adopted and persisted', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    putItem({}, AFTER_CUTOVER);
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('landing');
    expect(replaced.map((x) => [x.doc.state.adlsContainer, x.doc.state.lakehouseRoot])).toEqual([['landing', ITEM_ROOT]]);
    expect(STAMPS).toEqual([]);
    expect(CREATES).toEqual([]);
  });

  // The third marker value. FAILS IF this item's own UNMARKED item root is not
  // adopted: the walk then treats landing as held and answers 'bronze' (and a
  // persisting open creates a second, empty root there). The default call
  // answers the same and writes nothing.
  it('this item\'s own unmarked item root is adopted, and marked when the caller persists', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    putItem({}, AFTER_CUTOVER);
    const quiet = await resolveLakehouseAbfss(LH_ID, WS);
    expect([quiet?.container, quiet?.root]).toEqual(['landing', ITEM_ROOT]);
    expect(STAMPS).toEqual([]);
    expect(replaced).toEqual([]);
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect([r?.container, r?.root]).toEqual(['landing', ITEM_ROOT]);
    expect(STAMPS).toEqual([['landing', ITEM_ROOT, LH_ID, DIR_ETAG]]);
    expect(OWNERS.get(`landing/${ITEM_ROOT}`)).toBe(LH_ID);
    expect(replaced.map((x) => [x.doc.state.adlsContainer, x.doc.state.lakehouseRoot])).toEqual([['landing', ITEM_ROOT]]);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF a name-only root is adopted while another lakehouse derives the
  // same root: the answer would be 'landing', persisted.
  it('an unrecorded name root that another lakehouse also derives is not adopted', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    putTwin();
    expect(await resolveLakehouseAbfss(LH_ID, WS, PERSIST)).toBeNull();
    expect(replaced).toEqual([]);
    expect(STAMPS).toEqual([]);
  });

  // FAILS IF the other-lakehouses read leaves recycled items out: the recycled
  // twin's files are still in that directory until purge, and the answer
  // would be 'landing'. The query-text assertion FAILS IF the recycled filter
  // is appended.
  it('an unrecorded name root that a RECYCLED lakehouse also derives is not adopted', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    putTwin(NAME, { _recycled: { at: '2026-09-20T00:00:00.000Z', by: 'owner-1' } });
    expect(await resolveLakehouseStorage(LH_ID, WS, PERSIST)).toEqual({ ok: false, reason: 'root-shared' });
    expect(QUERIES.length).toBeGreaterThan(0);
    expect(QUERIES.filter((q) => q.includes(RECYCLED_FILTER))).toEqual([]);
    expect(replaced).toEqual([]);
  });

  // FAILS IF a failed read of the other items counts as "no other item": the
  // answer would be 'landing'.
  it('an unrecorded name root is not adopted when the other items cannot be read', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    QUERY_FAILS = true;
    expect(await resolveLakehouseStorage(LH_ID, WS, PERSIST)).toEqual({ ok: false, reason: 'root-unverified' });
    expect(replaced).toEqual([]);
  });

  // FAILS IF overlap is a string-prefix test: `lakehouses/Sales Lake-archive`
  // starts with `lakehouses/Sales Lake`, and the answer would be null.
  it('a lakehouse whose root only shares a string prefix does not block adoption', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    putTwin(`${NAME}-archive`);
    expect(`lakehouses/${NAME}-archive`.startsWith(ROOT)).toBe(true);
    expect((await resolveLakehouseAbfss(LH_ID, WS, PERSIST))?.container).toBe('landing');
    expect(replaced).toHaveLength(1);
  });

  // FAILS IF the overlap check also refuses a name root marked for THIS item
  // (the answer would be null).
  it('a name root marked for this item is adopted even when another lakehouse derives it', async () => {
    EXISTING.add(`landing/${ROOT}`);
    OWNERS.set(`landing/${ROOT}`, LH_ID);
    putItem({});
    putTwin();
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('landing');
    expect(QUERIES).toEqual([]);
  });
});

describe('a recorded location is used only when it is this item\'s own', () => {
  const OTHER_ID = 'lh-other';
  /** Another lakehouse's item root, literally: `lakehouseItemRootPath('Other', 'lh-other')`. */
  const OTHER_ITEM_ROOT = 'lakehouses/Other--lh-other';
  const OLD = 'lakehouses/Old Name';

  /** Another lakehouse, recorded at `root` in `container`, directory marked for it. */
  function putOther(container: string, root: string, createdAt = AFTER_CUTOVER) {
    DOCS.set(dkey(OTHER_ID, 'ws-other'), {
      id: OTHER_ID, workspaceId: 'ws-other', itemType: 'lakehouse', displayName: 'Other',
      state: { adlsContainer: container, lakehouseRoot: root }, createdAt,
    });
    EXISTING.add(`${container}/${root}`);
    OWNERS.set(`${container}/${root}`, OTHER_ID);
  }

  /** Another lakehouse named 'Old Name' with `state`, and no directory of its own. */
  function putTwin(state: Record<string, unknown>) {
    DOCS.set(dkey('lh-twin', 'ws-twin'), {
      id: 'lh-twin', workspaceId: 'ws-twin', itemType: 'lakehouse', displayName: 'Old Name', state,
      createdAt: BEFORE_CUTOVER,
    });
  }

  // FAILS IF a recorded root whose directory is marked for another item is
  // used: the answer would be `landing/${OTHER_ITEM_ROOT}`, the other item's
  // directory. The fixture's root has the exact shape step 2c accepts, so only
  // the ownership check can refuse it.
  it('a new item whose lakehouseRoot names another item\'s root gets its own root', async () => {
    putOther('landing', OTHER_ITEM_ROOT);
    putItem({ adlsContainer: 'landing', lakehouseRoot: OTHER_ITEM_ROOT }, AFTER_CUTOVER);
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r).toEqual({
      ok: true,
      bound: { abfss: `abfss://landing@dlzacct.dfs.core.windows.net/${ITEM_ROOT}`, container: 'landing', root: ITEM_ROOT },
    });
  });

  // FAILS IF step 1 returns the installer receipt unchecked: the answer would be
  // the other item's abfss URI.
  it('a new item whose installer receipt names another item\'s root gets its own root', async () => {
    putOther('gold', OTHER_ITEM_ROOT);
    putItem({
      provisioning: { secondaryIds: {
        adlsRoot: `abfss://gold@dlzacct.dfs.core.windows.net/${OTHER_ITEM_ROOT}`,
        container: 'gold', rootPath: OTHER_ITEM_ROOT,
      } },
    }, AFTER_CUTOVER);
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r.ok && r.bound.root).toBe(ITEM_ROOT);
    expect(r.ok && r.bound.abfss).not.toContain(OTHER_ITEM_ROOT);
  });

  // Positive twin of the two above, differing only in the recorded root. FAILS
  // IF the check reads storage or other items for this item's OWN recorded
  // item root (probes or QUERIES non-empty).
  it('a new item\'s own recorded item root is used with no storage or item read', async () => {
    putOther('landing', OTHER_ITEM_ROOT);
    putItem({ adlsContainer: 'gold', lakehouseRoot: ITEM_ROOT }, AFTER_CUTOVER);
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r.ok && [r.bound.container, r.bound.root]).toEqual(['gold', ITEM_ROOT]);
    expect(probes()).toEqual([]);
    expect(QUERIES).toEqual([]);
  });

  // FAILS IF a recorded root another item also RECORDS is used: the answer
  // would be ok at `gold/lakehouses/Old Name`. FAILS IF the resolver then falls
  // back to another container (more probes than the one marker read). The
  // recycled row FAILS IF recycled items are left out of that read.
  it.each([
    ['a live', {}],
    ['a recycled', { _recycled: { at: '2026-09-20T00:00:00.000Z', by: 'owner-1' } }],
  ])('a recorded root that %s lakehouse also records resolves to root-shared, with no fallback', async (_label, extra) => {
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    putTwin({ adlsContainer: 'gold', lakehouseRoot: OLD, ...extra });
    expect(await resolveLakehouseStorage(LH_ID, WS, PERSIST)).toEqual({ ok: false, reason: 'root-shared' });
    expect(probes()).toEqual([`gold/${OLD}`]);
    expect(replaced).toEqual([]);
    expect(CREATES).toEqual([]);
    // The null-returning wrapper agrees.
    expect(await resolveLakehouseAbfss(LH_ID, WS)).toBeNull();
  });

  // Paired positive, differing only in the twin's record. FAILS IF a recorded
  // root is withheld because another item merely has the same display name
  // (and so would DERIVE the same name root) without recording it.
  it('a recorded root is kept when another lakehouse only shares its name', async () => {
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    putTwin({});
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r.ok && [r.bound.container, r.bound.root]).toEqual(['gold', OLD]);
  });

  // FAILS IF a failed read of the other items keeps an UNMARKED recorded root
  // that is not the item's own item root (the answer would be ok at
  // `gold/lakehouses/Old Name`): it is not opened until it is confirmed.
  it('an unmarked recorded name root is withheld as root-unverified when the other items cannot be read', async () => {
    EXISTING.add(`gold/${OLD}`);
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    QUERY_FAILS = true;
    expect(await resolveLakehouseStorage(LH_ID, WS, PERSIST)).toEqual({ ok: false, reason: 'root-unverified' });
    expect(QUERIES).toHaveLength(1);
    expect(STAMPS).toEqual([]);
    expect(replaced).toEqual([]);
  });

  // Paired positives with the same failing read. FAILS IF the refusal above is
  // applied to a recorded ITEM root (which needs no read) or to a directory
  // marked for this item: either would then answer root-unverified.
  it('a recorded item root, or a root marked for this item, still resolves when the other items cannot be read', async () => {
    QUERY_FAILS = true;
    putItem({ adlsContainer: 'gold', lakehouseRoot: ITEM_ROOT }, AFTER_CUTOVER);
    const own = await resolveLakehouseStorage(LH_ID, WS);
    expect(own.ok && [own.bound.container, own.bound.root]).toEqual(['gold', ITEM_ROOT]);
    EXISTING.add(`gold/${OLD}`);
    OWNERS.set(`gold/${OLD}`, LH_ID);
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    const marked = await resolveLakehouseStorage(LH_ID, WS);
    expect(marked.ok && [marked.bound.container, marked.bound.root]).toEqual(['gold', OLD]);
    expect(QUERIES).toEqual([]);
  });

  // FAILS IF a recorded root marked for this item still reads the other items
  // (QUERIES non-empty), and so can be withheld when that read goes wrong.
  it('a recorded root marked for this item reads no other item', async () => {
    EXISTING.add(`gold/${OLD}`);
    OWNERS.set(`gold/${OLD}`, LH_ID);
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    putTwin({ adlsContainer: 'gold', lakehouseRoot: OLD });
    const r = await resolveLakehouseStorage(LH_ID, WS);
    expect(r.ok && r.bound.root).toBe(OLD);
    expect(QUERIES).toEqual([]);
  });

  // FAILS IF a persisting resolve does not mark an unmarked recorded root it
  // found to be this item's alone (STAMPS empty, and the next resolve queries
  // again). FAILS IF a default resolve marks it.
  it('an unmarked recorded root is marked on a persisting resolve, and the next resolve reads no other item', async () => {
    EXISTING.add(`gold/${OLD}`);
    putItem({ adlsContainer: 'gold', lakehouseRoot: OLD });
    await resolveLakehouseStorage(LH_ID, WS);
    expect(STAMPS).toEqual([]);
    expect(QUERIES).toHaveLength(1);
    const r = await resolveLakehouseStorage(LH_ID, WS, PERSIST);
    expect(r.ok && r.bound.root).toBe(OLD);
    expect(STAMPS).toEqual([['gold', OLD, LH_ID, DIR_ETAG]]);
    expect(QUERIES).toHaveLength(2);
    await resolveLakehouseStorage(LH_ID, WS);
    expect(QUERIES).toHaveLength(2);
  });

  // FAILS IF step 3 keeps walking past a directory another item also uses:
  // probes would go on past `landing`. FAILS IF the reason is anything but
  // root-shared.
  it('an existing unmarked name root another item also derives resolves to root-shared', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    DOCS.set(dkey('lh-twin', 'ws-twin'), {
      id: 'lh-twin', workspaceId: 'ws-twin', itemType: 'lakehouse', displayName: NAME, state: {},
      createdAt: BEFORE_CUTOVER,
    });
    expect(await resolveLakehouseStorage(LH_ID, WS, PERSIST)).toEqual({ ok: false, reason: 'root-shared' });
    expect(probes()).toEqual(both('bronze', 'landing'));
    expect(replaced).toEqual([]);
  });

  it('the not-found and no-storage reasons are distinct', async () => {
    // FAILS IF a missing item and unconfigured storage collapse to one reason.
    expect(await resolveLakehouseStorage('lh-missing', WS)).toEqual({ ok: false, reason: 'not-found' });
    configure([]);
    putItem({});
    expect(await resolveLakehouseStorage(LH_ID, WS)).toEqual({ ok: false, reason: 'no-storage' });
  });

  it('the withheld message names the next step for root-shared and root-unverified only', () => {
    // FAILS IF the root-shared text stops naming the readiness check and the
    // one-step action that resolves it, or if not-found / no-storage start
    // carrying text (each route words those itself).
    const shared = lakehouseStorageWithheldMessage('root-shared');
    expect(shared).toMatch(/also used by another item/);
    expect(shared).toContain(`"${LAKEHOUSE_SHARED_ROOTS_CHECK_TITLE}"`);
    expect(shared).toMatch(/Keep root for/);
    expect(lakehouseStorageWithheldMessage('root-unverified')).toMatch(/could not confirm/);
    expect(lakehouseStorageWithheldMessage('not-found')).toBeNull();
    expect(lakehouseStorageWithheldMessage('no-storage')).toBeNull();
  });
});

describe('listLakehouseRootFacts', () => {
  const recycledTwin = () => DOCS.set(dkey('lh-bin', 'ws-bin'), {
    id: 'lh-bin', workspaceId: 'ws-bin', itemType: 'lakehouse', displayName: NAME,
    state: { _recycled: { at: '2026-09-20T00:00:00.000Z' } }, createdAt: BEFORE_CUTOVER,
  });

  // The query TEXT, read directly. FAILS IF `includeRecycled: true` still
  // appends the recycled filter (the first assertion), or if the default read
  // stops leaving recycled items out (the second). FAILS IF the projection
  // drops the workspace or the recycled flag the readiness check shows.
  it('leaves recycled lakehouses out by default and keeps them when asked', async () => {
    putItem({});
    recycledTwin();
    const all = await listLakehouseRootFacts(undefined, { includeRecycled: true });
    const live = await listLakehouseRootFacts();
    expect(QUERIES[0]).not.toContain(RECYCLED_FILTER);
    expect(QUERIES[1]).toContain(RECYCLED_FILTER);
    for (const q of QUERIES) {
      expect(q).toContain('c.workspaceId');
      expect(q).toContain('c.state._recycled AS recycled');
    }
    expect(all.map((r) => r.id).sort()).toEqual(['lh-4759', 'lh-bin']);
    expect(live.map((r) => r.id)).toEqual(['lh-4759']);
  });
});
