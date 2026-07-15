'use client';

/**
 * use-canvas-presence (W5) — the client hook for real-time co-authoring
 * presence. It heartbeats the caller onto a canvas and polls the live peers so
 * the host can render their avatars (PresenceBar) + live cursor beacons
 * (PresenceCursorNode). Backed by the TTL-enabled canvas-presence BFF route —
 * REAL heartbeat writes + presence reads, no mock avatars.
 *
 * Cadence: the server returns its `ttlMs` (the freshness window); this hook
 * heartbeats at ~1/3 of it (min 5s) so a live peer never goes stale, and polls
 * peers on the same tick. `reportCursor` throttles cursor updates so pointer
 * moves don't flood the BFF — the next heartbeat carries the latest position.
 * On unmount it best-effort DELETEs the beacon so the peer disappears promptly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import type { PresenceCursor, PresencePeer } from './canvas-presence-model';

export interface UseCanvasPresenceResult {
  peers: PresencePeer[];
  /** Report the local cursor position (flow-coords); sent on the next heartbeat. */
  reportCursor: (cursor: PresenceCursor | null) => void;
}

const MIN_HEARTBEAT_MS = 5_000;
const DEFAULT_TTL_MS = 45_000;

function base(itemType: string, itemId: string): string {
  return `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/canvas-presence`;
}

export function useCanvasPresence(
  itemType: string,
  itemId: string | undefined,
  canvasKey = 'default',
  /** Disable entirely (e.g. presence turned off) — no heartbeat, no poll. */
  enabled = true,
): UseCanvasPresenceResult {
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const cursorRef = useRef<PresenceCursor | undefined>(undefined);
  const ttlRef = useRef<number>(DEFAULT_TTL_MS);

  const reportCursor = useCallback((cursor: PresenceCursor | null) => {
    cursorRef.current = cursor ?? undefined;
  }, []);

  useEffect(() => {
    if (!enabled || !itemId) { setPeers([]); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const beat = async () => {
      try {
        const r = await clientFetch(base(itemType, itemId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ canvasKey, cursor: cursorRef.current }),
        });
        const j = await r.json().catch(() => ({}));
        if (!stopped && r.ok && j?.ok) {
          setPeers(Array.isArray(j.peers) ? j.peers : []);
          if (Number.isFinite(j.ttlMs) && j.ttlMs > 0) ttlRef.current = j.ttlMs;
        }
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!stopped) {
          const interval = Math.max(MIN_HEARTBEAT_MS, Math.floor(ttlRef.current / 3));
          timer = setTimeout(beat, interval);
        }
      }
    };
    beat(); // immediate first heartbeat so the user appears at once

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Best-effort leave — TTL would evict anyway, but this is instant.
      clientFetch(`${base(itemType, itemId)}?canvasKey=${encodeURIComponent(canvasKey)}`, {
        method: 'DELETE',
      }).catch(() => { /* ignore */ });
    };
  }, [itemType, itemId, canvasKey, enabled]);

  return { peers, reportCursor };
}
