/**
 * AUTO-BIND SEEDING — #3549 "the empty twin".
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS PIN
 * ---------------------------------------------------------------------------
 * A bundle-installed item carries its authored content on `state.content` from
 * the moment the Cosmos item is created (`app/api/apps/[id]/install/route.ts`
 * stamps it BEFORE provisioning runs). When the install-time provisioner then
 * config-gates — `LOOM_ADF_NAME` unset, say — it returns `status:'remediation'`
 * without authoring anything, so no Azure object exists and no binding key is
 * stamped.
 *
 * On first open the bind GET calls `autoBindOnOpen` → `ensureAutoBinding`,
 * which finds no candidate, probes the deterministic name, finds nothing, and
 * calls `create()`. `create()` deliberately authors an EMPTY object. The item
 * is then bound to a real, published, EMPTY Azure resource and reports healthy
 * forever — live, 36 of 41 pipelines in `adf-loom-default-centralus` had
 * `activities: []`, with real `lastPublishTime` and `etag`.
 *
 * The fix is the `seedFromContent` hook: the engine calls it after a create so
 * the object is authored with the item's REAL content.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH TEST WOULD FAIL ON MAIN
 * ---------------------------------------------------------------------------
 * Every assertion below is about content ENDING UP IN THE BACKING OBJECT. On
 * main there is no `seedFromContent` call site at all, so the fake plane's
 * stored object stays `{activities: []}` and each content assertion fails.
 *
 * MUTATION PROOF (break the subject, watch these go red, restore):
 *   a) Delete the `if (provider.seedFromContent) { … }` block in
 *      `ensureAutoBinding` step 5b  → 6 RED, including
 *        "seeds the item's REAL activities into the object it just created"
 *        "records seeded:true on the provenance record"
 *   b) Move the seed call ABOVE the `probe(target)` guard so it runs on the
 *      attach path too → 1 RED:
 *        "NEVER re-seeds an object that already existed (attach path)"
 *      — i.e. bundle content would overwrite a user's authored pipeline.
 *   c) Make step 5b rethrow instead of capturing → 1 RED:
 *        "a throwing seed leaves a BOUND item, not a dead end"
 *   d) Drop `seeded`/`seedError` from the `changed` comparison in `finish()`
 *      → 1 RED: "a seed that lands is persisted (changed:true)"
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureAutoBinding,
  readAutoBindRecord,
  autoBindWireStatus,
  type AutoBindContext,
  type AutoBindProvider,
} from '@/lib/azure/auto-bind';
import { AUTO_BIND_PROVIDERS } from '@/lib/azure/auto-bind-providers';
import { authoredContent } from '@/lib/azure/auto-bind-seed';

// ---------------------------------------------------------------------------
// A fake control plane that stores an object's CONTENT, not just its name.
// That is the whole point: the #3549 object existed — it was its contents that
// were missing — so a fake that only tracked existence could not see the bug.
// ---------------------------------------------------------------------------
class ContentPlane {
  /** name → the document currently stored for it. */
  objects = new Map<string, { activities: unknown[] }>();
  createCalls: string[] = [];
  seedCalls: string[] = [];
  /** Names `isEmpty` was asked about — proves the steady-state open skips it. */
  emptyProbes: string[] = [];

  reset() {
    this.objects.clear();
    this.createCalls = [];
    this.seedCalls = [];
    this.emptyProbes = [];
  }
}

const plane = new ContentPlane();

/** The bundle shape a real content bundle stamps onto `state.content`. */
const BUNDLE_CONTENT = {
  kind: 'adf-pipeline',
  parameters: { ProcessingDate: { type: 'string', defaultValue: '@utcnow()' } },
  activities: [
    { name: 'BronzeToSilverDQ', type: 'DatabricksNotebook', config: { notebookPath: '/Shared/02_stream' } },
    { name: 'GoldAggregation', type: 'DatabricksNotebook', dependsOn: ['BronzeToSilverDQ'], config: { notebookPath: '/Shared/03_gold' } },
    { name: 'OptimizeGold', type: 'DatabricksNotebook', dependsOn: ['GoldAggregation'], config: { notebookPath: '/Shared/04_optimize' } },
  ],
};

/**
 * A provider shaped exactly like the real pipeline ones: `create` authors an
 * EMPTY object, `seedFromContent` fills it from `ctx.state.content`.
 */
function seedingProvider(over: Partial<AutoBindProvider> = {}): AutoBindProvider {
  return {
    provider: 'fake-pipeline',
    itemTypes: ['fake-item'],
    backingNameFor: (ctx) => ({ name: ctx.displayName.replace(/[^A-Za-z0-9-]+/g, '-'), sanitized: false }),
    preflight: async () => ({ ok: true, coords: { factoryName: 'adf-test' } }),
    probe: async (name) => plane.objects.has(name),
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

function ctxFor(displayName: string, state: Record<string, unknown> = {}): AutoBindContext {
  return { itemId: 'item-1', itemType: 'fake-item', displayName, workspaceId: 'ws-1', state };
}

/** The exact state a GATED bundle install leaves behind: content, no binding. */
function gatedInstallState() {
  return { sourceApp: 'app-azure-realtime-analytics', content: BUNDLE_CONTENT };
}

beforeEach(() => plane.reset());

describe('#3549 — a gated bundle install, opened for the first time', () => {
  it('seeds the item\'s REAL activities into the object it just created', async () => {
    const providers = [seedingProvider()];
    const outcome = await ensureAutoBinding(
      ctxFor('Daily-Batch-Processing-Pipeline', gatedInstallState()),
      { providers },
    );

    expect(outcome.status).toBe('bound');
    // The object was created by us on this open …
    expect(plane.createCalls).toEqual(['Daily-Batch-Processing-Pipeline']);
    // … and it is NOT the empty twin the live factory was full of.
    const stored = plane.objects.get('Daily-Batch-Processing-Pipeline');
    expect(stored?.activities).toHaveLength(3);
    expect((stored?.activities as any[]).map((a) => a.name)).toEqual([
      'BronzeToSilverDQ', 'GoldAggregation', 'OptimizeGold',
    ]);
  });

  it('records seeded:true on the provenance record so support can see it', async () => {
    const providers = [seedingProvider()];
    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    if (outcome.status !== 'bound') throw new Error('expected bound');

    expect(outcome.record.seeded).toBe(true);
    expect(outcome.record.via).toBe('created');
    expect(outcome.record.seedError).toBeUndefined();
    // …and it survives a round-trip through Cosmos.
    const roundTripped = readAutoBindRecord(outcome.statePatch as Record<string, unknown>);
    expect(roundTripped?.seeded).toBe(true);
  });

  it('a seed that lands is persisted (changed:true)', async () => {
    const providers = [seedingProvider()];
    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.changed).toBe(true);
  });

  it('surfaces the seed result on the wire so the editor can act on it', async () => {
    const providers = [seedingProvider()];
    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    expect(autoBindWireStatus(outcome)).toMatchObject({ status: 'bound', seeded: true });
  });
});

// ===========================================================================
// A FAILED SEED MUST NOT BE TERMINAL, AND THE ALREADY-BROKEN POPULATION MUST
// BE REPAIRED (#3549 review, BLOCKER 3).
//
// Two gaps, one mechanism:
//
//   RETRY    `seedError` was carried forward untouched on the 'existing' path
//            and step 5b ran on CREATE only, so once a seed failed nothing ever
//            retried it — not even after an operator granted the missing role.
//            The item stayed bound to an empty pipeline permanently.
//
//   BACKFILL `probe` is EXISTENCE-only. An item already bound to an empty
//            pipeline (the population #3549 was reported for) probes true →
//            `via:'existing'` → no seed → empty forever. The PR shipped no
//            backfill, so it prevented NEW occurrences while leaving every
//            existing one broken.
//
// The repair is gated on the backing object actually being EMPTY (the new
// `isEmpty` provider hook), because seeding over an object that holds work
// would destroy it. The two CONTROLS below run that direction.
// ===========================================================================
describe('#3549 BLOCKER 3 — a failed seed is retried, and empty bindings are repaired', () => {
  it('RE-SEEDS on a later open after the first seed failed', async () => {
    // Open 1: the estate refuses the write (no Data Factory Contributor yet).
    const failing = [seedingProvider({
      seedFromContent: async () => ({ seeded: false, error: 'ADF 403: cannot author the pipeline.' }),
    })];
    const first = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers: failing });
    if (first.status !== 'bound') throw new Error('expected bound');
    expect(first.record.seedError).toContain('403');
    expect(plane.objects.get('P1')?.activities).toEqual([]);

    // The operator grants the role. Open 2 must REPAIR, not report the same
    // failure forever.
    const state = { ...gatedInstallState(), ...first.statePatch };
    const healed = await ensureAutoBinding(ctxFor('P1', state), { providers: [seedingProvider()] });

    expect(healed.status).toBe('bound');
    if (healed.status === 'bound') {
      expect(healed.record.seeded).toBe(true);
      expect(healed.record.seedError).toBeUndefined();
      // It must be PERSISTED, or the repair is forgotten on the next open.
      expect(healed.changed).toBe(true);
    }
    expect(plane.objects.get('P1')?.activities).toHaveLength(3);
  });

  it('BACKFILLS an item already bound to an EMPTY pipeline (the live population)', async () => {
    // The #3549 shape: a real, published, EMPTY pipeline the item is already
    // bound to via the legacy key, with NO autoBind record at all.
    plane.objects.set('P1', { activities: [] });
    const state = { ...gatedInstallState(), pipelineName: 'P1' };

    const outcome = await ensureAutoBinding(ctxFor('P1', state), { providers: [seedingProvider()] });

    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') {
      // Adopted, not re-created — the object was already there.
      expect(outcome.record.via).toBe('existing');
      expect(outcome.record.seeded).toBe(true);
    }
    expect(plane.createCalls).toEqual([]);
    // …and it is no longer the empty twin.
    expect(plane.objects.get('P1')?.activities).toHaveLength(3);
  });

  it('CONTROL — NEVER seeds over an existing pipeline that holds work', async () => {
    plane.objects.set('P1', { activities: [{ name: 'UserAuthored', type: 'Copy' }] });
    const state = { ...gatedInstallState(), pipelineName: 'P1' };

    const outcome = await ensureAutoBinding(ctxFor('P1', state), { providers: [seedingProvider()] });

    expect(outcome.status).toBe('bound');
    // The emptiness probe ran and correctly said "not empty" …
    expect(plane.emptyProbes).toEqual(['P1']);
    // … so no seed, and the user's activity is intact.
    expect(plane.seedCalls).toEqual([]);
    expect(plane.objects.get('P1')?.activities).toEqual([{ name: 'UserAuthored', type: 'Copy' }]);
  });

  it('CONTROL — a HEALTHY seeded item costs ZERO extra control-plane calls', async () => {
    const providers = [seedingProvider()];
    const first = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    if (first.status !== 'bound') throw new Error('expected bound');
    const state = { ...gatedInstallState(), ...first.statePatch };
    plane.emptyProbes = [];

    const second = await ensureAutoBinding(ctxFor('P1', state), { providers });

    expect(second.status).toBe('bound');
    // `seeded:true` on the record already answers the question, so the engine
    // must not pay for an emptiness probe on every steady-state open.
    expect(plane.emptyProbes).toEqual([]);
    expect(plane.seedCalls).toHaveLength(1);
    if (second.status === 'bound') expect(second.changed).toBe(false);
  });

  it('a blank item with no content is NOT repeatedly probed into a seed', async () => {
    const providers = [seedingProvider()];
    // No `content` — nothing to seed, and an empty object is correct for it.
    const outcome = await ensureAutoBinding(ctxFor('blank-item', {}), { providers });
    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') {
      expect(outcome.record.seeded).toBeUndefined();
      expect(outcome.record.seedError).toBeUndefined();
    }
  });
});

describe('seeding never destroys existing work', () => {
  it('NEVER re-seeds an object that already existed (attach path)', async () => {
    // A pipeline the installer already authored, or the user already edited.
    plane.objects.set('P1', { activities: [{ name: 'UserAuthored', type: 'Copy' }] });
    const providers = [seedingProvider()];

    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });

    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') expect(outcome.record.via).toBe('attached');
    expect(plane.createCalls).toEqual([]);
    expect(plane.seedCalls).toEqual([]);
    // The user's single activity is intact — NOT replaced by the bundle's three.
    expect(plane.objects.get('P1')?.activities).toEqual([{ name: 'UserAuthored', type: 'Copy' }]);
  });

  it('NEVER re-seeds on a steady-state open of an already-bound item', async () => {
    const providers = [seedingProvider()];
    // Open 1 — creates + seeds.
    const first = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    if (first.status !== 'bound') throw new Error('expected bound');
    const state = { ...gatedInstallState(), ...first.statePatch };

    // The user then edits the pipeline on the canvas (live object diverges from
    // the stale bundle content that is still sitting on state.content).
    plane.objects.set('P1', { activities: [{ name: 'EditedOnCanvas', type: 'Copy' }] });

    // Open 2 — must NOT re-author the bundle over the user's edit.
    const second = await ensureAutoBinding(ctxFor('P1', state), { providers });
    expect(second.status).toBe('bound');
    if (second.status === 'bound') {
      expect(second.record.via).toBe('existing');
      // No churn: nothing to write on a steady-state open.
      expect(second.changed).toBe(false);
      // The seed provenance is carried forward, not silently dropped.
      expect(second.record.seeded).toBe(true);
    }
    expect(plane.seedCalls).toHaveLength(1);
    expect(plane.objects.get('P1')?.activities).toEqual([{ name: 'EditedOnCanvas', type: 'Copy' }]);
  });

  it('DOES re-seed on self-heal, when the backing object was deleted out of band', async () => {
    const providers = [seedingProvider()];
    const first = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });
    if (first.status !== 'bound') throw new Error('expected bound');
    const state = { ...gatedInstallState(), ...first.statePatch };

    // Someone deletes the pipeline in the portal.
    plane.objects.delete('P1');

    const healed = await ensureAutoBinding(ctxFor('P1', state), { providers });
    expect(healed.status).toBe('bound');
    if (healed.status === 'bound') expect(healed.record.via).toBe('recreated');
    // Repaired WITH its activities — not resurrected as an empty husk.
    expect(plane.objects.get('P1')?.activities).toHaveLength(3);
  });
});

describe('a blank item is not a defect', () => {
  it('leaves a freshly-created item with NO authored content empty, and says so', async () => {
    const providers = [seedingProvider()];
    const outcome = await ensureAutoBinding(ctxFor('uat-data-pipeline-123', {}), { providers });

    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') {
      // `seeded` is absent, not true — there was nothing to seed …
      expect(outcome.record.seeded).toBeUndefined();
      // … and that is NOT an error state.
      expect(outcome.record.seedError).toBeUndefined();
    }
    expect(plane.objects.get('uat-data-pipeline-123')?.activities).toEqual([]);
  });
});

describe('a failed seed is honest, never a dead end', () => {
  it('stays BOUND but records seedError when content could not be authored', async () => {
    const providers = [
      seedingProvider({
        seedFromContent: async () => ({ seeded: false, error: 'ADF 403: cannot author the pipeline.' }),
      }),
    ];
    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });

    // The object EXISTS, so the editor must still open on a canvas.
    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') {
      expect(outcome.record.seeded).toBeUndefined();
      expect(outcome.record.seedError).toContain('403');
    }
    // And the editor is TOLD, so it cannot present an empty pipeline as complete.
    expect(autoBindWireStatus(outcome)).toMatchObject({
      status: 'bound',
      seedError: 'ADF 403: cannot author the pipeline.',
    });
  });

  it('a throwing seed leaves a BOUND item, not a dead end', async () => {
    const providers = [
      seedingProvider({
        seedFromContent: async () => { throw new Error('control plane exploded'); },
      }),
    ];
    const outcome = await ensureAutoBinding(ctxFor('P1', gatedInstallState()), { providers });

    expect(outcome.status).toBe('bound');
    if (outcome.status === 'bound') expect(outcome.record.seedError).toContain('control plane exploded');
  });
});

// ---------------------------------------------------------------------------
// MECHANICAL ENUMERATION over the live registry.
//
// This repo has a recorded incident where six consumers of a pattern were fixed
// and a seventh was missed because the list was eyeballed. So this does not
// name providers — it walks AUTO_BIND_PROVIDERS and fails on any member that
// neither implements the hook nor is on an explicit, reasoned opt-out list.
// Registering a sixth provider without seeding turns this red.
// ---------------------------------------------------------------------------
describe('registry coverage — every provider that can hold content seeds it', () => {
  /**
   * Providers deliberately WITHOUT `seedFromContent`, each with the reason.
   * Empty today: all five registered backings can hold bundle content.
   */
  const DOCUMENTED_OPT_OUTS: Record<string, string> = {};

  it('has no provider missing seedFromContent without a documented reason', () => {
    const missing = AUTO_BIND_PROVIDERS
      .filter((p) => typeof p.seedFromContent !== 'function')
      .map((p) => p.provider)
      .filter((name) => !(name in DOCUMENTED_OPT_OUTS));

    expect(missing).toEqual([]);
  });

  it('every opt-out carries a REAL reason, not an empty placeholder', () => {
    // An opt-out map is an escape hatch. `{'x': ''}` would silence the walk
    // above while documenting nothing — the entry has to justify itself.
    for (const [name, reason] of Object.entries(DOCUMENTED_OPT_OUTS)) {
      expect(reason.trim().length, `opt-out '${name}' has no stated reason`).toBeGreaterThan(20);
    }
  });

  it('every registered seedFromContent ACTUALLY seeds — not just exists', async () => {
    // `typeof … === 'function'` is satisfied by `async () => ({seeded:false})`.
    // A provider could be registered with a no-op stub and pass the walk above
    // while shipping the exact defect #3549 is about, so each hook is INVOKED
    // against content of its own kind and must report that it wrote something.
    //
    // Per-provider content of the right `kind`, since `authoredContent` refuses
    // a mismatched kind by design.
    const CONTENT_BY_PROVIDER: Record<string, { itemType: string; content: unknown }> = {
      'adf-pipeline': { itemType: 'data-pipeline', content: BUNDLE_CONTENT },
      'synapse-pipeline': { itemType: 'data-pipeline', content: { ...BUNDLE_CONTENT, kind: 'synapse-pipeline' } },
      eventstream: {
        itemType: 'eventstream',
        content: { kind: 'eventstream', sources: [{ name: 's' }], destinations: [{ name: 'd' }], transforms: [] },
      },
      'adx-database': {
        itemType: 'kql-database',
        content: { kind: 'kql-database', tables: [{ name: 'T', columns: [{ name: 'a', type: 'string' }] }] },
      },
      'lakehouse-adls': {
        itemType: 'lakehouse',
        content: { kind: 'lakehouse', folders: [{ path: 'Files/raw' }], deltaTables: [] },
      },
    };

    // Guard the guard: the map must cover the live registry, or a provider
    // added tomorrow would be skipped rather than checked.
    expect(Object.keys(CONTENT_BY_PROVIDER).sort())
      .toEqual(AUTO_BIND_PROVIDERS.map((p) => p.provider).sort());

    for (const p of AUTO_BIND_PROVIDERS) {
      const fixture = CONTENT_BY_PROVIDER[p.provider];
      const ctx: AutoBindContext = {
        itemId: 'i-1', itemType: fixture.itemType, displayName: 'Seed Probe',
        workspaceId: 'ws-1', state: { content: fixture.content },
      };
      // Every real backing client is absent here, so the call must FAIL — but
      // it must fail having TRIED, i.e. report an error rather than the
      // "nothing to seed" answer a no-op stub would give. `{seeded:false}` with
      // NO error is exactly what a stub returns, so that is the failure case.
      const r = await p.seedFromContent!('probe-name', { container: 'landing' }, ctx);
      expect(
        r.seeded === true || (r.seeded === false && !!r.error),
        `${p.provider}.seedFromContent returned "nothing to seed" for content of its own kind — a no-op stub would look identical`,
      ).toBe(true);
    }
  });

  it('covers the five registered backings', () => {
    // Guards the test above against silently passing on an EMPTY registry —
    // a guard with zero population proves nothing.
    expect(AUTO_BIND_PROVIDERS.map((p) => p.provider).sort()).toEqual([
      'adf-pipeline', 'adx-database', 'eventstream', 'lakehouse-adls', 'synapse-pipeline',
    ]);
  });

  it('maps every seeding provider onto the item types users actually create', () => {
    const seedingTypes = new Set(
      AUTO_BIND_PROVIDERS.filter((p) => p.seedFromContent).flatMap((p) => [...p.itemTypes]),
    );
    for (const t of ['data-pipeline', 'adf-pipeline', 'synapse-pipeline', 'eventstream', 'eventhouse', 'kql-database', 'lakehouse']) {
      expect(seedingTypes.has(t)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// THE SECOND HOOK NEEDS THE SAME MECHANICAL WALK (#3549 review, BLOCKER 2).
//
// `maybeRepairSeed` returns early unless the provider has BOTH `seedFromContent`
// AND `isEmpty`. The walk above only enumerates the first, so three of the five
// registered providers could — and do — silently get exactly one seed attempt
// ever, while the engine's own docstring described a self-heal. Undocumented
// partial coverage is the shape this repo has been bitten by before (six
// consumers fixed, a seventh missed), so `isEmpty` gets the identical treatment:
// implement it, or say WHY not, per provider, mechanically enforced.
// ---------------------------------------------------------------------------
describe('registry coverage — every provider either re-seeds or says why not', () => {
  /**
   * Providers deliberately WITHOUT `isEmpty`, each with the reason it is not a
   * defect TODAY and what would change that. These are not "we didn't get to
   * it" — each one turns on the same missing wire, tracked in #3694.
   */
  const ISEMPTY_OPT_OUTS: Record<string, string> = {
    eventstream:
      'No call site would reach it. `autoBindOnOpen` is wired into the two PIPELINE bind routes only, so the '
      + 'engine runs for an eventstream exactly once, at item-create; an `isEmpty` here would be a hook with zero '
      + 'callers, which this repo has recorded as its own class of defect (a guard with no population). The repair '
      + 'that DOES exist and IS wired is the editor\'s "Provision to Azure" button — `POST /api/items/eventstream/'
      + '[id]/provision` calls the same idempotent `standUpEventstreamAzure`, so a stream whose Stream Analytics '
      + 'transform could not be provisioned (DoD/IL5, where ASA does not exist) is completed from the editor once '
      + 'it can be. Wiring `autoBindOnOpen` into the three non-pipeline editors is the change that makes an '
      + '`isEmpty` here meaningful, and is tracked in #3694.',
    'adx-database':
      'Same missing wire as eventstream (#3694) — no `autoBindOnOpen` call site for `kql-database` / `eventhouse`, '
      + 'so the hook would never run. It would also not be free: emptiness for an ADX database is a `.show tables` '
      + 'data-plane round-trip against the cluster, paid on every open, to answer a question nothing currently '
      + 'asks. The install-time provisioner and the editor\'s own schema surface both re-apply the bundle DDL, '
      + 'which is the path that actually repairs a half-seeded database today.',
    'lakehouse-adls':
      'Same missing wire again (#3694). Additionally, "empty" for a lakehouse root is a directory LISTING rather '
      + 'than a point read (`create` makes exactly one directory, and a real lakehouse has folders under it), so '
      + 'the probe is materially more expensive than the pipeline twins\' single GET. The lakehouse editor '
      + 're-creates missing folders/tables from the item content on its own save path.',
  };

  it('has no provider missing isEmpty without a documented reason', () => {
    const missing = AUTO_BIND_PROVIDERS
      .filter((p) => typeof p.isEmpty !== 'function')
      .map((p) => p.provider)
      .filter((name) => !(name in ISEMPTY_OPT_OUTS));

    expect(missing).toEqual([]);
  });

  it('every isEmpty opt-out carries a REAL reason, not an empty placeholder', () => {
    for (const [name, reason] of Object.entries(ISEMPTY_OPT_OUTS)) {
      expect(reason.trim().length, `opt-out '${name}' has no stated reason`).toBeGreaterThan(20);
    }
  });

  it('every isEmpty opt-out names a provider that is actually REGISTERED', () => {
    // A stale entry is worse than no entry: it silently pre-authorizes a
    // provider that no longer exists, and would keep a REGRESSION green if a
    // future provider reused the name. So the map may not drift from the
    // registry in either direction.
    const registered = new Set(AUTO_BIND_PROVIDERS.map((p) => p.provider));
    for (const name of Object.keys(ISEMPTY_OPT_OUTS)) {
      expect(registered.has(name), `opt-out '${name}' is not a registered provider`).toBe(true);
    }
  });

  it('the PIPELINE providers do implement isEmpty — the walk has a live population', () => {
    // Guards the walk against passing on an all-opt-out registry. These two are
    // the providers `autoBindOnOpen` actually reaches, so they are the two that
    // must be able to repair an empty binding (#3549's live population).
    for (const provider of ['adf-pipeline', 'synapse-pipeline']) {
      const p = AUTO_BIND_PROVIDERS.find((x) => x.provider === provider);
      expect(typeof p?.isEmpty, `${provider} must implement isEmpty`).toBe('function');
      expect(provider in ISEMPTY_OPT_OUTS, `${provider} must NOT be opted out`).toBe(false);
    }
  });
});

describe('authoredContent — the shared "is there anything to seed?" decision', () => {
  it('returns the content when the kind matches the backing service', () => {
    const c = authoredContent(ctxFor('P1', gatedInstallState()), ['adf-pipeline', 'synapse-pipeline']);
    expect(c).toMatchObject({ kind: 'adf-pipeline' });
  });

  it('refuses content whose kind belongs to a DIFFERENT item type', () => {
    // A lakehouse bundle must never be written into a pipeline.
    const state = { content: { kind: 'lakehouse', deltaTables: [{ name: 'orders' }] } };
    expect(authoredContent(ctxFor('P1', state), ['adf-pipeline', 'synapse-pipeline'])).toBeNull();
  });

  it('returns null for an item with no content at all', () => {
    expect(authoredContent(ctxFor('P1', {}), ['adf-pipeline'])).toBeNull();
  });

  it('returns null for junk on state.content rather than throwing', () => {
    for (const junk of [null, 'a string', 42, [], { noKind: true }]) {
      expect(authoredContent(ctxFor('P1', { content: junk }), ['adf-pipeline'])).toBeNull();
    }
  });
});
