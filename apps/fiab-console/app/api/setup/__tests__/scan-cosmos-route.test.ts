/**
 * BFF contract tests for GET /api/setup/scan-cosmos — the paging bound (#2557)
 * and, specifically, the regression the adversarial review caught in the first
 * cut of that fix.
 *
 * `armGetAll` deliberately swallows a `!r.ok` page ("A single sub the identity
 * can't read shouldn't fail the whole scan"). When the walk started handing its
 * remaining wall clock to `fetchWithTimeout`, a slow subscription began
 * THROWING FetchTimeoutError instead — straight past that swallow and into the
 * outer catch, 502-ing the entire scan. Exactly the failure mode the code being
 * edited said it did not want.
 *
 * Locked here:
 *   - a slow subscription degrades the scan, it does not 502 it;
 *   - the fan-out shares ONE budget across 1 + N subscriptions, so N subs
 *     cannot multiply the ceiling;
 *   - a genuinely unreadable sub is still skipped;
 *   - the happy path still enumerates every account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const getSessionMock = vi.fn(
  () => ({ claims: { oid: 'oid-test', upn: 'u@t.com' }, exp: Date.now() / 1000 + 3600 }) as any,
);
vi.mock('@/lib/auth/session', () => ({
  getSession: () => getSessionMock(),
  tenantScopeId: (s: any) => s?.claims?.tid ?? s?.claims?.oid,
}));

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
  getSessionMock.mockReturnValue({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SUB_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SUB_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function account(sub: string, name: string) {
  return {
    id: `/subscriptions/${sub}/resourceGroups/rg1/providers/Microsoft.DocumentDB/databaseAccounts/${name}`,
    name,
    location: 'eastus',
    properties: { capacityMode: 'Serverless' },
  };
}

/**
 * ARM stand-in. `hangFor` names a subscription whose databaseAccounts list
 * never responds until the caller aborts — a slow (not unreadable) sub.
 */
function stubArm(opts: { hangFor?: string; failFor?: string } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.push(u);
      if (u.includes('/subscriptions?api-version')) {
        return Promise.resolve(
          json({ value: [{ subscriptionId: SUB_A, state: 'Enabled' }, { subscriptionId: SUB_B, state: 'Enabled' }] }),
        );
      }
      if (opts.failFor && u.includes(`/subscriptions/${opts.failFor}/`)) {
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      if (opts.hangFor && u.includes(`/subscriptions/${opts.hangFor}/`)) {
        return new Promise<Response>((_res, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const onAbort = () => {
            const err: any = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      const sub = /\/subscriptions\/([^/]+)\//.exec(u)?.[1] ?? SUB_A;
      return Promise.resolve(json({ value: [account(sub, `cosmos-${sub.slice(0, 4)}`)] }));
    }),
  );
  return calls;
}

describe('GET /api/setup/scan-cosmos', () => {
  it('401s without a session', async () => {
    getSessionMock.mockReturnValue(null as any);
    const { GET } = await import('@/app/api/setup/scan-cosmos/route');
    const res = await (GET as any)(new Request('https://x/api/setup/scan-cosmos'), {});
    expect(res.status).toBe(401);
  });

  it('enumerates Cosmos accounts across every enabled subscription', async () => {
    stubArm();
    const { GET } = await import('@/app/api/setup/scan-cosmos/route');
    const res = await (GET as any)(new Request('https://x/api/setup/scan-cosmos'), {});
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.existing).toHaveLength(2);
    expect(j.existing.every((e: any) => e.serverless)).toBe(true);
  });

  it('does NOT 502 the whole scan when ONE subscription is slow', async () => {
    // A tight aggregate budget so the hanging sub trips it deterministically.
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '120';
    stubArm({ hangFor: SUB_B });
    const { GET } = await import('@/app/api/setup/scan-cosmos/route');

    const res = await (GET as any)(new Request('https://x/api/setup/scan-cosmos'), {});
    const j = await res.json();

    // Before the truncate-not-throw fix this was `502 ARM request failed`.
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    // Sub A's account still made it into the answer.
    expect(j.existing.map((e: any) => e.subscriptionId)).toContain(SUB_A);
  });

  it('still skips a subscription the identity cannot read', async () => {
    stubArm({ failFor: SUB_B });
    const { GET } = await import('@/app/api/setup/scan-cosmos/route');
    const res = await (GET as any)(new Request('https://x/api/setup/scan-cosmos'), {});
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.existing.map((e: any) => e.subscriptionId)).toEqual([SUB_A]);
  });

  it('shares ONE wall clock across the whole fan-out', async () => {
    // Budget smaller than the sub list + 2 per-sub walks: the aggregate ceiling
    // must stop the fan-out rather than resetting per subscription.
    process.env.LOOM_ARM_PAGING_BUDGET_MS = '100';
    const calls = stubArm({ hangFor: SUB_A });
    const { GET } = await import('@/app/api/setup/scan-cosmos/route');

    const started = Date.now();
    const res = await (GET as any)(new Request('https://x/api/setup/scan-cosmos'), {});
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    // 1 sub-list call + the hanging SUB_A call; SUB_B is never even attempted
    // because the shared budget is already spent.
    expect(calls.length).toBe(2);
    expect(elapsed).toBeLessThan(5_000);
  });
});
