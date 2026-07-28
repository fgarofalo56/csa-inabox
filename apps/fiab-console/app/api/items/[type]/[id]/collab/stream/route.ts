/**
 * GET /api/items/[type]/[id]/collab/stream — the A14 collab PUSH transport.
 *
 * One SSE stream per open editor/canvas that watches the item's REAL Cosmos
 * collab partitions and pushes an event the moment something changes:
 *
 *   event: presence        data: { peers, ttlMs, canvasKey }   (~1s cadence)
 *   event: canvas-comments data: { changed: true }             (~4s cadence)
 *   event: item-comments   data: { changed: true }             (~4s cadence)
 *   event: reconnect       data: { reason: 'rotate' }          (lifetime cap)
 *
 * Change-suppressed: each feed is signature-compared server-side and an event
 * is emitted ONLY on a real change (join/leave/cursor-move; comment add/edit/
 * resolve/delete) — never a per-tick firehose. All reads are single-partition
 * Cosmos queries on the item id (the same stores the poll routes use — real
 * persistence, no mock peers).
 *
 * Transport choice (A14 deviation, documented): SSE — the estate-proven
 * streaming pattern (Copilot orchestrate/help/chat stream SSE through the same
 * Front Door) — instead of the spec's opt-in Azure Web PubSub. Zero new infra,
 * identical on every cloud (Commercial / Gov / IL5 — no push service to
 * Learn-verify), and the poll transport remains the automatic fallback.
 *
 * Kill-switch: the `a14-collab-push` runtime flag (default-ON). OFF → this
 * route answers 503 and every client reverts to the pre-A14 poll path within
 * seconds, no roll. The flag is also re-checked in-stream so an open stream
 * winds down after a flip.
 *
 * Authorization: session + `loadOwnedItem` with read roles admitted — the same
 * guard as the canvas-presence poll route (a viewer is legitimately present).
 * Streams rotate every STREAM_MAX_LIFETIME_MS so auth + the flag are
 * re-evaluated on a fresh request and no zombie stream outlives a session.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiError, apiNotFound } from '@/lib/api/respond';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { runtimeFlag } from '@/lib/admin/runtime-flags';
import { listPresence } from '@/lib/collab/canvas-presence-store';
import { activePeers, presenceTtlMs } from '@/lib/collab/canvas-presence-model';
import { listCanvasComments } from '@/lib/collab/canvas-comment-store';
import { commentsContainer } from '@/lib/azure/cosmos-client';
import {
  COLLAB_PUSH_FLAG_ID,
  docsSignature,
  encodeSseEvent,
  presenceSignature,
  SSE_PING,
  STREAM_COMMENTS_TICK_MS,
  STREAM_MAX_LIFETIME_MS,
  STREAM_PING_MS,
  STREAM_PRESENCE_TICK_MS,
  type SignableDoc,
} from '@/lib/collab/collab-stream-model';

function canvasKeyOf(v: string | null): string {
  const k = typeof v === 'string' ? v.trim() : '';
  return k && k.length <= 120 ? k : 'default';
}

/** Item review-thread docs (single-partition read on the item id). */
async function listItemComments(itemId: string): Promise<SignableDoc[]> {
  const c = await commentsContainer();
  const { resources } = await c.items
    .query<SignableDoc>(
      {
        query: 'SELECT c.id, c.createdAt, c.updatedAt, c.resolved FROM c WHERE c.itemId = @i',
        parameters: [{ name: '@i', value: itemId }],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  return resources;
}

export const GET = withSession(async (req: NextRequest, { session, params }) => {
  const { type, id } = params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  if (!(await runtimeFlag(COLLAB_PUSH_FLAG_ID))) {
    // Honest OFF state: the client transport falls back to the poll path
    // (which keeps working end-to-end) and retries with capped backoff.
    return apiError('collab push transport is disabled (runtime flag a14-collab-push)', 503);
  }

  const canvasKey = canvasKeyOf(req.nextUrl.searchParams.get('canvasKey'));
  const readerOid = session.claims.oid;
  const ttlMs = presenceTtlMs();
  const encoder = new TextEncoder();
  let cancelStream: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t as ReturnType<typeof setInterval>);
        try { controller.close(); } catch { /* already closed */ }
      };
      // Reader-side cancellation (client disconnect surfaced as cancel rather
      // than an abort) must stop the Cosmos watch loops too.
      cancelStream = close;
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { close(); }
      };

      let lastPresenceSig: string | null = null;
      let lastCanvasSig: string | null = null;
      let lastItemSig: string | null = null;

      const pushPresence = async (): Promise<void> => {
        try {
          const docs = await listPresence(id, canvasKey);
          const peers = activePeers(docs, readerOid, Date.now(), ttlMs);
          const sig = presenceSignature(peers);
          if (sig !== lastPresenceSig) {
            lastPresenceSig = sig;
            send(encodeSseEvent('presence', { peers, ttlMs, canvasKey }));
          }
        } catch { /* transient Cosmos hiccup — next tick retries; poll unaffected */ }
      };

      const pushComments = async (): Promise<void> => {
        try {
          const canvas = await listCanvasComments(id, canvasKey);
          const sig = docsSignature(canvas);
          if (lastCanvasSig !== null && sig !== lastCanvasSig) {
            send(encodeSseEvent('canvas-comments', { changed: true }));
          }
          lastCanvasSig = sig;
        } catch { /* transient — next tick */ }
        try {
          const thread = await listItemComments(id);
          const sig = docsSignature(thread);
          if (lastItemSig !== null && sig !== lastItemSig) {
            send(encodeSseEvent('item-comments', { changed: true }));
          }
          lastItemSig = sig;
        } catch { /* transient — next tick */ }
      };

      // Initial snapshot at once (presence renders <1s after connect), then
      // baseline the comment signatures without emitting (the surfaces already
      // loaded their lists over the poll routes on mount).
      void pushPresence();
      void pushComments();

      timers.push(setInterval(() => { void pushPresence(); }, STREAM_PRESENCE_TICK_MS));
      timers.push(setInterval(() => { void pushComments(); }, STREAM_COMMENTS_TICK_MS));
      timers.push(setInterval(() => send(SSE_PING), STREAM_PING_MS));
      // Re-check the kill-switch in-stream so a flip winds an open stream down
      // within seconds (the client's reopen then gets the honest 503 → poll).
      timers.push(setInterval(() => {
        void runtimeFlag(COLLAB_PUSH_FLAG_ID).then((on) => { if (!on) close(); });
      }, 30_000));
      // Clean rotation: re-evaluate auth + flag on a fresh request.
      timers.push(setTimeout(() => {
        send(encodeSseEvent('reconnect', { reason: 'rotate' }));
        close();
      }, STREAM_MAX_LIFETIME_MS));

      req.signal.addEventListener('abort', close);
    },
    cancel() {
      cancelStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
