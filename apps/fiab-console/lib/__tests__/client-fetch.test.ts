/**
 * Unit tests for the client-side fetch ceiling (lib/client-fetch).
 *
 * Locks the abort-relabel: a TIMEOUT-driven abort throws a friendly
 * ClientFetchTimeoutError (so a `setErr(String(e))` caller surfaces a clear
 * "timed out" message instead of the browser's cryptic
 * "signal is aborted without reason"), while a CALLER-driven abort (component
 * unmount) re-throws unchanged.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { clientFetch, describeNonJsonResponse, ClientFetchTimeoutError } from '../client-fetch';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('clientFetch', () => {
  it('relabels a timeout abort to a clear ClientFetchTimeoutError (not "aborted without reason")', async () => {
    // fetch that never resolves until its signal aborts, then rejects like the
    // browser does (AbortError with the cryptic message).
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const e = new Error('signal is aborted without reason');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    );

    const err = await clientFetch('/api/slow', undefined, 10).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(ClientFetchTimeoutError);
    expect(String(err)).toMatch(/timed out/i);
    expect(String(err)).not.toMatch(/aborted without reason/i);
  });

  it('re-throws a caller-driven abort unchanged (component unmount)', async () => {
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('signal is aborted without reason');
          e.name = 'AbortError';
          reject(e);
        });
      }),
    );

    const ctrl = new AbortController();
    const p = clientFetch('/api/x', { signal: ctrl.signal }, 60_000);
    ctrl.abort(); // caller unmount, NOT our timeout
    const err = await p.then(() => null, (e) => e);
    expect(err).not.toBeInstanceOf(ClientFetchTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('returns the response when fetch resolves before the timeout', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"ok":true}', { status: 200 }));
    const r = await clientFetch('/api/fast', undefined, 1000);
    expect(r.status).toBe(200);
  });
});

describe('clientFetch — retryOnTimeoutOnce (#3571, deploy-integrity.md R6)', () => {
  it('retries ONCE, transparently, when the first attempt times out and retryOnTimeoutOnce is set', async () => {
    // Kill power: an implementation that never retries leaves `calls` at 1 and
    // the promise REJECTED; this pins both `calls === 2` and a successful
    // resolution, either of which a no-retry implementation fails.
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // First attempt: never resolves on its own — only the timeout aborts it.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('signal is aborted without reason');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      // Second attempt: the "now warm" response.
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    });

    let retried = false;
    const res = await clientFetch('/api/duckdb/capabilities', undefined, {
      timeoutMs: 10,
      retryOnTimeoutOnce: true,
      onTimeoutRetry: () => { retried = true; },
    });

    expect(calls).toBe(2);
    expect(retried).toBe(true);
    expect(res.status).toBe(200);
  });

  it('surfaces the timeout (bounded — no infinite retry) when the retry ALSO times out', async () => {
    // Kill power: an unbounded/looping retry would never settle this test
    // (vitest's own timeout would fail it); this pins the exact call count at 2.
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('signal is aborted without reason');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    const err = await clientFetch('/api/duckdb/capabilities', undefined, {
      timeoutMs: 10,
      retryOnTimeoutOnce: true,
    }).then(() => null, (e) => e);

    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(ClientFetchTimeoutError);
  });

  it('does NOT retry when retryOnTimeoutOnce is unset — existing callers keep failing fast', async () => {
    // Kill power: a global/always-on retry (the exact change this option
    // exists to AVOID making to every other caller) would push `calls` to 2.
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('signal is aborted without reason');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    const err = await clientFetch('/api/x', undefined, 10).then(() => null, (e) => e);

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(ClientFetchTimeoutError);
  });

  it('does not retry a one-shot stream body (not safely re-sendable)', async () => {
    // Kill power: skipping the re-sendable check would retry a ReadableStream
    // body and either throw "body already used" or silently send an empty
    // body on the second attempt — this pins `calls` staying at 1.
    let calls = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('signal is aborted without reason');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    const stream = new ReadableStream();
    const err = await clientFetch('/api/duckdb/query', { method: 'POST', body: stream as any }, {
      timeoutMs: 10,
      retryOnTimeoutOnce: true,
    }).then(() => null, (e) => e);

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(ClientFetchTimeoutError);
  });
});

describe('describeNonJsonResponse (gateway HTML → honest message)', () => {
  it('maps 504 to a gateway-timeout message naming the status — never the HTML body', () => {
    const msg = describeNonJsonResponse(504, 'The deploy service');
    expect(msg).toMatch(/HTTP 504/);
    expect(msg).toMatch(/gateway timed out/i);
    expect(msg).toMatch(/^The deploy service/);
    expect(msg).not.toMatch(/DOCTYPE|<html/i);
  });

  it('maps 502 to an unreachable-through-the-gateway message', () => {
    const msg = describeNonJsonResponse(502);
    expect(msg).toMatch(/HTTP 502/);
    expect(msg).toMatch(/unreachable/i);
  });

  it('maps 503 to a temporarily-unavailable message', () => {
    expect(describeNonJsonResponse(503)).toMatch(/HTTP 503/);
  });

  it('falls back to a generic non-JSON message with the status for anything else', () => {
    const msg = describeNonJsonResponse(500, 'The subscriptions service');
    expect(msg).toMatch(/HTTP 500/);
    expect(msg).toMatch(/non-JSON/i);
  });
});
