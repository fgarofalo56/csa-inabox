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

  it('a plain in-cap request makes exactly ONE request and reports a complete walk', async () => {
    responder = () => ({ total: 3, sessions: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 20);

    expect(requestedUrls).toHaveLength(1);
    expect(parseFromSize(requestedUrls[0])).toEqual({ from: 0, size: 20 });
    expect(result.sessions).toHaveLength(3);
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

  it('a pool smaller than one page costs exactly ONE request and no tail probe', async () => {
    responder = ascendingPool(7);
    const { listRecentSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listRecentSparkBatchJobs('pool1', 20);

    expect(requestedUrls).toHaveLength(1);
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
