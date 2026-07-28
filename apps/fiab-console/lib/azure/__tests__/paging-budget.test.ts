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

describe('PagingBudget', () => {
  it('stops at the page cap and reports the reason', async () => {
    const { PagingBudget } = await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 3, budgetMs: 60_000 });
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
    const { PagingBudget, DEFAULT_MAX_PAGES, DEFAULT_PAGING_BUDGET_MS } =
      await import('@/lib/azure/paging-budget');
    const b = new PagingBudget('t', { maxPages: 0, budgetMs: -1 });
    expect(b.maxPages).toBe(DEFAULT_MAX_PAGES);
    expect(b.budgetMs).toBe(DEFAULT_PAGING_BUDGET_MS);
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

describe('foundry-client listConnections — #2557 memo', () => {
  it('serves repeat callers from the memo (zero extra ARM calls)', async () => {
    const calls = stubEndlessPager();
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
    const calls = stubEndlessPager();
    const { listConnections, invalidateFoundryConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    invalidateFoundryConnections();
    await listConnections();

    expect(calls.length).toBeGreaterThan(after1);
  });

  it('force:true bypasses the memo (the ?refresh=1 escape hatch)', async () => {
    const calls = stubEndlessPager();
    const { listConnections } = await import('@/lib/azure/foundry-client');

    await listConnections();
    const after1 = calls.length;
    await listConnections({ force: true });

    expect(calls.length).toBeGreaterThan(after1);
  });
});
