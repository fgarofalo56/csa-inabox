#!/usr/bin/env node
/**
 * report-subscriptions — Container App Job entrypoint (WS-C2, B-FN C3).
 *
 * One-shot process: `modules/admin-plane/report-subscriptions-job.bicep`
 * schedules `loom-report-subscriptions` (Schedule trigger, default every 15
 * minutes) in the console's VNet-integrated Container Apps Environment, running
 * as the console UAMI. Each execution runs exactly one delivery pass and exits.
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
import { consoleLogger } from './run-logger';

async function main(): Promise<void> {
  const started = Date.now();
  const summary = await runDeliveryPass(consoleLogger);
  const ms = Date.now() - started;
  if (!summary.ran) {
    console.log(`[report-subscriptions] pass gated after ${ms}ms (missing: ${summary.gate}).`);
    return;
  }
  console.log(
    `[report-subscriptions] pass complete in ${ms}ms — enabled=${summary.enabled} due=${summary.due} `
    + `delivered=${summary.delivered} failed=${summary.failed}`,
  );
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`[report-subscriptions] pass FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  },
);
