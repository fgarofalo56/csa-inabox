/**
 * Advisory GHSA-4gvx-9p49-p43g — a bearer credential must not travel to an
 * address a RESPONSE BODY chose.
 *
 * Every client below resolved its request target as
 * `path.startsWith('http') ? path : BASE + path` and then attached a token,
 * where `path` can be a `nextLink` / `@odata.nextLink` read verbatim out of the
 * previous page. These tests drive the REAL clients over a stubbed `fetch` and
 * assert on the HOSTS actually contacted — a `not.toContain('attacker.example')`
 * over a recorded host list, which is the only assertion that discriminates.
 *
 * WHY BY HOST AND NOT BY RETURN VALUE. A refusal and a clean finish both yield
 * an empty list, so `resolves.toEqual([])` passes with and without the fix. The
 * stub therefore also THROWS if the off-origin host is ever reached, so a
 * regression cannot be absorbed into a caller's catch and read as "no rows".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return {
    DefaultAzureCredential: Cred,
    ManagedIdentityCredential: Cred,
    ChainedTokenCredential: Cred,
  };
});

const ARM = 'https://management.azure.com';
const EVIL = 'https://attacker.example/x?api-version=2024-10-01&$skiptoken=evil';

/** Records every host contacted; explodes if the off-origin one is reached. */
function recordingFetch(page: (url: string) => unknown) {
  const hosts: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    // By HOST, not by substring: an encoded id can put 'attacker.example' in
    // the PATH of a perfectly legitimate same-origin request, and a substring
    // check would report a leak that did not happen.
    const host = new URL(u).host;
    hosts.push(host);
    if (host === 'attacker.example') {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      throw new Error(`credential forwarded off-origin (authorization present: ${Boolean(auth)})`);
    }
    return new Response(JSON.stringify(page(u)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn, hosts };
}

beforeEach(() => {
  process.env.LOOM_SUBSCRIPTION_ID = 'sub-1';
  process.env.LOOM_FOUNDRY_RG = 'rg-foundry';
  process.env.LOOM_FOUNDRY_NAME = 'hub';
  process.env.LOOM_IDENTITY_PICKER_ENABLED = 'true';
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

// ---------------------------------------------------------------------------
// Confirmed reachable in the advisory — walkFoundryPages
// ---------------------------------------------------------------------------

describe('foundry-client walkFoundryPages', () => {
  it('does NOT follow a nextLink to a host ARM did not serve', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [], nextLink: EVIL }));
    vi.stubGlobal('fetch', fn);
    const { listModels } = await import('../foundry-client');
    await expect(listModels()).resolves.toEqual([]);
    expect(hosts).not.toContain('attacker.example');
    expect(hosts.every((h) => h === 'management.azure.com')).toBe(true);
  });

  it('a same-origin nextLink is still followed — paging is not broken by the fix', async () => {
    let page = 0;
    const { fn, hosts } = recordingFetch(() => {
      page += 1;
      return page === 1
        ? { value: [{ name: 'm1' }], nextLink: `${ARM}/page2?api-version=2024-10-01` }
        : { value: [{ name: 'm2' }] };
    });
    vi.stubGlobal('fetch', fn);
    const { listModels } = await import('../foundry-client');
    const rows = await listModels();
    expect(rows.map((r: { name: string }) => r.name)).toEqual(['m1', 'm2']);
    expect(hosts).toEqual(['management.azure.com', 'management.azure.com']);
  });

  it('treats a malformed nextLink as the end of the walk, not something to guess at', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [], nextLink: 'not-a-url' }));
    vi.stubGlobal('fetch', fn);
    const { listModels } = await import('../foundry-client');
    // Without the guard this became `fetch('not-a-url')` — a raw TypeError out
    // of the route rather than an honest end-of-walk.
    await expect(listModels()).resolves.toEqual([]);
    expect(hosts).toEqual(['management.azure.com']);
  });
});

// ---------------------------------------------------------------------------
// Confirmed reachable in the advisory — monitor-arm's five verbs
// ---------------------------------------------------------------------------

describe('monitor-arm — every verb pins the target to ARM', () => {
  it('armGet refuses an absolute non-ARM path (the nextLink monitor-client feeds it)', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [] }));
    vi.stubGlobal('fetch', fn);
    const m = await import('../monitor-arm');
    await expect(m.armGet('https://attacker.example/x?api-version=2024-01-01')).rejects.toThrow(
      /Refusing to send the ARM token/,
    );
    expect(hosts).toEqual([]); // nothing was fetched at all
  });

  it('the WRITE verbs are guarded too, not just the read path', async () => {
    const { fn } = recordingFetch(() => ({}));
    vi.stubGlobal('fetch', fn);
    const m = await import('../monitor-arm');
    const off = 'https://management.azure.com.evil.test/x?api-version=2024-01-01';
    await expect(m.armPut(off, {})).rejects.toThrow(/Refusing to send the ARM token/);
    await expect(m.armPost(off, {})).rejects.toThrow(/Refusing to send the ARM token/);
    await expect(m.armPatch(off, {})).rejects.toThrow(/Refusing to send the ARM token/);
    await expect(m.armDelete(off)).rejects.toThrow(/Refusing to send the ARM token/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a relative path and a same-origin absolute one both still work', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [1] }));
    vi.stubGlobal('fetch', fn);
    const m = await import('../monitor-arm');
    await expect(m.armGet('/subscriptions/sub-1/x?api-version=2024-01-01')).resolves.toEqual({ value: [1] });
    await expect(m.armGet(`${ARM}/subscriptions/sub-1/y?api-version=2024-01-01`)).resolves.toEqual({ value: [1] });
    expect(hosts).toEqual(['management.azure.com', 'management.azure.com']);
  });

  it('armPagedList stops the walk on an off-origin nextLink', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [{ id: 'a' }], nextLink: EVIL }));
    vi.stubGlobal('fetch', fn);
    const m = await import('../monitor-arm');
    await expect(m.armPagedList('t', '/subscriptions/sub-1/x?api-version=2024-01-01', 10))
      .resolves.toEqual([{ id: 'a' }]);
    expect(hosts).not.toContain('attacker.example');
  });
});

// ---------------------------------------------------------------------------
// Same shape, Graph side. Reachability of a body-supplied @odata.nextLink here
// was NOT traced — this is defence in depth, and it is stated as such.
// ---------------------------------------------------------------------------

describe('graph-identity-client graphFetch', () => {
  it('does NOT follow an @odata.nextLink to a host Graph did not serve', async () => {
    const { fn, hosts } = recordingFetch(() => ({
      value: [{ id: 'u1', displayName: 'U1' }],
      '@odata.nextLink': 'https://attacker.example/v1.0/groups/g/transitiveMembers?$skiptoken=evil',
    }));
    vi.stubGlobal('fetch', fn);
    const m = await import('../graph-identity-client');
    // The refusal ENDS the walk with the members already read — a picker keeps
    // working — rather than 500-ing the request.
    await expect(m.getGroupTransitiveMembers('g')).resolves.toHaveLength(1);
    expect(hosts).toEqual(['graph.microsoft.com']);
  });

  it('graphFetch itself refuses an off-origin absolute target (the backstop)', async () => {
    const { fn, hosts } = recordingFetch(() => ({ value: [] }));
    vi.stubGlobal('fetch', fn);
    // getGroupsForPrincipal-style paths encode their inputs, so the only way to
    // reach graphFetch with an absolute URL is a continuation. Drive the
    // resolver the walker uses, at the same base, to pin the backstop.
    const { resolveSameOriginUrl } = await import('@/lib/util/same-origin-url');
    expect(() => resolveSameOriginUrl(
      'https://graph.microsoft.com.evil.test/v1.0/me',
      'https://graph.microsoft.com/v1.0',
      'the Microsoft Graph token',
    )).toThrow(/Refusing to send the Microsoft Graph token/);
    expect(hosts).toEqual([]);
  });

  it('follows an @odata.nextLink on the Graph origin', async () => {
    let page = 0;
    const { fn, hosts } = recordingFetch(() => {
      page += 1;
      return page === 1
        ? { value: [{ id: 'u1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/g/transitiveMembers?$skiptoken=s' }
        : { value: [{ id: 'u2' }] };
    });
    vi.stubGlobal('fetch', fn);
    const m = await import('../graph-identity-client');
    const rows = await m.getGroupTransitiveMembers('g');
    expect(rows.map((r) => r.id)).toEqual(['u1', 'u2']);
    expect(new Set(hosts)).toEqual(new Set(['graph.microsoft.com']));
  });
});

// ---------------------------------------------------------------------------
// The shared walker itself: the two properties it had NEITHER of.
// ---------------------------------------------------------------------------

describe('paging-budget walkPagedListResult', () => {
  it('stops on an off-origin nextLink when sameOriginAs is set, keeping the rows', async () => {
    const { walkPagedListResult } = await import('../paging-budget');
    const seen: (string | null)[] = [];
    const res = await walkPagedListResult<number>(
      't',
      async (next) => {
        seen.push(next);
        return next ? { value: [2] } : { value: [1], nextLink: EVIL };
      },
      { sameOriginAs: ARM },
    );
    expect(res.rows).toEqual([1]);
    // fetchPage was NEVER handed the off-origin link.
    expect(seen).toEqual([null]);
  });

  it('a same-origin nextLink is still followed', async () => {
    const { walkPagedListResult } = await import('../paging-budget');
    const seen: (string | null)[] = [];
    const res = await walkPagedListResult<number>(
      't',
      async (next) => {
        seen.push(next);
        return next ? { value: [2] } : { value: [1], nextLink: `${ARM}/p2` };
      },
      { sameOriginAs: ARM },
    );
    expect(res.rows).toEqual([1, 2]);
    expect(seen).toEqual([null, `${ARM}/p2`]);
  });

  it('refuses an UNPARSEABLE absolute nextLink even with no origin configured', async () => {
    const { walkPagedListResult } = await import('../paging-budget');
    const seen: (string | null)[] = [];
    const res = await walkPagedListResult<number>('t', async (next) => {
      seen.push(next);
      return next ? { value: [2] } : { value: [1], nextLink: 'https://' };
    });
    expect(res.rows).toEqual([1]);
    expect(seen).toEqual([null]);
  });

  it('detects a CYCLE rather than merely bounding it', async () => {
    const { walkPagedListResult } = await import('../paging-budget');
    let calls = 0;
    const res = await walkPagedListResult<number>('t', async () => {
      calls += 1;
      return { value: [], nextLink: `${ARM}/loop?$skiptoken=forever` };
    }, { sameOriginAs: ARM, maxPages: 50 });
    expect(res.rows).toEqual([]);
    // `toBeLessThanOrEqual(50)` would pass with no paging at all and
    // discriminates nothing. A cycle must stop on the REPEAT.
    expect(calls).toBe(2);
  });

  it('a truncation is still reported as a truncation, not as a refusal', async () => {
    const { walkPagedListResult } = await import('../paging-budget');
    const res = await walkPagedListResult<number>('t', async () => ({
      value: [1], nextLink: `${ARM}/p${Math.random()}`,
    }), { sameOriginAs: ARM, maxPages: 3 });
    expect(res.truncatedBy).toBe('pages');
    expect(res.pagesFetched).toBe(3);
  });
});
