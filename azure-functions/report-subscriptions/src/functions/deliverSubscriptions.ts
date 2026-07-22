/**
 * report-subscriptions timer Function (WS-C2) — the delivery runtime.
 *
 * On REPORT_SUBSCRIPTIONS_CRON it:
 *   1. reads enabled report subscriptions from Cosmos,
 *   2. selects the ones whose OWN NCRONTAB cron is due this minute (schedule.ts),
 *   3. renders each Azure-native via the paginated-report-renderer (NO Power BI
 *      ExportTo — Gov-safe, no Fabric dependency),
 *   4. POSTs the rendered bytes to the delivery Logic App (Office 365 email),
 *   5. appends a ReportDeliveryLog row + patches lastRun on the subscription.
 *
 * Every failure is caught PER subscription and logged (honest telemetry the
 * [subId]/logs route surfaces) — one bad report never blocks the batch.
 * Managed-identity auth, no keys (no-vaporware.md).
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { dueSubscriptions } from '../schedule';
import {
  readEnabledSubscriptions, renderReport, deliverViaLogicApp, recordDelivery,
} from '../clients';

export async function deliverSubscriptions(_timer: Timer, context: InvocationContext): Promise<void> {
  const now = new Date();
  let subs;
  try {
    subs = await readEnabledSubscriptions();
  } catch (e: any) {
    context.error(`[report-subscriptions] cannot read subscriptions: ${e?.message || e}`);
    return;
  }
  const due = dueSubscriptions(subs, now);
  context.log(`[report-subscriptions] ${subs.length} enabled, ${due.length} due at ${now.toISOString()}`);

  for (const sub of due) {
    try {
      const { base64, sizeBytes } = await renderReport(sub);
      await deliverViaLogicApp(sub, base64);
      await recordDelivery(sub, { status: 'succeeded', sizeBytes }, now);
      context.log(`[report-subscriptions] delivered ${sub.id} (${sizeBytes} bytes) to ${sub.recipients.length} recipient(s)`);
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 400);
      context.error(`[report-subscriptions] ${sub.id} FAILED: ${error}`);
      // Honest failure telemetry — the delivery-log row records the real error.
      await recordDelivery(sub, { status: 'failed', error }, now).catch(() => { /* best-effort */ });
    }
  }
}

app.timer('deliverSubscriptions', {
  schedule: process.env.REPORT_SUBSCRIPTIONS_CRON || '0 0 8 * * 1-5',
  handler: deliverSubscriptions,
});
