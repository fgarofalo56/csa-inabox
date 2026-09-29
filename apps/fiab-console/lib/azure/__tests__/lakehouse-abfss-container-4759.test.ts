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
 * WHAT EACH TEST PINS, AND THE VALUE THAT BREAKS IT — stated per `it` below.
 * Assertions marked "RED on the defect" were run against the pre-fix
 * `lakehouse-abfss.ts` in a separate git worktree and failed there with
 * `expected 'bronze' to be 'landing'` (or `'silver'` for the silver+landing
 * subset). The "GUARD" tests' CONTAINER assertions hold on the pre-fix code by
 * design — they pin that the fix did not move LEGACY (pre-08-22, bronze-rooted)
 * lakehouses, and each names the wrong fix it exists to catch; their probe /
 * persist assertions pin behaviour the pre-fix code did not have, so those
 * tests are red there too, for that reason and not the container.
 *
 * Instrument: the REAL `lakehouseAutoBind` provider and the REAL resolver.
 * Only Cosmos (an in-memory doc map) and the storage probe
 * (`getServiceClient().getFileSystemClient(c).getFileClient(p).getProperties`)
 * are faked; `configuredContainerNames` and `resolveAbfssRoot` are the real
 * ones and read the LOOM_*_URL env this file sets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const DOCS = new Map<string, any>();
const replaced: Array<{ doc: any; opts: any }> = [];
const dkey = (id: string, pk: string) => `${pk}::${id}`;
/** When set, the cross-item root read (`listLakehouseRootFacts`) rejects. */
let QUERY_FAILS = false;

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: async () => ({
    // `listLakehouseRootFacts`: every lakehouse's root facts, projected the way
    // its SELECT projects them. The step-3 name-root check reads this.
    items: {
      query: () => ({
        fetchAll: async () => {
          if (QUERY_FAILS) throw Object.assign(new Error('cosmos unavailable'), { code: 503 });
          const resources = [...DOCS.values()]
            .filter((d) => d.itemType === 'lakehouse' && !d.state?._recycled)
            .map((d) => ({
              id: d.id,
              displayName: d.displayName,
              createdAt: d.createdAt,
              lakehouseRoot: d.state?.lakehouseRoot,
              adlsContainer: d.state?.adlsContainer,
              storageAccount: d.state?.storageAccount,
              provAdlsRoot: d.state?.provisioning?.secondaryIds?.adlsRoot,
              provContainer: d.state?.provisioning?.secondaryIds?.container,
              provRootPath: d.state?.provisioning?.secondaryIds?.rootPath,
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

/**
 * Every directory create: `[container, path, marker]` (marker null when none is
 * written). A create over an existing directory with `ifNoneMatch: '*'` is
 * refused with 409, as ADLS refuses it.
 */
const CREATES: Array<[string, string, string | null]> = [];

function fakeCreate(container: string, path: string, marker: string | null, ifNoneMatch: boolean) {
  CREATES.push([container, path, marker]);
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
    // The storage helpers the lakehouse provider used before item roots, backed
    // by the same fake account, so a copy of this file run against that code
    // reaches its assertions rather than a live endpoint.
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
              ? Promise.resolve({ metadata: OWNERS.has(at) ? { loomitemid: OWNERS.get(at) } : {} })
              : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
          },
        }),
      }),
    }),
  };
});

import { resolveLakehouseAbfss, PROBE_TIMEOUT_MS } from '@/lib/azure/lakehouse-abfss';
import { lakehouseAutoBind } from '@/lib/azure/auto-bind-providers';
import { ensureAutoBinding, type AutoBindContext } from '@/lib/azure/auto-bind';

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
 *  The root of an item created BEFORE `LAKEHOUSE_ITEM_ROOT_SINCE`. */
const ROOT = 'lakehouses/Sales Lake';
/** `lakehouseItemRootPath('Sales Lake', id)`, literally — a NEW item's root. */
const ITEM_ROOT = 'lakehouses/Sales Lake--lh-4759';
/** A `createdAt` before the cutover (the name root) and one after (the item root). */
const BEFORE_CUTOVER = '2026-09-01T00:00:00.000Z';
const AFTER_CUTOVER = '2026-09-29T12:00:00.000Z';
const PERSIST = { persist: true } as const;

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
  QUERY_FAILS = false;
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
  it('resolves the persisted auto-bind binding, with no storage probe', async () => {
    // The item exactly as New item leaves it: preflight picks the container,
    // create makes the root there, stateKeys is what gets persisted. A New item
    // today is created after the cutover, so it carries an ITEM root.
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
    // RED on the defect: 'bronze' (the pre-fix step 3, which never read state).
    expect(r?.container).toBe(created);
    expect(r?.root).toBe(ITEM_ROOT);
    expect(r?.abfss).toBe('abfss://landing@dlzacct.dfs.core.windows.net/lakehouses/Sales Lake--lh-4759');
    // Pins that STEP 2c answered, not the probe fallback: delete step 2c and the
    // container is still 'landing' (the probe finds it) but these go non-empty.
    expect(probes()).toEqual([]);
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
    // RED on the defect for ['silver','landing'] (pre-fix answered 'silver',
    // first in KNOWN_CONTAINERS order) and for all five ('bronze').
    expect(r?.container).toBe(pre.coords.container);
    expect(r?.root).toBe(ITEM_ROOT);
  });
});

describe('#4759 — an item with NO persisted binding is found, not guessed', () => {
  it('finds a post-08-22 root in landing and, when the caller opts in, persists it', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    // RED on the defect: 'bronze'.
    expect(r?.container).toBe('landing');
    expect(r?.root).toBe(ROOT);
    // Legacy container probed FIRST, then auto-bind's order.
    expect(probes()).toEqual([`bronze/${ROOT}`, `landing/${ROOT}`]);
    // What was found is recorded, so the next resolve takes step 2c ...
    expect(replaced).toHaveLength(1);
    expect(replaced[0].doc.state).toMatchObject({ adlsContainer: 'landing', lakehouseRoot: ROOT });
    // ... conditionally on the item not having changed since it was read.
    // Breaks if the write drops its IfMatch (a concurrent edit would be lost).
    expect(replaced[0].opts).toEqual({ accessCondition: { type: 'IfMatch', condition: '"etag-1"' } });
    PROBES.length = 0;
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('landing');
    expect(probes()).toEqual([]);
  });

  it('a DEFAULT call writes nothing, even when it finds the root', async () => {
    // Breaks if `persist` defaults to true: the resolver is reached from read
    // routes and must not write unless the caller opts in.
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    // Paired positive — the answer is still right; only the write is withheld.
    expect(r?.container).toBe('landing');
    expect(replaced).toEqual([]);
    // Nothing was recorded, so the next resolve probes again.
    PROBES.length = 0;
    await resolveLakehouseAbfss(LH_ID, WS);
    expect(probes()).toEqual([`bronze/${ROOT}`, `landing/${ROOT}`]);
  });

  it('answers the container auto-bind WOULD create in when no root exists anywhere', async () => {
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    // RED on the defect: 'bronze'. Also breaks a fix that returns the legacy
    // container when nothing is found.
    expect(r?.container).toBe('landing');
    expect(probes()).toHaveLength(ALL_FIVE.length);
    // Nothing was found, so nothing is persisted, even with persist:true.
    expect(replaced).toEqual([]);
  });

  it('GUARD: a legacy bronze-rooted lakehouse still resolves to bronze', async () => {
    // Breaks the naive fix — flipping the fallback to landing-first without
    // probing — which would answer 'landing' here and orphan the item's data.
    EXISTING.add(`bronze/${ROOT}`);
    putItem({});
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('bronze');
    expect(r?.abfss).toBe('abfss://bronze@dlzacct.dfs.core.windows.net/lakehouses/Sales Lake');
    expect(replaced[0].doc.state).toMatchObject({ adlsContainer: 'bronze', lakehouseRoot: ROOT });
  });

  it('GUARD: the legacy container is probed before auto-bind\'s order', async () => {
    // Pins resolver precedence: when the root is present in both the legacy
    // container and `landing`, the legacy container is the answer and the walk
    // stops there. Breaks if the probe walks auto-bind's order (landing first)
    // before the legacy container.
    EXISTING.add(`bronze/${ROOT}`);
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('bronze');
    expect(probes()).toEqual([`bronze/${ROOT}`]);
  });

  it('GUARD: a FAILED probe returns the legacy answer and persists nothing', async () => {
    // Breaks a probe that treats a 403 as "absent" and moves on: it would find
    // landing and answer — and persist — 'landing' on evidence it never had.
    FAILING.set('bronze', 403);
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    expect((await resolveLakehouseAbfss(LH_ID, WS, PERSIST))?.container).toBe('bronze');
    expect(probes()).toEqual([`bronze/${ROOT}`]);
    expect(replaced).toEqual([]);
  });

  it('every probe carries an abort signal', async () => {
    // Breaks if the signal is dropped from the probe: an unreachable account
    // then retries with backoff and the caller hangs (see the next test).
    putItem({});
    await resolveLakehouseAbfss(LH_ID, WS);
    expect(PROBES).toHaveLength(ALL_FIVE.length);
    for (const p of PROBES) expect(p.signal).toBeInstanceOf(AbortSignal);
  });

  it(`a HANGING probe is cut off at PROBE_TIMEOUT_MS and treated as failed`, async () => {
    // Real timers, deliberately: this is the bound itself, not a mock of it.
    // Breaks (test times out) if the probe carries no signal, and answers
    // 'landing' if a timed-out probe is treated as "absent".
    expect(PROBE_TIMEOUT_MS).toBe(6000);
    HANGING.add('bronze');
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    const t0 = Date.now();
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    const took = Date.now() - t0;
    expect(r?.container).toBe('bronze');
    expect(probes()).toEqual([`bronze/${ROOT}`]);
    expect(replaced).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 250);
    expect(took).toBeLessThan(PROBE_TIMEOUT_MS + 4000);
  }, 20_000);

  it('keeps the declared ownedContainers order when nothing is found', async () => {
    // Unchanged from before #4759: with ownedContainers ['gold','bronze'] and
    // no root in either, the answer is the first owned container. Breaks if the
    // owned list is re-ordered through auto-bind's preference ('bronze').
    putItem({ ownedContainers: ['gold', 'bronze'] });
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect(r?.container).toBe('gold');
    expect(probes()).toEqual([`gold/${ROOT}`, `bronze/${ROOT}`]);
  });

  it('returns null, and probes nothing, when no LOOM_*_URL is configured', async () => {
    configure([]);
    putItem({});
    expect(await resolveLakehouseAbfss(LH_ID, WS)).toBeNull();
    expect(probes()).toEqual([]);
  });
});

describe('#4759 — step 2c accepts only the binding shape auto-bind writes', () => {
  it('honours a well-formed persisted binding in a non-default container', async () => {
    // The paired POSITIVE for the refusals below — without it they would pass
    // with step 2c deleted outright.
    putItem({ adlsContainer: 'gold', lakehouseRoot: 'lakehouses/Old Name' });
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect(r?.container).toBe('gold');
    expect(r?.root).toBe('lakehouses/Old Name');
    expect(probes()).toEqual([]);
  });

  it.each([
    ['gold', 'finance/reports'],          // outside lakehouses/
    ['gold', 'lakehouses/'],              // the whole lakehouses/ tree
    ['gold', 'lakehouses/../finance'],    // traversal
    ['gold', 'lakehouses//x'],            // not a sanitiser fixpoint
    ['not-a-container', 'lakehouses/x'],  // unknown container
  ])('ignores adlsContainer=%s lakehouseRoot=%s and falls back to the convention root', async (c, root) => {
    // Breaks if the shape check (or the known-container check) is removed:
    // the resolver would answer `${c}/${root}` instead of the convention root.
    putItem({ adlsContainer: c, lakehouseRoot: root });
    const r = await resolveLakehouseAbfss(LH_ID, WS);
    expect(r?.root).toBe(ROOT);
    expect(r?.container).toBe('landing');
  });
});

describe('#4759 — preflight still honours an item\'s pinned container', () => {
  it('pins gold when gold is configured, and ignores an unconfigured pin', async () => {
    // Breaks if `pinned` is dropped from lakehouseContainerOrder: 'landing'.
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
    // FAILS IF the probe is existence-only (the pre-change provider): true.
    expect(await lakehouseAutoBind.probe(ITEM_ROOT, { container: 'landing' }, ctx())).toBe(false);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    // FAILS IF the probe refuses its own marker: false.
    expect(await lakehouseAutoBind.probe(ITEM_ROOT, { container: 'landing' }, ctx())).toBe(true);
  });

  it('probe: an unmarked root is present only when it is the root this item has on record', async () => {
    EXISTING.add(`landing/${ROOT}`);
    // FAILS IF an unmarked directory is adopted without a record (true here).
    expect(await lakehouseAutoBind.probe(ROOT, { container: 'landing' }, ctx())).toBe(false);
    // FAILS IF an existing item's unmarked root is no longer recognised (false
    // here) — the item would be given a new, empty root.
    expect(await lakehouseAutoBind.probe(ROOT, { container: 'landing' }, ctx({ lakehouseRoot: ROOT }))).toBe(true);
  });

  // Through the engine. FAILS IF a recorded root marked for another item is
  // kept: the pre-change provider answers via 'existing' at ROOT with no create.
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

  // Positive control for the arm above, differing only in the marker. HOLDS on
  // the pre-change provider too, by design: it pins that an existing item keeps
  // its root. FAILS IF the marker rule also refuses an unmarked recorded root
  // (via 'recreated' and one create).
  it('a recorded unmarked root is kept, with no create', async () => {
    EXISTING.add(`landing/${ROOT}`);
    const out = await ensureAutoBinding(ctx({ adlsContainer: 'landing', lakehouseRoot: ROOT }));
    expect(out.status === 'bound' && [out.record.backingName, out.record.via]).toEqual([ROOT, 'existing']);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF the provider still targets the name root: the pre-change provider
  // probes `lakehouses/Sales Lake`, finds nothing and creates it (via 'created').
  it('an item root marked for this item is attached, with no create', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    const out = await ensureAutoBinding(ctx());
    expect(out.status === 'bound' && [out.record.backingName, out.record.via]).toEqual([ITEM_ROOT, 'attached']);
    expect(CREATES).toEqual([]);
  });

  // FAILS IF the create overwrites or adopts an existing directory: status
  // would be 'bound'. The create is attempted once, conditionally, and refused.
  it('an unmarked directory already at the target is neither attached nor overwritten', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    const out = await ensureAutoBinding(ctx());
    expect(out.status).not.toBe('bound');
    expect(CREATES).toEqual([['landing', ITEM_ROOT, LH_ID]]);
    expect(OWNERS.has(`landing/${ITEM_ROOT}`)).toBe(false);
  });
});

describe('the resolver adopts a found root only when this item may use it', () => {
  /** Another lakehouse, in another workspace, with this item's display name. */
  function putTwin(displayName = NAME, createdAt = BEFORE_CUTOVER) {
    DOCS.set(dkey('lh-twin', 'ws-twin'), {
      id: 'lh-twin', workspaceId: 'ws-twin', itemType: 'lakehouse', displayName, state: {}, createdAt,
    });
  }

  // FAILS IF an item-era root marked for another item is adopted: the answer
  // would be 'landing' (where that directory is). The resolver skips it and
  // answers the next preferred container.
  it('an item root marked for another item is skipped', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, 'lh-someone-else');
    putItem({}, AFTER_CUTOVER);
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('bronze');
    expect(r?.root).toBe(ITEM_ROOT);
    expect(replaced).toEqual([]);
  });

  // Positive twin, differing only in the marker. FAILS IF the resolver refuses
  // its own marker (answer 'bronze', nothing persisted).
  it('an item root marked for this item is adopted and persisted', async () => {
    EXISTING.add(`landing/${ITEM_ROOT}`);
    OWNERS.set(`landing/${ITEM_ROOT}`, LH_ID);
    putItem({}, AFTER_CUTOVER);
    const r = await resolveLakehouseAbfss(LH_ID, WS, PERSIST);
    expect(r?.container).toBe('landing');
    expect(replaced.map((x) => [x.doc.state.adlsContainer, x.doc.state.lakehouseRoot])).toEqual([['landing', ITEM_ROOT]]);
  });

  // FAILS IF a name-only root is adopted while another lakehouse derives the
  // same root: the answer would be 'landing', persisted.
  it('an unrecorded name root that another lakehouse also derives is not adopted', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    putTwin();
    expect(await resolveLakehouseAbfss(LH_ID, WS, PERSIST)).toBeNull();
    expect(replaced).toEqual([]);
  });

  // FAILS IF a failed read of the other items counts as "no other item": the
  // answer would be 'landing'.
  it('an unrecorded name root is not adopted when the other items cannot be read', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    QUERY_FAILS = true;
    expect(await resolveLakehouseAbfss(LH_ID, WS, PERSIST)).toBeNull();
    expect(replaced).toEqual([]);
  });

  // HOLDS on the pre-change resolver by design (it had no overlap check). FAILS
  // IF overlap is a string-prefix test: `lakehouses/Sales Lake-archive` starts
  // with `lakehouses/Sales Lake`, and the answer would be null.
  it('a lakehouse whose root only shares a string prefix does not block adoption', async () => {
    EXISTING.add(`landing/${ROOT}`);
    putItem({});
    putTwin(`${NAME}-archive`);
    expect(`lakehouses/${NAME}-archive`.startsWith(ROOT)).toBe(true);
    expect((await resolveLakehouseAbfss(LH_ID, WS, PERSIST))?.container).toBe('landing');
    expect(replaced).toHaveLength(1);
  });

  // HOLDS on the pre-change resolver by design. FAILS IF the overlap check also
  // refuses a name root marked for THIS item (the answer would be null).
  it('a name root marked for this item is adopted even when another lakehouse derives it', async () => {
    EXISTING.add(`landing/${ROOT}`);
    OWNERS.set(`landing/${ROOT}`, LH_ID);
    putItem({});
    putTwin();
    expect((await resolveLakehouseAbfss(LH_ID, WS))?.container).toBe('landing');
  });
});
