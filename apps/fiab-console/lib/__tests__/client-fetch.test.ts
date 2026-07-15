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
