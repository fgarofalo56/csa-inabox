/**
 * BFF contract tests for GET /api/azure/connectables — the cross-subscription
 * "Add existing Azure resource" browser.
 *
 * The regression locked here is #2582's second rule: **a truncation must never
 * surface as a wrong cause.** This route's only empty-handed answer used to be
 * `code:'no_access'`, whose message tells the operator to admin-consent an app
 * registration and grant the UAMI Reader at the tenant root. A slow ARM that
 * ran out of wall clock mid-enumeration produced exactly that message — the
 * route's own comment records the live incident ("at the old 25s the server
 * aborted the fallback mid-enumeration and returned a premature 'no access'
 * gate"), which was band-aided by raising the timeout rather than by telling
 * the two states apart.
 *
 * Now the walk is a `PagingBudget`: a deadline TRUNCATES, the truncation is
 * carried out of `runArg` / `runArmList`, and an empty-but-truncated result
 * answers `code:'paging_timeout'` naming the deadline and the knob.
 *
 * Both hanging stubs settle ONLY on `AbortSignal` — a stub that ignores the
 * signal cannot reach the mid-fetch branch at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  getSession: () => ({ claims: { oid: 'oid-test' }, exp: Date.now() / 1000 + 3600 }),
}));
vi.mock('@/lib/azure/user-token-store', () => ({ getUserArmToken: async () => 'user-tk' }));
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

const SUB = '00000000-0000-0000-0000-000000000000';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.LOOM_SUBSCRIPTION_ID = SUB;
  // Tight enough that the very first hanging round-trip spends the walk.
  process.env.LOOM_ARM_PAGING_BUDGET_MS = '60';
  process.env.LOOM_CONNECTABLES_ARG_BUDGET_MS = '60';
  process.env.LOOM_CONNECTABLES_ARM_BUDGET_MS = '60';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.LOOM_SUBSCRIPTION_ID;
  delete process.env.LOOM_ARM_PAGING_BUDGET_MS;
  delete process.env.LOOM_CONNECTABLES_ARG_BUDGET_MS;
  delete process.env.LOOM_CONNECTABLES_ARM_BUDGET_MS;
});

/** A response that settles ONLY when its AbortSignal fires. */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no deadline threaded => never settles => the test times out
    const onAbort = () => {
      const err: any = new Error('The operation was aborted.');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

const jsonRes = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('GET /api/azure/connectables — a paging deadline is not a permission problem (#2582)', () => {
  it('an ARM that hangs on every call answers paging_timeout, NOT no_access', async () => {
    // Everything hangs: ARG (user), ARG (uami), then the ARM-list fallback.
    vi.stubGlobal('fetch', vi.fn((_url: any, init?: RequestInit) => hangUntilAborted(init)));
    const { GET } = await import('@/app/api/azure/connectables/route');

    const res = await GET(); // must RESOLVE, not hang or reject
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.code).toBe('paging_timeout');
    expect(body.error).toMatch(/PAGING DEADLINE/);
    expect(body.error).toMatch(/LOOM_CONNECTABLES_AR[GM]_BUDGET_MS/);
    // The wrong-cause remediation must be nowhere near this answer.
    expect(body.code).not.toBe('no_access');
    expect(body.error).not.toMatch(/Reader/);
    expect(body.error).not.toMatch(/admin-consent/i);
  });

  it('rows already collected by a truncated walk are returned, flagged truncated', async () => {
    // ARG page 1 answers with a resource AND a $skipToken; page 2 hangs.
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any, init?: RequestInit) => {
        calls.push(String(url));
        if (calls.length === 1) {
          return Promise.resolve(jsonRes({
            data: [{
              id: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/st1`,
              name: 'st1',
              type: 'microsoft.storage/storageaccounts',
              subscriptionId: SUB,
              resourceGroup: 'rg',
              host: '',
            }],
            $skipToken: 'more',
          }));
        }
        return hangUntilAborted(init);
      }),
    );
    const { GET } = await import('@/app/api/azure/connectables/route');

    const res = await GET();
    const body = await res.json();

    // Found-in-a-truncated-list is a perfectly good answer — return it.
    expect(body.ok).toBe(true);
    expect(body.resources.map((r: any) => r.name)).toContain('st1');
    // ...but say so, so a caller that needs completeness can tell.
    expect(body.truncated).toBe('time');
    // And the deadline was reached INSIDE a fetch, not at a loop top.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a genuinely empty estate still gets the honest no_access gate', async () => {
    // Every call answers, nothing anywhere — a real "you cannot see anything".
    vi.stubGlobal(
      'fetch',
      vi.fn((url: any) =>
        Promise.resolve(String(url).includes('ResourceGraph')
          ? jsonRes({ data: [] })
          : jsonRes({ value: [] })),
      ),
    );
    const { GET } = await import('@/app/api/azure/connectables/route');

    const res = await GET();
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.code).toBe('no_access');
  });
});
