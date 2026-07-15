/**
 * Unit tests for the PURE canvas-presence model (W5):
 *  - activePeers (own-row drop, stale filter, oid de-dupe, stable order)
 *  - presenceColorKey (stable, in-palette)
 *  - normalizeCursor (finite-only)
 *  - presenceTtlSeconds (env override + floor)
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  activePeers,
  presenceColorKey,
  normalizeCursor,
  presenceTtlSeconds,
  presenceTtlMs,
  PRESENCE_COLOR_KEYS,
  DEFAULT_PRESENCE_TTL_MS,
  type CanvasPresenceDoc,
} from '@/lib/collab/canvas-presence-model';

function beacon(over: Partial<CanvasPresenceDoc>): CanvasPresenceDoc {
  return {
    id: 'pres:i1:default:oidX',
    docType: 'canvas-presence',
    itemId: 'i1',
    canvasKey: 'default',
    oid: 'oidX',
    lastSeen: new Date().toISOString(),
    ttl: 45,
    ...over,
  };
}

describe('activePeers', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z');
  const ttlMs = 45_000;

  it('drops the reader own row', () => {
    const docs = [beacon({ oid: 'me', lastSeen: new Date(now).toISOString() })];
    expect(activePeers(docs, 'me', now, ttlMs)).toEqual([]);
  });

  it('drops stale beacons older than the ttl window', () => {
    const fresh = beacon({ oid: 'a', name: 'Ann', lastSeen: new Date(now - 5_000).toISOString() });
    const stale = beacon({ oid: 'b', name: 'Bob', lastSeen: new Date(now - 60_000).toISOString() });
    const peers = activePeers([fresh, stale], 'me', now, ttlMs);
    expect(peers.map((p) => p.oid)).toEqual(['a']);
  });

  it('de-dupes by oid keeping the freshest, and orders by name', () => {
    const older = beacon({ oid: 'a', name: 'Ann', lastSeen: new Date(now - 20_000).toISOString(), cursor: { x: 1, y: 1 } });
    const newer = beacon({ oid: 'a', name: 'Ann', lastSeen: new Date(now - 2_000).toISOString(), cursor: { x: 9, y: 9 } });
    const zed = beacon({ oid: 'z', name: 'Zed', lastSeen: new Date(now - 1_000).toISOString() });
    const peers = activePeers([older, newer, zed], 'me', now, ttlMs);
    expect(peers.map((p) => p.oid)).toEqual(['a', 'z']); // Ann before Zed
    expect(peers[0].cursor).toEqual({ x: 9, y: 9 }); // freshest cursor won
  });

  it('ignores malformed lastSeen', () => {
    const bad = beacon({ oid: 'a', lastSeen: 'not-a-date' });
    expect(activePeers([bad], 'me', now, ttlMs)).toEqual([]);
  });
});

describe('presenceColorKey', () => {
  it('is stable for an oid and always in the palette', () => {
    const c1 = presenceColorKey('some-oid-123');
    const c2 = presenceColorKey('some-oid-123');
    expect(c1).toBe(c2);
    expect(PRESENCE_COLOR_KEYS).toContain(c1);
  });
});

describe('normalizeCursor', () => {
  it('returns undefined for non-finite / non-object', () => {
    expect(normalizeCursor(null)).toBeUndefined();
    expect(normalizeCursor({ x: 'a', y: 1 })).toBeUndefined();
    expect(normalizeCursor({ x: Infinity, y: 1 })).toBeUndefined();
  });
  it('rounds a valid cursor', () => {
    expect(normalizeCursor({ x: 1.23456, y: -2.99999 })).toEqual({ x: 1.23, y: -3 });
  });
});

describe('presenceTtl', () => {
  const orig = process.env.LOOM_CANVAS_PRESENCE_TTL_MS;
  afterEach(() => { process.env.LOOM_CANVAS_PRESENCE_TTL_MS = orig; });

  it('defaults + floors sub-10s overrides', () => {
    delete process.env.LOOM_CANVAS_PRESENCE_TTL_MS;
    expect(presenceTtlMs()).toBe(DEFAULT_PRESENCE_TTL_MS);
    expect(presenceTtlSeconds()).toBe(45);
    process.env.LOOM_CANVAS_PRESENCE_TTL_MS = '5000'; // below floor → ignored
    expect(presenceTtlMs()).toBe(DEFAULT_PRESENCE_TTL_MS);
  });

  it('honors a valid override', () => {
    process.env.LOOM_CANVAS_PRESENCE_TTL_MS = '30000';
    expect(presenceTtlMs()).toBe(30_000);
    expect(presenceTtlSeconds()).toBe(30);
  });
});
