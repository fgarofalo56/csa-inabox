/**
 * collab-stream-model tests (A14) — pin the pure decisions both the SSE stream
 * route and the client transport depend on: change-suppression signatures,
 * SSE wire framing round-trip, and the push retry backoff.
 */
import { describe, expect, it } from 'vitest';
import type { PresencePeer } from '../canvas-presence-model';
import {
  COLLAB_PUSH_FLAG_ID,
  docsSignature,
  encodeSseEvent,
  nextPushRetryMs,
  parseSseBuffer,
  presenceSignature,
  PUSH_RETRY_MAX_MS,
  PUSH_RETRY_MIN_MS,
  SSE_PING,
} from '../collab-stream-model';

function peer(oid: string, extra: Partial<PresencePeer> = {}): PresencePeer {
  return { oid, name: `User ${oid}`, lastSeen: '2026-07-24T00:00:00Z', color: 'blue', ...extra };
}

describe('presenceSignature', () => {
  it('is order-insensitive (same peers, any order → same signature)', () => {
    const a = [peer('a'), peer('b')];
    const b = [peer('b'), peer('a')];
    expect(presenceSignature(a)).toBe(presenceSignature(b));
  });

  it('IGNORES lastSeen — a plain heartbeat must not push an event', () => {
    const before = [peer('a', { lastSeen: '2026-07-24T00:00:00Z' })];
    const after = [peer('a', { lastSeen: '2026-07-24T00:00:15Z' })];
    expect(presenceSignature(before)).toBe(presenceSignature(after));
  });

  it('changes on join, leave, rename, and cursor move', () => {
    const base = [peer('a')];
    expect(presenceSignature(base)).not.toBe(presenceSignature([peer('a'), peer('b')])); // join
    expect(presenceSignature(base)).not.toBe(presenceSignature([]));                     // leave
    expect(presenceSignature(base)).not.toBe(presenceSignature([peer('a', { name: 'Renamed' })]));
    expect(presenceSignature(base)).not.toBe(presenceSignature([peer('a', { cursor: { x: 1, y: 2 } })]));
    expect(presenceSignature([peer('a', { cursor: { x: 1, y: 2 } })]))
      .not.toBe(presenceSignature([peer('a', { cursor: { x: 3, y: 2 } })]));
  });
});

describe('docsSignature', () => {
  it('is order-insensitive and fires on add / edit / resolve / delete', () => {
    const a = [{ id: '1', createdAt: 't1' }, { id: '2', createdAt: 't2' }];
    const b = [{ id: '2', createdAt: 't2' }, { id: '1', createdAt: 't1' }];
    expect(docsSignature(a)).toBe(docsSignature(b));
    expect(docsSignature(a)).not.toBe(docsSignature([...a, { id: '3', createdAt: 't3' }])); // add
    expect(docsSignature(a)).not.toBe(docsSignature([a[0]]));                               // delete
    expect(docsSignature(a)).not.toBe(
      docsSignature([{ id: '1', createdAt: 't1', updatedAt: 't9' }, a[1]]),                 // edit
    );
    expect(docsSignature(a)).not.toBe(
      docsSignature([{ id: '1', createdAt: 't1', resolved: true }, a[1]]),                  // resolve
    );
  });
});

describe('SSE framing', () => {
  it('encodeSseEvent → parseSseBuffer round-trips, ignoring keep-alive pings', () => {
    const wire =
      SSE_PING +
      encodeSseEvent('presence', { peers: [], ttlMs: 45000, canvasKey: 'default' }) +
      encodeSseEvent('item-comments', { changed: true });
    const { events, remaining } = parseSseBuffer(wire);
    expect(remaining).toBe('');
    expect(events.map((e) => e.event)).toEqual(['presence', 'item-comments']);
    expect(JSON.parse(events[0].data)).toEqual({ peers: [], ttlMs: 45000, canvasKey: 'default' });
  });

  it('carries a partial trailing block forward as remaining', () => {
    const full = encodeSseEvent('presence', { peers: [] });
    const head = full.slice(0, full.length - 4); // cut mid-frame
    const r1 = parseSseBuffer(head);
    expect(r1.events).toHaveLength(0);
    const r2 = parseSseBuffer(r1.remaining + full.slice(full.length - 4));
    expect(r2.events).toHaveLength(1);
    expect(r2.events[0].event).toBe('presence');
  });
});

describe('nextPushRetryMs', () => {
  it('backs off exponentially between the clamps', () => {
    expect(nextPushRetryMs(0)).toBe(PUSH_RETRY_MIN_MS);
    expect(nextPushRetryMs(1)).toBe(PUSH_RETRY_MIN_MS * 2);
    expect(nextPushRetryMs(10)).toBe(PUSH_RETRY_MAX_MS);
    expect(nextPushRetryMs(-3)).toBe(PUSH_RETRY_MIN_MS);
  });
});

describe('flag id', () => {
  it('matches the registered runtime kill-switch id', () => {
    expect(COLLAB_PUSH_FLAG_ID).toBe('a14-collab-push');
  });
});
