/**
 * `lib/azure/arm-client.ts` — the SHARED ARM fetcher — may not send the
 * management-plane token to an address a response chose (GHSA-4gvx-9p49-p43g).
 *
 * WHY THIS FILE GETS ITS OWN SUITE. It is the module whose own header tells new
 * ARM code to use it ("so new ARM calls don't re-implement token acquisition"),
 * and it is the one the first fix missed: `armUrl()` returned an absolute `path`
 * verbatim and `armFetch()` attached `Bearer ${token.token}` to it. The value is
 * not always one this process composed — `monitor-client.listResources()` copies
 * `id` straight out of an ARM list RESPONSE BODY and `cost-management-client`
 * interpolates that id as the head of a path — so a traced, three-hop path
 * exists from a response body to this function's argument.
 *
 * ASSERT ON THE HOST CONTACTED, NEVER ON THE RETURN VALUE. A refusal and a
 * successful call can both produce a plausible-looking result, and every one of
 * these entry points wraps errors. The stub records `new URL(u).host` for every
 * request and THROWS if the off-origin host is reached, so a regression cannot
 * be absorbed by a caller's catch and re-read as "nothing happened".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@azure/identity', () => {
  class Cred { async getToken() { return { token: 'tk', expiresOnTimestamp: Date.now() + 3600_000 }; } }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const EVIL_HOST = 'attacker.example';

function recordingFetch(body: unknown = { value: [] }) {
  const hosts: string[] = [];
  const authOffOrigin: boolean[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    hosts.push(host);
    if (host === EVIL_HOST) {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      authOffOrigin.push(Boolean(auth));
      throw new Error(`ARM token forwarded off-origin (authorization present: ${Boolean(auth)})`);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { fn, hosts, authOffOrigin };
}

beforeEach(() => {
  delete process.env.LOOM_ARM_ENDPOINT;
  delete process.env.AZURE_CLOUD;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('arm-client — a body-supplied absolute path cannot redirect the ARM token', () => {
  it.each([
    ['bare foreign host', `https://${EVIL_HOST}/subscriptions/s/resources?api-version=2021-04-01`],
    ['suffix impostor', 'https://management.azure.com.attacker.example/subscriptions/s'],
    ['userinfo authority', `https://management.azure.com@${EVIL_HOST}/subscriptions/s`],
    ['scheme downgrade', 'http://management.azure.com/subscriptions/s'],
    ['off port', 'https://management.azure.com:8443/subscriptions/s'],
    ['trailing-dot host', 'https://management.azure.com./subscriptions/s'],
  ])('armGet refuses %s and contacts NOTHING', async (_label, hostile) => {
    const { fn, hosts } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    const { armGet } = await import('../arm-client');
    await expect(armGet(hostile)).rejects.toThrow(/not the configured service endpoint|unparseable/);
    // The refusal happens BEFORE the request, so nothing at all was contacted.
    expect(hosts).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('the positive control — a legitimate absolute ARM URL IS still fetched', async () => {
    // Without this the suite above is satisfied by a helper that refuses
    // everything, which would break every ARM nextLink walk in the console.
    const { fn, hosts } = recordingFetch({ value: [{ id: '/subscriptions/s/x' }] });
    vi.stubGlobal('fetch', fn);
    const { armGet } = await import('../arm-client');
    const out = await armGet<{ value: unknown[] }>(
      'https://management.azure.com/subscriptions/s/resources?api-version=2021-04-01',
    );
    expect(out.value).toHaveLength(1);
    expect(hosts).toEqual(['management.azure.com']);
  });

  it('a bare path still resolves onto the ARM base, with and without a leading slash', async () => {
    const { fn, hosts } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    const { armGet } = await import('../arm-client');
    await armGet('/subscriptions/s/resources?api-version=2021-04-01');
    await armGet('subscriptions/s/resources?api-version=2021-04-01');
    expect(hosts).toEqual(['management.azure.com', 'management.azure.com']);
    const urls = fn.mock.calls.map((c) => String(c[0]));
    // The slash is inserted exactly once in each case — the pre-fix behaviour,
    // preserved: this fix must not change any legitimate URL it builds.
    expect(urls[0]).toBe('https://management.azure.com/subscriptions/s/resources?api-version=2021-04-01');
    expect(urls[1]).toBe(urls[0]);
  });

  it('the token is attached to the request that WAS allowed', async () => {
    // The complement of the refusal assertions: proves this suite is exercising
    // a credentialed path at all, so "no credential leaked" is not vacuously
    // true because no credential was ever attached.
    const { fn } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    const { armGet } = await import('../arm-client');
    await armGet('/subscriptions/s/resources?api-version=2021-04-01');
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tk');
  });

  it('every verb goes through the same resolution — not just GET', async () => {
    // A fix applied to one entry point is the narrower enumeration this
    // advisory keeps producing. armPatch/armPut/armPost/armDelete and the
    // 429-retry GET all reach `armFetch`, so all of them refuse.
    const { fn, hosts } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    const mod = await import('../arm-client');
    const hostile = `https://${EVIL_HOST}/subscriptions/s`;
    await expect(mod.armPatch(hostile, {})).rejects.toThrow(/not the configured service endpoint/);
    await expect(mod.armPut(hostile, {})).rejects.toThrow(/not the configured service endpoint/);
    await expect(mod.armPost(hostile, {})).rejects.toThrow(/not the configured service endpoint/);
    await expect(mod.armDelete(hostile)).rejects.toThrow(/not the configured service endpoint/);
    await expect(mod.armGetWithRetry(hostile)).rejects.toThrow(/not the configured service endpoint/);
    expect(hosts).toEqual([]);
  });

  it('the sovereign endpoint governs — Gov admits Gov and refuses Commercial', async () => {
    // The base is read from `armBase()` per call, never hardcoded, so each
    // boundary compares against its own ARM host (cloud-parity.md). A Commercial
    // continuation arriving in a Gov deployment is off-origin THERE.
    process.env.LOOM_ARM_ENDPOINT = 'https://management.usgovcloudapi.net';
    const { fn, hosts } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    const { armGet } = await import('../arm-client');
    await armGet('https://management.usgovcloudapi.net/subscriptions/s?api-version=2021-04-01');
    await expect(
      armGet('https://management.azure.com/subscriptions/s?api-version=2021-04-01'),
    ).rejects.toThrow(/not the configured service endpoint/);
    expect(hosts).toEqual(['management.usgovcloudapi.net']);
  });

  it('the refusal never echoes the rejected URL back to the caller', () => {
    // The value is attacker-chosen; reflecting it puts it in logs and in
    // whatever response a BFF route builds from the error.
    return (async () => {
      const { fn } = recordingFetch();
      vi.stubGlobal('fetch', fn);
      const { armGet } = await import('../arm-client');
      const err = await armGet(`https://${EVIL_HOST}/subscriptions/s`).catch((e: Error) => e);
      expect((err as Error).message).toContain('the ARM token');
      expect((err as Error).message).not.toContain(EVIL_HOST);
    })();
  });
});
