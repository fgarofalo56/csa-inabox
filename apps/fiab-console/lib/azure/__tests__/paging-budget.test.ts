/**
 * Regression tests for the bounded ARM pager (issue #2557).
 *
 * The defect: `pagedList('/connections')` in foundry-client was a bare
 * `while (nextLink)` walk. Each page inherited fetchWithTimeout's 30s ceiling
 * but the LOOP had none, so on the AOAI target-resolution path
 * (`resolveAoaiTarget` -> `listConnections` -> here) one cold walk measured
 * 22.9s inside a route whose own `maxDuration` is 60 — an unbounded await on a
 * request path, the exact thing fetch-with-timeout.ts's invariant forbids.
 *
 * What is locked here:
 *   1. PagingBudget arithmetic — page cap, wall clock, remainingMs floor,
 *      truncation reporting.
 *   2. A pager that would page FOREVER terminates on the page cap instead of
 *      hanging (the structural fix, exercised through the real listConnections).
 *   3. A pager whose pages are SLOW terminates on the wall clock — the case a
 *      page cap alone would never catch.
 *   4. The connections memo keeps repeat callers off ARM entirely, does not
 *      cache failures, and is dropped by invalidateFoundryConnections().
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

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS;
  delete process.env.LOOM_FOUNDRY_CONNECTIONS_TTL_MS;
  delete process.env.LOOM_ARM_PAGING_MAX_PAGES;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});

/**
 * An ARM stand-in that ALWAYS hands back another `nextLink` — i.e. a pager that
 * would run forever if the loop were unbounded. `delayMs` simulates a slow page.
 */
function stubEndlessPager(opts: { delayMs?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(u);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const n = calls.length;
      return new Response(
        JSON.stringify({
          value: [{ id: `/c/${n}`, name: `conn-${n}`, properties: { category: 'AzureOpenAI', target: 'https://aoai' } }],
          nextLink: `https://arm.example.com/next?page=${n + 1}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

/**
 * A pager whose pages HANG until the caller's AbortSignal fires — i.e. the real
 * shape of a slow tenant. `stubEndlessPager` above cannot exercise this: its
 * pages always resolve, so `fetchWithTimeout`'s abort branch is unreachable and
 * the walk can only ever breach at the `claimPage()` loop top.
 *
 * `fastFirst` makes page 1 return instantly so the breach lands on page 2 —
 * that is the case where "the caller keeps the rows already collected" has to
 * be proved rather than asserted.
 */
function stubHangingPager(opts: { fastFirst?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(u);
      const n = calls.length;
      const body = JSON.stringify({
        value: [{ id: `/c/${n}`, name: `conn-${n}`, properties: { category: 'AzureOpenAI', target: 'https://aoai' } }],
        nextLink: `https://arm.example.com/next?page=${n + 1}`,
      });
      if (opts.fastFirst && n === 1) {
        return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      // Hang until aborted — reject the way a real fetch does on abort.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // never settles; the budget must still bound us
        const onAbort = () => {
          const err: any = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }),
  );
  return calls;
}

/**
 * A pager that ENDS — one page, no `nextLink`, so the walk is COMPLETE. Only a
 * complete walk is memoized, so every "the memo works" assertion has to be made
 * over this stub rather than `stubEndlessPager` (which page-cap-truncates and
 * is therefore deliberately un-memoizable).
 */
function stubFinitePager() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      calls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
      return new Response(
        JSON.stringify({
          value: [{ id: '/c/1', name: 'conn-1', properties: { category: 'AzureOpenAI', target: 'https://aoai' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return calls;
}

describe('PagingBudget', () => {
  it('stops at the page cap and reports the reason', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');    const b = new PagingBudget('t', { maxPages: 3, budgetMs: 60_000 });
    expect([b.claimPage(), b.claimPage(), b.claimPage()]).toEqual([true, true, true]);
    expect(b.claimPage()).toBe(false);
    expect(b.truncatedBy).toBe('pages');
    expect(b.pagesFetched).toBe(3);
  });

  it('stops on the wall clock and reports the reason', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 1000, budgetMs: 10 });
    expect(b.claimPage()).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(b.claimPage()).toBe(false);
    expect(b.truncatedBy).toBe('time');
  });

  it('never hands a 0/negative deadline to fetchWithTimeout', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { budgetMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(b.remainingMs()).toBeGreaterThan(0);
  });

  it('reports no truncation when the walk finishes inside both ceilings', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 5, budgetMs: 60_000 });
    b.claimPage();
    expect(b.truncatedBy).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    b.warnIfTruncated(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the module defaults for absent/invalid options', async () => {
    const { PagingBudget, defaultMaxPages, defaultPagingBudgetMs } =
      await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 0, budgetMs: -1 });
    expect(b.maxPages).toBe(defaultMaxPages());
    expect(b.budgetMs).toBe(defaultPagingBudgetMs());
  });

  it('reads its knobs per walk, so raising one needs no container restart', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    expect(new PagingBudget('t').maxPages).toBe(50);
    // Same module instance — the knob is re-read when the NEXT budget is built.
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '7';
    expect(new PagingBudget('t').maxPages).toBe(7);
  });

  it('absorbs ITS OWN deadline as a time truncation instead of throwing', async () => {
    const { PagingBudget, PAGE_DEADLINE } = await import('@/lib/azure/paging-budget');
    const { FetchTimeoutError } = await import('@/lib/azure/fetch-with-timeout');
    const b = new PagingBudget('t', { budgetMs: 1_000 });
    b.claimPage();
    const r = await b.runPage(async (ms) => {
      throw new FetchTimeoutError('https://arm/x', ms);
    });
    expect(r).toBe(PAGE_DEADLINE);
    expect(b.truncatedBy).toBe('time');
  });

  it('does NOT absorb a timeout from some other, larger ceiling', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const { FetchTimeoutError } = await import('@/lib/azure/fetch-with-timeout');
    const b = new PagingBudget('t', { budgetMs: 1_000 });
    b.claimPage();
    // 30s = the shared per-request default: a real transport failure, not ours.
    await expect(
      b.runPage(async () => { throw new FetchTimeoutError('https://arm/x', 30_000); }),
    ).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(b.truncatedBy).toBeNull();
  });

  it('propagates a non-timeout error untouched', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { budgetMs: 1_000 });
    b.claimPage();
    await expect(b.runPage(async () => { throw new Error('ECONNRESET'); })).rejects.toThrow('ECONNRESET');
    expect(b.truncatedBy).toBeNull();
  });

  it('assertComplete throws a DEADLINE error that never blames a missing resource', async () => {
    const { PagingBudget, PagingDeadlineError } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('foundry /connections', { maxPages: 1, budgetMs: 60_000 });
    b.claimPage();
    expect(b.claimPage()).toBe(false);
    try {
      b.assertComplete(3);
      throw new Error('assertComplete did not throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PagingDeadlineError);
      expect(e.message).toContain('PAGING DEADLINE');
      expect(e.message).toContain('does NOT mean the resource is missing');
      expect(e.message).toContain('LOOM_ARM_PAGING_MAX_PAGES');
    }
  });

  it('assertComplete is a no-op on a complete walk', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 5, budgetMs: 60_000 });
    b.claimPage();
    expect(() => b.assertComplete(1)).not.toThrow();
  });
});

describe('foundry-client pagedList — #2557 bound', () => {
  it('an endless pager terminates on the page cap instead of hanging', async () => {
    const calls = stubEndlessPager();
    const { listConnections } = await import('@/lib/azure/foundry-client');

    const rows = await listConnections();

    // /connections is budgeted at 10 pages; without the bound this would never
    // return (the stub always supplies another nextLink).
    expect(calls.length).toBe(10);
    expect(rows).toHaveLength(10);
    expect(rows[0].category).toBe('AzureOpenAI');
  });

  it('a slow pager terminates on the wall clock (the case a page cap misses)', async () => {
    // 25ms budget, ~15ms per page -> the wall clock trips well before 10 pages.
    process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '25';
    const calls = stubEndlessPager({ delayMs: 15 });
    const { listConnections } = await import('@/lib/azure/foundry-client');

    const started = Date.now();
    const rows = await listConnections();
    const elapsed = Date.now() - started;

    expect(calls.length).toBeLessThan(10); // stopped by TIME, not by the page cap
    expect(rows.length).toBe(calls.length);
    // Generous ceiling for CI jitter — the point is it returns, bounded.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('caps the whole walk even when every page is instant and infinite', async () => {
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '4';
    stubEndlessPager();
    const { listModels } = await import('@/lib/azure/foundry-client');
    // listModels uses the SHARED default budget (no per-call override), so the
    // env cap proves the shared helper — not just /connections — is bounded.
    const models = await listModels();
    expect(models).toHaveLength(4);
  });
});

/**
 * The case the first cut of #2557 got WRONG: the wall clock is handed to
 * `fetchWithTimeout` as each page's `timeoutMs`, so on a genuinely slow tenant
 * the breach happens INSIDE a page fetch — `fetchWithTimeout` throws
 * FetchTimeoutError. If that propagates, the documented truncation policy is a
 * lie AND `resolveAoaiTarget` converts it into "deploy a gpt-4o model first".
 */
describe('foundry-client pagedList — a deadline INSIDE a fetch truncates, never throws', () => {
  it('returns the rows already collected when page 2 blows the wall clock', async () => {
    process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '80';
    const calls = stubHangingPager({ fastFirst: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { listConnections } = await import('@/lib/azure/foundry-client');

    const rows = await listConnections(); // must RESOLVE, not reject

    expect(calls.length).toBe(2);
    expect(rows).toHaveLength(1); // page 1's row survived the page-2 deadline
    expect(rows[0].name).toBe('conn-1');
    // …and the operator got the one warn line naming the knob.
    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('[paging-budget]'));
    expect(line).toBeTruthy();
    expect(line).toContain('stopped by time budget');
    expect(line).toContain('LOOM_ARM_PAGING_BUDGET_MS');
  });

  it('returns an empty list (not a rejection) when the FIRST page blows it', async () => {
    process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '60';
    stubHangingPager();
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await expect(listConnections()).resolves.toEqual([]);
  });

  it('requireComplete turns that same breach into a DEADLINE, not "no such connection"', async () => {
    process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '60';
    stubHangingPager({ fastFirst: true });
    const { listConnections } = await import('@/lib/azure/foundry-client');
    const { PagingDeadlineError } = await import('@/lib/azure/paging-budget');

    await expect(listConnections({ requireComplete: true })).rejects.toBeInstanceOf(PagingDeadlineError);
  });

  it('never memoizes a TIME-truncated list — the next caller re-walks ARM', async () => {
    process.env.LOOM_FOUNDRY_CONNECTIONS_BUDGET_MS = '60';
    const calls = stubHangingPager({ fastFirst: true });
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    await listConnections();

    // A list truncated because ARM was slow must NOT stick for the 5-min TTL —
    // that would keep the surface wrong long after ARM recovered.
    expect(calls.length).toBeGreaterThan(after1);
  });

  /**
   * Cross-consumer memo POISONING (#2557 re-review). The `/connections` memo is
   * shared by consumers that want different things — Copilot AOAI discovery,
   * `GET /api/foundry/connections`, `resolveContentSafetyEndpoint`. Keeping a
   * PAGE-cap-truncated walk for the full 5-minute TTL (on the reasoning that a
   * page cap is "deterministic") hands one caller's partial list to every other
   * caller, none of whom asked for a partial list or can tell they got one.
   * The rule is flat: truncated ⇒ not memoized.
   */
  it('never memoizes a PAGE-CAP-truncated list either — no cross-consumer poisoning', async () => {
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '2'; // page-cap the walk, keep it fast
    const calls = stubEndlessPager(); // always another nextLink -> 'pages' truncation
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    // A DIFFERENT consumer, one that never asked about completeness, reads next.
    const rows = await listConnections();

    expect(calls.length).toBeGreaterThan(after1); // it re-walked; it was not served the memo
    expect(rows.length).toBeGreaterThan(0); // …and it still got the rows in hand
  });

  it('a truncated walk still reports its truncation to the caller that paid for it', async () => {
    process.env.LOOM_ARM_PAGING_MAX_PAGES = '2';
    stubEndlessPager();
    const { listConnections } = await import('@/lib/azure/foundry-client');

    const seen: string[] = [];
    await listConnections({ onTruncated: (t) => seen.push(t) });

    expect(seen).toEqual(['pages']);
  });
});

describe('foundry-client listConnections — #2557 memo', () => {
  it('serves repeat callers from the memo (zero extra ARM calls)', async () => {
    const calls = stubFinitePager(); // a COMPLETE walk — the only kind that memoizes
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    await listConnections();
    await listConnections();

    expect(calls.length).toBe(after1); // the hot path never re-walked ARM
  });

  it('de-dupes concurrent callers onto ONE in-flight walk', async () => {
    const calls = stubEndlessPager({ delayMs: 5 });
    const { listConnections } = await import('@/lib/azure/foundry-client');

    const [a, b] = await Promise.all([listConnections(), listConnections()]);

    expect(a).toEqual(b);
    expect(calls.length).toBe(10); // one 10-page walk, not two
  });

  it('does not cache a failure — a transient ARM error must not gate Copilot', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ value: [{ id: '/c/1', name: 'ok', properties: {} }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await expect(listConnections()).rejects.toBeTruthy();
    const rows = await listConnections();
    expect(rows.map((r) => r.name)).toEqual(['ok']);
  });

  it('invalidateFoundryConnections() drops the memo so a write is visible next read', async () => {
    const calls = stubFinitePager(); // COMPLETE, so the memo would otherwise hold
    const { listConnections, invalidateFoundryConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    invalidateFoundryConnections();
    await listConnections();

    expect(calls.length).toBeGreaterThan(after1);
  });

  it('force:true bypasses the memo (the ?refresh=1 escape hatch)', async () => {
    const calls = stubFinitePager(); // COMPLETE, so only `force` can cause a re-walk
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    await listConnections({ force: true });

    expect(calls.length).toBeGreaterThan(after1);
  });
});
