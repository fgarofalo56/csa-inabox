'use client';

/**
 * use-canvas-presence (W5, transport upgraded in A14) — the client hook for
 * real-time co-authoring presence. It joins the caller onto a canvas (or a
 * non-canvas editor via canvasKey='editor') and surfaces the live peers so the
 * host renders their avatars (PresenceBar) + cursor beacons
 * (PresenceCursorNode). Backed by the TTL-enabled canvas-presence BFF route —
 * REAL heartbeat writes + presence reads, no mock avatars.
 *
 * Transport (A14): delegated to `presence-transport.ts`. The heartbeat POST
 * (~TTL/3, min 5s) is always on — it is both the presence WRITE and the
 * zero-infra poll fallback. The transport additionally subscribes to the
 * item's SSE collab stream so a peer joining / leaving / moving a cursor lands
 * in ~1s instead of the next poll tick. The `a14-collab-push` runtime
 * kill-switch is enforced server-side (stream route → 503; open streams wind
 * down): flipping it OFF reverts every surface to the pre-A14 poll behavior
 * with no roll — and no client-side flag read, so this hook needs no
 * react-query provider.
 *
 * `reportCursor` throttles cursor updates so pointer moves don't flood the
 * BFF — the next heartbeat carries the latest position. On unmount the
 * transport best-effort DELETEs the beacon so the peer disappears promptly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PresenceCursor, PresencePeer } from './canvas-presence-model';
import { createPresenceTransport } from './presence-transport';

export interface UseCanvasPresenceResult {
  peers: PresencePeer[];
  /** Report the local cursor position (flow-coords); sent on the next heartbeat. */
  reportCursor: (cursor: PresenceCursor | null) => void;
}

export function useCanvasPresence(
  itemType: string,
  itemId: string | undefined,
  canvasKey = 'default',
  /** Disable entirely (e.g. presence turned off) — no heartbeat, no stream. */
  enabled = true,
): UseCanvasPresenceResult {
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const cursorRef = useRef<PresenceCursor | undefined>(undefined);

  const reportCursor = useCallback((cursor: PresenceCursor | null) => {
    cursorRef.current = cursor ?? undefined;
  }, []);

  useEffect(() => {
    if (!enabled || !itemId) { setPeers([]); return; }
    let unmounted = false;
    const transport = createPresenceTransport({
      itemType,
      itemId,
      canvasKey,
      onPeers: (next) => { if (!unmounted) setPeers(next); },
      getCursor: () => cursorRef.current,
    });
    return () => {
      unmounted = true;
      transport.stop();
    };
  }, [itemType, itemId, canvasKey, enabled]);

  // Stable reference (see use-canvas-suggestion for the render-loop rationale).
  return useMemo(() => ({ peers, reportCursor }), [peers, reportCursor]);
}
