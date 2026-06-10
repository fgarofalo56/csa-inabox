/**
 * Report subscription delivery log — the "delivery log" half of the acceptance
 * receipt.
 *
 *   GET /api/items/report/[id]/subscriptions/[subId]/logs
 *         → { ok, logs: ReportDeliveryLog[] }
 *         Append-only delivery history for one subscription (most-recent
 *         first), written by the fiab-report-subscriptions timer Function after
 *         each scheduled export+email. Only the subscription's owner may read.
 *
 * No Microsoft Fabric dependency — the log records real Power BI ExportTo
 * deliveries archived to ADLS + emailed via the delivery Logic App.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  reportSubscriptionsContainer,
  reportDeliveryLogContainer,
  type ReportSubscription,
  type ReportDeliveryLog,
} from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LOGS = 100;

function unauth() {
  return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; subId: string }> }) {
  const s = getSession();
  if (!s) return unauth();
  const { id: reportId, subId } = await ctx.params;

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
    if (sub.createdBy !== s.claims.oid) {
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
}
