/**
 * POST /api/items/azure-sql-database/[id]/query/cancel
 *   body { requestId: string }
 *
 * Sends a TDS ATTENTION packet to the in-flight mssql `Request` identified by
 * `requestId`, causing the tedious driver to reject the running `.query()`
 * promise with `RequestError('Canceled.', 'ECANCEL')`. The /query route's catch
 * block then surfaces this to the client as
 * `{ ok: false, error: 'Canceled.', code: 'ECANCEL' }` — that response IS the
 * "TDS reports cancellation" receipt.
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
 * That store is NOT implemented yet — it needs a Cosmos container registered in
 * `lib/azure/cosmos-client.ts` and in the cosmos bicep `loomContainers` list.
 * Until it lands, a cancel that reaches the wrong replica is a no-op, and this
 * route says so instead of reporting a cancellation it did not perform.
 */

import { NextRequest, NextResponse } from 'next/server';
import { liveRequests } from '@/lib/azure/azure-sql-client';
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
    // R7 — state ONLY what was established. This replica holds no live request
    // under that id; the code cannot tell "already completed" from "started on
    // another replica", so it must not assert either. `ok:true` because the
    // call itself was handled and is idempotent (the UI may cancel while the
    // query is completing); `cancelled:false` because nothing was cancelled.
    return NextResponse.json({
      ok: true,
      cancelled: false,
      reason:
        'No in-flight request with that id is registered on the replica that received this call. '
        + 'It has either already completed, or it is running on a different console replica — this '
        + 'endpoint cannot distinguish the two, and no cross-replica cancel signal exists yet (#3400).',
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
