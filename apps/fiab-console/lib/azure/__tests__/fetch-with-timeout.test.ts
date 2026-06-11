/**
 * fetch-with-timeout — verifies the server-side per-request timeout wrapper:
 *   - passes through a successful response unchanged,
 *   - aborts and throws FetchTimeoutError when the round-trip exceeds the budget,
 *   - composes a caller-supplied AbortSignal (caller abort still propagates and
 *     is NOT misreported as a timeout),
 *   - reads its default ceiling from LOOM_SERVER_FETCH_TIMEOUT_MS.
 *
 * global.fetch is stubbed so no network is touched.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchWithTimeout, FetchTimeoutError } from '../fetch-with-timeout';

const REAL_FETCH = global.fetch;

afterEach(() => {
  global.fetch = REAL_FETCH;
  vi.restoreAllMocks();
});

describe('fetchWithTimeout', () => {
  it('returns the response on success and forwards init', async () => {
    const ok = new Response('hi', { status: 200 });
    const spy = vi.fn(async (_input: any, init?: RequestInit) => {
      // signal is always set by the wrapper.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return ok;
    });
    global.fetch = spy as any;
    const res = await fetchWithTimeout('https://example.test/x', { method: 'GET' }, 1000);
    expect(res).toBe(ok);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws FetchTimeoutError when the request exceeds the budget', async () => {
    // A fetch that only rejects when its signal aborts (models a hung backend).
    global.fetch = ((_input: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as any;

    await expect(fetchWithTimeout('https://example.test/hang', {}, 20)).rejects.toBeInstanceOf(
      FetchTimeoutError,
    );
  });

  it('propagates a caller abort without misreporting it as a timeout', async () => {
    global.fetch = ((_input: any, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        sig?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      })) as any;

    const caller = new AbortController();
    const p = fetchWithTimeout('https://example.test/cancel', { signal: caller.signal }, 5000);
    caller.abort();
    await expect(p).rejects.not.toBeInstanceOf(FetchTimeoutError);
  });

  it('exposes an env-driven default timeout', async () => {
    vi.resetModules();
    process.env.LOOM_SERVER_FETCH_TIMEOUT_MS = '12345';
    const mod = await import('../fetch-with-timeout');
    expect(mod.DEFAULT_SERVER_FETCH_TIMEOUT_MS).toBe(12345);
    delete process.env.LOOM_SERVER_FETCH_TIMEOUT_MS;
  });
});
