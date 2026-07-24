/**
 * collab-stream-model — the PURE (no-Cosmos, no-DOM) logic layer for the A14
 * collab PUSH transport. Owns every decision the SSE stream route
 * (app/api/items/[type]/[id]/collab/stream) and the client transport
 * (presence-transport.ts) share, so both sides are unit-tested without a
 * Cosmos account or a browser:
 *
 *   • the event vocabulary ({@link CollabStreamEventName}) one stream carries —
 *     presence, canvas-comments, item-comments, reconnect;
 *   • the server cadences (presence tick, comments tick, keep-alive ping,
 *     max stream lifetime before a forced clean reconnect);
 *   • change-detection signatures ({@link presenceSignature} /
 *     {@link docsSignature}) so the server pushes an event ONLY when something
 *     actually changed — never a per-tick firehose;
 *   • SSE wire encoding/decoding ({@link encodeSseEvent} /
 *     {@link parseSseBuffer}) — the exact `event:`/`data:` framing the estate's
 *     Copilot streams already use;
 *   • the client retry backoff ({@link nextPushRetryMs}).
 *
 * Transport design (spec A14, round-3 deviation note): the push transport is
 * SSE — the estate-proven streaming pattern (Copilot orchestrate/help/chat all
 * stream SSE through the same Front Door) — not Azure Web PubSub. Zero new
 * infra, default-ON via the `a14-collab-push` runtime kill-switch; OFF (or any
 * stream failure) reverts to the pre-A14 poll transport with no roll.
 */

import type { PresencePeer } from './canvas-presence-model';

/** FLAG0 runtime kill-switch id — OFF reverts every surface to the poll path. */
export const COLLAB_PUSH_FLAG_ID = 'a14-collab-push';

/** Events one collab stream multiplexes. */
export type CollabStreamEventName =
  | 'presence'        // { peers: PresencePeer[] } — live peers on the canvasKey
  | 'canvas-comments' // { changed: true } — canvas sticky comments changed
  | 'item-comments'   // { changed: true } — item review thread changed
  | 'reconnect';      // server-initiated clean rotation — client reopens at once

/** Server-side Cosmos read cadence for presence (single-partition, ~3 RU). */
export const STREAM_PRESENCE_TICK_MS = 1_000;
/** Server-side Cosmos read cadence for the two comment feeds. */
export const STREAM_COMMENTS_TICK_MS = 4_000;
/** SSE keep-alive comment cadence (defeats idle-timeout proxies). */
export const STREAM_PING_MS = 15_000;
/**
 * Max lifetime of one stream connection. The server then emits `reconnect`
 * and closes so auth + the runtime flag are re-evaluated on a fresh request
 * (and no zombie stream outlives a revoked session behind Front Door).
 */
export const STREAM_MAX_LIFETIME_MS = 4 * 60_000;

/** Client push-retry backoff bounds (stream error → retry; poll keeps running). */
export const PUSH_RETRY_MIN_MS = 5_000;
export const PUSH_RETRY_MAX_MS = 60_000;

/** Exponential backoff for push reconnect attempts, clamped to the bounds. */
export function nextPushRetryMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  const ms = PUSH_RETRY_MIN_MS * 2 ** n;
  return Math.min(PUSH_RETRY_MAX_MS, ms);
}

/**
 * Stable change signature for a peer list. Excludes `lastSeen` on purpose —
 * a heartbeat that changes nothing visible must NOT push an event; only a
 * join/leave, rename, or cursor move does. Order-insensitive (sorted by oid).
 */
export function presenceSignature(peers: ReadonlyArray<PresencePeer>): string {
  return [...peers]
    .sort((a, b) => (a.oid < b.oid ? -1 : 1))
    .map((p) => `${p.oid}|${p.name ?? ''}|${p.cursor ? `${p.cursor.x},${p.cursor.y}` : ''}`)
    .join(';');
}

/** Minimal doc shape both comment feeds share for change detection. */
export interface SignableDoc {
  id: string;
  updatedAt?: string;
  createdAt?: string;
  resolved?: boolean;
}

/**
 * Stable change signature for a comment list (canvas stickies OR the item
 * review thread). Order-insensitive; fires on add / delete / edit / resolve.
 */
export function docsSignature(docs: ReadonlyArray<SignableDoc>): string {
  return docs
    .map((d) => `${d.id}|${d.updatedAt ?? d.createdAt ?? ''}|${d.resolved === true ? 1 : 0}`)
    .sort()
    .join(';');
}

/** Encode one SSE event block (the exact framing the Copilot streams emit). */
export function encodeSseEvent(event: CollabStreamEventName, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE keep-alive comment line (ignored by parsers, keeps proxies awake). */
export const SSE_PING = ': ping\n\n';

/** One parsed SSE event off the wire. */
export interface ParsedSseEvent {
  event: string;
  data: string;
}

/**
 * Incremental SSE buffer parser (same idiom as the Copilot panes' parseSse,
 * factored here so the collab transport's copy is unit-tested). Returns the
 * complete events found and the unterminated remainder to carry forward.
 */
export function parseSseBuffer(buffer: string): { events: ParsedSseEvent[]; remaining: string } {
  const out: ParsedSseEvent[] = [];
  const blocks = buffer.split(/\n\n/);
  const remaining = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.slice(6);
    }
    if (data) out.push({ event, data });
  }
  return { events: out, remaining };
}

/** Detail carried on the `loom:collab-comments` window CustomEvent. */
export interface CollabCommentsEventDetail {
  itemType: string;
  itemId: string;
  canvasKey: string;
  /** Which feed changed: the canvas stickies or the item review thread. */
  scope: 'canvas' | 'item';
}

/** Window event name comment surfaces subscribe to for live refresh. */
export const COLLAB_COMMENTS_EVENT = 'loom:collab-comments';
