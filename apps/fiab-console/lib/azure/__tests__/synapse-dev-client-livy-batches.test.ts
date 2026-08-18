/**
 * Regression spec for issue #3568 and the review of PR #3689.
 *
 * TWO DEFECTS, and the second is the one that mattered.
 *
 * 1. SIZE. `listSparkBatchJobs` forwarded `size` straight through to the
 *    Synapse Livy batches list endpoint, which documents "By default it is 20
 *    and that is the maximum" and 400s above it. Two callers hardcoded an
 *    over-cap literal (100, 25) and two forwarded an unvalidated query-string
 *    value, so patching only the reported call site would have left three
 *    other ways to reproduce it. The clamp lives in the shared client.
 *
 * 2. WINDOW. Livy lists batches in ASCENDING batch-id order and `from` is an
 *    index into that ascending list, so `from=0` is the OLDEST end. Every
 *    "recent runs" surface in the console asked for `from=0`. While `size` was
 *    over the cap that failed LOUDLY with a 400; clamping `size` alone would
 *    have converted a loud failure into a silent one — the Runs grid filling
 *    with the pool's OLDEST batches. `listRecentSparkBatchJobs` fixes the
 *    window, and does not take the ordering on faith: it probes both ends and
 *    walks whichever actually holds the newer ids.
 *
 * 3. WALL CLOCK. The first cut of the fix constructed its `PagingBudget` AFTER
 *    the first fetch and never called `runPage`, so `claimPage()` was pure
 *    bookkeeping: no fetch ever received the budget's deadline and each could
 *    hang for the full 30s `DEFAULT_SERVER_FETCH_TIMEOUT_MS` on its own. These
 *    specs assert the deadline reaches EVERY fetch including the first, and
 *    that a slow backend actually cuts the walk short.
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

interface BatchRow { id: number }
type PageBody = { total: number; sessions: BatchRow[] };
/** A responder may return a page, or the string 'timeout' to simulate a hung backend. */
type Responder = (url: string, timeoutMs: number | undefined) => PageBody | 'timeout';

/** Every URL the client actually requested, captured at the `fetchWithTimeout` chokepoint. */
let requestedUrls: string[] = [];
/** The `timeoutMs` each of those requests was given — undefined means "no deadline was wired". */
let requestedTimeouts: Array<number | undefined> = [];
let responder: Responder = () => ({ total: 0, sessions: [] });

vi.mock('@/lib/azure/fetch-with-timeout', () => {
  // A faithful stand-in: `paging-budget` only absorbs a deadline it recognises
  // via `instanceof FetchTimeoutError` AND `err.timeoutMs <= budgetMs`, so the
  // mock must export the real class shape or the absorb path never runs.
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
      if (body === 'timeout') throw new FetchTimeoutError(input, timeoutMs ?? 30_000);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
});

/** Parse the `from`/`size` query params the client put on a captured URL. */
function parseFromSize(url: string): { from: number; size: number } {
  const u = new URL(url);
  return { from: Number(u.searchParams.get('from')), size: Number(u.searchParams.get('size')) };
}

/**
 * A pool holding `total` batches with ASCENDING ids 0..total-1 — Apache Livy's
 * real shape (`sessions.view(from, from + size)` over an insertion-ordered
 * `LinkedHashMap` fed by a monotonic id counter), so index 0 is the OLDEST.
 */
function ascendingPool(total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    return { total, sessions: all.slice(from, from + size) };
  };
}

/** The same pool, but served NEWEST-FIRST — the ordering we refuse to assume away. */
function descendingPool(total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: total - 1 - i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    return { total, sessions: all.slice(from, from + size) };
  };
}

/**
 * An ascending pool whose backend OMITS `total` from every page.
 *
 * Found in review of PR #3689 and NOT hypothetical-only: `readTotal` fell back
 * to the length of the page just returned, which made `total` 20 on a pool of
 * any size, `tailFrom = max(0, 20 - 20) = 0`, and therefore sent
 * `listRecentSparkBatchJobs` down its "everything already fits in the head
 * window" branch. The head window on an ascending list is the OLDEST 20 rows —
 * so a "recent runs" grid silently filled with the pool's most ancient batches
 * and reported `truncatedBy: null` while doing it. That is the exact defect
 * this PR exists to remove, arriving from the direction the fix did not watch.
 */
function totallessAscendingPool(total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    return { sessions: all.slice(from, from + size) } as unknown as PageBody;
  };
}

/**
 * An ascending pool whose `total` is the LENGTH OF THE PAGE JUST RETURNED —
 * Synapse's documented semantics, and the one shape none of the fixtures above
 * modelled.
 *
 * `ascendingPool`/`descendingPool` both serve a pool-wide `total` (Apache
 * Livy's `sessionManager.size()`); `totallessAscendingPool` omits it entirely.
 * A suite made only of those three is green regardless of which reading the
 * client assumes, so it is not evidence about the thing that actually decides
 * whether "recent runs" shows recent runs.
 *
 * The reading modelled here is the one in the Azure REST spec that GENERATES
 * every Synapse Spark SDK — `specification/synapse/data-plane/
 * Microsoft.Synapse/preview/2019-11-01-preview/sparkJob.json` describes
 * `SparkBatchJobCollection.total` as "Number of sessions fetched." (which is
 * why the JS, Java and .NET reference pages all carry that identical
 * sentence). Under it, a 137-batch pool answers a `from=0&size=20` request with
 * `total: 20` — and the pre-fix client computed
 * `tailFrom = max(0, 20 - 20) = 0`, took its "everything already fits in the
 * head window" shortcut, skipped the direction probe entirely and returned the
 * OLDEST 20 rows with `truncatedBy: null`. Verbatim the defect the function was
 * written to remove.
 */
function pageLengthTotalPool(total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    const sessions = all.slice(from, from + size);
    return { total: sessions.length, sessions };
  };
}

/** {@link pageLengthTotalPool}, served NEWEST-FIRST. */
function pageLengthTotalDescendingPool(total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: total - 1 - i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    const sessions = all.slice(from, from + size);
    return { total: sessions.length, sessions };
  };
}

/**
 * A backend that answers 200 with a body carrying NO `sessions` array at all.
 *
 * `{"total":0,"sessions":[]}` and `{"total":0}` are different facts: the first
 * says the list is exhausted, the second says the server did not answer the
 * question. Collapsing the second into the first is how a broken backend gets
 * to hand back a confident "no batch jobs" / a complete census.
 */
function malformedAfter(goodPages: number, total: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  let served = 0;
  return (url) => {
    const { from, size } = parseFromSize(url);
    if (served++ >= goodPages) return { total: 0 } as unknown as PageBody;
    return { total, sessions: all.slice(from, from + size) };
  };
}

/**
 * A server that returns FEWER rows per page than asked for, while reporting a
 * pool-wide `total` that exceeds them.
 *
 * This is the ONLY shape that reaches `walkRecentBatches`'s `tailFrom === 0`
 * path with a non-null `total`, and none of the fixtures above produce it —
 * which is exactly why the fast path that used to guard it went unnoticed as
 * dead code. `readTotal` returns a number only when `total > headRows.length`,
 * so `tailFrom === 0` (`total <= pageSize`) additionally requires a head page
 * SHORTER than `total`. A normal offset pager never does that; a server that
 * dribbles short pages mid-list does, and this module deliberately refuses to
 * assume such a server cannot exist — that refusal is the whole reason
 * `readTotal` will not trust a short page's `total`.
 */
function shortPagePool(total: number, rowsPerPage: number): Responder {
  const all: BatchRow[] = Array.from({ length: total }, (_, i) => ({ id: i }));
  return (url) => {
    const { from, size } = parseFromSize(url);
    return { total, sessions: all.slice(from, from + Math.min(size, rowsPerPage)) };
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

describe('listSparkBatchJobs — #3568 size/from clamp', () => {
  it('clamps at the boundary: 20 passes through untouched, 21 does not', async () => {
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    responder = ascendingPool(500);
    await listSparkBatchJobs('pool1', 0, 20);
    expect(parseFromSize(requestedUrls[0]).size).toBe(20);

    requestedUrls = [];
    await listSparkBatchJobs('pool1', 0, 21);
    for (const url of requestedUrls) expect(parseFromSize(url).size).toBeLessThanOrEqual(20);
  });

  it('never issues a Livy request with size > 20, for any of the four real call shapes', async () => {
    const { listSparkBatchJobs } = await import('../synapse-dev-client');
    responder = ascendingPool(500);

    for (const size of [100, 25, 20, 9999]) {
      requestedUrls = [];
      await listSparkBatchJobs('pool1', 0, size);
      expect(requestedUrls.length).toBeGreaterThan(0);
      for (const url of requestedUrls) {
        const parsed = parseFromSize(url);
        expect(parsed.size).toBeLessThanOrEqual(20);
        expect(parsed.size).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('sanity-clamps a negative/NaN `from` to a non-negative integer', async () => {
    responder = () => ({ total: 1, sessions: [{ id: 1 }] });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    await listSparkBatchJobs('pool1', -5, 10);
    expect(parseFromSize(requestedUrls[0]).from).toBe(0);

    requestedUrls = [];
    await listSparkBatchJobs('pool1', NaN as unknown as number, 10);
    expect(parseFromSize(requestedUrls[0]).from).toBe(0);
  });

  it('a plain in-cap request confirms the end of the list, then reports a complete walk', async () => {
    responder = ascendingPool(3);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 20);

    // TWO requests, not one, and the second is the price of the `readTotal`
    // fix. The first page answers `total: 3` alongside 3 rows — a value that is
    // identical under BOTH documented readings of `total` (pool-wide, and
    // "number of sessions fetched"), so it cannot be used to conclude the list
    // is finished. The only thing that settles it is asking again and getting
    // nothing back. `size` is still clamped and the walk still reports
    // complete.
    expect(requestedUrls).toHaveLength(2);
    expect(parseFromSize(requestedUrls[0])).toEqual({ from: 0, size: 20 });
    expect(parseFromSize(requestedUrls[1]).from).toBe(3);
    expect(result.sessions.map((s) => s.id)).toEqual([0, 1, 2]);
    expect(result.truncatedBy).toBeNull();
  });

  it('paginates internally to honor a >20 request, walking `from` forward', async () => {
    responder = ascendingPool(45);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 45);

    expect(result.sessions).toHaveLength(45);
    expect(result.sessions.map((s) => s.id)).toEqual(Array.from({ length: 45 }, (_, i) => i));
    expect(requestedUrls.length).toBeGreaterThan(1);
    expect(result.truncatedBy).toBeNull();
  });

  it('bounds the internal walk at 10 pages even when the backend claims a huge total', async () => {
    responder = (url) => {
      const { from, size } = parseFromSize(url);
      return { total: 100_000, sessions: Array.from({ length: size }, (_, i) => ({ id: from + i })) };
    };
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 100_000);

    expect(requestedUrls.length).toBeLessThanOrEqual(10);
    expect(result.sessions.length).toBeLessThanOrEqual(200);
    expect(result.truncatedBy).toBe('pages');
  });
});

describe('the paging budget must actually BOUND the walk, not merely count it', () => {
  it('hands EVERY fetch — including the FIRST — the budget deadline, never the bare 30s default', async () => {
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '5000';
    responder = ascendingPool(200);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    await listSparkBatchJobs('pool1', 0, 100);

    expect(requestedTimeouts.length).toBeGreaterThan(1);
    for (const t of requestedTimeouts) {
      // undefined here would mean the fetch fell back to
      // DEFAULT_SERVER_FETCH_TIMEOUT_MS (30s) and was NOT inside the budget —
      // exactly the hole the first cut of #3568 left.
      expect(t).toBeTypeOf('number');
      expect(t as number).toBeGreaterThan(0);
      expect(t as number).toBeLessThanOrEqual(5000);
    }
  });

  it('a slow backend cuts pagination short on WALL CLOCK, keeping the rows already collected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '1000';
    const pool = ascendingPool(1000);
    // Each page burns 600ms of wall clock: page 1 at t=0, page 2 at t=600,
    // and the claim for page 3 at t=1200 is refused by the 1000ms budget.
    responder = (url, timeoutMs) => {
      vi.setSystemTime(Date.now() + 600);
      return pool(url, timeoutMs) as PageBody;
    };
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 200);

    expect(requestedUrls).toHaveLength(2);
    expect(result.truncatedBy).toBe('time');
    expect(result.sessions).toHaveLength(40); // both pages kept, nothing thrown
  });

  it('a deadline that lands INSIDE the very first fetch truncates instead of throwing', async () => {
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '1000';
    responder = () => 'timeout';
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    // The OLD code awaited the first page outside any budget, so a hung first
    // page could only surface as a 30s stall then a thrown FetchTimeoutError.
    const result = await listSparkBatchJobs('pool1', 0, 20);

    expect(requestedUrls).toHaveLength(1);
    expect(result.sessions).toEqual([]);
    expect(result.truncatedBy).toBe('time');
  });
});

describe('listRecentSparkBatchJobs — "recent" must actually mean recent', () => {
  it('returns the NEWEST batches, not the oldest, from an ascending Livy list', async () => {
    // 200 batches, ids 0..199. `from=0` would hand back ids 0..19 — the pool's
    // oldest — under a grid labelled "Runs". The newest 20 are 180..199.
    responder = ascendingPool(200);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 199 - i),
    );
    expect(result.total).toBe(200);
    expect(result.truncatedBy).toBeNull();
  });

  it('sorts newest-first even when Livy hands back a page in ascending order', async () => {
    responder = ascendingPool(200);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const ids = (await listRecentSparkBatchJobs('pool1', 20)).sessions.map((s) => s.id);

    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('MEASURES which end is newest rather than assuming ascending — a descending backend still yields the newest', async () => {
    // If Synapse's Livy reimplementation ever served newest-first, a fix that
    // hardcoded "walk the tail" would silently return the OLDEST rows. This is
    // the counterfactual that proves it does not.
    responder = descendingPool(200);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 199 - i),
    );
  });

  it('a pool smaller than one page runs the list dry instead of probing a tail', async () => {
    responder = ascendingPool(7);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    // The head page reports `total: 7` next to 7 rows. That is exactly what a
    // page-length `total` looks like too, so it cannot drive `tailFrom`; the
    // walk instead reads on until the list runs dry. Two requests, and neither
    // is a tail probe at a computed offset — the second continues forward from
    // where the first stopped.
    expect(requestedUrls).toHaveLength(2);
    expect(parseFromSize(requestedUrls[0]).from).toBe(0);
    expect(parseFromSize(requestedUrls[1]).from).toBe(7);
    expect(result.sessions.map((s) => s.id)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(result.scanned).toBe(7);
    expect(result.truncatedBy).toBeNull();
  });

  it('never asks Livy for more than 20 rows in one request, whatever limit it is given', async () => {
    responder = ascendingPool(1000);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    await listRecentSparkBatchJobs('pool1', 100);

    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) expect(parseFromSize(url).size).toBeLessThanOrEqual(20);
  });

  it('collects more than one page of the NEWEST rows when asked for more than 20', async () => {
    responder = ascendingPool(1000);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 60);

    expect(result.sessions).toHaveLength(60);
    expect(result.sessions[0].id).toBe(999);
    expect(result.sessions.at(-1)!.id).toBe(940);
  });

  it('the head PROBE page never leaks into the answer — no oldest rows padding a >1-page window', async () => {
    // Direction detection has to read the head window, but on an ascending
    // pool those are the OLDEST rows. An earlier cut merged both probe pages
    // into the accumulator, so asking for 60 rows returned 40 recent ones plus
    // ids 19..0 — the pool's most ancient batches — sitting at the bottom of a
    // grid labelled "Runs". This is the counterfactual that keeps them out.
    responder = ascendingPool(1000);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const ids = (await listRecentSparkBatchJobs('pool1', 60)).sessions.map((s) => s.id);

    expect(Math.min(...ids)).toBe(940);
    expect(ids).not.toContain(0);
    expect(ids).not.toContain(19);
  });

  it('when the budget dies before the direction is known, returns NOTHING + a truncation — never the oldest rows as "recent"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '500';
    const pool = ascendingPool(1000);
    // One page fits; the tail probe's claim does not.
    responder = (url, timeoutMs) => {
      vi.setSystemTime(Date.now() + 600);
      return pool(url, timeoutMs) as PageBody;
    };
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(requestedUrls).toHaveLength(1); // only the head probe got through
    expect(result.sessions).toEqual([]); // the head holds ids 0..19 — the OLDEST
    expect(result.truncatedBy).toBe('time');
    expect(result.total).toBe(1000);
  });

  it('reports truncation instead of silently returning a short window', async () => {
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '1000';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    const pool = ascendingPool(5000);
    responder = (url, timeoutMs) => {
      vi.setSystemTime(Date.now() + 600);
      return pool(url, timeoutMs) as PageBody;
    };
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 200);

    expect(result.truncatedBy).toBe('time');
    expect(result.scanned).toBeLessThan(200);
    expect(result.total).toBe(5000);
  });
});

/**
 * A backend that omits `total` must not be able to talk either walker into
 * claiming a complete window. Learn documents `total` on the batches
 * collection, so a page without it is schema-violating — but "the server broke
 * its contract" is exactly when a client must not assert something it did not
 * establish (`deploy-integrity.md` R7). The consequence here is not a crash, it
 * is the silent OLDEST-window regression #3568 was filed about.
 */
describe('a `total`-less page must never read as a complete window', () => {
  it('does not present the OLDEST rows as "recent" when the backend omits `total`', async () => {
    responder = totallessAscendingPool(1000);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    // The head of an ascending list is ids 0..19 — the pool's most ancient
    // batches. Returning those under a "recent" contract, with truncatedBy
    // null, is the defect. Either we reached genuinely newer rows, or we say
    // the window is incomplete; silently-oldest-and-complete is not allowed.
    const returnedTheOldestWindow =
      result.sessions.length > 0 && Math.max(...result.sessions.map((s) => s.id)) === 19;
    expect(returnedTheOldestWindow && result.truncatedBy == null).toBe(false);
  });

  it('walks a `total`-less pool to the end and returns the genuinely newest rows', async () => {
    responder = totallessAscendingPool(55);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    // 55 rows fit inside the 10-page cap, so the walk can run the list dry —
    // and a walk that ran dry HAS established what the newest rows are.
    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 54 - i),
    );
    expect(result.truncatedBy).toBeNull();
    expect(result.total).toBe(55);
  });

  it('discloses truncation when a `total`-less pool is too big to run dry', async () => {
    responder = totallessAscendingPool(1000);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    // Without `total` there is no way to jump to the far end, so the page cap
    // stops the walk short. That is acceptable — saying so is mandatory.
    expect(result.truncatedBy).not.toBeNull();
  });

  it('listSparkBatchJobs keeps paging for the rows it was asked for without a `total`', async () => {
    responder = totallessAscendingPool(500);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 60);

    // `total` fell back to the first page's length (20), so `nextFrom < total`
    // was false on the very first check and the walk stopped one page in —
    // a 60-row request quietly answered with 20.
    expect(result.sessions).toHaveLength(60);
    expect(result.sessions.map((s) => s.id)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('a `total`-less pool that runs dry inside one page is still complete', async () => {
    responder = totallessAscendingPool(7);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(result.total).toBe(7);
    expect(result.truncatedBy).toBeNull();
  });
});

/**
 * B1 FROM THE PR #3689 REVIEW — `total` may be the PAGE LENGTH, not the pool.
 *
 * The recency algorithm navigates by offset arithmetic on `total`, which is
 * only sound under Apache Livy's reading (`"total" -> sessionManager.size()`).
 * The Azure REST spec that generates every Synapse Spark SDK says the other
 * thing, in one sentence, for the field this client reads:
 *
 *   specification/synapse/data-plane/Microsoft.Synapse/preview/
 *   2019-11-01-preview/sparkJob.json
 *     SparkBatchJobCollection.total -> "Number of sessions fetched."
 *
 * That single swagger is why `@azure/synapse-spark`, the Java
 * `com.azure.analytics.synapse.spark.models` getter and the .NET
 * `Azure.Analytics.Synapse.Spark.Models` property all carry the identical
 * wording — they are generated from it, so the three surfaces are ONE source,
 * not three independent confirmations.
 *
 * Which reading the LIVE service exhibits is NOT settled here and cannot be
 * settled from source: it needs a real request against a pool holding more than
 * 20 batches. These specs make that unnecessary by pinning the behaviour under
 * BOTH readings — every fixture above serves a pool-wide `total` (or none),
 * every fixture below serves a page-length one. Green on both is the point.
 */
describe('a `total` that is really the PAGE LENGTH must not steer the walk', () => {
  it('returns the NEWEST rows from a 137-batch ascending pool whose `total` is always the page length', async () => {
    // THE REPORTED DEFECT, byte for byte. `tailFrom = max(0, 20 - 20) = 0` sent
    // this straight into the "everything already fits" shortcut, which returns
    // the head window — ids 0..19, the pool's OLDEST — under a "recent"
    // contract, with `truncatedBy: null` to silence the doubt.
    responder = pageLengthTotalPool(137);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 136 - i),
    );
    expect(result.scanned).toBe(137);
    expect(result.total).toBe(137);
    expect(result.truncatedBy).toBeNull();
  });

  it('never reports a complete window while holding the oldest rows, at any pool size', async () => {
    // A ratchet across sizes rather than one lucky number: at 21 the pool is
    // one row past a single page, the smallest pool where the two readings of
    // `total` disagree at all.
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    for (const size of [21, 40, 137, 199]) {
      requestedUrls = [];
      responder = pageLengthTotalPool(size);

      const result = await listRecentSparkBatchJobs('pool1', 20);
      const newest = Math.max(...result.sessions.map((s) => s.id));

      // Either we genuinely reached the newest row, or the result says it is
      // incomplete. "Oldest window, reported complete" must not exist.
      expect(newest === size - 1 || result.truncatedBy != null).toBe(true);
      expect(newest === 19 && result.truncatedBy == null).toBe(false);
    }
  });

  it('MEASURES direction even under page-length `total` — a descending backend still yields the newest', async () => {
    responder = pageLengthTotalDescendingPool(137);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 136 - i),
    );
    expect(result.truncatedBy).toBeNull();
  });

  it('collects a >1-page recent window under page-length `total` without padding it with the oldest', async () => {
    responder = pageLengthTotalPool(137);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 60);

    expect(result.sessions).toHaveLength(60);
    expect(result.sessions[0].id).toBe(136);
    expect(Math.min(...result.sessions.map((s) => s.id))).toBe(77);
  });

  it('listSparkBatchJobs answers a 100-row request with 100 rows, not one page of 20', async () => {
    // `listSparkBatchJobs(pool, 0, 100)` exited after a single page because
    // `nextFrom < reportedTotal` was `20 < 20` — false on the very first check —
    // and then reported the 20-row result as a COMPLETE walk.
    responder = pageLengthTotalPool(137);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 100);

    expect(result.sessions).toHaveLength(100);
    expect(result.sessions.map((s) => s.id)).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(result.truncatedBy).toBeNull();
  });

  it('still uses a `total` that CANNOT be a page length — no extra requests on a big pool', async () => {
    // `total: 200` next to a 20-row page is impossible under the page-length
    // reading, so it is unambiguous evidence of a pool-wide count and the
    // offset probe runs exactly as before. The fix must not cost anything here.
    responder = ascendingPool(200);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(requestedUrls).toHaveLength(2); // head probe + tail probe, nothing more
    expect(parseFromSize(requestedUrls[1]).from).toBe(180); // the computed tail
    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => 199 - i),
    );
    expect(result.total).toBe(200);
    expect(result.truncatedBy).toBeNull();
  });
});

/**
 * A 200 whose body carries NO `sessions` array is a BROKEN RESPONSE, and must
 * not be read as an exhausted list.
 *
 * Flagged in the same review: this PR ships `livy-session-census.py`, which
 * refuses that inference in as many words — "cannot distinguish an exhausted
 * list from a broken response" — while the TypeScript walkers in the same PR
 * did the opposite and set `ranDry = true`. Two implementations of one rule,
 * inside one PR, disagreeing on the single case that decides whether a census
 * reads as complete.
 */
describe('a page with no `sessions` array is a broken read, not an empty pool', () => {
  it('listSparkBatchJobs does not report a complete walk after a bodyless page', async () => {
    responder = malformedAfter(0, 137);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 20);

    expect(result.sessions).toEqual([]);
    // `truncatedBy: null` here reads as "this pool has no batch jobs".
    expect(result.truncatedBy).not.toBeNull();
  });

  it('listSparkBatchJobs keeps the rows it did read and still discloses the break', async () => {
    responder = malformedAfter(2, 137);
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 100);

    expect(result.sessions).toHaveLength(40); // two good pages, kept
    expect(result.truncatedBy).not.toBeNull();
  });

  it('listRecentSparkBatchJobs does not present an empty pool when the first body is broken', async () => {
    responder = malformedAfter(0, 137);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions).toEqual([]);
    expect(result.truncatedBy).not.toBeNull();
  });

  it('listRecentSparkBatchJobs marks the window incomplete when the walk hits a broken page', async () => {
    // One good page, then a bodyless one. Under the old rule the broken page
    // set `ranDry` and the 20 OLDEST rows came back as a complete recent
    // window.
    responder = malformedAfter(1, 137);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.truncatedBy).not.toBeNull();
  });

  it('an EMPTY `sessions` array is still a genuinely complete walk', async () => {
    // The counterfactual that keeps the rule from degenerating into "everything
    // is a truncation": `{"total":0,"sessions":[]}` DID answer the question.
    responder = () => ({ total: 0, sessions: [] });
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions).toEqual([]);
    expect(result.truncatedBy).toBeNull();
  });
});

/**
 * `tailFrom === 0` WITH A USABLE `total` — the path a dead fast path used to sit on.
 *
 * Round-2 review measured that `if (tailFrom === 0 && headRows.length >= total)`
 * was UNREACHABLE: `readTotal` returns a number only when
 * `total > pageRows(head).rows.length`, and `headRows` comes from the same call,
 * so the conjunct is a contradiction. A `throw` as the branch's first statement
 * left all 34 specs passing, and so did deleting the conjunct — the branch was
 * dead in one direction and toothless in the other.
 *
 * The path itself is real, and no fixture reached it. These specs do, via a
 * server that returns short pages while claiming more rows exist — the exact
 * behaviour `readTotal` refuses to assume away.
 */
describe('a short head page with a bigger `total` has no tail to probe', () => {
  it('enumerates the whole list instead of probing a tail window identical to the head', async () => {
    // total=15 > headRows=10, and 15 <= pageSize 20, so tailFrom = 0.
    responder = shortPagePool(15, 10);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => 14 - i),
    );
    expect(result.scanned).toBe(15);
    expect(result.truncatedBy).toBeNull();
  });

  it('issues NO duplicate from=0 request — the tail probe would have been byte-identical', async () => {
    responder = shortPagePool(15, 10);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    await listRecentSparkBatchJobs('pool1', 20);

    // The old fall-through fetched from=0 twice: once as the head, once as a
    // "tail probe" at `tailFrom = 0`. A byte-identical page that decides
    // nothing, burning one of only 10 budgeted slots.
    const fromZero = requestedUrls.filter((u) => parseFromSize(u).from === 0);
    expect(fromZero).toHaveLength(1);
    // Forward-only: 0 → 10 → 15, then the empty page that proves the end.
    expect(requestedUrls.map((u) => parseFromSize(u).from)).toEqual([0, 10, 15]);
  });

  it('reports the rows it actually saw, not a `total` the server contradicted', async () => {
    // The server claims 15 but runs dry after 10. Echoing 15 next to 10 rows
    // repeats a number the walk just disproved.
    responder = (url) => {
      const { from } = parseFromSize(url);
      return from === 0
        ? { total: 15, sessions: Array.from({ length: 10 }, (_, i) => ({ id: i })) }
        : { total: 15, sessions: [] };
    };
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.scanned).toBe(10);
    expect(result.total).toBe(10);
    expect(result.sessions.map((s) => s.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 9 - i),
    );
  });

  it('still discloses a ceiling when a short-page server cannot be run dry', async () => {
    // total=15 (> the 1 row the head returns, and <= pageSize) so this is still
    // the tailFrom === 0 path — but 1 row per page cannot reach the end inside
    // the 10-page cap, so the window is incomplete and must say so.
    responder = shortPagePool(15, 1);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(result.truncatedBy).not.toBeNull();
    expect(result.scanned).toBeLessThan(15);
    expect(result.scanned).toBeGreaterThan(0);
  });
});
