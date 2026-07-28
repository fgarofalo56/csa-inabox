/**
 * reportSubscriptions — timer-triggered Azure Function (Node v4 model).
 *
 * Fires on REPORT_SUBSCRIPTIONS_CRON (NCRONTAB, 6-field — default weekdays at
 * 08:00 UTC, but a finer cadence is recommended so per-subscription schedules
 * fire close to their intended time). On each tick it processes every enabled
 * report subscription whose own schedule became due in the window since the
 * previous tick (see subscription-engine.runSubscriptions).
 *
 * The window is derived from the timer's scheduleStatus.last → now. On the very
 * first run (no prior status) it falls back to a one-interval lookback so a
 * subscription due "right now" is not silently skipped.
 *
 * No Microsoft Fabric dependency — exports run against the Power BI ExportTo
 * REST API and delivery uses an Azure Consumption Logic App.
 *
 * B-N19d: the SAME tick also processes scheduled insight digests
 * (`insights-engine.runInsightDigests`) — Azure Monitor metric/alert deltas,
 * Copilot narration, delivered through the SAME Logic App. Deliberately one
 * scheduler: a digest failure never blocks report delivery and vice versa.
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { runSubscriptions } from '../subscription-engine';
import { runInsightDigests } from '../insights-engine';

const SCHEDULE = process.env.REPORT_SUBSCRIPTIONS_CRON || '0 0 8 * * 1-5';
// Fallback lookback when scheduleStatus is absent (first run / cold start).
const FALLBACK_WINDOW_MS = Number(process.env.REPORT_SUBSCRIPTIONS_FALLBACK_WINDOW_MS) || 15 * 60_000;

app.timer('reportSubscriptions', {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer: Timer, context: InvocationContext) => {
    const now = Date.now();
    // scheduleStatus.last is the ISO time of the previous occurrence; use it as
    // the window start so each subscription fires exactly once across ticks.
    const lastIso = timer?.scheduleStatus?.last;
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const windowStart = Number.isFinite(lastMs) && lastMs < now ? lastMs : now - FALLBACK_WINDOW_MS;

    try {
      await runSubscriptions(
        {
          log: (m: string) => context.log(m),
          warn: (m: string) => context.warn(m),
          error: (m: string) => context.error(m),
        },
        windowStart,
        now,
      );
    } catch (e: any) {
      context.error(`report-subscriptions tick failed: ${e?.message || e}`);
      throw e;
    }

    // B-N19d — scheduled insight digests ride the same tick. Isolated so a
    // digest problem (Monitor RBAC, AOAI outage) can never fail or delay the
    // report-subscription deliveries above.
    try {
      await runInsightDigests(
        {
          log: (m: string) => context.log(m),
          warn: (m: string) => context.warn(m),
          error: (m: string) => context.error(m),
        },
        windowStart,
        now,
      );
    } catch (e: any) {
      context.error(`insight-digests tick failed: ${e?.message || e}`);
    }
  },
});
