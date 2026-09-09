/**
 * Unit tests for /api/items/azure-sql-database/[id]/query/cancel BFF route, and
 * for the cross-replica cancel-intent mechanism in azure-sql-client that backs
 * it (#3400).
 *
 * ROUTE
 *   1. unauthenticated → 401
 *   2. missing requestId → 400
 *   3. unknown requestId, no intent store → idempotent { ok:true, cancelled:false }
 *   4. unknown requestId, intent store up → { ok:true, cancelled:'requested' }
 *   5. live request → calls request.cancel() (TDS ATTENTION) and removes it
 *   6. cancel() throwing → 502
 *
 * MECHANISM (added after review; see the M3/M4 note further down)
 *   7. the watcher's LIFECYCLE — registering a request is what starts the poll
 *   8. recordCancelIntent's PERSISTENCE — the claim the route's answer rests on
 *   9. the REAL Cosmos-backed store — container, document shape, point-read
 *
 * The /query route's ECANCEL receipt (M5) lives in the sibling suite
 * app/api/items/azure-sql-database/[id]/query/__tests__/query-cancel-receipt.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// vi.mock factories are hoisted above module-scope consts, so the shared map
// must itself be hoisted (vi.hoisted) to be referenceable inside the factory.
const { liveRequests, recordCancelIntent, cancelIntentUnavailableReason } = vi.hoisted(() => ({
  liveRequests: new Map<string, { cancel: () => void }>(),
  recordCancelIntent: vi.fn(async (_requestId: string) => false),
  cancelIntentUnavailableReason: vi.fn(() => 'no Cosmos endpoint is configured (LOOM_COSMOS_ENDPOINT)'),
}));

vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/azure/azure-sql-client', () => ({
  liveRequests,
  recordCancelIntent,
  cancelIntentUnavailableReason,
}));

/**
 * A fake Cosmos SDK, so the REAL `cancelIntentStore()` init path — the client,
 * `databases.createIfNotExists`, `containers.createIfNotExists`, the upsert
 * document shape and the `(id, id)` point-read — is exercised rather than
 * skipped by an injected store. The describe block that uses it is the only
 * consumer; nothing else in this file imports @azure/cosmos.
 */
const cosmos = vi.hoisted(() => ({
  failInit: false,
  /** How many times the CosmosClient constructor ran — the "am I hammering it?" counter. */
  constructs: 0,
  clientOpts: null as any,
  databases: [] as any[],
  containers: [] as any[],
  upserts: [] as any[],
  reads: [] as Array<[string, string]>,
  deletes: [] as Array<[string, string]>,
  docs: new Map<string, any>(),
  reset() {
    this.failInit = false;
    this.constructs = 0;
    this.clientOpts = null;
    this.databases.length = 0;
    this.containers.length = 0;
    this.upserts.length = 0;
    this.reads.length = 0;
    this.deletes.length = 0;
    this.docs.clear();
  },
}));

vi.mock('@azure/cosmos', () => {
  const container = {
    items: {
      upsert: async (doc: any) => { cosmos.upserts.push(doc); cosmos.docs.set(doc.id, doc); },
    },
    item: (id: string, partitionKey: string) => ({
      read: async () => { cosmos.reads.push([id, partitionKey]); return { resource: cosmos.docs.get(id) }; },
      delete: async () => { cosmos.deletes.push([id, partitionKey]); cosmos.docs.delete(id); },
    }),
  };
  return {
    CosmosClient: class {
      databases = {
        createIfNotExists: async (spec: any) => {
          cosmos.databases.push(spec);
          return { database: { containers: { createIfNotExists: async (cspec: any) => { cosmos.containers.push(cspec); return { container }; } } } };
        },
      };
      constructor(opts: any) {
        cosmos.constructs += 1;
        if (cosmos.failInit) throw new Error('Cosmos endpoint unreachable');
        cosmos.clientOpts = opts;
      }
    },
  };
});

type SqlClient = typeof import('@/lib/azure/azure-sql-client');
/** The real module — the describe blocks above mock the whole thing. */
function realClient(): Promise<SqlClient> {
  return vi.importActual<SqlClient>('@/lib/azure/azure-sql-client');
}

/** An in-memory CancelIntentStore that records what was asked of it. */
function memStore(seed: string[] = []) {
  const intents = new Set(seed);
  const recorded: string[] = [];
  const cleared: string[] = [];
  return {
    intents, recorded, cleared,
    store: {
      record: async (id: string) => { recorded.push(id); intents.add(id); },
      has: async (id: string) => intents.has(id),
      clear: async (id: string) => { cleared.push(id); intents.delete(id); },
    },
  };
}

import { POST } from '../route';
import { getSession } from '@/lib/auth/session';

function postReq(body: any) { return { json: async () => body } as any; }

beforeEach(() => {
  vi.resetAllMocks();
  liveRequests.clear();
  // Default: no intent store reachable (local dev / no Cosmos endpoint).
  recordCancelIntent.mockResolvedValue(false);
  cancelIntentUnavailableReason.mockReturnValue('no Cosmos endpoint is configured (LOOM_COSMOS_ENDPOINT)');
});

describe('POST /api/items/azure-sql-database/[id]/query/cancel', () => {
  it('returns 401 when no session', async () => {
    (getSession as any).mockReturnValue(null);
    const res = await POST(postReq({ requestId: 'r1' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 when requestId missing', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });

  it('is idempotent for an unknown requestId when no intent store is reachable', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const res = await POST(postReq({ requestId: 'gone' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.cancelled).toBe(false);
  });

  it('cancels a live request (sends TDS ATTENTION) and removes it', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    const cancel = vi.fn();
    liveRequests.set('r1', { cancel });
    const res = await POST(postReq({ requestId: 'r1' }));
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.cancelled).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(liveRequests.has('r1')).toBe(false);
    // A locally-owned request is cancelled directly — no intent is published.
    expect(recordCancelIntent).not.toHaveBeenCalled();
  });

  it('returns 502 when cancel() throws', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    liveRequests.set('r1', { cancel: () => { throw new Error('boom'); } });
    const res = await POST(postReq({ requestId: 'r1' }));
    const j = await res.json();
    expect(res.status).toBe(502);
    expect(j.ok).toBe(false);
    expect(j.error).toContain('boom');
  });
});

/**
 * #3400 / #3399 — the guidance this route and `azure-sql-client` carried was
 * FALSE, and following it would have broken the estate.
 *
 * Both files told the reader that a scaled-out console should "enable ingress
 * sticky sessions (`ingress.stickySessions.affinity: 'sticky'`) or run a single
 * replica". Measured against the templates that actually deploy this console:
 *
 *   - admin-plane/main.bicep declares loom-console `multiRevision: true` with
 *     `minReplicas: 2`. Neither escape hatch describes the estate.
 *   - ACA REQUIRES `affinity:'none'` in multiple-revision mode, and
 *     app-deployments.bicep now ASSERTS that value on every deploy, with a
 *     comment naming this exact caller: "The one caller that wants affinity is
 *     SQL query-cancel — see #3400; its fix is a cross-replica cancel signal,
 *     not affinity." A sticky value set out-of-band failed 4 of 4
 *     console-bluegreen-roll runs.
 *
 * So the product's own source instructed the operator to perform plumbing the
 * platform forbids and self-heals away — an R7 assertion the code never
 * established, and a user-performed step under auto-bind-by-default.
 *
 * The cross-replica intent store now EXISTS (azure-sql-client:
 * `recordCancelIntent` + the poll watcher), so the wrong-replica case is no
 * longer a no-op. What these assertions pin is that the route still never
 * over-claims: `cancelled:'requested'` when the signal was persisted,
 * `cancelled:false` when it could not be, and `cancelled:true` only when this
 * replica cancelled the request itself.
 */
describe('cancel route honesty (#3400)', () => {
  const SRC_ROUTE = readFileSync(join(__dirname, '..', 'route.ts'), 'utf8');
  const SRC_CLIENT = readFileSync(
    join(process.cwd(), 'lib', 'azure', 'azure-sql-client.ts'),
    'utf8',
  );
  const SRC_INTENTS = readFileSync(
    join(process.cwd(), 'lib', 'azure', 'azure-sql-cancel-intents.ts'),
    'utf8',
  );

  /**
   * The population, declared ONCE.
   *
   * It was two files until the cancel machinery was split out of
   * azure-sql-client.ts (that module crossed the 1500-LOC monolith-creep line).
   * The split moved the anti-affinity record with the code and this guard went
   * red — correctly: a source-content guard whose subject moves out from under
   * it is asserting nothing. Enumerating the files in each `it` separately is
   * how that becomes a silent hole next time, so the list lives here and every
   * assertion iterates it. azure-sql-client.ts keeps a summary of the record
   * because it is still where a reader looking for `liveRequests` lands.
   */
  const SOURCES = [
    ['cancel/route.ts', SRC_ROUTE],
    ['azure-sql-client.ts', SRC_CLIENT],
    ['azure-sql-cancel-intents.ts', SRC_INTENTS],
  ] as const;

  it('no file instructs the operator to enable sticky sessions', () => {
    for (const [name, src] of SOURCES) {
      expect(src, `${name} still prescribes affinity:'sticky'`).not.toMatch(/enable ingress sticky sessions/i);
      expect(src, `${name} still offers affinity:'sticky' as the remedy`)
        .not.toMatch(/stickySessions\.affinity:\s*'sticky'\)?\s*(?:or run a single replica|\*\/)/i);
    }
  });

  it('every file records that affinity is FORBIDDEN and names the real mechanism', () => {
    for (const [name, src] of SOURCES) {
      expect(src, `${name} does not say affinity is not the answer`).toMatch(/NOT SESSION AFFINITY|NOT "FIX" THIS WITH SESSION AFFINITY/i);
      expect(src, `${name} does not name the cross-replica signal`).toMatch(/cross-replica cancel signal/i);
      expect(src, `${name} does not record the multiRevision constraint`).toMatch(/multiRevision/);
    }
  });

  it('no file still claims the intent store is unimplemented', () => {
    for (const [name, src] of SOURCES) {
      expect(src, `${name} still says the store is not implemented`)
        .not.toMatch(/store is (?:NOT|not) implemented yet/);
    }
  });

  it('an unknown requestId with NO reachable store reports the no-op honestly', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(false);
    const res = await POST(postReq({ requestId: 'elsewhere' }));
    const j = await res.json();
    expect(j.cancelled).toBe(false);
    expect(j.crossReplica).toBe(false);
    // It must say which of the two causes it CANNOT distinguish, rather than
    // asserting one of them as fact.
    expect(j.reason).toMatch(/cannot distinguish/i);
    expect(j.reason).toMatch(/replica that received this call/i);
    // And it must not tell the operator to go set an affinity the platform
    // forbids (auto-bind-by-default: no user-performed plumbing).
    expect(j.reason).not.toMatch(/sticky/i);
  });

  /**
   * R7, review finding 4. The reason used to assert "(no Cosmos endpoint
   * configured, or the write failed)" as the cause. TWO other branches reach
   * here: the documented `LOOM_SQL_CANCEL_INTENTS_DISABLED=1` opt-out, where the
   * store was deliberately switched off rather than unreachable, and an init
   * that failed earlier and is still backing off, where nothing was attempted on
   * this call at all. The route must report the branch the client actually took,
   * not a guess.
   *   MUTATION: inline a fixed sentence instead of calling
   *   `cancelIntentUnavailableReason()` → this spec goes red.
   */
  it('reports the REASON the client actually recorded, not a guessed cause', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(false);
    cancelIntentUnavailableReason.mockReturnValue(
      'the cross-replica cancel-intent store is switched off in this deployment '
      + '(LOOM_SQL_CANCEL_INTENTS_DISABLED=1), so the signal was not carried to any other replica',
    );

    const res = await POST(postReq({ requestId: 'elsewhere' }));
    const j = await res.json();

    expect(cancelIntentUnavailableReason).toHaveBeenCalled();
    expect(j.cancelled).toBe(false);
    expect(j.reason).toContain('LOOM_SQL_CANCEL_INTENTS_DISABLED=1');
    // The old wording named a cause that does not hold on this branch.
    expect(j.reason).not.toMatch(/no Cosmos endpoint configured, or the write failed/);
  });

  /** The reason function is consulted only when there was nothing to report. */
  it('does not ask for an unavailability reason when the intent WAS published', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(true);
    await POST(postReq({ requestId: 'on-another-replica' }));
    expect(cancelIntentUnavailableReason).not.toHaveBeenCalled();
  });

  /**
   * RED before the fix: the route had no intent store at all, so a requestId
   * owned by another replica returned `cancelled:false` and the signal died
   * there. GREEN now: the intent is persisted and the response says exactly
   * that — 'requested', not 'cancelled'.
   */
  it('publishes a cross-replica intent when the id is not local, and reports it as REQUESTED', async () => {
    (getSession as any).mockReturnValue({ claims: { oid: 'u' } });
    recordCancelIntent.mockResolvedValue(true);
    const res = await POST(postReq({ requestId: 'on-another-replica' }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(recordCancelIntent).toHaveBeenCalledWith('on-another-replica');
    expect(j.ok).toBe(true);
    expect(j.crossReplica).toBe(true);
    // NOT `true` — persisting a signal is not observing a cancellation (R7).
    expect(j.cancelled).toBe('requested');
    expect(j.cancelled).not.toBe(true);
    // It must point at the thing that DOES establish the cancellation.
    expect(j.reason).toMatch(/ECANCEL/);
    expect(j.reason).toMatch(/does not claim/i);
  });
});

/**
 * The client half of the cross-replica signal (#3400): the replica that OWNS
 * the request must notice an intent published by a different replica and send
 * the TDS ATTENTION packet itself.
 *
 * RED before the fix: `azure-sql-client` had no watcher and no intent store, so
 * `_pollCancelIntentsOnce` did not exist and nothing ever consumed an intent.
 *
 * Uses `importActual` because the describe block above mocks the whole module.
 * The intent store is injected, so this exercises the real poll logic with no
 * Cosmos and no network.
 */
describe('azure-sql-client cancel-intent watcher (#3400)', () => {
  it('cancels a locally-owned request when an intent exists for its id', async () => {
    const client = await realClient();
    const m = memStore(['mine']);
    client._setCancelIntentStore(m.store);

    const cancel = vi.fn();
    const untouched = vi.fn();
    client.liveRequests.set('mine', { cancel } as any);
    client.liveRequests.set('no-intent', { cancel: untouched } as any);

    await client._pollCancelIntentsOnce();

    expect(cancel).toHaveBeenCalledOnce();
    expect(untouched).not.toHaveBeenCalled();
    // The cancelled request is deregistered; the other is left alone.
    expect(client.liveRequests.has('mine')).toBe(false);
    expect(client.liveRequests.has('no-intent')).toBe(true);
    // The spent intent is cleaned up so it can never cancel a later request.
    expect(m.cleared).toContain('mine');

    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });

  it('does nothing when no intent store is configured', async () => {
    const client = await realClient();
    client._setCancelIntentStore(null);
    const cancel = vi.fn();
    client.liveRequests.set('mine', { cancel } as any);
    // No LOOM_COSMOS_ENDPOINT in the test env → the store is off, and the poll
    // must be a silent no-op rather than an error or a spurious cancel.
    await client._pollCancelIntentsOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(client.liveRequests.has('mine')).toBe(true);
    client.liveRequests.clear();
  });

  /**
   * R7, review finding 3. A FAILED store read is UNKNOWN, never "an intent
   * exists". The branch had no guard, so inverting `catch { continue; }` to
   * `catch { wanted = true; }` — the store read failed, therefore cancel — left
   * the suite fully green while silently killing users' running queries on the
   * next transient Cosmos error. That inversion is exactly the R7 shape this
   * repo keeps getting bitten by.
   *   MUTATION: `catch { wanted = true; }` in `_pollCancelIntentsOnce` → red here.
   */
  it('a store read that THROWS is unknown, not a cancel — the request stays registered', async () => {
    const client = await realClient();
    const cancel = vi.fn();
    let reads = 0;
    client._setCancelIntentStore({
      record: async () => {},
      has: async () => { reads += 1; throw new Error('Cosmos 429 TooManyRequests'); },
      clear: async () => { throw new Error('clear must not be called for an unknown intent'); },
    });
    client.liveRequests.set('mine', { cancel } as any);

    await expect(client._pollCancelIntentsOnce()).resolves.toBeUndefined();

    expect(reads).toBe(1);
    expect(cancel).not.toHaveBeenCalled();
    // Still ours: the next tick must get another chance to read the intent.
    expect(client.liveRequests.has('mine')).toBe(true);

    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });

  /** One id failing its read must not stop the loop reaching the others. */
  it('a throwing read for one id does not prevent a real intent cancelling another', async () => {
    const client = await realClient();
    const bad = vi.fn();
    const good = vi.fn();
    client._setCancelIntentStore({
      record: async () => {},
      has: async (id: string) => {
        if (id === 'bad') throw new Error('read failed');
        return id === 'good';
      },
      clear: async () => {},
    });
    client.liveRequests.set('bad', { cancel: bad } as any);
    client.liveRequests.set('good', { cancel: good } as any);

    await client._pollCancelIntentsOnce();

    expect(bad).not.toHaveBeenCalled();
    expect(good).toHaveBeenCalledOnce();
    expect(client.liveRequests.has('bad')).toBe(true);
    expect(client.liveRequests.has('good')).toBe(false);

    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });
});

/**
 * ═══ WHAT THE FIRST ROUND OF THIS PR DID NOT GUARD (review, #3400) ═══
 *
 * Review authored three mutations that each restore the original defect and
 * each left the suite fully green. They are the spec for everything below:
 *
 *   M3  azure-sql-client.ts `registerLiveRequest` — drop the
 *       `startCancelWatcher()` call. The watcher then never starts on ANY
 *       replica, `_pollCancelIntentsOnce` is never invoked in production, and
 *       cross-replica cancel is the exact permanent no-op #3400 describes.
 *       Only `_pollCancelIntentsOnce` was tested — never the thing that CALLS
 *       it. Killed by 'watcher lifecycle' below.
 *
 *   M4  `recordCancelIntent` — replace the body's first statement with
 *       `return true;`. The route then reports `cancelled:'requested'` while
 *       nothing was stored, which is precisely the R7 lie its own comment
 *       forbids. The route specs vi.mock the module, so the real function and
 *       the whole Cosmos store path had ZERO coverage. Killed by
 *       'recordCancelIntent persistence' and 'the Cosmos-backed store' below.
 *
 *   M5  ../../route.ts (the /query route) — delete the `e?.code === 'ECANCEL'`
 *       block, i.e. the only thing that establishes a query stopped. Killed in
 *       app/api/items/azure-sql-database/[id]/query/__tests__/
 *       query-cancel-receipt.test.ts, which did not exist and now does.
 */

describe('watcher lifecycle — registering a request is what STARTS the poll (#3400, M3)', () => {
  let client: SqlClient;
  let savedEndpoint: string | undefined;

  beforeEach(async () => {
    client = await realClient();
    savedEndpoint = process.env.LOOM_COSMOS_ENDPOINT;
    delete process.env.LOOM_COSMOS_ENDPOINT;
    client.liveRequests.clear();
    client._setCancelIntentStore(null); // also stops any interval left running
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
    if (savedEndpoint === undefined) delete process.env.LOOM_COSMOS_ENDPOINT;
    else process.env.LOOM_COSMOS_ENDPOINT = savedEndpoint;
  });

  /**
   * THE M3 KILLER, and the closest thing this suite has to the real scenario:
   * NOTHING in this spec calls `_pollCancelIntentsOnce`. The request is
   * registered exactly as `executeQuery` registers it, another replica publishes
   * an intent, time passes — and the TDS ATTENTION must happen on its own.
   *   MUTATION: remove `startCancelWatcher()` from `registerLiveRequest`.
   */
  it('a request registered by executeQuery is cancelled by the watcher alone', async () => {
    const m = memStore();
    client._setCancelIntentStore(m.store);
    const cancel = vi.fn();

    client.registerLiveRequest('mine', { cancel } as any);
    // ...meanwhile, the cancel POST lands on a DIFFERENT replica, which writes:
    m.intents.add('mine');

    expect(cancel).not.toHaveBeenCalled(); // nothing has polled yet
    await vi.advanceTimersByTimeAsync(1_100); // one default poll interval

    expect(cancel).toHaveBeenCalledOnce();
    expect(client.liveRequests.has('mine')).toBe(false);
    expect(m.cleared).toContain('mine');
  });

  /**
   * The watcher must exist only while this replica has work. An always-on
   * interval would point-read Cosmos forever on every idle replica.
   *   MUTATION: remove `stopCancelWatcherIfIdle()` from
   *   `unregisterLiveRequest` → the timer survives the last request.
   */
  it('stops the watcher once the replica goes idle', async () => {
    client._setCancelIntentStore(memStore().store);
    client.registerLiveRequest('mine', { cancel: vi.fn() } as any);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    client.unregisterLiveRequest('mine');
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * ...and it must never start where there is no store to poll (local dev, or
   * the documented `LOOM_SQL_CANCEL_INTENTS_DISABLED=1` opt-out).
   *   MUTATION: drop the `!cancelIntentStoreConfigured()` guard from
   *   `startCancelWatcher`.
   */
  it('never starts a watcher when no intent store is configured', async () => {
    client._setCancelIntentStore(null);
    client.registerLiveRequest('mine', { cancel: vi.fn() } as any);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** A single watcher, not one per concurrent query. */
  it('registering a second request does not start a second watcher', async () => {
    client._setCancelIntentStore(memStore().store);
    client.registerLiveRequest('a', { cancel: vi.fn() } as any);
    const after1 = vi.getTimerCount();
    client.registerLiveRequest('b', { cancel: vi.fn() } as any);
    expect(vi.getTimerCount()).toBe(after1);
  });
});

describe('recordCancelIntent persistence — the claim the route relies on (#3400, M4)', () => {
  let client: SqlClient;
  let savedEndpoint: string | undefined;

  beforeEach(async () => {
    client = await realClient();
    savedEndpoint = process.env.LOOM_COSMOS_ENDPOINT;
    delete process.env.LOOM_COSMOS_ENDPOINT;
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });

  afterEach(() => {
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
    if (savedEndpoint === undefined) delete process.env.LOOM_COSMOS_ENDPOINT;
    else process.env.LOOM_COSMOS_ENDPOINT = savedEndpoint;
  });

  /**
   * R7. The cancel route answers `cancelled:'requested'` on a TRUE here, so a
   * `true` that stored nothing is the route asserting a persistence that never
   * happened.
   *   MUTATION: `return true;` as the first statement of recordCancelIntent.
   */
  it('returns FALSE when there is no store — it never claims a write it could not make', async () => {
    await expect(client.recordCancelIntent('nowhere')).resolves.toBe(false);
  });

  it('WRITES the intent, and only then returns true', async () => {
    const m = memStore();
    client._setCancelIntentStore(m.store);
    await expect(client.recordCancelIntent('r-42')).resolves.toBe(true);
    expect(m.recorded).toEqual(['r-42']);
  });

  /** A store that throws is not a store that stored. */
  it('returns FALSE when the store throws', async () => {
    client._setCancelIntentStore({
      record: async () => { throw new Error('Cosmos 429 TooManyRequests'); },
      has: async () => false,
      clear: async () => {},
    });
    await expect(client.recordCancelIntent('r-43')).resolves.toBe(false);
  });

  /**
   * The full loop in one process: replica A publishes through the PUBLIC api
   * the route calls, replica B (holding the request) consumes it. Kills M4 even
   * if the `false` cases above were somehow satisfied, because a
   * `recordCancelIntent` that stores nothing leaves nothing for the poll to find.
   */
  it('an intent published by recordCancelIntent is what the owning replica acts on', async () => {
    const m = memStore();
    client._setCancelIntentStore(m.store);

    // Replica A: the cancel POST landed here, the request is not local.
    expect(await client.recordCancelIntent('cross')).toBe(true);

    // Replica B: it owns the request and polls for its own keys.
    const cancel = vi.fn();
    client.liveRequests.set('cross', { cancel } as any);
    await client._pollCancelIntentsOnce();

    expect(cancel).toHaveBeenCalledOnce();
    expect(client.liveRequests.has('cross')).toBe(false);
  });

  /** Nobody else's request is touched by an intent that names one id. */
  it('an intent cancels ONLY the request it names', async () => {
    const m = memStore();
    client._setCancelIntentStore(m.store);
    await client.recordCancelIntent('theirs');

    const mine = vi.fn();
    client.liveRequests.set('mine', { cancel: mine } as any);
    await client._pollCancelIntentsOnce();

    expect(mine).not.toHaveBeenCalled();
    expect(client.liveRequests.has('mine')).toBe(true);
  });
});

/**
 * The REAL Cosmos-backed store (#3400, M4 second half).
 *
 * Everything above injects a store, so `cancelIntentStore()`'s own init path —
 * the one that actually runs in production — had no coverage at all: the
 * container it provisions, the document it writes, and whether the `(id, id)`
 * point-read it does on the other replica can even find that document. A
 * partition-key path that disagreed with the point-read would make every
 * cross-replica cancel silently miss, with every injected-store test green.
 *
 * @azure/cosmos is faked at module scope; the azure-sql-client code under test
 * is the real thing.
 */
describe('the Cosmos-backed intent store (#3400, M4)', () => {
  let client: SqlClient;
  let savedEndpoint: string | undefined;
  let savedDb: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(async () => {
    client = await realClient();
    savedEndpoint = process.env.LOOM_COSMOS_ENDPOINT;
    savedDb = process.env.LOOM_COSMOS_DATABASE;
    savedDisabled = process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED;
    process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.invalid/';
    process.env.LOOM_COSMOS_DATABASE = 'loom';
    delete process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED;
    cosmos.reset();
    client.liveRequests.clear();
    client._setCancelIntentStore(null); // clears the injected store AND the memo
  });

  afterEach(() => {
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
    cosmos.reset();
    for (const [k, v] of [
      ['LOOM_COSMOS_ENDPOINT', savedEndpoint],
      ['LOOM_COSMOS_DATABASE', savedDb],
      ['LOOM_SQL_CANCEL_INTENTS_DISABLED', savedDisabled],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /**
   * auto-bind-by-default: the container is provisioned by the platform on first
   * use. No operator step, no separate ARM deployment.
   */
  it('provisions its own TTL container and writes a document keyed for the point-read', async () => {
    expect(await client.recordCancelIntent('xrep')).toBe(true);

    expect(cosmos.databases).toEqual([{ id: 'loom' }]);
    expect(cosmos.containers).toEqual([{
      id: client.CANCEL_INTENT_CONTAINER,
      partitionKey: { paths: ['/requestId'] },
      defaultTtl: client.CANCEL_INTENT_TTL_SECONDS,
    }]);

    const doc = cosmos.upserts.at(-1);
    expect(doc.id).toBe('xrep');
    // id === the partition-key VALUE, which is what makes `item(id, id)` a
    // legal point read on the other replica. If these ever diverge the read
    // below misses and every cross-replica cancel silently no-ops.
    expect(doc.requestId).toBe('xrep');
    expect(doc.ttl).toBe(client.CANCEL_INTENT_TTL_SECONDS);
    expect(typeof doc.requestedAt).toBe('number');
  });

  /** The other half of the round trip, through the real Cosmos accessors. */
  it('the owning replica point-reads that document and cancels the request', async () => {
    await client.recordCancelIntent('xrep');

    const cancel = vi.fn();
    client.liveRequests.set('xrep', { cancel } as any);
    await client._pollCancelIntentsOnce();

    expect(cosmos.reads).toContainEqual(['xrep', 'xrep']);
    expect(cancel).toHaveBeenCalledOnce();
    // clear() is fire-and-forget, so wait for it rather than assume ordering.
    await vi.waitFor(() => expect(cosmos.deletes).toContainEqual(['xrep', 'xrep']));
  });

  /** No intent for this replica's key → no read result, no cancel. */
  it('a request with no intent is left running', async () => {
    const cancel = vi.fn();
    client.liveRequests.set('untouched', { cancel } as any);
    await client._pollCancelIntentsOnce();
    expect(cosmos.reads).toContainEqual(['untouched', 'untouched']);
    expect(cancel).not.toHaveBeenCalled();
  });

  /**
   * R7 — an unreachable store must surface as "could not persist", never as a
   * claimed request. This is what the cancel route's `cancelled:false` branch
   * is built on.
   */
  it('an init failure yields FALSE, not a claimed write', async () => {
    cosmos.failInit = true;
    await expect(client.recordCancelIntent('boom')).resolves.toBe(false);
    expect(cosmos.upserts).toEqual([]);
  });

  /** The documented opt-out really opts out — no Cosmos client is constructed. */
  it('LOOM_SQL_CANCEL_INTENTS_DISABLED=1 disables the store entirely', async () => {
    process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED = '1';
    client._setCancelIntentStore(null);
    expect(client.cancelIntentStoreConfigured()).toBe(false);
    await expect(client.recordCancelIntent('nope')).resolves.toBe(false);
    expect(cosmos.databases).toEqual([]);
    expect(cosmos.clientOpts).toBeNull();
  });

  /**
   * Review finding 2. The init used to be a ONE-SHOT memo (`_cosmosIntentInitTried`
   * set before the try, never reset outside the test hook). One 429 / cold start
   * / DNS blip on the very first call therefore left that replica unable to
   * publish OR consume an intent for its entire lifetime — the permanent
   * cross-replica no-op #3400 exists to remove, re-introduced through a
   * different door and observable nowhere.
   *
   * Bounded backoff is the contract: don't hammer a failing endpoint...
   *   MUTATION: drop the `Date.now() - _cosmosIntentInitFailedAt < ...` guard →
   *   red here (a second construct inside the window).
   */
  it('backs off after a failed init instead of hammering the endpoint', async () => {
    cosmos.failInit = true;
    await expect(client.recordCancelIntent('a')).resolves.toBe(false);
    expect(cosmos.constructs).toBe(1);

    // Immediately again, inside the backoff window: no second attempt.
    await expect(client.recordCancelIntent('b')).resolves.toBe(false);
    expect(cosmos.constructs).toBe(1);
  });

  /**
   * ...but ALWAYS re-arm. This is the half the one-shot memo got wrong.
   *   MUTATION: restore `if (_cosmosIntentInitTried) return _cosmosIntentStore;`
   *   with the flag set before the try → red here, permanently false.
   */
  it('RECOVERS on its own once the backoff window has passed — the failure is not permanent', async () => {
    vi.useFakeTimers();
    try {
      cosmos.failInit = true;
      await expect(client.recordCancelIntent('during-outage')).resolves.toBe(false);
      expect(cosmos.constructs).toBe(1);
      expect(cosmos.upserts).toEqual([]);

      // The blip passes. Nothing resets anything — no redeploy, no test hook.
      cosmos.failInit = false;
      await vi.advanceTimersByTimeAsync(31_000);

      await expect(client.recordCancelIntent('after-recovery')).resolves.toBe(true);
      expect(cosmos.constructs).toBe(2);
      expect(cosmos.upserts.at(-1)?.id).toBe('after-recovery');
    } finally {
      vi.useRealTimers();
    }
  });

  /** A successful init is still memoised — one client per replica, not one per call. */
  it('memoises a SUCCESSFUL init', async () => {
    await expect(client.recordCancelIntent('one')).resolves.toBe(true);
    await expect(client.recordCancelIntent('two')).resolves.toBe(true);
    expect(cosmos.constructs).toBe(1);
  });
});

/**
 * Review finding 4 — the cancel route's `cancelled:false` copy asserted "(no
 * Cosmos endpoint configured, or the write failed)". FOUR branches reach that
 * response, and on two of them neither named cause holds. R7: the message must
 * report the branch that was actually taken.
 */
describe('cancelIntentUnavailableReason — the cancel route\'s R7 copy (#3400)', () => {
  let client: SqlClient;
  let savedEndpoint: string | undefined;
  let savedDisabled: string | undefined;

  beforeEach(async () => {
    client = await realClient();
    savedEndpoint = process.env.LOOM_COSMOS_ENDPOINT;
    savedDisabled = process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED;
    cosmos.reset();
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
  });

  afterEach(() => {
    client.liveRequests.clear();
    client._setCancelIntentStore(null);
    cosmos.reset();
    for (const [k, v] of [
      ['LOOM_COSMOS_ENDPOINT', savedEndpoint],
      ['LOOM_SQL_CANCEL_INTENTS_DISABLED', savedDisabled],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('names the deliberate opt-out as an opt-out, not as an unreachable store', async () => {
    process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.invalid/';
    process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED = '1';
    client._setCancelIntentStore(null);

    expect(await client.recordCancelIntent('x')).toBe(false);
    const why = client.cancelIntentUnavailableReason();
    expect(why).toContain('LOOM_SQL_CANCEL_INTENTS_DISABLED=1');
    expect(why).toMatch(/switched off/i);
    // It must NOT claim the endpoint is missing — it is set.
    expect(why).not.toMatch(/no Cosmos endpoint/i);
  });

  it('names the missing endpoint when there is genuinely no store to reach', async () => {
    delete process.env.LOOM_COSMOS_ENDPOINT;
    delete process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED;
    client._setCancelIntentStore(null);

    expect(await client.recordCancelIntent('x')).toBe(false);
    expect(client.cancelIntentUnavailableReason()).toContain('LOOM_COSMOS_ENDPOINT');
  });

  it('names the INIT failure — including that nothing was attempted on this call', async () => {
    process.env.LOOM_COSMOS_ENDPOINT = 'https://cosmos.invalid/';
    delete process.env.LOOM_SQL_CANCEL_INTENTS_DISABLED;
    client._setCancelIntentStore(null);
    cosmos.failInit = true;

    expect(await client.recordCancelIntent('x')).toBe(false);
    const why = client.cancelIntentUnavailableReason();
    expect(why).toMatch(/could not be opened/i);
    expect(why).toContain('Cosmos endpoint unreachable'); // the real error text
    expect(why).toMatch(/backing off/i);
  });

  it('names the WRITE failure, and reports the real driver message', async () => {
    client._setCancelIntentStore({
      record: async () => { throw new Error('Cosmos 429 TooManyRequests'); },
      has: async () => false,
      clear: async () => {},
    });

    expect(await client.recordCancelIntent('x')).toBe(false);
    const why = client.cancelIntentUnavailableReason();
    expect(why).toMatch(/write failed/i);
    expect(why).toContain('429 TooManyRequests');
  });

  /** A stale write error must not be reported for a later, different failure. */
  it('does not carry a previous write error into a later attempt', async () => {
    client._setCancelIntentStore({
      record: async () => { throw new Error('Cosmos 429 TooManyRequests'); },
      has: async () => false,
      clear: async () => {},
    });
    expect(await client.recordCancelIntent('x')).toBe(false);
    expect(client.cancelIntentUnavailableReason()).toContain('429');

    // Now the store goes away entirely — the reason must follow the new branch.
    client._setCancelIntentStore(null);
    delete process.env.LOOM_COSMOS_ENDPOINT;
    expect(await client.recordCancelIntent('x')).toBe(false);
    const why = client.cancelIntentUnavailableReason();
    expect(why).not.toContain('429');
    expect(why).toContain('LOOM_COSMOS_ENDPOINT');
  });
});
