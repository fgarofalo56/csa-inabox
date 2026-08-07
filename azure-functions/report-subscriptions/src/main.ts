#!/usr/bin/env node
/**
 * report-subscriptions — Container App Job entrypoint (WS-C2, B-FN C3).
 *
 * One-shot process: `modules/admin-plane/report-subscriptions-job.bicep`
 * schedules `loom-report-subscriptions` (Schedule trigger, default every 15
 * minutes) in the console's VNet-integrated Container Apps Environment, running
 * as the console UAMI. Each execution runs exactly one delivery pass — and then
 * one B-N19d insight-digest pass — and exits.
 *
 * WHY AN ACA JOB, NOT A Y1 FUNCTION (estate constraint, operator decision
 * 2026-07-23; re-measured 2026-08-06): the Function-hosted runtime on this
 * estate executes nothing.
 *
 *   LOAD-BEARING EVIDENCE — FunctionExecutionCount (2026-07-25→08-06, P1D,
 *   Total) sums to ZERO for ALL SEVEN Function Apps in
 *   rg-csa-loom-admin-centralus: errorCode=Success, 13 of 13 datapoints with an
 *   EXPLICIT `total: 0.0`, none absent. Real measured zeros, not missing data.
 *   func-rptsub-… additionally indexes no functions at all
 *   (`az functionapp function list` → `[]`, exit 0), so this timer had never
 *   fired once.
 *
 * Do NOT re-derive this from `function list` alone — it does not generalise.
 * func-secexp-… and func-cpeval-… hold indexed, ENABLED timers, and
 * func-loom-prpt-renderer-…'s list call fails with `Bad Request` (unknown, not
 * empty). Only the execution metric covers all seven. No root cause is claimed:
 * two hosts index fine under the same Azure Policy regime, so any
 * "policy seals the storage data-plane" story would not explain its own
 * variance. The in-VNet ACA-job pattern (lineage-extractor-job.bicep /
 * secret-expiry-monitor-job.bicep) is the estate standard. Managed identity
 * only — no keys, no host storage.
 *
 * Exit code: 0 on a completed pass INCLUDING an honest config gate (an unset
 * Cosmos endpoint or an undeployed delivery Logic App is a configuration state,
 * not a code failure) AND including per-subscription delivery failures, which
 * are durable telemetry on the ReportDeliveryLog row rather than a process
 * fault. Non-zero ONLY on an unexpected throw, so a Failed execution in the ACA
 * job history is always a real regression worth paging on.
 */
import { runDeliveryPass } from './run-delivery';
import { runInsightDigests } from './insights-engine';
import { consoleLogger } from './run-logger';

/**
 * B-N19d window. The job's Schedule trigger has no `scheduleStatus.last` (that
 * was a Functions timer concept), so the digest window is the job cadence: any
 * digest whose cron fell in the last `LOOM_DIGEST_WINDOW_MS` is due. Default 15
 * minutes to match the every-15-minutes cron in
 * report-subscriptions-job.bicep. Widening it only risks a duplicate send,
 * which `runNowRequestedAt` / `lastRunAt` already guard; narrowing it below the
 * cadence would silently DROP digests.
 */
const DIGEST_WINDOW_MS = Number(process.env.LOOM_DIGEST_WINDOW_MS) || 15 * 60_000;

async function main(): Promise<void> {
  const started = Date.now();
  const summary = await runDeliveryPass(consoleLogger);
  const ms = Date.now() - started;
  if (!summary.ran) {
    console.log(`[report-subscriptions] pass gated after ${ms}ms (missing: ${summary.gate}).`);
  } else {
    console.log(
      `[report-subscriptions] pass complete in ${ms}ms — enabled=${summary.enabled} due=${summary.due} `
      + `delivered=${summary.delivered} failed=${summary.failed}`,
    );
  }

  // B-N19d — scheduled insight digests ride the SAME execution. Isolated in its
  // own try/catch so a digest problem (Monitor RBAC, AOAI outage) can never
  // fail or delay the report deliveries above, and so a gated delivery pass
  // does not skip digests. Per the exit-code contract this does NOT rethrow:
  // a digest failure is durable telemetry on the insight-digest-log row, not a
  // process fault, so a Failed execution stays a real regression.
  const digestStarted = Date.now();
  try {
    const d = await runInsightDigests(consoleLogger, digestStarted - DIGEST_WINDOW_MS, digestStarted);
    console.log(
      `[insight-digests] pass complete in ${Date.now() - digestStarted}ms — scanned=${d.scanned} `
      + `due=${d.due} delivered=${d.delivered} failed=${d.failed} gated=${d.gated}`,
    );
  } catch (e: unknown) {
    console.error(
      `[insight-digests] pass FAILED (report deliveries above are unaffected): `
      + `${e instanceof Error ? e.stack || e.message : String(e)}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`[report-subscriptions] pass FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  },
);
