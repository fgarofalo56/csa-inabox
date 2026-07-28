/**
 * BFF route test for GET /api/items/[type]/[id]/collab/stream — the A14
 * collab push transport.
 *
 * Asserts: (1) unauthed → 401, (2) unreachable item → 404 (same 404-not-403
 * as the poll routes), (3) the `a14-collab-push` kill-switch OFF → honest 503
 * naming the flag (the client transport then rides the poll fallback),
 * (4) flag ON → a real text/event-stream whose FIRST frame is the presence
 * snapshot (peers read from the mocked Cosmos store, reader's own beacon
 * excluded via activePeers).
 *
 * Session, item-crud, runtime flag, and the Cosmos stores are mocked — no live
 * Azure; the change-suppression logic itself is pinned in
 * collab-stream-model.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { parseSseBuffer } from '@/lib/collab/collab-stream-model';

const getSessionMock = vi.fn(() => ({ claims: { oid: 'me', upn: 'me@t.com', name: 'Me' }, exp: Date.now() / 1000 + 3600 }) as any);
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSessionMock() }));

const loadOwnedItemMock = vi.fn(async () => ({ id: 'item-1', itemType: 'notebook', workspaceId: 'ws-1' }) as any);
vi.mock('@/app/api/items/_lib/item-crud', () => ({
  loadOwnedItem: (...a: any[]) => loadOwnedItemMock(...a),
}));

const runtimeFlagMock = vi.fn(async () => true);
vi.mock('@/lib/admin/runtime-flags', () => ({
  runtimeFlag: (...a: any[]) => runtimeFlagMock(...a),
}));

const listPresenceMock = vi.fn(async () => [
  { id: 'pres:item-1:default:me', docType: 'canvas-presence', itemId: 'item-1', canvasKey: 'default', oid: 'me', name: 'Me', lastSeen: new Date().toISOString(), ttl: 45 },
  { id: 'pres:item-1:default:peer', docType: 'canvas-presence', itemId: 'item-1', canvasKey: 'default', oid: 'peer', name: 'Peer B', lastSeen: new Date().toISOString(), ttl: 45 },
]);
vi.mock('@/lib/collab/canvas-presence-store', () => ({
  listPresence: (...a: any[]) => listPresenceMock(...a),
}));

vi.mock('@/lib/collab/canvas-comment-store', () => ({
  listCanvasComments: vi.fn(async () => []),
}));

vi.mock('@/lib/azure/cosmos-client', () => ({
  commentsContainer: vi.fn(async () => ({
    items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) },
  })),
}));

function getReq(canvasKey = 'default'): NextRequest {
  return new NextRequest(`http://localhost/api/items/notebook/item-1/collab/stream?canvasKey=${canvasKey}`);
}

const ctx = { params: Promise.resolve({ type: 'notebook', id: 'item-1' }) };

beforeEach(() => {
  getSessionMock.mockClear();
  loadOwnedItemMock.mockClear();
  runtimeFlagMock.mockClear();
  runtimeFlagMock.mockResolvedValue(true);
  loadOwnedItemMock.mockResolvedValue({ id: 'item-1', itemType: 'notebook', workspaceId: 'ws-1' });
});

describe('GET /api/items/[type]/[id]/collab/stream', () => {
  it('401 when unauthenticated', async () => {
    getSessionMock.mockReturnValueOnce(null as any);
    const { GET } = await import('../route');
    const res = await GET(getReq(), ctx as any);
    expect(res.status).toBe(401);
  });

  it('404 when the caller cannot reach the item', async () => {
    loadOwnedItemMock.mockResolvedValueOnce(null);
    const { GET } = await import('../route');
    const res = await GET(getReq(), ctx as any);
    expect(res.status).toBe(404);
  });

  it('503 naming the kill-switch when a14-collab-push is OFF (poll fallback stays honest)', async () => {
    runtimeFlagMock.mockResolvedValueOnce(false);
    const { GET } = await import('../route');
    const res = await GET(getReq(), ctx as any);
    expect(res.status).toBe(503);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(String(j.error)).toContain('a14-collab-push');
  });

  it('streams SSE with the presence snapshot as the first frame (reader excluded)', async () => {
    const { GET } = await import('../route');
    const res = await GET(getReq(), ctx as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let presence: { peers: Array<{ oid: string }> } | undefined;
    for (let i = 0; i < 5 && !presence; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = parseSseBuffer(buffer);
      buffer = remaining;
      const ev = events.find((e) => e.event === 'presence');
      if (ev) presence = JSON.parse(ev.data);
    }
    await reader.cancel();

    expect(presence).toBeDefined();
    expect(presence!.peers.map((p) => p.oid)).toEqual(['peer']); // own beacon dropped
  });
});
