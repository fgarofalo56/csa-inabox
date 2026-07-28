/**
 * B-N19d — POST /api/insights/digests/[id]/run.
 *
 * Queues an out-of-band delivery: stamps `runNowRequestedAt` on the digest doc.
 * The EXISTING C5 report-subscriptions timer Function consumes + clears the
 * stamp on its next tick and delivers through the same Logic App as report
 * subscriptions. There is deliberately NO second scheduler and no console-side
 * email path — the console never sends mail, so a queued run is the honest
 * mechanism (the response says exactly that).
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiNotFound, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { deliveryGateBlock } from '@/lib/insights/digest-gate';
import { getDigest, requestRunNow } from '@/lib/insights/digest-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession(async (_req: NextRequest, { session, params }) => {
  const id = String(params.id || '');
  const tenantId = session.claims.oid;
  try {
    const existing = await getDigest(tenantId, id);
    if (!existing) return apiNotFound('digest not found');

    const queued = await requestRunNow(tenantId, id);
    if (!queued) return apiNotFound('digest not found');

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'insights.digest.queue-run',
      targetType: 'insight-digest',
      targetId: id,
      outcome: 'success',
      tenantId,
      detail: { name: queued.name, recipients: queued.recipients.length },
    });

    return apiOk({
      digest: queued,
      queuedAt: queued.runNowRequestedAt,
      message:
        'Queued. The report-subscriptions timer Function delivers this digest on its next tick (REPORT_SUBSCRIPTIONS_CRON) — the same scheduler that delivers report subscriptions.',
      deliveryGate: deliveryGateBlock(),
    });
  } catch (e) {
    return apiServerError(e, 'Failed to queue the digest run', 'insight_digest_queue_failed');
  }
});
