/**
 * Report subscription delivery log — the "delivery log" half of the acceptance
 * receipt.
 *
 *   GET /api/items/report/[id]/subscriptions/[subId]/logs
 *         → { ok, logs: ReportDeliveryLog[] }
 *         Append-only delivery history for one subscription (most-recent
 *         first), written by the report-subscriptions ACA job after
 *         each scheduled export+email. Only the subscription's owner may read.
 *
 * No Microsoft Fabric dependency — the log records deliveries rendered by the
 * Azure-native paginated-report-renderer (NOT Power BI ExportTo, which is
 * unavailable in GCC-High) and emailed via the delivery Logic App.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import {
  reportSubscriptionsContainer,
  reportDeliveryLogContainer,
  type ReportSubscription,
  type ReportDeliveryLog,
} from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LOGS = 100;

export const GET = withSession<{ id: string; subId: string }>(async (req: NextRequest, { session, params }) => {
  const reportId = String(params.id || '');
  const subId = String(params.subId || '');

  try {
    // Ownership check — the subscription is partitioned by reportId.
    const subs = await reportSubscriptionsContainer();
    let sub: ReportSubscription | null = null;
    try {
      const { resource } = await subs.item(subId, reportId).read<ReportSubscription>();
      sub = resource ?? null;
    } catch (e: any) {
      if (e?.code !== 404) throw e;
    }
    if (!sub) return NextResponse.json({ ok: false, error: 'subscription not found' }, { status: 404 });
    if (sub.createdBy !== session.claims.oid) {
      return NextResponse.json({ ok: false, error: 'only the subscription owner may read its delivery log' }, { status: 403 });
    }

    const top = Math.min(Number(req.nextUrl.searchParams.get('top')) || MAX_LOGS, MAX_LOGS);
    const c = await reportDeliveryLogContainer();
    const { resources } = await c.items
      .query<ReportDeliveryLog>({
        query: 'SELECT TOP @n * FROM c WHERE c.subscriptionId = @s ORDER BY c.deliveredAt DESC',
        parameters: [
          { name: '@n', value: top },
          { name: '@s', value: subId },
        ],
      })
      .fetchAll();
    return NextResponse.json({ ok: true, logs: resources });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});
