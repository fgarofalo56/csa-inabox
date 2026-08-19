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
 * MUTATION PROOF — measured, not asserted (temp/mutation-proof.py, 2026-08-19)
 * ---------------------------------------------------------------------------
 * Each mutation was applied to `auto-bind-sweep.ts`, the suite run, the file
 * restored. Baseline 26/26 green; every mutation below was CAUGHT.
 *
 *   a) In `repairOne`, delete `if (!actionable) return preview;` so `has-content`
 *      rows return the ENGINE's verdict → 3 RED, incl.
 *        "a REFUSED repair is never reported as repaired"
 *      This is the real defect the restructure fixed: `maybeRepairSeed` reports
 *      its refusal as `{seeded:true}`, so reading it back credits the sweep with
 *      a write it never made — inflating the headline, in the flattering
 *      direction, which is the direction nobody re-checks.
 *   b) In `repairOne`, short-circuit `has-content` BEFORE calling the engine
 *      (widen the early return to `if (!actionable)`) → 1 RED:
 *        "a second pass over the same estate costs nothing"
 *      That is the convergence property the route's docblock promises.
 *   c) Drop the `+ 1` from `load({… limit: limit + 1})` → 3 RED, incl.
 *        "an exactly-full page is not reported as a complete scan"
 *   d) Remove the per-item try/catch in `sweepAutoBind` → 1 RED:
 *        "one item that throws does not abort the sweep"
 *   e) Hand-list `sweepableItemTypes` instead of deriving it → 3 RED, incl.
 *        "item types are DERIVED from the registry, never hand-listed"
 *   f) Let dry-run call `repairOne` → 5 RED (every "writes nothing" assertion).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// `persistAutoBindPatch` and `loadSweepItems` both `await import()` this module.
// Mocking it keeps the real Cosmos client (and its env/connection work) out of
// a unit test, and gives the enumeration test a container to inspect.
vi.mock('@/lib/azure/cosmos-client', () => ({ itemsContainer: vi.fn() }));

import { sweepAutoBind, sweepableItemTypes, type SweepRow } from '@/lib/azure/auto-bind-sweep';
import { readAutoBindRecord, type AutoBindProvider } from '@/lib/azure/auto-bind';
import { AUTO_BIND_PROVIDERS } from '@/lib/azure/auto-bind-providers';
import { authoredContent } from '@/lib/azure/auto-bind-seed';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { itemsContainer } from '@/lib/azure/cosmos-client';

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
  state?: Record<string, unknown>;
}): WorkspaceItem {
  return {
    id: o.id ?? `id-${o.displayName}`,
    workspaceId: 'ws-1',
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

/** Run the sweep over a fixed item list, bypassing Cosmos. */
function sweep(items: WorkspaceItem[], o: Partial<Parameters<typeof sweepAutoBind>[0]> = {}) {
  return sweepAutoBind({
    dryRun: true,
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
      providers: [seedingProvider()],
      itemTypes: ['mirrored-database'],
      loadItems: async () => { called = true; return []; },
    });

    expect(called).toBe(false);
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
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

    await sweepAutoBind({ dryRun: true, providers: [seedingProvider()] });

    // `c.workspaceId` is also a PROJECTED column (SweepRow reports it), so the
    // assertion has to name the predicate, not the identifier.
    expect(spec!.query).toContain('c.workspaceId,');
    expect(spec!.query).not.toContain('= @ws');
    expect(spec!.parameters.map((p) => p.name)).toEqual(['@types', '@limit']);
  });
});
