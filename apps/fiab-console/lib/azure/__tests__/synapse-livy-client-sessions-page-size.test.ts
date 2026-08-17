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
    expect(requestedUrls).toHaveLength(1);
  });
});
