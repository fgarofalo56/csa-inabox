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
  _setCancelIntentStore(null);
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
