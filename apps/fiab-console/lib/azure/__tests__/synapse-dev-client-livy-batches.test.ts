/**
 * Regression tests for issue #3568 — `listSparkBatchJobs` (synapse-dev-client.ts)
 * forwarded `size` straight through to the Synapse Livy batches list endpoint,
 * which 400s above its documented per-request maximum of 20. Two callers
 * hardcoded an over-cap literal (100, 25 — materialized-lake-view runs route,
 * sparkjobdefinitions run route) and two forwarded an unvalidated
 * caller/query-string value (spark-job-definition + synapse-spark-pool runs
 * routes), so patching only the reported call site would have left three
 * other ways to reproduce the 400.
 *
 * The fix clamps `size` (and sanity-clamps `from`) INSIDE the client so every
 * caller inherits it, and — since two call sites clearly wanted MANY rows
 * (100, 25), not just one clamped page — paginates internally (bounded at 10
 * pages / 200 rows) to honor that intent instead of silently truncating to
 * the first 20.
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

/** Every URL the client actually requested, captured via the real `fetchWithTimeout` chokepoint. */
let requestedUrls: string[] = [];
let responder: (url: string) => { total: number; sessions: Array<{ id: number }> } = () => ({ total: 0, sessions: [] });

vi.mock('@/lib/azure/fetch-with-timeout', () => ({
  fetchWithTimeout: async (input: string) => {
    requestedUrls.push(input);
    const body = responder(input);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

/** Parse the `from`/`size` query params the client put on a captured URL. */
function parseFromSize(url: string): { from: number; size: number } {
  const u = new URL(url);
  return { from: Number(u.searchParams.get('from')), size: Number(u.searchParams.get('size')) };
}

beforeEach(() => {
  requestedUrls = [];
  process.env.LOOM_SYNAPSE_WORKSPACE = 'ws1';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.LOOM_SYNAPSE_WORKSPACE;
  delete process.env.LOOM_ARM_PAGING_MAX_PAGES;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});

describe('listSparkBatchJobs — #3568 size/from clamp', () => {
  it('never issues a Livy request with size > 20, even when asked for 100 (the hardcoded materialized-lake-view call)', async () => {
    responder = () => ({
      total: 100,
      sessions: Array.from({ length: 20 }, (_, i) => ({ id: i })),
    });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    await listSparkBatchJobs('pool1', 0, 100);

    expect(requestedUrls.length).toBeGreaterThan(0);
    for (const url of requestedUrls) {
      const { size } = parseFromSize(url);
      expect(size).toBeLessThanOrEqual(20);
      expect(size).toBeGreaterThanOrEqual(1);
    }
  });

  it('never issues a Livy request with size > 20 for the hardcoded 25 (sparkjobdefinitions run route)', async () => {
    responder = () => ({ total: 25, sessions: Array.from({ length: 20 }, (_, i) => ({ id: i })) });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    await listSparkBatchJobs('pool1', 0, 25);

    for (const url of requestedUrls) {
      expect(parseFromSize(url).size).toBeLessThanOrEqual(20);
    }
  });

  it('clamps an unvalidated caller-supplied size (spark-job-definition / synapse-spark-pool runs routes)', async () => {
    responder = () => ({ total: 500, sessions: Array.from({ length: 20 }, (_, i) => ({ id: i })) });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    // A query-string value forwarded with no validation, e.g. ?size=9999.
    await listSparkBatchJobs('pool1', 0, 9999);

    for (const url of requestedUrls) {
      expect(parseFromSize(url).size).toBeLessThanOrEqual(20);
    }
  });

  it('sanity-clamps a negative/NaN `from` to a non-negative integer', async () => {
    responder = () => ({ total: 1, sessions: [{ id: 1 }] });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    await listSparkBatchJobs('pool1', -5, 10);
    expect(parseFromSize(requestedUrls[0]).from).toBe(0);

    requestedUrls = [];
    await listSparkBatchJobs('pool1', NaN as any, 10);
    expect(parseFromSize(requestedUrls[0]).from).toBe(0);
  });

  it('a plain in-cap request (size=20, the synapse-spark-pool editor default) makes exactly ONE request, unchanged', async () => {
    responder = () => ({ total: 3, sessions: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 20);

    expect(requestedUrls).toHaveLength(1);
    expect(parseFromSize(requestedUrls[0])).toEqual({ from: 0, size: 20 });
    expect(result.sessions).toHaveLength(3);
    expect(result.truncatedBy).toBeNull();
  });

  it('paginates internally to honor a >20 request, walking `from` forward across bounded pages', async () => {
    // 45 total rows on the pool; requester wants 45 (>20), so the client must
    // walk multiple <=20-row pages rather than truncate to the first 20.
    const ALL = Array.from({ length: 45 }, (_, i) => ({ id: i }));
    responder = (url) => {
      const { from, size } = parseFromSize(url);
      return { total: ALL.length, sessions: ALL.slice(from, from + size) };
    };
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 45);

    expect(result.sessions).toHaveLength(45);
    expect(result.sessions.map((s: any) => s.id)).toEqual(ALL.map((s) => s.id));
    expect(requestedUrls.length).toBeGreaterThan(1); // more than one page was fetched
    expect(result.truncatedBy).toBeNull(); // walk finished before the budget tripped
  });

  it('bounds the internal walk at 10 pages (<=200 rows) even when the backend reports a much larger total', async () => {
    responder = (url) => {
      const { from, size } = parseFromSize(url);
      // An endless supply of rows — total is reported far larger than any
      // sane page cap, so an unbounded walk would keep paging forever.
      return {
        total: 100_000,
        sessions: Array.from({ length: size }, (_, i) => ({ id: from + i })),
      };
    };
    const { listSparkBatchJobs } = await import('../synapse-dev-client');

    const result = await listSparkBatchJobs('pool1', 0, 100_000);

    // 10 pages x 20 rows/page = 200 rows max, documented in the client.
    expect(requestedUrls.length).toBeLessThanOrEqual(10);
    expect(result.sessions.length).toBeLessThanOrEqual(200);
    expect(result.truncatedBy).toBe('pages');
  });
});
