/**
 * report-subscriptions delivery pass (WS-C2) — the runtime, decoupled from any host.
 *
 * One pass:
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
 *
 * B-FN migration (C3, 2026-08-06): this body is the former
 * `src/functions/deliverSubscriptions.ts` handler with `InvocationContext`
 * replaced by the host-agnostic `RunLogger`, so the same logic runs under the
 * `Microsoft.App/jobs` entrypoint (src/main.ts). No behaviour change.
 */
import { dueSubscriptions } from './schedule';
import {
  readEnabledSubscriptions, renderReport, deliverViaLogicApp, recordDelivery,
} from './clients';
import type { RunLogger } from './run-logger';

export interface DeliveryPassSummary {
  /** False when the pass honest-gated on missing configuration (still exit 0). */
  ran: boolean;
  /** The config value that was missing when `ran` is false. */
  gate?: string;
  enabled: number;
  due: number;
  delivered: number;
  failed: number;
}

/**
 * Configuration required before a pass can do anything at all. An unset value
 * here is a CONFIGURATION state, not a code failure — the pass reports it and
 * exits 0 so a Failed execution in the job history is always a real regression
 * (the secret-expiry-monitor convention).
 */
function configGate(): string | undefined {
  if (!process.env.LOOM_COSMOS_ENDPOINT) return 'LOOM_COSMOS_ENDPOINT';
  return undefined;
}

export async function runDeliveryPass(
  logger: RunLogger,
  now: Date = new Date(),
): Promise<DeliveryPassSummary> {
  const gate = configGate();
  if (gate) {
    logger.warn(
      `[report-subscriptions] honest gate: ${gate} is not set, so no subscription store is reachable. `
      + 'Deploy modules/admin-plane/report-subscriptions-job.bicep (it wires LOOM_COSMOS_ENDPOINT from the admin-plane Cosmos account).',
    );
    return { ran: false, gate, enabled: 0, due: 0, delivered: 0, failed: 0 };
  }

  let subs;
  try {
    subs = await readEnabledSubscriptions();
  } catch (e: any) {
    logger.error(`[report-subscriptions] cannot read subscriptions: ${e?.message || e}`);
    return { ran: false, gate: 'cosmos-read', enabled: 0, due: 0, delivered: 0, failed: 0 };
  }

  const due = dueSubscriptions(subs, now);
  logger.log(`[report-subscriptions] ${subs.length} enabled, ${due.length} due at ${now.toISOString()}`);

  let delivered = 0;
  let failed = 0;
  for (const sub of due) {
    try {
      const { base64, sizeBytes } = await renderReport(sub);
      await deliverViaLogicApp(sub, base64);
      await recordDelivery(sub, { status: 'succeeded', sizeBytes }, now);
      delivered += 1;
      logger.log(`[report-subscriptions] delivered ${sub.id} (${sizeBytes} bytes) to ${sub.recipients.length} recipient(s)`);
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 400);
      failed += 1;
      logger.error(`[report-subscriptions] ${sub.id} FAILED: ${error}`);
      // Honest failure telemetry — the delivery-log row records the real error.
      await recordDelivery(sub, { status: 'failed', error }, now).catch(() => { /* best-effort */ });
    }
  }

  return { ran: true, enabled: subs.length, due: due.length, delivered, failed };
}
