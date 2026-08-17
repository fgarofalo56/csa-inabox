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

  reset() {
    this.objects.clear();
    this.createCalls = [];
    this.seedCalls = [];
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
