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
 * 2026-07-23; re-measured 2026-08-06): Y1 Linux Consumption Functions are
 * structurally broken on this estate — Azure Policy seals the storage
 * data-plane (publicNetworkAccess Disabled, AAD-only, no private endpoint) and
 * the multitenant Y1 runtime is not a trusted service, so host keys and timer
 * leases fail. Measured on 2026-08-06: `az functionapp function list` returned
 * `[]` (exit 0) for ALL SEVEN Function Apps in rg-csa-loom-admin-centralus and
 * the ANONYMOUS health route on func-csa-loom-mcp returned HTTP 404 — the hosts
 * have indexed zero functions, so `func-rptsub-…`'s timer has never fired.
 * The in-VNet ACA-job pattern (lineage-extractor-job.bicep /
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
