/**
 * Regression spec for the sibling of #3568 found in review of PR #3689.
 *
 * `listLivySessions` in synapse-livy-client.ts defaulted `pageSize` to 100 and
 * never validated it, against the Livy SESSIONS endpoint — which carries the
 * IDENTICAL documented cap as the batches endpoint that #3568 reported:
 * "size — Optional param specifying the size of the returned list. By default
 * it is 20 and that is the maximum."
 * (https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/get-spark-sessions)
 *
 * Clamping alone would have been a REGRESSION, not a fix: the old guard
 * `ceil(hardCap/size)+1` allowed 21 pages at size=100 and allows 101 at the
 * correct size=20, each of which — outside a budget — gets the full 30s
 * `DEFAULT_SERVER_FETCH_TIMEOUT_MS`. So the clamp ships with a `PagingBudget`
 * bounding pages AND wall clock, and with a truncation signal, because the
 * reaper this feeds treats "absent from the list" as "gone from the pool".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});
vi.mock('@/lib/azure/aca-managed-identity', () => {
  class Cred {
    async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; }
  }
  return { AcaManagedIdentityCredential: Cred };
});

interface SessionRow { id: number }
type PageBody = { total: number; sessions: SessionRow[] };

let requestedUrls: string[] = [];
let requestedTimeouts: Array<number | undefined> = [];
let responder: (url: string, timeoutMs: number | undefined) => PageBody = () => ({ total: 0, sessions: [] });

vi.mock('@/lib/azure/fetch-with-timeout', () => {
  class FetchTimeoutError extends Error {
    readonly url: string;
    readonly timeoutMs: number;
    constructor(url: string, timeoutMs: number) {
      super(`Request to ${url} timed out after ${timeoutMs}ms`);
      this.name = 'FetchTimeoutError';
      this.url = url;
      this.timeoutMs = timeoutMs;
    }
  }
  return {
    FetchTimeoutError,
    DEFAULT_SERVER_FETCH_TIMEOUT_MS: 30_000,
    fetchWithTimeout: async (input: string, _init?: RequestInit, timeoutMs?: number) => {
      requestedUrls.push(input);
      requestedTimeouts.push(timeoutMs);
      const body = responder(input, timeoutMs);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
});

function parseFromSize(url: string): { from: number; size: number } {
  const u = new URL(url);
  return { from: Number(u.searchParams.get('from')), size: Number(u.searchParams.get('size')) };
}

/** A pool holding `total` sessions, served as an offset window like real Livy. */
function pool(total: number) {
  const all: SessionRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url: string): PageBody => {
    const { from, size } = parseFromSize(url);
    return { total, sessions: all.slice(from, from + size) };
  };
}

/**
 * The same pool, but the backend OMITS `total` from every page.
 *
 * Found in review of PR #3689. `total` was initialised to 0 and only assigned
 * when the server reported one, so `out.length >= total` was `20 >= 0` after
 * page one and the walk broke immediately — with `truncatedBy: null`. A 20-row
 * subset of a 137-session pool therefore reads as a COMPLETE census.
 *
 * That is not merely a short list. `reapStaleSessions` gates its tracker GC on
 * exactly this `truncatedBy` — the guard added earlier in this PR — so a
 * `total`-less backend walks straight past it and the reaper forgets the grace
 * window of every session it never paged to. The #1796 jam, re-introduced
 * through the one direction the new guard does not watch.
 */
function totallessPool(total: number) {
  const all: SessionRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url: string): PageBody => {
    const { from, size } = parseFromSize(url);
    return { sessions: all.slice(from, from + size) } as unknown as PageBody;
  };
}

/**
 * The same pool, but `total` is the LENGTH OF THE PAGE JUST RETURNED.
 *
 * Neither fixture above models this. `pool()` serves a pool-wide `total`
 * (Apache Livy's `sessionManager.size()`) and `totallessPool()` omits it, so a
 * suite built only from those two is green whichever reading the client
 * assumes — which makes it no evidence at all about the one that decides
 * whether the reaper sees a complete census.
 *
 * The Azure REST spec that generates every Synapse Spark SDK describes the
 * BATCH collection's identical field as "Number of sessions fetched"
 * (`specification/synapse/data-plane/Microsoft.Synapse/preview/
 * 2019-11-01-preview/sparkJob.json`), and gives `SparkSessionCollection` — the
 * shape THIS endpoint returns — no description whatsoever. So the page-length
 * reading is the documented one for the sibling and the undocumented one here;
 * either way it is not safe to navigate by.
 *
 * Under it, a 137-session pool answers page one with `total: 20` beside 20
 * rows, `out.length >= total` is `20 >= 20`, the walk breaks after ONE page and
 * `truncatedBy` comes back null. `reapStaleSessions` gates its tracker GC on
 * that field, so it then GCs the grace-window trackers of the 117 sessions the
 * census never reached — #1796, reopened through the direction the earlier
 * guard did not watch.
 */
function pageLengthTotalPool(total: number) {
  const all: SessionRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url: string): PageBody => {
    const { from, size } = parseFromSize(url);
    const sessions = all.slice(from, from + size);
    return { total: sessions.length, sessions };
  };
}

/**
 * A backend that answers 200 with a body carrying NO `sessions` array.
 *
 * `{"total":0,"sessions":[]}` says the list is exhausted; `{"total":0}` says
 * the server did not answer. Collapsing the second into the first is how a
 * broken read becomes a confident, COMPLETE census of zero sessions.
 */
function malformedAfter(goodPages: number, total: number) {
  const all: SessionRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  let served = 0;
  return (url: string): PageBody => {
    const { from, size } = parseFromSize(url);
    if (served++ >= goodPages) return { total: 0 } as unknown as PageBody;
    return { total, sessions: all.slice(from, from + size) };
  };
}

beforeEach(() => {
  requestedUrls = [];
  requestedTimeouts = [];
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_ARM_PAGING_MAX_PAGES;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});

describe('listLivySessions — the sessions endpoint carries the same max-20 cap', () => {
  it('never requests more than 20 sessions per page, even on the old default of 100', async () => {
    responder = pool(75);
    const { listLivySessions } = await import('../synapse-livy-client');

    await listLivySessions('pool1');

    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      const { size } = parseFromSize(url);
      expect(size).toBeLessThanOrEqual(20);
      expect(size).toBeGreaterThanOrEqual(1);
    }
  });

  it('clamps an explicitly over-cap pageSize at the boundary (20 stays, 21 does not)', async () => {
    responder = pool(500);
    const { listLivySessions } = await import('../synapse-livy-client');

    await listLivySessions('pool1', { pageSize: 20, hardCap: 20 });
    expect(parseFromSize(requestedUrls[0]).size).toBe(20);

    requestedUrls = [];
    await listLivySessions('pool1', { pageSize: 21, hardCap: 40 });
    for (const url of requestedUrls) expect(parseFromSize(url).size).toBeLessThanOrEqual(20);

    requestedUrls = [];
    await listLivySessions('pool1', { pageSize: 100, hardCap: 40 });
    for (const url of requestedUrls) expect(parseFromSize(url).size).toBeLessThanOrEqual(20);
  });

  it('still enumerates the WHOLE pool across the smaller pages — the clamp is not a truncation', async () => {
    responder = pool(75);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(res.sessions.map((s) => s.id)).toEqual(Array.from({ length: 75 }, (_, i) => i));
    expect(res.total).toBe(75);
    expect(res.scanned).toBe(75);
    expect(res.truncatedBy).toBeNull();
  });

  it('hands EVERY request the budget deadline — a 101-page walk of bare 30s fetches is the thing being prevented', async () => {
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '8000';
    responder = pool(200);
    const { listLivySessions } = await import('../synapse-livy-client');

    await listLivySessions('pool1', { hardCap: 200 });

    expect(requestedTimeouts.length).toBeGreaterThan(1);
    for (const t of requestedTimeouts) {
      expect(t).toBeTypeOf('number');
      expect(t as number).toBeGreaterThan(0);
      expect(t as number).toBeLessThanOrEqual(8000);
    }
  });

  it('a slow backend truncates on WALL CLOCK and SAYS SO, rather than walking 101 pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '1000';
    const p = pool(2000);
    responder = (url) => {
      vi.setSystemTime(Date.now() + 600);
      return p(url);
    };
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(requestedUrls).toHaveLength(2);
    expect(res.truncatedBy).toBe('time');
    expect(res.scanned).toBe(40);
    expect(res.total).toBe(2000);
  });

  it('discloses truncation when `hardCap` stops the walk short of the real total', async () => {
    responder = pool(500);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { hardCap: 40 });

    expect(res.sessions).toHaveLength(40);
    expect(res.total).toBe(500);
    // A census that saw 40 of 500 MUST NOT read as "the pool has 40 sessions".
    expect(res.truncatedBy).not.toBeNull();
  });

  it('reports a COMPLETE census as complete — silence has to mean "this list is whole"', async () => {
    responder = pool(12);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { hardCap: 400 });

    expect(res.sessions).toHaveLength(12);
    expect(res.truncatedBy).toBeNull();
    // TWO requests, not one — the cost of no longer trusting a `total` that is
    // indistinguishable from the page it arrived on. Page one reports
    // `total: 12` beside 12 rows, which is what BOTH readings produce for a
    // 12-session pool, so it cannot end the walk; the empty second page is what
    // actually establishes the list is whole. `res.total` is unaffected —
    // `total ?? out.length` reports the exact 12 either way.
    expect(requestedUrls).toHaveLength(2);
    expect(res.total).toBe(12);
  });
});

/**
 * A `total` that is really the PAGE LENGTH must not be able to end the walk.
 *
 * Found in the PR #3689 review, against the batches sibling; the same shape is
 * here, and here it lands on `reapStaleSessions`.
 */
describe('a page-length `total` must not forge a complete census', () => {
  it('enumerates all 137 sessions when every page reports `total` = its own length', async () => {
    responder = pageLengthTotalPool(137);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    // Pre-fix: `out.length >= total` was `20 >= 20` after page one, the walk
    // broke, and 20 of 137 came back with `truncatedBy: null`.
    expect(res.sessions).toHaveLength(137);
    expect(res.scanned).toBe(137);
    expect(res.total).toBe(137);
    expect(res.truncatedBy).toBeNull();
  });

  it('never reports a complete census it did not finish, at any pool size', async () => {
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    for (const size of [21, 60, 137]) {
      requestedUrls = [];
      responder = pageLengthTotalPool(size);

      const res = await listLivySessionsResult('pool1');

      // THE GUARD BYPASS, ratcheted. A null truncation is the reaper's licence
      // to GC every tracker not in this list, so it is only allowed when the
      // list really is all of them.
      expect(res.scanned === size || res.truncatedBy != null).toBe(true);
      expect(res.scanned < size && res.truncatedBy == null).toBe(false);
    }
  });

  it('still honours a `total` that CANNOT be a page length', async () => {
    // `total: 500` beside a 20-row page is impossible under the page-length
    // reading, so it stays usable and still stops the walk at `hardCap` with a
    // disclosed truncation. The fix must not blunt the existing signal.
    responder = pool(500);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { hardCap: 40 });

    expect(res.sessions).toHaveLength(40);
    expect(res.total).toBe(500);
    expect(res.truncatedBy).not.toBeNull();
  });
});

/**
 * A page with no `sessions` array is a BROKEN READ, not an exhausted list.
 *
 * `livy-session-census.py`, shipped in this same PR, refuses that inference in
 * as many words. The TypeScript side did the opposite until now.
 */
describe('a page with no `sessions` array must not read as an exhausted list', () => {
  it('does not report a complete, empty census when the very first body is broken', async () => {
    responder = malformedAfter(0, 137);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(res.sessions).toHaveLength(0);
    // 0 sessions + `truncatedBy: null` is a licence to GC every tracker on the
    // pool, issued off a response that answered nothing.
    expect(res.truncatedBy).not.toBeNull();
  });

  it('keeps the rows it did read and still marks the census incomplete', async () => {
    responder = malformedAfter(3, 137);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(res.sessions).toHaveLength(60); // three good pages, kept
    expect(res.truncatedBy).not.toBeNull();
  });

  it('an EMPTY `sessions` array is still a genuinely complete census', async () => {
    // The counterfactual: the rule must not degenerate into "every census is
    // truncated". `{"total":0,"sessions":[]}` DID answer the question.
    responder = () => ({ total: 0, sessions: [] });
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(res.sessions).toHaveLength(0);
    expect(res.truncatedBy).toBeNull();
  });
});

/**
 * `pageSize` reaches `listLivySessionsResult` from callers and from config, and
 * the sibling `clampLivyPageSize` guards non-finite input while this one did
 * not. Both values below produced a silently wrong census rather than an error.
 */
describe('a non-finite or zero pageSize must not silently break the census', () => {
  it('a NaN pageSize still enumerates the pool instead of returning nothing', async () => {
    responder = pool(45);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { pageSize: NaN });

    // Pre-fix: size=NaN went out on the query string AND `maxPages` became
    // `ceil(hardCap/NaN)` = NaN, which `claimPage()` reads as `0 < NaN` =
    // false — zero pages fetched, an EMPTY census, `truncatedBy` from a budget
    // that never ran.
    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      const { size } = parseFromSize(url);
      expect(Number.isFinite(size)).toBe(true);
      expect(size).toBeLessThanOrEqual(20);
      expect(size).toBeGreaterThanOrEqual(1);
    }
    expect(res.sessions).toHaveLength(45);
    expect(res.truncatedBy).toBeNull();
  });

  it('a zero pageSize does not turn a 2000-ROW cap into a 2000-PAGE walk', async () => {
    responder = pool(45);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { pageSize: 0 });

    // `Math.max(1, 0)` floored the page size to 1, so the documented 2000-row
    // `hardCap` became `ceil(2000/1)` = 2000 pages — 2000 budgeted requests to
    // read 45 sessions.
    for (const url of requestedUrls) expect(parseFromSize(url).size).toBe(20);
    expect(requestedUrls.length).toBeLessThanOrEqual(4);
    expect(res.sessions).toHaveLength(45);
  });

  it('a non-finite hardCap falls back to the documented default instead of NaN', async () => {
    responder = pool(45);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { hardCap: NaN });

    expect(res.sessions).toHaveLength(45);
    expect(res.truncatedBy).toBeNull();
  });
});

describe('a `total`-less backend must not be able to forge a complete census', () => {
  it('does not stop after page one when the server omits `total`', async () => {
    responder = totallessPool(137);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    // 137 rows, 20 per page, well inside the default hardCap — the walk can run
    // the list dry, and a walk that ran dry has genuinely seen everything.
    expect(res.sessions).toHaveLength(137);
    expect(res.scanned).toBe(137);
    expect(res.truncatedBy).toBeNull();
  });

  it('marks the census INCOMPLETE when a `total`-less walk stops on a ceiling', async () => {
    responder = totallessPool(500);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1', { hardCap: 40 });

    expect(res.sessions).toHaveLength(40);
    // THE GUARD BYPASS. `reapStaleSessions` reads "absent from this list" as
    // "gone from the pool" whenever `truncatedBy` is null. 40 of 500 rows with
    // a null truncation is how the reaper GCs the grace window of 460 live
    // sessions and never reaps a leaked one again.
    expect(res.truncatedBy).not.toBeNull();
  });

  it('an EMPTY pool that says so is still complete, `total` or not', async () => {
    responder = totallessPool(0);
    const { listLivySessionsResult } = await import('../synapse-livy-client');

    const res = await listLivySessionsResult('pool1');

    expect(res.sessions).toHaveLength(0);
    expect(res.truncatedBy).toBeNull();
    expect(requestedUrls).toHaveLength(1);
  });
});
