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
 *
 * COST/ABUSE SURFACE — WHY THIS ROUTE NOW SHAPE-CHECKS AND RATE-LIMITS (#3400
 * re-review, 2026-09-09). Before the cross-replica store existed, an unknown
 * requestId was a pure in-memory `Map` miss: replica-local, no side effect, so
 * `withSession` alone was proportionate. It is not any more — the same branch
 * now performs a Cosmos upsert with an `id` taken verbatim from the request
 * body, so an authenticated session could drive unbounded document writes into
 * `sql-cancel-intents` with ids of its choosing. Two bounds, both BEFORE
 * `recordCancelIntent`:
 *
 *   1. the id must match a shape a Loom client actually mints — a UUID, or the
 *      `req-<ms>-<base36>` fallback all three SQL editors use when
 *      `crypto.randomUUID` is unavailable (a secure-context-only API, so that
 *      branch is live on a plain-http host). A bare UUID check was the review's
 *      suggestion and would have 400'd that path;
 *   2. `enforceRateLimit(session, 'query')` — the SAME bucket the sibling
 *      /query route uses (query/route.ts:57), so a cancel cannot be cheaper to
 *      spam than the query it cancels.
 *
 * The shape check bounds WHICH document ids a body can name; the rate limit
 * bounds HOW MANY. Neither is authenticity — either shape is forgeable — and
 * the code does not claim otherwise.
 *
 * This is NOT privilege escalation and the code does not claim it was: ids are
 * random UUIDs, so another user's in-flight requestId is not guessable, and the
 * bound is a cost/DoS bound rather than an access-control one. The remaining
 * access-control gap — this route never resolves `[id]` and so never runs the
 * owner check the /query route runs via `loadOwnedSqlItem` — is tracked on
 * #4407 and deliberately NOT folded in here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { liveRequests, unregisterLiveRequest, recordCancelIntent, cancelIntentUnavailableReason } from '@/lib/azure/azure-sql-client';
import { withSession } from '@/lib/api/route-toolkit';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The id shapes a REAL Loom client mints, and nothing else.
 *
 * NOT a bare UUID check, which is what the review suggested and what I started
 * with — measured against the callers, that would have 400'd a live path. All
 * three SQL editors mint the id the same way and all three carry a fallback:
 *
 *   lib/editors/unified-sql-database-editor.tsx:915-917
 *   lib/editors/azure-sql-editors.tsx:956-958 and :1442-1444
 *     crypto.randomUUID() when available, else `req-${Date.now()}-${base36}`
 *
 * `crypto.randomUUID` is secure-context-only, so the fallback is reachable on a
 * plain-http dev host. Rejecting it would have made Cancel return 400 exactly
 * there. Both shapes are accepted, anchored, with a length ceiling — the point
 * is to bound the id space a request body can name for the Cosmos upsert below,
 * not to certify RFC-4122 conformance.
 *
 * This is a SHAPE bound, not an authenticity one, and the code does not pretend
 * otherwise: a caller can forge either shape just as easily. What it removes is
 * an arbitrary attacker-chosen document id (and unbounded id length); what
 * bounds the VOLUME is the rate limit immediately after it.
 */
const REQUEST_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|req-\d{1,20}-[a-z0-9]{1,32})$/i;

export const POST = withSession(async (req: NextRequest, { session }) => {
  const body = await req.json().catch(() => ({}));
  const requestId = String(body?.requestId || '').trim();
  if (!requestId) {
    return NextResponse.json({ ok: false, error: 'requestId is required' }, { status: 400 });
  }
  // Shape-check BEFORE any lookup or write. An id outside these shapes can match
  // nothing in `liveRequests` either — every entry there was keyed by an id one
  // of the three editors above minted — so rejecting here costs no reachable
  // behaviour; it only removes the attacker-chosen Cosmos document id below.
  if (!REQUEST_ID_RE.test(requestId)) {
    return NextResponse.json(
      { ok: false, error: 'requestId is not a well-formed Loom request id (the value /query was called with)' },
      { status: 400 },
    );
  }
  // Same bucket as the sibling /query route, so a cancel is not a cheaper way
  // to reach the same backends than the query it cancels.
  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;
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
  // `unregisterLiveRequest`, NOT a bare `liveRequests.delete` — the two teardown
  // call sites must not differ. The bare delete leaves the poll watcher running
  // until some other path happens to call `stopCancelWatcherIfIdle()`; it
  // self-heals on the next `.finally()` in azure-sql-client, which is why this
  // was cosmetic rather than a leak, but "cosmetic because something else cleans
  // up after me" is not an invariant worth keeping.
  unregisterLiveRequest(requestId);
  return NextResponse.json({ ok: true, cancelled: true, requestId });
});
