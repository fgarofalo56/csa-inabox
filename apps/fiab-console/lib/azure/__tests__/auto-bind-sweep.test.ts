/**
 * BULK AUTO-BIND SWEEP — #3796.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS PIN
 * ---------------------------------------------------------------------------
 * #3549's repair exists, and it only fires when a human OPENS the item. Create
 * -time binding is best-effort by design (it races an 8s deadline and never
 * throws), so the estate accumulates real, bound, EMPTY backing objects that
 * nothing ever revisits — live, 36 of 41 pipelines in the default factory.
 * `auto-bind-by-default.md` §3 calls the binding self-healing; a heal that
 * waits for a human is not self-healing for an item nobody opens.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ACTUALLY BEING ASSERTED
 * ---------------------------------------------------------------------------
 * Not "36 → 0". `seedPipelineFromContent` authors `state.content`, and a
 * catalog-picker item HAS no `state.content` — its empty pipeline is correct.
 * So the acceptance tested here is #3796's own alternative branch: every empty
 * backing object is either repaired OR carries a stated, inspectable reason.
 * Each disposition below is a distinct such reason, and each test proves the
 * sweep can tell it apart from its neighbours.
 *
 * ---------------------------------------------------------------------------
 * MUTATION PROOF — measured, not asserted (temp/mutate.sh, 2026-08-20)
 * ---------------------------------------------------------------------------
 * Each mutation was applied byte-exactly (the applier REFUSES unless the needle
 * appears exactly once — a CRLF mismatch otherwise no-ops the edit and every
 * mutation then "survives" for the wrong reason), the spec run, the file
 * restored, and the restored sha256 re-printed. Baseline 39/39 + 19/19 green;
 * all sixteen below were CAUGHT.
 *
 * The five the 2026-08-20 review filed, and what pinned each BEFORE it:
 *
 *   B2a `scopeToCallerAccess` deleted                      → 4 RED  (was 0)
 *   B2b `callerTid: session.claims.tid` → `undefined`      → 4 RED  (was 0)
 *   B2c filter applied AFTER classification, not before    → 4 RED  (was 0)
 *   B3  `record?.seeded === true` → `record`               → 2 RED  (was 0)
 *   B4a `persisted` asserted true instead of measured      → 1 RED  (was 0)
 *   B4b `persisted` dropped from the row                   → 2 RED  (was 0)
 *   B5a route: `!== false` → `=== true`                    → 4 RED  (was 0 — no route spec existed)
 *   B5b route: stops threading the session into the sweep  → 1 RED  (was 0)
 *   B5c route: `withTenantAdmin` → `withSession`           → 1 RED  (was 0)
 *
 * "was 0" is measured, not inferred: B3 and the `persisted` probe were both
 * applied to the PRE-FIX tree and the suite stayed 26/26 green.
 *
 * The six the original commit claimed, RE-PROVED on the rebuilt harness — the
 * fake Cosmos now actually persists, which could have blinded them:
 *
 *   a) `has-content` returns the ENGINE's verdict            → 4 RED
 *   b) `has-content` short-circuits BEFORE the engine        → 2 RED
 *   c) fetch `limit` instead of `limit + 1`                  → 3 RED
 *   d) one item's throw aborts the sweep                     → 1 RED
 *   e) hand-list `sweepableItemTypes`                        → 3 RED
 *   f) dry-run calls `repairOne`                             → 8 RED
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A fake COSMOS, not a stub.
//
// `persistAutoBindPatch`, `loadSweepItems` and `resolveWorkspaceAccessByOid`
// all reach this module. The previous revision mocked `itemsContainer` to a
// bare `vi.fn()`, which `vi.resetAllMocks()` then emptied — so every live-mode
// test ran with the provenance write FAILING silently (`persistAutoBindPatch`
// swallows its own throw and returns false). The convergence property the route
// documents is a property of what the NEXT pass re-reads from Cosmos, so a
// harness where nothing is ever written cannot observe it, and the one test
// that claimed to was re-using the same in-memory array across both passes.
//
// `docStore` is therefore a real (in-memory) document store with working
// point-read + replace, and `wsStore` holds workspace docs so the REAL
// `resolveWorkspaceAccessByOid` runs — mocking the resolver would test the mock
// and reproduce exactly the blind spot #2703 filed.
// ---------------------------------------------------------------------------
interface WsDoc { id: string; tenantId: string; tid?: string; name: string }
/** Workspace docs, keyed by id. `tenantId` is the OWNER's oid (the partition). */
const wsStore = new Map<string, WsDoc>();
/** Item docs, keyed `${workspaceId}::${id}` — the PERSISTED estate. */
const docStore = new Map<string, WorkspaceItem>();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function itemsFake() {
  return {
    item: (id: string, pk: string) => ({
      read: async () => ({ resource: docStore.get(`${pk}::${id}`) }),
      replace: async (doc: WorkspaceItem) => {
        docStore.set(`${pk}::${doc.id}`, clone(doc));
        return { resource: doc };
      },
    }),
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  };
}

function workspacesFake() {
  return {
    // Owner fast-path: a point read on (id, oid) only hits for the OWNER.
    item: (id: string, pk: string) => ({
      read: async () => {
        const d = wsStore.get(id);
        return { resource: d && d.tenantId === pk ? d : undefined };
      },
    }),
    // `readWorkspaceById` — cross-partition lookup by id.
    items: {
      query: (spec: { parameters?: Array<{ name: string; value: unknown }> }) => ({
        fetchAll: async () => {
          const id = spec?.parameters?.find((p) => p.name === '@id')?.value as string;
          const d = wsStore.get(id);
          return { resources: d ? [d] : [] };
        },
      }),
    },
  };
}

vi.mock('@/lib/azure/cosmos-client', () => ({
  itemsContainer: vi.fn(),
  workspacesContainer: async () => workspacesFake(),
  workspaceRolesContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
  featurePermissionsContainer: async () => ({ items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } }),
}));
// No ACL grant by default — the caller reaches `ws-1` through the OWNER
// fast-path, so the shared-access path is off unless a test arms it.
vi.mock('@/lib/azure/workspace-roles-client', () => ({ resolveEffectiveRole: vi.fn() }));

import { sweepAutoBind, sweepableItemTypes, type SweepRow } from '@/lib/azure/auto-bind-sweep';
import { readAutoBindRecord, type AutoBindProvider } from '@/lib/azure/auto-bind';
import { AUTO_BIND_PROVIDERS } from '@/lib/azure/auto-bind-providers';
import { authoredContent } from '@/lib/azure/auto-bind-seed';
import type { WorkspaceItem } from '@/lib/types/workspace';
import type { SessionPayload } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';

/** The caller every sweep in this file runs as. */
const CALLER_OID = 'oid-sweep-caller';
const CALLER_TID = 'tid-alpha';
/** A DIFFERENT Entra tenant — the boundary tests' only changed variable. */
const FOREIGN_TID = 'tid-beta';
const SESSION = { claims: { oid: CALLER_OID, tid: CALLER_TID }, exp: 4_102_444_800 } as SessionPayload;


// ---------------------------------------------------------------------------
// A fake control plane that stores an object's CONTENT, not just its name —
// the same shape as `auto-bind-seed.test.ts`, because the same distinction is
// load-bearing here: the #3549 objects EXISTED, it was their contents that were
// missing, so a fake that tracked only existence could not see the bug.
//
// Extra counters over the sibling harness: `preflightCalls` / `probeCalls`, so
// "costs ZERO control-plane calls" can be asserted as a measurement rather than
// asserted about `isEmpty` alone.
// ---------------------------------------------------------------------------
class ContentPlane {
  objects = new Map<string, { activities: unknown[] }>();
  createCalls: string[] = [];
  seedCalls: string[] = [];
  emptyProbes: string[] = [];
  preflightCalls = 0;
  probeCalls: string[] = [];

  reset() {
    this.objects.clear();
    this.createCalls = [];
    this.seedCalls = [];
    this.emptyProbes = [];
    this.preflightCalls = 0;
    this.probeCalls = [];
  }

  /** Total calls that would have crossed the network on a real estate. */
  get networkCalls() {
    return this.preflightCalls + this.probeCalls.length + this.emptyProbes.length
      + this.createCalls.length + this.seedCalls.length;
  }
}

const plane = new ContentPlane();

/** The bundle shape a content bundle stamps onto `state.content` at install. */
const BUNDLE_CONTENT = {
  kind: 'adf-pipeline',
  activities: [
    { name: 'BronzeToSilverDQ', type: 'DatabricksNotebook' },
    { name: 'GoldAggregation', type: 'DatabricksNotebook', dependsOn: ['BronzeToSilverDQ'] },
    { name: 'OptimizeGold', type: 'DatabricksNotebook', dependsOn: ['GoldAggregation'] },
  ],
};

/** A provider shaped exactly like the real pipeline ones. */
function seedingProvider(over: Partial<AutoBindProvider> = {}): AutoBindProvider {
  return {
    provider: 'fake-pipeline',
    itemTypes: ['fake-item'],
    backingNameFor: (ctx) => ({ name: ctx.displayName.replace(/[^A-Za-z0-9-]+/g, '-'), sanitized: false }),
    preflight: async () => {
      plane.preflightCalls += 1;
      return { ok: true, coords: { factoryName: 'adf-test' } };
    },
    probe: async (name) => {
      plane.probeCalls.push(name);
      return plane.objects.has(name);
    },
    create: async (name) => {
      plane.createCalls.push(name);
      plane.objects.set(name, { activities: [] });
    },
    seedFromContent: async (name, _coords, ctx) => {
      plane.seedCalls.push(name);
      const content = authoredContent<{ activities?: unknown[] }>(ctx, ['adf-pipeline', 'synapse-pipeline']);
      if (!content?.activities?.length) return { seeded: false };
      plane.objects.set(name, { activities: content.activities });
      return { seeded: true, detail: `${content.activities.length} activities` };
    },
    isEmpty: async (name) => {
      plane.emptyProbes.push(name);
      return (plane.objects.get(name)?.activities.length ?? 0) === 0;
    },
    stateKeys: (name) => ({ pipelineName: name }),
    existingBinding: (ctx) => (typeof ctx.state.pipelineName === 'string' ? ctx.state.pipelineName : null),
    ...over,
  };
}

function item(o: {
  displayName: string;
  id?: string;
  itemType?: string;
  workspaceId?: string;
  state?: Record<string, unknown>;
}): WorkspaceItem {
  return {
    id: o.id ?? `id-${o.displayName}`,
    workspaceId: o.workspaceId ?? 'ws-1',
    itemType: o.itemType ?? 'fake-item',
    displayName: o.displayName,
    createdBy: 'tester@example.com',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...(o.state ? { state: o.state } : {}),
  };
}

/** The exact state a GATED bundle install leaves behind: content, no binding. */
function gatedInstallState() {
  return { sourceApp: 'app-azure-realtime-analytics', content: BUNDLE_CONTENT };
}

/**
 * Put these items in the fake Cosmos as PERSISTED documents (deep-cloned, so
 * the in-memory objects a sweep mutates are not the same objects the store
 * holds — that distinction is the whole point of the convergence test), and
 * give any unseen workspace a doc the caller OWNS.
 */
function register(items: readonly WorkspaceItem[]) {
  for (const it of items) {
    if (!wsStore.has(it.workspaceId)) {
      wsStore.set(it.workspaceId, { id: it.workspaceId, tenantId: CALLER_OID, tid: CALLER_TID, name: it.workspaceId });
    }
    docStore.set(`${it.workspaceId}::${it.id}`, clone(it));
  }
}

/** Every doc in the fake store, as FRESH objects — what a later pass re-reads. */
const reread = async (): Promise<WorkspaceItem[]> => [...docStore.values()].map(clone);

/** Run the sweep over a fixed item list, bypassing the Cosmos ENUMERATION. */
function sweep(items: WorkspaceItem[], o: Partial<Parameters<typeof sweepAutoBind>[0]> = {}) {
  register(items);
  return sweepAutoBind({
    dryRun: true,
    session: SESSION,
    providers: [seedingProvider()],
    loadItems: async () => items,
    ...o,
  });
}

const only = (rows: SweepRow[]): SweepRow => {
  expect(rows).toHaveLength(1);
  return rows[0];
};

beforeEach(() => {
  plane.reset();
  vi.resetAllMocks();
  wsStore.clear();
  docStore.clear();
  // The default workspace every `item()` lands in, OWNED by the caller — so the
  // access resolver takes its owner fast-path and the 26 pre-existing specs are
  // unaffected by the boundary while still passing through it.
  wsStore.set('ws-1', { id: 'ws-1', tenantId: CALLER_OID, tid: CALLER_TID, name: 'Ours' });
  vi.mocked(itemsContainer).mockImplementation(async () => itemsFake() as never);
});

// ===========================================================================
// THE CROSS-TENANT BOUNDARY (#2703 applied to a cross-partition scan)
//
// The sweep's default scope — no `workspaceId` — is the only shape that can
// reach a backlog, and it is a cross-partition query over a container that
// holds EVERY tenant's items. Nothing in the query can scope it: `items` is
// partitioned by `workspaceId` and the owning tenant is recorded on the
// WORKSPACE doc. So the boundary has to be a per-row filter, and these specs
// are what make its absence visible — the previous revision referenced the
// boundary zero times and every one of the other 26 specs stayed green.
//
// The REAL `resolveWorkspaceAccessByOid` runs (only Cosmos and the session are
// faked): mocking the resolver would test the mock, which is precisely the
// blind spot #2703 was filed about.
//
// DISCRIMINATION. The admin-open bypass is deliberately ON for these
// (`LOOM_TENANT_ADMIN_OID` = the caller), because that is the live shape — this
// route is admin-gated. With the bypass on, the tid comparison is the ONLY
// thing standing between the caller and every workspace in the container, and
// the include/exclude pair below differs in exactly one field: `tid`.
// ===========================================================================
describe('a workspace in another Entra tenant is out of scope', () => {
  const FOREIGN_WS = 'ws-theirs';
  const OTHER_OWNER = 'oid-someone-else';
  let priorAdminOid: string | undefined;

  /** Register the foreign workspace doc; `tid` is the variable under test. */
  const theirWorkspace = (tid: string) =>
    wsStore.set(FOREIGN_WS, { id: FOREIGN_WS, tenantId: OTHER_OWNER, tid, name: 'Theirs' });

  /** No backing object exists — so a live sweep WOULD create and seed one. */
  const theirItem = () =>
    item({ displayName: 'Theirs-ETL', id: 'id-theirs', workspaceId: FOREIGN_WS, state: gatedInstallState() });

  beforeEach(() => {
    priorAdminOid = process.env.LOOM_TENANT_ADMIN_OID;
    process.env.LOOM_TENANT_ADMIN_OID = CALLER_OID;
  });
  afterEach(() => {
    if (priorAdminOid === undefined) delete process.env.LOOM_TENANT_ADMIN_OID;
    else process.env.LOOM_TENANT_ADMIN_OID = priorAdminOid;
  });

  it('is excluded from the DRY-RUN rows, and not even probed', async () => {
    theirWorkspace(FOREIGN_TID);

    const result = await sweep([theirItem()]);

    expect(result.rows).toEqual([]);
    expect(result.scanned).toBe(0);
    // Counted, never silently dropped — `scanned` must not read as "all of it".
    expect(result.excludedByAccess).toBe(1);
    // The filter runs BEFORE classification, so the row costs zero reads.
    expect(plane.networkCalls).toBe(0);
  });

  it('is excluded from the LIVE mutation path — nothing created, seeded or stamped', async () => {
    theirWorkspace(FOREIGN_TID);

    const result = await sweep([theirItem()], { dryRun: false });

    expect(result.rows).toEqual([]);
    expect(result.excludedByAccess).toBe(1);
    // The concrete harm: a live sweep over an unbound item CREATES the ADF
    // object and writes the item's authored activities into it.
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    // …and stamps provenance on their Cosmos document.
    expect(readAutoBindRecord(docStore.get(`${FOREIGN_WS}::id-theirs`)!.state)).toBeNull();
  });

  it('leaks no identifier for it — the response carries a COUNT and nothing else', async () => {
    theirWorkspace(FOREIGN_TID);

    const body = JSON.stringify(await sweep([theirItem()]));

    expect(body).not.toContain('Theirs-ETL');
    expect(body).not.toContain('id-theirs');
    expect(body).not.toContain(FOREIGN_WS);
  });

  it('but the SAME row IS swept when that workspace is in the caller\'s tenant', async () => {
    // Byte-identical to the exclusion cases except for this one field. Without
    // this control the specs above would also pass on a sweep that returns
    // nothing at all, or one whose provider never matched.
    theirWorkspace(CALLER_TID);

    const result = await sweep([theirItem()], { dryRun: false });

    expect(result.rows.map((r) => r.disposition)).toEqual(['created']);
    expect(result.excludedByAccess).toBe(0);
    expect(plane.createCalls).toEqual(['Theirs-ETL']);
    expect(plane.objects.get('Theirs-ETL')!.activities).toHaveLength(3);
  });

  it('a mixed page reports only the caller\'s rows and counts the rest', async () => {
    theirWorkspace(FOREIGN_TID);
    plane.objects.set('Ours-ETL', { activities: [] });

    const result = await sweep([
      theirItem(),
      item({ displayName: 'Ours-ETL', state: gatedInstallState() }),
      theirItem(),
    ]);

    expect(result.rows.map((r) => r.workspaceId)).toEqual(['ws-1']);
    expect(result.scanned).toBe(1);
    expect(result.excludedByAccess).toBe(2);
    // One resolve per DISTINCT workspace, not per row — the cache is what keeps
    // a 200-row page from costing 200 workspace lookups.
    expect(only(result.rows).disposition).toBe('would-repair');
  });
});


// ===========================================================================
// THE SAFETY CASE — the one that must never regress
// ===========================================================================
describe('an authored backing object is never touched', () => {
  const authored = [{ name: 'UserWrote', type: 'Copy' }];

  it('a LIVE sweep leaves a non-empty pipeline byte-identical', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });

    const result = await sweep([item({ displayName: 'Prod-ETL', state: gatedInstallState() })], { dryRun: false });

    expect(only(result.rows).disposition).toBe('has-content');
    // The seed hook was never invoked, so bundle content cannot have overwritten
    // work the user (or a previous authoring run) put there.
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.get('Prod-ETL')!.activities).toBe(authored);
  });

  it('a REFUSED repair is never reported as repaired', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });

    const result = await sweep([item({ displayName: 'Prod-ETL', state: gatedInstallState() })], { dryRun: false });
    const r = only(result.rows);

    // `maybeRepairSeed` answers a refusal with `{seeded:true, detail:'backing
    // object already holds content'}` — right for the editor (it clears a stale
    // seedError), wrong for a report. Reading that back as `repaired` would
    // credit the sweep with a write it never made, and the count would be wrong
    // in the flattering direction.
    expect(r.disposition).not.toBe('repaired');
    expect(r.disposition).not.toBe('created');
    expect(result.byDisposition.repaired).toBeUndefined();
    expect(r.reason).toMatch(/already holds content/i);
  });

  it('a second pass over the same estate costs nothing', async () => {
    plane.objects.set('Prod-ETL', { activities: authored });
    const items = [item({ displayName: 'Prod-ETL', state: gatedInstallState() })];

    await sweep(items, { dryRun: false });
    // The engine stamped provenance on the in-memory item — that stamp is the
    // entire reason `has-content` rows are still handed to it.
    expect(readAutoBindRecord(items[0].state)?.seeded).toBe(true);

    plane.reset();
    plane.objects.set('Prod-ETL', { activities: authored });
    const second = await sweep(items, { dryRun: false });

    expect(only(second.rows).disposition).toBe('already-healthy');
    // Guard 1 returns before ANY network call. Without this, every later sweep
    // re-pays the isEmpty probe and the route's "each pass strictly cheapens the
    // next" claim is false.
    expect(plane.networkCalls).toBe(0);
  });
});

// ===========================================================================
// GUARD 1 — `already-healthy` is the ONE disposition that verifies nothing
//
// It returns before `preflight`, before `probe`, before `isEmpty`: the entire
// basis for calling an item healthy is the provenance record on its own state.
// So exactly what that guard accepts is load-bearing, and until these specs
// existed it was pinned by nothing — widening `record?.seeded === true` to
// `record` left all 26 other tests green while reclassifying #3549's ACTUAL
// population (an item bound at create time whose seed never finished, so the
// record exists and `seeded` is absent, over an empty ADF pipeline) from
// "repair this" to "healthy, don't look".
// ===========================================================================
describe('guard 1 accepts a SEEDED record, not merely a record', () => {
  /** #3549's population: bound (record present) but never seeded. */
  const boundUnseeded = () => item({
    displayName: 'Legacy-Bound',
    state: {
      ...gatedInstallState(),
      autoBind: { provider: 'fake-pipeline', backingName: 'Legacy-Bound', via: 'created' },
    },
  });

  it('a record WITHOUT `seeded` over an empty object is would-repair, not already-healthy', async () => {
    plane.objects.set('Legacy-Bound', { activities: [] });

    const r = only((await sweep([boundUnseeded()])).rows);

    expect(r.disposition).toBe('would-repair');
    expect(r.disposition).not.toBe('already-healthy');
    // It has to actually LOOK. `already-healthy` short-circuits every probe, so
    // the emptiness probe firing is what proves the guard did not swallow it.
    expect(plane.emptyProbes).toEqual(['Legacy-Bound']);
  });

  it('and a LIVE sweep repairs it', async () => {
    plane.objects.set('Legacy-Bound', { activities: [] });

    const r = only((await sweep([boundUnseeded()], { dryRun: false })).rows);

    expect(r.disposition).toBe('repaired');
    expect(plane.objects.get('Legacy-Bound')!.activities).toHaveLength(3);
  });

  it('while the SAME record WITH `seeded:true` is already-healthy at zero cost', async () => {
    // The discrimination control: one field apart from the fixture above. It is
    // what stops "would-repair" being the answer to everything.
    plane.objects.set('Legacy-Bound', { activities: [] });
    const seeded = item({
      displayName: 'Legacy-Bound',
      state: {
        ...gatedInstallState(),
        autoBind: { provider: 'fake-pipeline', backingName: 'Legacy-Bound', via: 'created', seeded: true },
      },
    });

    const r = only((await sweep([seeded])).rows);

    expect(r.disposition).toBe('already-healthy');
    expect(plane.networkCalls).toBe(0);
  });
});

// ===========================================================================
// CONVERGENCE IS A PROPERTY OF COSMOS, NOT OF THE IN-MEMORY ITEM
//
// The route's docblock justifies returning a partial result with "each pass
// strictly cheapens the next". The next pass is a different request in a
// different process: it re-reads the document. `autoBindOnOpen` merges the
// patch into the in-memory item ALWAYS and persists it only best-effort —
// `persistAutoBindPatch` catches its own failure and returns false, which the
// sweep used to discard. A suite that hands pass 2 the same array pass 1
// mutated therefore measures the merge and never the write.
// ===========================================================================
describe('the provenance write', () => {
  it('is reported as landed on a repaired row, and is in the STORE', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });

    const r = only((await sweep(
      [item({ displayName: 'Daily-Batch', state: gatedInstallState() })],
      { dryRun: false },
    )).rows);

    expect(r.disposition).toBe('repaired');
    expect(r.persisted).toBe(true);
    // Not the in-memory item — the document a later pass will re-read.
    expect(readAutoBindRecord(docStore.get('ws-1::id-Daily-Batch')!.state)?.seeded).toBe(true);
  });

  it('is reported as landed on a REFUSED (has-content) row too — that stamp IS the cheapening', async () => {
    plane.objects.set('Prod-ETL', { activities: [{ name: 'UserWrote', type: 'Copy' }] });

    const r = only((await sweep(
      [item({ displayName: 'Prod-ETL', state: gatedInstallState() })],
      { dryRun: false },
    )).rows);

    expect(r.disposition).toBe('has-content');
    expect(r.persisted).toBe(true);
    expect(readAutoBindRecord(docStore.get('ws-1::id-Prod-ETL')!.state)?.seeded).toBe(true);
  });

  it('is reported as NOT landed when the write is swallowed', async () => {
    plane.objects.set('Ghost', { activities: [] });
    // Deliberately NOT registered in the store: `persistAutoBindPatch` reads the
    // document first, finds nothing, and returns false without throwing. Before
    // `persisted` was surfaced this row was indistinguishable from a converged
    // one — the sweep would report `repaired` on every pass, forever, with
    // nothing anywhere saying why the count never fell.
    const orphan = item({ displayName: 'Ghost', state: gatedInstallState() });

    const r = only((await sweepAutoBind({
      dryRun: false,
      session: SESSION,
      providers: [seedingProvider()],
      loadItems: async () => [orphan],
    })).rows);

    expect(r.disposition).toBe('repaired');
    expect(r.persisted).toBe(false);
    expect(docStore.has('ws-1::id-Ghost')).toBe(false);
  });

  it('makes a second pass that RE-READS Cosmos already-healthy at zero cost', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });
    await sweep([item({ displayName: 'Daily-Batch', state: gatedInstallState() })], { dryRun: false });

    plane.reset();
    plane.objects.set('Daily-Batch', { activities: BUNDLE_CONTENT.activities });
    const second = await sweepAutoBind({
      dryRun: false,
      session: SESSION,
      providers: [seedingProvider()],
      // FRESH documents out of the fake Cosmos — not the objects pass 1 mutated.
      loadItems: reread,
    });

    expect(only(second.rows).disposition).toBe('already-healthy');
    expect(plane.networkCalls).toBe(0);
    expect(plane.seedCalls).toEqual([]);
  });

  it('is absent on a dry-run row — nothing was written, so there is nothing to report', async () => {
    plane.objects.set('Empty-One', { activities: [] });

    const r = only((await sweep([item({ displayName: 'Empty-One', state: gatedInstallState() })])).rows);

    expect(r.disposition).toBe('would-repair');
    expect(r.persisted).toBeUndefined();
    expect('persisted' in r).toBe(false);
  });
});

// ===========================================================================
// DRY-RUN WRITES NOTHING
// ===========================================================================
describe('dry-run', () => {
  it('creates nothing and seeds nothing, even for items that need both', async () => {
    plane.objects.set('Empty-One', { activities: [] });
    const items = [
      item({ displayName: 'Empty-One', state: gatedInstallState() }),
      item({ displayName: 'Absent-One', state: gatedInstallState() }),
    ];

    const result = await sweep(items);

    expect(result.dryRun).toBe(true);
    expect(result.rows.map((r) => r.disposition)).toEqual(['would-repair', 'missing']);
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.get('Empty-One')!.activities).toEqual([]);
    expect(plane.objects.has('Absent-One')).toBe(false);
  });

  it('separates "empty with content to author" from "correctly empty"', async () => {
    plane.objects.set('Has-Content', { activities: [] });
    plane.objects.set('Blank-Item', { activities: [] });

    const result = await sweep([
      item({ displayName: 'Has-Content', state: gatedInstallState() }),
      item({ displayName: 'Blank-Item' }),
    ]);

    expect(result.rows[0].disposition).toBe('would-repair');
    // The picker-created item: empty backing object, nothing to author. #3796's
    // "stated reason" branch, not a defect to be counted against 36 → 0.
    expect(result.rows[1].disposition).toBe('no-authored-content');
    expect(result.rows[1].reason).toMatch(/CORRECT state/);
  });
});

// ===========================================================================
// LIVE MODE — the repair actually lands
// ===========================================================================
describe('live mode', () => {
  it('authors the item\'s real activities into an existing EMPTY object', async () => {
    plane.objects.set('Daily-Batch', { activities: [] });

    const result = await sweep(
      [item({ displayName: 'Daily-Batch', state: gatedInstallState() })],
      { dryRun: false },
    );
    const r = only(result.rows);

    expect(r.disposition).toBe('repaired');
    expect(r.backingName).toBe('Daily-Batch');
    // The reason is the ENGINE's own seedDetail, not a sentence of ours guessing
    // at what it did.
    expect(r.reason).toBe('3 activities');
    expect(plane.objects.get('Daily-Batch')!.activities).toHaveLength(3);
  });

  it('creates AND seeds a backing object that does not exist', async () => {
    const result = await sweep(
      [item({ displayName: 'Missing-One', state: gatedInstallState() })],
      { dryRun: false },
    );

    expect(only(result.rows).disposition).toBe('created');
    expect(plane.createCalls).toEqual(['Missing-One']);
    expect(plane.objects.get('Missing-One')!.activities).toHaveLength(3);
  });

  it('reports content of a kind this provider cannot author, rather than claiming a repair', async () => {
    plane.objects.set('Odd-Kind', { activities: [] });

    // Dry-run can only test SHAPE — the accepted kind list lives inside the
    // provider's own seedFromContent, and a second copy here would drift. So
    // dry-run says `would-repair` and only the live run knows better.
    const dry = await sweep([item({ displayName: 'Odd-Kind', state: { content: { kind: 'power-bi-report' } } })]);
    expect(only(dry.rows).disposition).toBe('would-repair');

    plane.reset();
    plane.objects.set('Odd-Kind', { activities: [] });
    const live = await sweep(
      [item({ displayName: 'Odd-Kind', state: { content: { kind: 'power-bi-report' } } })],
      { dryRun: false },
    );

    expect(only(live.rows).disposition).toBe('no-authored-content');
    expect(plane.objects.get('Odd-Kind')!.activities).toEqual([]);
  });

  it('surfaces a seed that FAILED instead of swallowing it', async () => {
    plane.objects.set('Boom', { activities: [] });
    const providers = [seedingProvider({
      seedFromContent: async () => { throw new Error('ADF returned 403 on pipeline write'); },
    })];

    const result = await sweep(
      [item({ displayName: 'Boom', state: gatedInstallState() })],
      { dryRun: false, providers },
    );
    const r = only(result.rows);

    expect(r.disposition).toBe('seed-failed');
    expect(r.reason).toContain('403');
  });
});

// ===========================================================================
// DRY-RUN AND LIVE AGREE ON EVERY NON-ACTIONABLE ROW
// ===========================================================================
describe('the two modes cannot drift', () => {
  it('agree on every disposition that needs no action', async () => {
    plane.objects.set('Full', { activities: [{ name: 'x' }] });
    plane.objects.set('Blank', { activities: [] });
    const items = () => [
      item({ displayName: 'Full', state: gatedInstallState() }),
      item({ displayName: 'Blank' }),
      item({ displayName: 'Alien', itemType: 'no-such-type' }),
      item({
        displayName: 'Healthy',
        state: { autoBind: { provider: 'fake-pipeline', backingName: 'Healthy', seeded: true } },
      }),
    ];

    const dry = await sweep(items());
    plane.emptyProbes = [];
    const live = await sweep(items(), { dryRun: false });

    // Both verdicts come from ONE function (`previewOne`), which is what makes
    // this hold by construction rather than by two lists being kept in step.
    expect(dry.rows.map((r) => r.disposition)).toEqual(['has-content', 'no-authored-content', 'unsupported', 'already-healthy']);
    expect(live.rows.map((r) => r.disposition)).toEqual(dry.rows.map((r) => r.disposition));
    expect(live.rows.map((r) => r.reason)).toEqual(dry.rows.map((r) => r.reason));
  });

  it('report an infrastructure gate identically and probe nothing', async () => {
    const providers = [seedingProvider({
      preflight: async () => {
        plane.preflightCalls += 1;
        return { ok: false, kind: 'unavailable', reason: 'LOOM_ADF_NAME is not set on this deployment.' };
      },
    })];
    const items = [item({ displayName: 'Gated', state: gatedInstallState() })];

    for (const dryRun of [true, false]) {
      plane.reset();
      const result = await sweep(items, { dryRun, providers });
      const r = only(result.rows);
      expect(r.disposition).toBe('unavailable');
      expect(r.reason).toContain('LOOM_ADF_NAME');
      expect(plane.probeCalls).toEqual([]);
    }
  });

  it('classify a transient preflight as retry, not as a permanent gate', async () => {
    const providers = [seedingProvider({
      preflight: async () => ({ ok: false, kind: 'retry', reason: 'ADF returned 429.' }),
    })];

    const result = await sweep([item({ displayName: 'Throttled' })], { providers });
    expect(only(result.rows).disposition).toBe('retry');
  });
});

// ===========================================================================
// COVERAGE STATED, NEVER IMPLIED
// ===========================================================================
describe('providers repair cannot reach', () => {
  it('names a provider with no isEmpty probe instead of skipping it silently', async () => {
    plane.objects.set('No-Probe', { activities: [] });
    const providers = [seedingProvider({ isEmpty: undefined })];

    const r = only((await sweep([item({ displayName: 'No-Probe', state: gatedInstallState() })], { providers })).rows);

    // eventstream / adx-database / lakehouse-adls land here on the real
    // registry. Counted and named — the alternative is a sweep that reports a
    // clean estate over item types it never evaluated.
    expect(r.disposition).toBe('no-empty-probe');
    expect(r.reason).toContain('#3694');
    expect(plane.emptyProbes).toEqual([]);
  });

  it('names an item type no provider claims', async () => {
    const r = only((await sweep([item({ displayName: 'Orphan', itemType: 'mirrored-database' })])).rows);
    expect(r.disposition).toBe('unsupported');
    expect(r.reason).toContain('mirrored-database');
    expect(r.provider).toBeNull();
  });
});

// ===========================================================================
// A PARTIAL SCAN IS NEVER REPORTED AS A COMPLETE ONE
// ===========================================================================
describe('truncation honesty', () => {
  it('an exactly-full page is not reported as a complete scan', async () => {
    const items = ['a', 'b', 'c'].map((n) => item({ displayName: n }));
    let asked = 0;

    const result = await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      limit: 2,
      loadItems: async (o) => { asked = o.limit; return items; },
    });

    // Fetch limit+1: a page of exactly `limit` rows is otherwise
    // indistinguishable from an estate that happens to hold exactly that many.
    expect(asked).toBe(3);
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('limit');
  });

  it('a full page that fits is NOT flagged truncated', async () => {
    const result = await sweep([item({ displayName: 'a' }), item({ displayName: 'b' })], { limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBy).toBeUndefined();
  });

  it('stops on the wall-clock budget and says so', async () => {
    // [deadline base, item-1 check, item-2 check]
    const ticks = [0, 0, 9_999];
    let i = 0;

    const result = await sweep(
      [item({ displayName: 'a' }), item({ displayName: 'b' })],
      { deadlineMs: 500, now: () => ticks[Math.min(i++, ticks.length - 1)] },
    );

    expect(result.scanned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe('deadline');
  });

  it('clamps the row cap to the documented bounds', async () => {
    const asked: number[] = [];
    const run = (limit: number) => sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      limit,
      loadItems: async (o) => { asked.push(o.limit); return []; },
    });

    await run(5000);
    await run(0);
    expect(asked).toEqual([1001, 2]); // MAX_LIMIT + 1, then min 1 + 1
  });
});

// ===========================================================================
// ONE BAD ITEM MUST NOT COST THE REST OF THE ESTATE
// ===========================================================================
describe('resilience', () => {
  it('one item that throws does not abort the sweep', async () => {
    plane.objects.set('Good', { activities: [] });
    const providers = [seedingProvider({
      probe: async (name) => {
        plane.probeCalls.push(name);
        if (name === 'Poison') throw new Error('ETIMEDOUT reading pipeline');
        return plane.objects.has(name);
      },
    })];

    const result = await sweep(
      [item({ displayName: 'Poison' }), item({ displayName: 'Good', state: gatedInstallState() })],
      { providers },
    );

    expect(result.rows[0].disposition).toBe('failed');
    expect(result.rows[0].reason).toContain('ETIMEDOUT');
    // The backlog is exactly the population most likely to throw, so aborting on
    // the first failure would make the sweep useless precisely where it matters.
    expect(result.rows[1].disposition).toBe('would-repair');
    expect(result.scanned).toBe(2);
  });

  it('tallies every disposition it emitted', async () => {
    plane.objects.set('Full', { activities: [{ name: 'x' }] });
    plane.objects.set('E1', { activities: [] });
    plane.objects.set('E2', { activities: [] });
    plane.objects.set('Blank', { activities: [] });

    const result = await sweep([
      item({ displayName: 'Full', state: gatedInstallState() }),
      item({ displayName: 'E1', state: gatedInstallState() }),
      item({ displayName: 'E2', state: gatedInstallState() }),
      item({ displayName: 'Blank' }),
    ]);

    expect(result.byDisposition).toEqual({ 'has-content': 1, 'would-repair': 2, 'no-authored-content': 1 });
    expect(Object.values(result.byDisposition).reduce((a, b) => a + b, 0)).toBe(result.scanned);
  });
});

// ===========================================================================
// SCOPE SELECTION
// ===========================================================================
describe('scope', () => {
  it('item types are DERIVED from the registry, never hand-listed', async () => {
    const derived = sweepableItemTypes();

    expect(derived.length).toBeGreaterThan(0); // a list that can silently empty is not a control
    expect(derived).toEqual([...new Set(AUTO_BIND_PROVIDERS.flatMap((p) => p.itemTypes))].sort());
    // Known-true anchor: two providers claim `data-pipeline`, so this also
    // proves the de-duplication rather than just the flatten.
    expect(derived).toContain('data-pipeline');
    expect(derived.filter((t) => t === 'data-pipeline')).toHaveLength(1);
    expect([...derived]).toEqual([...derived].sort());
  });

  it('narrows to the intersection of the request and the registry', async () => {
    let passed: string[] = [];
    await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider(), { ...seedingProvider(), provider: 'other', itemTypes: ['other-item'] }],
      itemTypes: ['fake-item', 'not-a-real-type'],
      loadItems: async (o) => { passed = o.itemTypes; return []; },
    });
    expect(passed).toEqual(['fake-item']);
  });

  it('queries nothing at all when the requested types match no provider', async () => {
    let called = false;
    const result = await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      itemTypes: ['mirrored-database'],
      loadItems: async () => { called = true; return []; },
    });

    expect(called).toBe(false);
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.excludedByAccess).toBe(0);
  });

  it('passes the workspace filter through to the loader', async () => {
    let seen: string | undefined = 'unset';
    await sweep([], { workspaceId: 'ws-42', loadItems: async (o) => { seen = o.workspaceId; return []; } });
    expect(seen).toBe('ws-42');
  });
});

// ===========================================================================
// THE REAL COSMOS ENUMERATION (the path no injected loader exercises)
// ===========================================================================
describe('loadSweepItems', () => {
  it('filters by item type and workspace, and caps with TOP', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    await sweepAutoBind({
      dryRun: true,
      session: SESSION,
      providers: [seedingProvider()],
      workspaceId: 'ws-7',
      limit: 5,
    });

    expect(spec!.query).toContain('ARRAY_CONTAINS(@types, c.itemType)');
    expect(spec!.query).toContain('c.workspaceId = @ws');
    expect(spec!.query).toContain('SELECT TOP @limit');
    expect(spec!.parameters).toEqual([
      { name: '@types', value: ['fake-item'] },
      { name: '@ws', value: 'ws-7' },
      { name: '@limit', value: 6 },
    ]);
  });

  it('omits the workspace predicate when sweeping every workspace', async () => {
    let spec: { query: string; parameters: { name: string; value: unknown }[] } | undefined;
    vi.mocked(itemsContainer).mockResolvedValue({
      items: {
        query: (s: typeof spec) => { spec = s; return { fetchAll: async () => ({ resources: [] }) }; },
      },
    } as never);

    await sweepAutoBind({ dryRun: true, session: SESSION, providers: [seedingProvider()] });

    // `c.workspaceId` is also a PROJECTED column (SweepRow reports it), so the
    // assertion has to name the predicate, not the identifier.
    expect(spec!.query).toContain('c.workspaceId,');
    expect(spec!.query).not.toContain('= @ws');
    expect(spec!.parameters.map((p) => p.name)).toEqual(['@types', '@limit']);
  });
});
