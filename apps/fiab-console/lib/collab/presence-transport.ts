'use client';

/**
 * presence-transport (A14) — the pluggable client transport behind
 * `use-canvas-presence`. Two cooperating loops:
 *
 *   • POLL (always on — the zero-infra fallback and the WRITE path): a
 *     heartbeat POST to the canvas-presence BFF at ~TTL/3 (min 5s). The POST
 *     both refreshes the caller's Cosmos TTL beacon AND returns the live
 *     peers, so presence keeps working with the push transport disabled,
 *     failing, or flipped off mid-session — exactly the pre-A14 behavior.
 *
 *   • PUSH (default-ON via the `a14-collab-push` runtime flag): an SSE
 *     subscription to /api/items/[type]/[id]/collab/stream. The server watches
 *     the item's Cosmos partitions and pushes `presence` events the moment the
 *     peer set changes (~1s, vs the ~15s poll), plus `canvas-comments` /
 *     `item-comments` change events which are fanned out to comment surfaces
 *     through the `loom:collab-comments` window CustomEvent. Any stream error
 *     falls back to the poll silently and retries with capped backoff — push
 *     is a latency upgrade, never a dependency (no-vaporware: both paths hit
 *     the same real Cosmos-backed BFF).
 *
 * Framework-free on purpose (no React import) so the loops are unit-testable
 * with injected fetch/timers; `use-canvas-presence` is the thin hook shell.
 *
 * Raw `fetch` (not clientFetch) for the SSE subscription only: clientFetch's
 * 20s abort is wrong for a long-lived stream (same exemption as the Copilot
 * SSE call sites); credentials are included so the loom_session cookie reaches
 * the BFF behind Front Door. Heartbeats keep using clientFetch.
 */

import { clientFetch } from '@/lib/client-fetch';
import type { PresenceCursor, PresencePeer } from './canvas-presence-model';
import {
  COLLAB_COMMENTS_EVENT,
  type CollabCommentsEventDetail,
  nextPushRetryMs,
  parseSseBuffer,
  PUSH_RETRY_MAX_MS,
  STREAM_MAX_LIFETIME_MS,
} from './collab-stream-model';

const MIN_HEARTBEAT_MS = 5_000;
const DEFAULT_TTL_MS = 45_000;
/**
 * Re-probe cadence after a SETTLED refusal (see {@link isSettledRefusal}) —
 * the same 60s ceiling the push backoff tops out at, so a refused surface
 * costs one request a minute instead of one every 5-15s.
 */
const SETTLED_REPROBE_MS = PUSH_RETRY_MAX_MS;

/**
 * Statuses that will NOT become a different answer within seconds, so retrying
 * on the fast ramp is pure noise (#3697 — every canvas open produced a 404
 * storm against canvas-presence / collab/stream while `loadOwnedItem` refused
 * the item):
 *
 *   503 — the `a14-collab-push` kill-switch is OFF server-side.
 *   401 — the caller is not authenticated for this route. clientFetch already
 *         handles a SESSION-EXPIRY 401 itself (refresh + reauth); a 401 that
 *         reaches here is the authorization kind, which a retry cannot fix.
 *   403 — the caller has no access to this item.
 *   404 — the item lookup refused (wrong type, deleted, or no access path).
 *
 * These are RE-PROBED, never abandoned: an access grant or a flag flip made
 * out-of-band self-heals on the next slow probe, per auto-bind-by-default §3.
 * Anything else (5xx, network, a proxy hiccup) stays on the fast ramp.
 */
function isSettledRefusal(status: number): boolean {
  return status === 503 || status === 401 || status === 403 || status === 404;
}

export interface PresenceTransportOptions {
  itemType: string;
  itemId: string;
  canvasKey: string;
  /**
   * Attempt the SSE push subscription (default true). The `a14-collab-push`
   * runtime kill-switch is enforced SERVER-side: with the flag OFF the stream
   * route answers 503 and this transport settles into a slow (60s) re-probe
   * while the poll carries presence — no client-side flag read, so mounting a
   * presence surface never requires a react-query provider. The same slow
   * re-probe covers a 401/403/404 refusal (see {@link isSettledRefusal}).
   */
  pushEnabled?: boolean;
  /** Live peer list sink (called from both the poll and the push path). */
  onPeers: (peers: PresencePeer[]) => void;
  /** Latest local cursor to carry on the next heartbeat (undefined = none). */
  getCursor: () => PresenceCursor | undefined;
  /** Injectable for tests; defaults to the global fetch (SSE) / clientFetch (poll). */
  streamFetch?: typeof fetch;
}

export interface PresenceTransport {
  /** Close the stream, stop the heartbeat, best-effort DELETE the beacon. */
  stop: () => void;
}

function baseUrl(itemType: string, itemId: string): string {
  return `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/canvas-presence`;
}

function streamUrl(itemType: string, itemId: string, canvasKey: string): string {
  return `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/collab/stream?canvasKey=${encodeURIComponent(canvasKey)}`;
}

/** Fan a comments-changed push out to any open comment surface on the page. */
function dispatchCommentsChanged(detail: CollabCommentsEventDetail): void {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent<CollabCommentsEventDetail>(COLLAB_COMMENTS_EVENT, { detail }));
}

export function createPresenceTransport(opts: PresenceTransportOptions): PresenceTransport {
  const { itemType, itemId, canvasKey, onPeers, getCursor } = opts;
  const pushEnabled = opts.pushEnabled !== false;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let ttlMs = DEFAULT_TTL_MS;
  let streamAbort: AbortController | undefined;
  let pushAttempt = 0;
  /**
   * The poll's own settled-refusal latch. Set when a heartbeat POST is refused
   * with a settled status, cleared by the next accepted beat — so a repaired
   * grant restores the normal TTL/3 cadence with no reload.
   */
  let pollSettled = false;

  // ── Poll loop (heartbeat write + peers read — the always-on fallback) ─────
  const beat = async (): Promise<void> => {
    try {
      const r = await clientFetch(baseUrl(itemType, itemId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canvasKey, cursor: getCursor() }),
      });
      const j: unknown = await r.json().catch(() => ({}));
      const body = j as { ok?: boolean; peers?: unknown; ttlMs?: number };
      if (!stopped && r.ok && body?.ok) {
        pollSettled = false;
        onPeers(Array.isArray(body.peers) ? (body.peers as PresencePeer[]) : []);
        if (Number.isFinite(body.ttlMs) && (body.ttlMs as number) > 0) ttlMs = body.ttlMs as number;
      } else if (!r.ok && isSettledRefusal(r.status)) {
        // The BFF refused this beacon for a reason a 15s retry cannot change.
        // Slow to the re-probe cadence rather than re-POSTing every TTL/3.
        pollSettled = true;
      }
    } catch {
      /* transient — next tick retries */
    } finally {
      if (!stopped) {
        const interval = pollSettled
          ? SETTLED_REPROBE_MS
          : Math.max(MIN_HEARTBEAT_MS, Math.floor(ttlMs / 3));
        heartbeatTimer = setTimeout(() => { void beat(); }, interval);
      }
    }
  };

  // ── Push loop (SSE subscription — low-latency reads, never a dependency) ──
  const openStream = async (): Promise<void> => {
    if (stopped || !pushEnabled) return;
    const doFetch = opts.streamFetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!doFetch) return;
    streamAbort = new AbortController();
    // Belt-and-braces client-side lifetime cap alongside the server's — a
    // proxy that swallows the server close can't leave a zombie reader.
    const lifetimeCap = setTimeout(() => streamAbort?.abort(), STREAM_MAX_LIFETIME_MS + 10_000);
    let sawReconnect = false;
    let settled = false;
    try {
      const res = await doFetch(streamUrl(itemType, itemId, canvasKey), {
        headers: { accept: 'text/event-stream' },
        credentials: 'include',
        signal: streamAbort.signal,
        cache: 'no-store',
      });
      if (!res.ok || !res.body) {
        // A settled refusal (kill-switch OFF, or the item is not readable by
        // this caller) — drop to the slow re-probe; the poll carries presence
        // meanwhile. Anything else keeps the fast ramp.
        settled = isSettledRefusal(res.status);
        throw new Error(`stream HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSseBuffer(buffer);
        buffer = remaining;
        for (const ev of events) {
          if (ev.event === 'presence') {
            try {
              const data = JSON.parse(ev.data) as { peers?: unknown };
              if (Array.isArray(data.peers)) {
                pushAttempt = 0; // a live event proves the stream is healthy
                onPeers(data.peers as PresencePeer[]);
              }
            } catch { /* malformed frame — ignore, poll still authoritative */ }
          } else if (ev.event === 'canvas-comments') {
            dispatchCommentsChanged({ itemType, itemId, canvasKey, scope: 'canvas' });
          } else if (ev.event === 'item-comments') {
            dispatchCommentsChanged({ itemType, itemId, canvasKey, scope: 'item' });
          } else if (ev.event === 'reconnect') {
            sawReconnect = true;
          }
        }
        if (sawReconnect) break;
      }
    } catch {
      /* stream failed — fall through to the retry scheduler; poll unaffected */
    } finally {
      clearTimeout(lifetimeCap);
      streamAbort = undefined;
    }
    if (stopped) return;
    if (sawReconnect) {
      // Server-initiated clean rotation — reopen immediately, no backoff.
      void openStream();
      return;
    }
    const delay = settled ? SETTLED_REPROBE_MS : nextPushRetryMs(pushAttempt++);
    retryTimer = setTimeout(() => { void openStream(); }, delay);
  };

  void beat(); // immediate first heartbeat so the user appears at once
  void openStream();

  return {
    stop: () => {
      stopped = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (retryTimer) clearTimeout(retryTimer);
      streamAbort?.abort();
      // Best-effort leave — TTL would evict anyway, but this is instant.
      clientFetch(`${baseUrl(itemType, itemId)}?canvasKey=${encodeURIComponent(canvasKey)}`, {
        method: 'DELETE',
      }).catch(() => { /* ignore */ });
    },
  };
}
