/**
 * POST /api/items/azure-sql-database/[id]/query/cancel
 *   body { requestId: string }
 *
 * Sends a TDS ATTENTION packet to the in-flight mssql `Request` identified by
 * `requestId`, causing the tedious driver to reject the running `.query()`
 * promise with `RequestError('Canceled.', 'ECANCEL')`. The /query route's catch
 * block then surfaces this to the client as
 * `{ ok: false, canceled: true, error: 'Query canceled by user.', code: 'ECANCEL' }`
 * with HTTP 200 — the same shape every sibling SQL query route returns — and
 * THAT response IS the "TDS reports cancellation" receipt.
 *
 * `requestId` is generated client-side (crypto.randomUUID()) and passed in the
 * /query POST body so the BFF registers the Request in `liveRequests` BEFORE
 * execution begins.
 *
 * Scope note (#3400/#3399). `liveRequests` is in-process Node.js state on ONE
 * Container App replica, and `loom-console` runs `multiRevision: true` with
 * `minReplicas: 2` — so a cancel POST can land on a replica that never started
 * the query.
 *
 * THE ANSWER IS NOT SESSION AFFINITY. This comment used to tell the reader to
 * set `ingress.stickySessions.affinity: 'sticky'` or run a single replica. ACA
 * REQUIRES `affinity:'none'` in multiple-revision mode, and
 * app-deployments.bicep now asserts that value on every deploy so a sticky
 * value set out-of-band cannot wedge blue-green rolls again (it failed 4 of 4
 * console-bluegreen-roll runs). A reader following the old advice would break
 * the roll and have the setting reverted by the next deploy.
 *
 * The correct fix is a cross-replica cancel signal: a TTL'd cancel-intent
 * record keyed by requestId that every replica polls for its OWN live keys.
 * That store IS the mechanism now (`recordCancelIntent` in azure-sql-client),
 * so a cancel that lands on the wrong replica is no longer a no-op — it is
 * persisted, and the replica that owns the request acts on it.
 *
 * WHAT THE RESPONSE PROMISES (R7). `cancelled:true` is returned ONLY when this
 * replica held the request and called `.cancel()` itself. Otherwise the honest
 * answer is `cancelled:'requested'` — the signal was persisted, which is not the
 * same as a query having stopped. Only the /query response's `code: 'ECANCEL'`
 * establishes that, and the client should treat that as the receipt. When the
 * intent store is unavailable the route says so and claims nothing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { liveRequests, recordCancelIntent, cancelIntentUnavailableReason } from '@/lib/azure/azure-sql-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const requestId = String(body?.requestId || '').trim();
  if (!requestId) {
    return NextResponse.json({ ok: false, error: 'requestId is required' }, { status: 400 });
  }
  const request = liveRequests.get(requestId);
  if (!request) {
    // Not this replica's request. Publish a cross-replica cancel intent; the
    // replica that owns it picks the intent up on its next poll and sends the
    // TDS ATTENTION packet (#3400).
    const persisted = await recordCancelIntent(requestId);
    if (persisted) {
      // R7 — 'requested', NOT 'cancelled'. What was established is that the
      // signal is stored, not that a query stopped. The /query response
      // (code ECANCEL) is the receipt for the cancellation itself.
      return NextResponse.json({
        ok: true,
        cancelled: 'requested',
        reason:
          'No in-flight request with that id is registered on the replica that received this call, so a '
          + 'cross-replica cancel intent was recorded instead. If the query is still running on another '
          + 'replica it will be cancelled within one poll interval and its /query call returns code ECANCEL; '
          + 'if it had already completed the intent simply expires. This endpoint cannot distinguish those '
          + 'two cases and does not claim to.',
        crossReplica: true,
        requestId,
      });
    }
    // R7 — state ONLY what was established. This replica holds no live request
    // under that id, and no intent could be published to carry the signal
    // anywhere else, so nothing was cancelled and nothing was requested. The
    // cause comes from `cancelIntentUnavailableReason()`, which reports which
    // branch was actually taken (opt-out / no Cosmos endpoint / init failed and
    // backing off / write threw) rather than asserting one of them.
    // `ok:true` because the call itself was handled and is idempotent (the UI
    // may cancel while the query is completing); `cancelled:false` because
    // nothing was cancelled.
    return NextResponse.json({
      ok: true,
      cancelled: false,
      reason:
        'No in-flight request with that id is registered on the replica that received this call. '
        + 'It has either already completed, or it is running on a different console replica — this '
        + 'endpoint cannot distinguish the two, and no cross-replica cancel intent could be published: '
        + `${cancelIntentUnavailableReason()}.`,
      crossReplica: false,
      requestId,
    });
  }
  try {
    request.cancel(); // tedious: connection.cancel() → TDS ATTENTION packet
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
  liveRequests.delete(requestId);
  return NextResponse.json({ ok: true, cancelled: true, requestId });
});
