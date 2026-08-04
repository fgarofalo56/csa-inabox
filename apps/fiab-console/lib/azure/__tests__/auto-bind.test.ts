/**
 * AUTO-BIND ENGINE — invariant tests.
 *
 * These exercise the ENGINE (`ensureAutoBinding`) against a FAKE provider that
 * models a real Azure control plane as a `Set<string>` of object names. That is
 * deliberate and is the opposite of the "fixture that models the code" trap: the
 * fake models the SERVICE (objects exist or they don't; create adds one; probe
 * asks), never the engine's own logic. Every assertion below is therefore about
 * behaviour the engine must produce, not about a shape a helper happens to have.
 *
 * The invariants, in the order the rule demands them:
 *
 *   1. CREATES when the backing object is absent.
 *   2. ATTACHES when an object of the right name already exists (no duplicate).
 *   3. IDEMPOTENT — N calls, ONE backing object, and no create after the first.
 *   4. SELF-HEALS — an out-of-band delete is repaired on the next call.
 *   5. NAMES MATCH — the object carries the item's displayName, sanitized only
 *      where forced, with the mapping recorded so it is inspectable.
 *   6. A FAILURE IS A RETRYABLE PROGRESS STATE, never a dead end.
 *
 * MUTATION PROOF (break the subject, watch the test go red, restore). Run on
 * 2026-08-04 against `lib/azure/auto-bind.ts`; the failing test names below are
 * the ones actually observed, not a prediction:
 *
 *   a) Delete the whole `if (candidate) { … probe … }` block in step 4 (the
 *      idempotency + self-heal probe). 4 RED:
 *        "two calls produce ONE backing object and only ONE create"
 *        "the steady-state open reports changed:false …"
 *        "keeps the ORIGINAL object after a Loom rename, and flags the drift"
 *        "takes over a hand-bound item without creating a second object"
 *   b) Delete the `if (await provider.probe(target.name, …)) return finish(…)`
 *      guard in step 5, so create always runs. 3 RED:
 *        "does NOT create a duplicate when the name is already taken"
 *        "always probes before creating"
 *        "does not call create when probe reports the object present"
 *   c) Make `classifyThrow`'s default branch return `'unavailable'` instead of
 *      `'retry'`. 3 RED:
 *        "classifies a 5xx create failure as retry"
 *        "classifies a throttle as retry, not as a gate"
 *        "a retry outcome resolves itself on the next call once the plane recovers"
 *      — i.e. a transient blip would become the dead-end gate #2942 was made of.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ensureAutoBinding,
  readAutoBindRecord,
  autoBindWireStatus,
  resolveAutoBindProvider,
  AUTO_BIND_STATE_KEY,
  type AutoBindContext,
  type AutoBindProvider,
  type AutoBindOutcome,
} from '@/lib/azure/auto-bind';

// ---------------------------------------------------------------------------
// A fake Azure control plane. Objects exist or they don't — exactly the only
// two states a real `getPipeline` / `.show databases` can report.
// ---------------------------------------------------------------------------
class FakePlane {
  objects = new Set<string>();
  probeCalls: string[] = [];
  createCalls: string[] = [];
  /** When set, the NEXT probe throws this instead of answering. */
  probeThrows: unknown = null;
  /** When set, the NEXT create throws this instead of creating. */
  createThrows: unknown = null;

  reset() {
    this.objects.clear();
    this.probeCalls = [];
    this.createCalls = [];
    this.probeThrows = null;
    this.createThrows = null;
  }
}

const plane = new FakePlane();

/** Deliberately restrictive so sanitization is observable: letters/digits/`-`. */
function fakeSanitize(displayName: string): string {
  return displayName.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'fallback';
}

function makeProvider(over: Partial<AutoBindProvider> = {}): AutoBindProvider {
  return {
    provider: 'fake',
    itemTypes: ['fake-item'],
    backingNameFor: (ctx) => {
      const name = fakeSanitize(ctx.displayName);
      return { name, sanitized: name !== ctx.displayName };
    },
    preflight: async () => ({ ok: true, coords: { region: 'eastus2' } }),
    probe: async (name) => {
      plane.probeCalls.push(name);
      if (plane.probeThrows) { const e = plane.probeThrows; plane.probeThrows = null; throw e; }
      return plane.objects.has(name);
    },
    create: async (name) => {
      plane.createCalls.push(name);
      if (plane.createThrows) { const e = plane.createThrows; plane.createThrows = null; throw e; }
      plane.objects.add(name);
    },
    stateKeys: (name) => ({ fakeName: name }),
    existingBinding: (ctx) => (typeof ctx.state.fakeName === 'string' ? ctx.state.fakeName : null),
    ...over,
  };
}

function ctxFor(displayName: string, state: Record<string, unknown> = {}): AutoBindContext {
  return {
    itemId: 'item-1',
    itemType: 'fake-item',
    displayName,
    workspaceId: 'ws-1',
    state,
  };
}

/** Run one ensure and, when it bound, fold the patch back onto the state — the
 *  same thing the real adopters do. Returns the outcome AND the next state, so
 *  a test can model repeated opens of the same item. */
async function ensureAndApply(
  displayName: string,
  state: Record<string, unknown>,
  providers: readonly AutoBindProvider[],
): Promise<{ outcome: AutoBindOutcome; state: Record<string, unknown> }> {
  const outcome = await ensureAutoBinding(ctxFor(displayName, state), { providers });
  const next = outcome.status === 'bound' ? { ...state, ...outcome.statePatch } : state;
  return { outcome, state: next };
}

beforeEach(() => plane.reset());

describe('ensureAutoBinding — creates when the backing object is absent', () => {
  it('creates the object and reports via:created', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', {}, providers);

    expect(outcome.status).toBe('bound');
    if (outcome.status !== 'bound') return;
    expect(outcome.record.via).toBe('created');
    expect(outcome.record.backingName).toBe('orders');
    // The REAL assertion: the control plane actually gained the object.
    expect([...plane.objects]).toEqual(['orders']);
    expect(plane.createCalls).toEqual(['orders']);
  });

  it('writes the binding key the existing downstream resolvers read', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', {}, providers);
    if (outcome.status !== 'bound') throw new Error('expected bound');
    // `stateKeys` output must be present alongside the provenance record, so
    // nothing downstream has to learn about auto-bind to see the binding.
    expect(outcome.statePatch.fakeName).toBe('orders');
    expect(outcome.statePatch[AUTO_BIND_STATE_KEY]).toBeTruthy();
  });
});

describe('ensureAutoBinding — attaches to an object that already exists', () => {
  it('does NOT create a duplicate when the name is already taken', async () => {
    plane.objects.add('orders'); // e.g. the installer's provisioner made it
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', {}, providers);

    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.record.via).toBe('attached');
    expect(plane.createCalls).toEqual([]);          // nothing was created
    expect(plane.objects.size).toBe(1);             // still exactly one object
  });
});

describe('ensureAutoBinding — IDEMPOTENT (the editor calls it on every open)', () => {
  it('two calls produce ONE backing object and only ONE create', async () => {
    const providers = [makeProvider()];

    const first = await ensureAndApply('orders', {}, providers);
    const second = await ensureAndApply('orders', first.state, providers);

    expect(plane.objects.size).toBe(1);
    expect(plane.createCalls).toEqual(['orders']);  // create ran exactly once
    if (first.outcome.status !== 'bound' || second.outcome.status !== 'bound') {
      throw new Error('expected both to bind');
    }
    expect(first.outcome.record.via).toBe('created');
    expect(second.outcome.record.via).toBe('existing');
    expect(second.outcome.record.backingName).toBe(first.outcome.record.backingName);
  });

  it('ten calls still produce ONE backing object', async () => {
    const providers = [makeProvider()];
    let state: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      ({ state } = await ensureAndApply('orders', state, providers));
    }
    expect(plane.objects.size).toBe(1);
    expect(plane.createCalls).toEqual(['orders']);
  });

  it('the steady-state open reports changed:false so it writes nothing to Cosmos', async () => {
    const providers = [makeProvider()];
    const first = await ensureAndApply('orders', {}, providers);
    const second = await ensureAndApply('orders', first.state, providers);

    if (first.outcome.status !== 'bound' || second.outcome.status !== 'bound') {
      throw new Error('expected both to bind');
    }
    expect(first.outcome.changed).toBe(true);   // the first open persists
    expect(second.outcome.changed).toBe(false); // every later open does not
  });

  it('re-writes when the provenance record survived but the BINDING KEY was lost', async () => {
    // The #2942 dead end's side door. `state.pipelineName` (here: `fakeName`)
    // is what the bind GET answers `bound` from and what every downstream
    // resolver reads. If the record alone were enough to report changed:false,
    // an item that lost that key would come back "bound" from the engine while
    // the route still answered `bound: null` — and the editor would render the
    // manual picker in place of its canvas.
    plane.objects.add('orders');
    const providers = [makeProvider()];
    const first = await ensureAndApply('orders', {}, providers);
    if (first.outcome.status !== 'bound') throw new Error('expected bound');

    const lost = { ...first.state };
    delete lost.fakeName;

    const { outcome } = await ensureAndApply('orders', lost, providers);
    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.changed).toBe(true);
    expect(outcome.statePatch.fakeName).toBe('orders');
    expect(plane.createCalls).toEqual([]); // and it did NOT make a second object
  });
});

describe('ensureAutoBinding — SELF-HEALS a backing object deleted out of band', () => {
  it('re-creates the object and reports via:recreated, without user action', async () => {
    const providers = [makeProvider()];
    const first = await ensureAndApply('orders', {}, providers);
    if (first.outcome.status !== 'bound') throw new Error('expected bound');

    // Someone deletes the pipeline in the Azure portal.
    plane.objects.delete('orders');

    const healed = await ensureAndApply('orders', first.state, providers);

    expect(healed.outcome.status).toBe('bound');   // NOT an error, NOT a gate
    if (healed.outcome.status !== 'bound') return;
    expect(healed.outcome.record.via).toBe('recreated');
    expect([...plane.objects]).toEqual(['orders']); // it is back
    expect(plane.createCalls).toEqual(['orders', 'orders']);
  });

  it('heals a binding whose recorded name no longer exists, using the CURRENT name', async () => {
    const providers = [makeProvider()];
    // An item bound to a now-deleted object, and since renamed in Loom.
    const stale = {
      fakeName: 'old-name',
      [AUTO_BIND_STATE_KEY]: {
        provider: 'fake', backingName: 'old-name', sourceName: 'old name',
        sanitized: true, via: 'created', boundAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const { outcome } = await ensureAndApply('new name', stale, providers);

    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.record.via).toBe('recreated');
    expect(outcome.record.backingName).toBe('new-name'); // the CURRENT name
    expect([...plane.objects]).toEqual(['new-name']);
  });
});

describe('ensureAutoBinding — NAMES MATCH the Loom displayName', () => {
  it('uses the displayName verbatim when the service permits it', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders2026', {}, providers);
    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.record.backingName).toBe('orders2026');
    expect(outcome.record.sanitized).toBe(false);
  });

  it('records the mapping when the service forces a change — inspectable, not guessed', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('Daily Orders → Bronze', {}, providers);
    if (outcome.status !== 'bound') throw new Error('expected bound');

    expect(outcome.record.backingName).toBe('Daily-Orders-Bronze');
    expect(outcome.record.sourceName).toBe('Daily Orders → Bronze');
    expect(outcome.record.sanitized).toBe(true);
    // And the record survives a round-trip through the state bag.
    const rec = readAutoBindRecord(outcome.statePatch);
    expect(rec?.backingName).toBe('Daily-Orders-Bronze');
    expect(rec?.sourceName).toBe('Daily Orders → Bronze');
  });

  it('is deterministic — the same displayName always yields the same name', async () => {
    const providers = [makeProvider()];
    const a = await ensureAndApply('Daily Orders → Bronze', {}, providers);
    plane.reset();
    const b = await ensureAndApply('Daily Orders → Bronze', {}, providers);
    if (a.outcome.status !== 'bound' || b.outcome.status !== 'bound') throw new Error('expected bound');
    expect(b.outcome.record.backingName).toBe(a.outcome.record.backingName);
  });

  it('keeps the ORIGINAL object after a Loom rename, and flags the drift', async () => {
    const providers = [makeProvider()];
    const first = await ensureAndApply('orders', {}, providers);
    if (first.outcome.status !== 'bound') throw new Error('expected bound');

    // The user renames the Loom item. The backing object still exists.
    const renamed = await ensureAndApply('orders-v2', first.state, providers);
    if (renamed.outcome.status !== 'bound') throw new Error('expected bound');

    // The authored pipeline is NOT orphaned...
    expect(renamed.outcome.record.backingName).toBe('orders');
    expect(plane.createCalls).toEqual(['orders']); // no second object
    // ...and the divergence is recorded rather than hidden.
    expect(renamed.outcome.record.nameDrift).toBe(true);
    expect(renamed.outcome.record.sourceName).toBe('orders-v2');
  });
});

describe('ensureAutoBinding — adopts a pre-existing binding instead of duplicating', () => {
  it('takes over a hand-bound item without creating a second object', async () => {
    plane.objects.add('hand-bound-pipeline');
    const providers = [makeProvider()];
    // No `autoBind` record — only the legacy key a manual Bind would have set.
    const { outcome } = await ensureAndApply('orders', { fakeName: 'hand-bound-pipeline' }, providers);

    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.record.backingName).toBe('hand-bound-pipeline');
    expect(outcome.record.via).toBe('existing');
    expect(plane.createCalls).toEqual([]);
  });
});

describe('ensureAutoBinding — a failure is a RETRYABLE progress state, not a dead end', () => {
  it('classifies a 5xx create failure as retry', async () => {
    plane.createThrows = Object.assign(new Error('upstream 503'), { status: 503 });
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', {}, providers);

    expect(outcome.status).toBe('retry');
    if (outcome.status !== 'retry') return;
    expect(outcome.reason).toContain('503');
    // And the UI is told it is retryable — the property that keeps the editor
    // showing progress instead of a disabled Bind button (#2942).
    expect(autoBindWireStatus(outcome).retryable).toBe(true);
  });

  it('classifies a throttle as retry, not as a gate', async () => {
    plane.probeThrows = Object.assign(new Error('429 too many requests'), { status: 429 });
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', { fakeName: 'orders' }, providers);
    expect(outcome.status).toBe('retry');
  });

  it('a retry outcome resolves itself on the next call once the plane recovers', async () => {
    plane.createThrows = Object.assign(new Error('upstream 503'), { status: 503 });
    const providers = [makeProvider()];
    const failed = await ensureAndApply('orders', {}, providers);
    expect(failed.outcome.status).toBe('retry');

    // Plane recovers; the very next call succeeds with no user action.
    const recovered = await ensureAndApply('orders', failed.state, providers);
    expect(recovered.outcome.status).toBe('bound');
    expect([...plane.objects]).toEqual(['orders']);
  });

  it('classifies a 403 as UNAVAILABLE (a Fix-it), because retrying cannot fix it', async () => {
    plane.createThrows = Object.assign(new Error('Forbidden'), { status: 403 });
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', {}, providers);

    expect(outcome.status).toBe('unavailable');
    expect(autoBindWireStatus(outcome).retryable).toBe(false);
  });

  it('surfaces a preflight gate with the missing estate resource named', async () => {
    const providers = [makeProvider({
      preflight: async () => ({
        ok: false, kind: 'unavailable', reason: 'no factory anywhere', missing: 'Microsoft.DataFactory/factories',
      }),
    })];
    const { outcome } = await ensureAndApply('orders', {}, providers);

    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.missing).toBe('Microsoft.DataFactory/factories');
    // A gate must never have created anything.
    expect(plane.createCalls).toEqual([]);
  });

  it('never creates against unknown coordinates when preflight says retry', async () => {
    const providers = [makeProvider({
      preflight: async () => ({ ok: false, kind: 'retry', reason: 'ARM timeout' }),
    })];
    const { outcome } = await ensureAndApply('orders', {}, providers);
    expect(outcome.status).toBe('retry');
    expect(plane.probeCalls).toEqual([]);
    expect(plane.createCalls).toEqual([]);
  });

  it('a provider that throws from preflight does not escape as an exception', async () => {
    const providers = [makeProvider({
      preflight: async () => { throw new Error('boom'); },
    })];
    await expect(ensureAndApply('orders', {}, providers)).resolves.toBeTruthy();
  });
});

describe('ensureAutoBinding — item types with no backing service', () => {
  it('reports unsupported rather than inventing a gate', async () => {
    const providers = [makeProvider()];
    const outcome = await ensureAutoBinding(
      { ...ctxFor('a report'), itemType: 'report' },
      { providers },
    );
    expect(outcome.status).toBe('unsupported');
    expect(plane.createCalls).toEqual([]);
  });
});

describe('resolveAutoBindProvider — backend selection', () => {
  const adfish = makeProvider({ provider: 'adf', itemTypes: ['data-pipeline'], claims: (c) => c.slugHint === 'adf-pipeline' });
  const synapseish = makeProvider({ provider: 'synapse', itemTypes: ['data-pipeline'], claims: (c) => c.slugHint !== 'adf-pipeline' });

  it('routes a data-pipeline opened through the ADF slug to the ADF provider', () => {
    const p = resolveAutoBindProvider(
      { ...ctxFor('x'), itemType: 'data-pipeline', slugHint: 'adf-pipeline' },
      [adfish, synapseish],
    );
    expect(p?.provider).toBe('adf');
  });

  it('routes the same item through the Synapse slug to the Synapse provider', () => {
    const p = resolveAutoBindProvider(
      { ...ctxFor('x'), itemType: 'data-pipeline', slugHint: 'synapse-pipeline' },
      [adfish, synapseish],
    );
    expect(p?.provider).toBe('synapse');
  });

  it('returns null for a type no provider claims', () => {
    expect(resolveAutoBindProvider({ ...ctxFor('x'), itemType: 'report' }, [adfish])).toBeNull();
  });
});

describe('readAutoBindRecord — rejects a malformed record rather than trusting it', () => {
  it.each([
    ['undefined state', undefined],
    ['no record', {}],
    ['record is not an object', { [AUTO_BIND_STATE_KEY]: 'nope' }],
    ['no provider', { [AUTO_BIND_STATE_KEY]: { backingName: 'x' } }],
    ['empty backingName', { [AUTO_BIND_STATE_KEY]: { provider: 'fake', backingName: '' } }],
  ])('%s → null', (_label, state) => {
    expect(readAutoBindRecord(state as Record<string, unknown> | undefined)).toBeNull();
  });

  it('a malformed record does not block re-binding — the item just re-derives', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('orders', { [AUTO_BIND_STATE_KEY]: 'garbage' }, providers);
    expect(outcome.status).toBe('bound');
    expect([...plane.objects]).toEqual(['orders']);
  });
});

describe('autoBindWireStatus — the shape the editor renders from', () => {
  it('carries the name mapping on a bound outcome', async () => {
    const providers = [makeProvider()];
    const { outcome } = await ensureAndApply('Daily Orders', {}, providers);
    const wire = autoBindWireStatus(outcome);
    expect(wire.status).toBe('bound');
    expect(wire.backingName).toBe('Daily-Orders');
    expect(wire.sourceName).toBe('Daily Orders');
    expect(wire.sanitized).toBe(true);
  });

  it('uses a deterministic clock seam when one is supplied', async () => {
    const providers = [makeProvider()];
    const fixed = new Date('2026-08-04T12:00:00.000Z');
    const outcome = await ensureAutoBinding(ctxFor('orders'), { providers, now: () => fixed });
    if (outcome.status !== 'bound') throw new Error('expected bound');
    expect(outcome.record.boundAt).toBe('2026-08-04T12:00:00.000Z');
  });
});

describe('the engine never mounts a create on an unprobed name', () => {
  it('always probes before creating', async () => {
    const providers = [makeProvider()];
    await ensureAndApply('orders', {}, providers);
    expect(plane.probeCalls.length).toBeGreaterThan(0);
    // The probed name and the created name are the same object identity.
    expect(plane.probeCalls).toContain(plane.createCalls[0]);
  });

  it('does not call create when probe reports the object present', async () => {
    plane.objects.add('orders');
    const createSpy = vi.fn();
    const providers = [makeProvider({
      create: async (n) => { createSpy(n); plane.objects.add(n); },
    })];
    await ensureAndApply('orders', {}, providers);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
