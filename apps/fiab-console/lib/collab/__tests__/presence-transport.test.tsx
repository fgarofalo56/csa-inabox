/**
 * presence-transport tests (A14) — pin the transport contract:
 *   • the heartbeat POST (poll path) always runs and feeds onPeers — the
 *     zero-infra fallback works with push disabled OR failing;
 *   • with push enabled, SSE `presence` frames feed onPeers with sub-poll
 *     latency and comment frames fan out via the window CustomEvent;
 *   • a failed stream never breaks the poll;
 *   • stop() sends the best-effort DELETE beacon.
 *
 * jsdom (.test.tsx) so window/CustomEvent exist for the comment fan-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { COLLAB_COMMENTS_EVENT, encodeSseEvent } from '../collab-stream-model';
import { createPresenceTransport, type PresenceTransport } from '../presence-transport';

vi.mock('@/lib/client-fetch', () => ({ clientFetch: vi.fn() }));
import { clientFetch } from '@/lib/client-fetch';

const clientFetchMock = clientFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true): { ok: boolean; json: () => Promise<unknown> } {
  return { ok, json: () => Promise.resolve(body) };
}

/** A stream fetch stub that emits the given SSE chunks then stays open. */
function sseFetch(chunks: string[], opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  const encoder = new TextEncoder();
  return vi.fn(async () => {
    let i = 0;
    const body = {
      getReader: () => ({
        read: async (): Promise<{ value?: Uint8Array; done: boolean }> => {
          if (i < chunks.length) return { value: encoder.encode(chunks[i++]), done: false };
          return new Promise(() => { /* stream stays open */ });
        },
      }),
    };
    return { ok: opts.ok ?? true, status: opts.status ?? 200, body } as unknown as Response;
  }) as unknown as typeof fetch;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let transport: PresenceTransport | undefined;

beforeEach(() => {
  clientFetchMock.mockReset();
  clientFetchMock.mockResolvedValue(
    jsonResponse({ ok: true, peers: [{ oid: 'poll-peer', name: 'Poll Peer', lastSeen: 't', color: 'blue' }], ttlMs: 45_000 }),
  );
});

afterEach(() => {
  transport?.stop();
  transport = undefined;
});

describe('createPresenceTransport', () => {
  it('heartbeats immediately and feeds onPeers from the poll response', async () => {
    const onPeers = vi.fn();
    transport = createPresenceTransport({
      itemType: 'notebook', itemId: 'item-1', canvasKey: 'editor',
      pushEnabled: false, onPeers, getCursor: () => undefined,
    });
    await flush();
    const [url, init] = clientFetchMock.mock.calls[0];
    expect(url).toBe('/api/items/notebook/item-1/canvas-presence');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).canvasKey).toBe('editor');
    expect(onPeers).toHaveBeenCalledWith([expect.objectContaining({ oid: 'poll-peer' })]);
  });

  it('with push enabled, SSE presence frames feed onPeers and comment frames dispatch the window event', async () => {
    const onPeers = vi.fn();
    const seen: Array<{ scope: string; itemId: string; canvasKey: string }> = [];
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail;
      seen.push({ scope: d.scope, itemId: d.itemId, canvasKey: d.canvasKey });
    };
    window.addEventListener(COLLAB_COMMENTS_EVENT, listener);
    try {
      transport = createPresenceTransport({
        itemType: 'notebook', itemId: 'item-1', canvasKey: 'default',
        pushEnabled: true, onPeers, getCursor: () => undefined,
        streamFetch: sseFetch([
          encodeSseEvent('presence', { peers: [{ oid: 'push-peer', name: 'Push Peer', lastSeen: 't', color: 'teal' }] }),
          encodeSseEvent('canvas-comments', { changed: true }) + encodeSseEvent('item-comments', { changed: true }),
        ]),
      });
      await flush();
      await flush();
      expect(onPeers).toHaveBeenCalledWith([expect.objectContaining({ oid: 'push-peer' })]);
      expect(seen).toEqual([
        { scope: 'canvas', itemId: 'item-1', canvasKey: 'default' },
        { scope: 'item', itemId: 'item-1', canvasKey: 'default' },
      ]);
    } finally {
      window.removeEventListener(COLLAB_COMMENTS_EVENT, listener);
    }
  });

  it('a 503 stream (flag off) leaves the poll path fully working', async () => {
    const onPeers = vi.fn();
    transport = createPresenceTransport({
      itemType: 'notebook', itemId: 'item-1', canvasKey: 'default',
      pushEnabled: true, onPeers, getCursor: () => undefined,
      streamFetch: sseFetch([], { ok: false, status: 503 }),
    });
    await flush();
    await flush();
    // Poll delivered peers despite the stream refusing.
    expect(onPeers).toHaveBeenCalledWith([expect.objectContaining({ oid: 'poll-peer' })]);
  });

  it('stop() sends the best-effort DELETE beacon', async () => {
    transport = createPresenceTransport({
      itemType: 'notebook', itemId: 'item-1', canvasKey: 'editor',
      pushEnabled: false, onPeers: () => undefined, getCursor: () => undefined,
    });
    await flush();
    transport.stop();
    transport = undefined;
    const del = clientFetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(del?.[0]).toBe('/api/items/notebook/item-1/canvas-presence?canvasKey=editor');
  });

  it('carries the latest cursor on the heartbeat body', async () => {
    transport = createPresenceTransport({
      itemType: 'pipeline', itemId: 'item-2', canvasKey: 'default',
      pushEnabled: false, onPeers: () => undefined, getCursor: () => ({ x: 10, y: 20 }),
    });
    await flush();
    const [, init] = clientFetchMock.mock.calls[0];
    expect(JSON.parse(init.body).cursor).toEqual({ x: 10, y: 20 });
  });
});
