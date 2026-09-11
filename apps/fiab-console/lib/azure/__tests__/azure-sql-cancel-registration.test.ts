/**
 * #3400 — the LAST link in the cancel chain: `executeQuery` / `executeQueryBatch`
 * must actually REGISTER the in-flight request under the caller's requestId.
 *
 * Nothing else can guard this. The BFF route specs vi.mock the whole
 * azure-sql-client module, and the cancel specs drive `registerLiveRequest`
 * directly — so deleting `if (opts?.requestId) registerLiveRequest(...)` from
 * the executors leaves every one of them green while making BOTH cancel paths
 * dead: `liveRequests` stays empty, so a same-replica cancel finds nothing, and
 * the watcher never starts, so a cross-replica intent is never consumed. That is
 * the class review found as M3, one call site further out.
 *
 * TWO HALVES, AND THE SECOND ONE NEEDED ITS OWN SPEC (added after the 2026-09-09
 * re-review). The map half above is guarded by `liveRequests.get(id)`. The
 * WATCHER half was not, and the reviewer demonstrated the hole rather than
 * asserting it: replacing `registerLiveRequest(id, request)` with a bare
 * `liveRequests.set(id, request)` at BOTH executor call sites left 51/51 green
 * while no replica in the estate ever started the poll — every cross-replica
 * intent written to Cosmos and never consumed, i.e. the exact permanent no-op
 * #3400 exists to remove, restored through a narrower door. Deleting the line
 * outright DID go red (5 failed | 2 passed), so the guard was live, just too
 * coarse.
 *
 * The `executeQuery*` ARMS THE CROSS-REPLICA WATCHER blocks at the bottom of
 * this file close that half: they join an EXECUTOR to a cancel that arrives
 * only through the intent store, and they never call `_pollCancelIntentsOnce()`
 * themselves — the poll has to have been armed by the executor or nothing
 * cancels. `cancel.test.ts`'s own watcher-lifecycle block calls
 * `registerLiveRequest` directly and so cannot see this; that comment's claim
 * that "the request is registered exactly as executeQuery registers it" was an
 * assumption stated as fact, and these specs are what makes it true.
 *
 * The queries here are DEFERRED — the fake Request does not resolve until the
 * spec releases it — so every assertion is made while the query is genuinely
 * in flight, which is the only moment registration means anything.
 *
 * @azure/identity and mssql are stubbed (matching azure-sql-client-share.test.ts)
 * — no live tenant, no TDS.
 *
 * Cloud: this path is cloud-agnostic (TDS + the host suffix resolved by
 * sqlHostSuffix()), so it behaves identically in Commercial and Gov. That is an
 * argument about the code, NOT a runtime receipt from either boundary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'TOK', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const OK_RESULT = { recordsets: [[]], recordset: [], rowsAffected: [0] };

/**
 * A Request whose `.query()` hangs until the spec settles it — the stand-in for
 * a long-running statement the user then cancels.
 */
class DeferredRequest {
  cancel = vi.fn();
  on = vi.fn();
  settle!: (v: any) => void;
  reject!: (e: any) => void;
  query = vi.fn(() => new Promise<any>((res, rej) => { this.settle = res; this.reject = rej; }));
}

const issued: DeferredRequest[] = [];

vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      connected = false;
      async connect() { this.connected = true; return this; }
      on() { /* pool 'error' listener */ }
      request() { const r = new DeferredRequest(); issued.push(r); return r; }
    },
  },
}));

import { executeQuery, executeQueryBatch, liveRequests, _setCancelIntentStore } from '../azure-sql-client';

/** Unique per spec so `pools` (keyed `server/database`) never hands back a reuse. */
let n = 0;
function uniqueServer() { n += 1; return `srv-cancel-reg-${n}`; }

/** Start a query and return once its Request has been issued by the pool. */
async function inFlight(run: () => Promise<unknown>) {
  const before = issued.length;
  const promise = run().catch(() => undefined);
  // getPool awaits a token + connect(), so poll rather than assume a tick count.
  for (let i = 0; i < 50 && issued.length === before; i += 1) await Promise.resolve();
  expect(issued.length, 'the pool never issued a Request').toBe(before + 1);
  return { promise, request: issued[issued.length - 1] };
}

beforeEach(() => {
  issued.length = 0;
  liveRequests.clear();
  _setCancelIntentStore(null); // registration only — no watcher, no Cosmos
});

afterEach(() => {
  liveRequests.clear();
  // `_setCancelIntentStore(null)` also stops the watcher — call it BEFORE the
  // timers are restored, so the pending interval is cleared through the same
  // fake clock that created it and `_cancelWatcher` is genuinely null again.
  _setCancelIntentStore(null);
  vi.useRealTimers();
});

describe('executeQuery registers the live request (#3400)', () => {
  /**
   * THE SPEC. While the query is running, the cancel route must be able to find
   * THIS Request object by the caller's id — that lookup is the entire
   * same-replica cancel, and the registration is also what starts the watcher
   * for the cross-replica one.
   *   MUTATION: delete `if (opts?.requestId) registerLiveRequest(...)` from
   *   executeQuery → liveRequests is empty and both cancel paths are dead.
   */
  it('exposes the in-flight Request under the caller requestId', async () => {
    const { promise, request } = await inFlight(
      () => executeQuery(uniqueServer(), 'db', 'SELECT 1', { requestId: 'reg-1' }),
    );
    expect(liveRequests.get('reg-1')).toBe(request);

    // Cancelling through the registered handle reaches THIS request.
    (liveRequests.get('reg-1') as any).cancel();
    expect(request.cancel).toHaveBeenCalledOnce();

    request.settle(OK_RESULT);
    await promise;
  });

  /** A completed id must never linger — a stale entry would cancel a later query. */
  it('deregisters once the query completes', async () => {
    const { promise, request } = await inFlight(
      () => executeQuery(uniqueServer(), 'db', 'SELECT 1', { requestId: 'reg-2' }),
    );
    expect(liveRequests.has('reg-2')).toBe(true);
    request.settle(OK_RESULT);
    await promise;
    expect(liveRequests.has('reg-2')).toBe(false);
  });

  /**
   * ...including on the cancel path itself, where the query REJECTS with
   * ECANCEL. A `finally` that only ran on success would leak every cancelled id.
   *   MUTATION: move the unregister out of `finally` into the success path.
   */
  it('deregisters when the query REJECTS (the ECANCEL path)', async () => {
    const { promise, request } = await inFlight(
      () => executeQuery(uniqueServer(), 'db', 'SELECT 1', { requestId: 'reg-3' }),
    );
    expect(liveRequests.has('reg-3')).toBe(true);
    request.reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
    await promise;
    expect(liveRequests.has('reg-3')).toBe(false);
  });

  it('registers NOTHING when the caller passed no requestId', async () => {
    const { promise, request } = await inFlight(
      () => executeQuery(uniqueServer(), 'db', 'SELECT 1'),
    );
    expect(liveRequests.size).toBe(0);
    request.settle(OK_RESULT);
    await promise;
  });
});

describe('executeQueryBatch registers the live request (#3400)', () => {
  /**
   * The multi-recordset executor is the one the /query BFF route actually calls,
   * so this is the path a real Cancel click depends on.
   *   MUTATION: as above, in executeQueryBatch.
   */
  it('exposes the in-flight Request under the caller requestId', async () => {
    const { promise, request } = await inFlight(
      () => executeQueryBatch(uniqueServer(), 'db', 'SELECT 1', { requestId: 'batch-1' }),
    );
    expect(liveRequests.get('batch-1')).toBe(request);
    request.settle(OK_RESULT);
    await promise;
    expect(liveRequests.has('batch-1')).toBe(false);
  });

  it('deregisters when the batch REJECTS (the ECANCEL path)', async () => {
    const { promise, request } = await inFlight(
      () => executeQueryBatch(uniqueServer(), 'db', 'SELECT 1', { requestId: 'batch-2' }),
    );
    expect(liveRequests.has('batch-2')).toBe(true);
    request.reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
    await promise;
    expect(liveRequests.has('batch-2')).toBe(false);
  });

  it('registers NOTHING when the caller passed no requestId', async () => {
    const { promise, request } = await inFlight(
      () => executeQueryBatch(uniqueServer(), 'db', 'SELECT 1'),
    );
    expect(liveRequests.size).toBe(0);
    request.settle(OK_RESULT);
    await promise;
  });
});

/**
 * THE WATCHER HALF (#3400) — an executor must ARM the cross-replica poll, not
 * merely populate the map.
 *
 * WHY THIS EXISTS AND WHY IT IS SHAPED THIS WAY. The specs above all assert
 * `liveRequests.get(id)`, which a bare `liveRequests.set(id, request)` in the
 * executor satisfies just as well as `registerLiveRequest(...)` does — and only
 * the latter calls `startCancelWatcher()`. So the one-token downgrade left the
 * whole suite green while permanently disabling the feature. These specs assert
 * the OUTCOME instead: a cancel published by ANOTHER replica reaches THIS
 * request. Nothing here touches `registerLiveRequest`, `startCancelWatcher` or
 * `_pollCancelIntentsOnce` — if the executor did not arm the poll, no timer
 * exists, `request.cancel` is never called, and these go red.
 *
 * `_setCancelIntentStore` is installed BEFORE the query starts, for two reasons:
 * `cancelIntentStoreConfigured()` is what `startCancelWatcher()` gates on (an
 * injected store makes it true with no `LOOM_COSMOS_ENDPOINT`), and the setter
 * stops any watcher already running — installing it afterwards would tear down
 * the very thing under test.
 *
 * Fake timers are installed before the executor call for the same ordering
 * reason: `setInterval` has to be the fake one for `advanceTimersByTimeAsync`
 * to be able to fire it. `advanceTimersByTimeAsync` (not the sync variant) is
 * required because the poll body is async — it awaits the store's `has()`.
 *
 * Cloud: same argument as the header — TDS + the intent store are cloud-
 * agnostic, so this behaves identically in Commercial and Gov. It is an
 * argument about the code, NOT a runtime receipt from either boundary.
 */
describe('the executors ARM the cross-replica cancel watcher (#3400)', () => {
  /** A store another replica can publish into, mirroring recordCancelIntent(). */
  function otherReplicaStore() {
    const intents = new Set<string>();
    return {
      /** What the cancel route on a DIFFERENT replica does. */
      publish(requestId: string) { intents.add(requestId); },
      cleared(requestId: string) { return !intents.has(requestId); },
      store: {
        record: async (id: string) => { intents.add(id); },
        has: async (id: string) => intents.has(id),
        clear: async (id: string) => { intents.delete(id); },
      },
    };
  }

  /**
   * The executor the real /query BFF route calls (query/route.ts imports
   * executeQueryBatch), so this is the path a real Cancel click depends on.
   *   MUTATION: `registerLiveRequest(id, r)` → `liveRequests.set(id, r)` here.
   *   The map stays correct, the watcher never starts, this goes red.
   */
  it('executeQueryBatch: an intent published elsewhere cancels THIS request on the next poll', async () => {
    const other = otherReplicaStore();
    _setCancelIntentStore(other.store);
    vi.useFakeTimers();
    const { promise, request } = await inFlight(
      () => executeQueryBatch(uniqueServer(), 'db', 'SELECT 1', { requestId: 'watch-batch' }),
    );
    // Nothing has asked for a cancel yet — a poll that fired now must be a no-op.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request.cancel, 'cancelled with no intent published').not.toHaveBeenCalled();

    // Another replica received the Cancel click and wrote the intent.
    other.publish('watch-batch');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request.cancel, 'the executor never armed the cancel-intent poll').toHaveBeenCalledOnce();
    // The intent is SPENT, not left to re-fire on the next tick.
    expect(other.cleared('watch-batch')).toBe(true);
    expect(liveRequests.has('watch-batch')).toBe(false);

    // tedious would now reject the in-flight query with ECANCEL.
    request.reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
    await promise;
  });

  /** Same invariant on the single-recordset executor. */
  it('executeQuery: an intent published elsewhere cancels THIS request on the next poll', async () => {
    const other = otherReplicaStore();
    _setCancelIntentStore(other.store);
    vi.useFakeTimers();
    const { promise, request } = await inFlight(
      () => executeQuery(uniqueServer(), 'db', 'SELECT 1', { requestId: 'watch-single' }),
    );
    other.publish('watch-single');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request.cancel, 'the executor never armed the cancel-intent poll').toHaveBeenCalledOnce();
    expect(liveRequests.has('watch-single')).toBe(false);

    request.reject(Object.assign(new Error('Canceled.'), { code: 'ECANCEL' }));
    await promise;
  });

  /**
   * An id this replica does not own must never be cancelled by this replica's
   * poll — the watcher reads intents for its OWN live keys only. Without this,
   * a store returning `has() === true` for everything would make the spec above
   * pass for the wrong reason.
   */
  it('cancels ONLY the ids this replica owns', async () => {
    const other = otherReplicaStore();
    _setCancelIntentStore(other.store);
    vi.useFakeTimers();
    const { promise, request } = await inFlight(
      () => executeQueryBatch(uniqueServer(), 'db', 'SELECT 1', { requestId: 'mine' }),
    );
    other.publish('someone-elses');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(request.cancel).not.toHaveBeenCalled();
    expect(other.cleared('someone-elses')).toBe(false);

    request.settle(OK_RESULT);
    await promise;
  });
});
