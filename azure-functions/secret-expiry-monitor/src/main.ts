#!/usr/bin/env node
/**
 * secret-expiry-monitor — Container App Job entrypoint (S1).
 *
 * One-shot process: `modules/admin-plane/secret-expiry-monitor-job.bicep`
 * schedules `loom-secret-expiry-monitor` (Schedule trigger, default daily 06:00
 * UTC) in the console's VNet-integrated Container Apps Environment, running as
 * the console UAMI. Each execution runs exactly one monitor pass and exits.
 *
 * WHY AN ACA JOB, NOT A Y1 FUNCTION (estate constraint, operator decision
 * 2026-07-23): Y1 Linux Consumption Functions are structurally broken on this
 * estate — Azure Policy seals the storage data-plane (publicNetworkAccess
 * Disabled, AAD-only, no private endpoint) and the multitenant Y1 runtime is
 * not a trusted service, so host keys and timer leases fail. The in-VNet
 * ACA-job pattern (lineage-extractor-job.bicep / synthetic-monitor-job.bicep)
 * is the estate standard. Managed identity only — no keys, no host storage.
 *
 * Exit code: 0 on a completed pass INCLUDING an honest config gate (an unset
 * MSAL client id or vault URI is a configuration state, not a code failure).
 * Non-zero ONLY on an unexpected throw, so a Failed execution in the ACA job
 * history is always a real regression worth paging on.
 */
import { runSecretExpiryMonitor } from './run-monitor';
import { consoleLogger } from './run-logger';

async function main(): Promise<void> {
  const started = Date.now();
  const summary = await runSecretExpiryMonitor(consoleLogger);
  const ms = Date.now() - started;
  if (!summary.ran) {
    console.log(`[secret-expiry] pass gated after ${ms}ms (missing: ${summary.gate}).`);
    return;
  }
  console.log(
    `[secret-expiry] pass complete in ${ms}ms — inventory=${summary.inventory} escalated=${summary.escalated} worst=${summary.worst}`,
  );
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`[secret-expiry] pass FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    process.exit(1);
  },
);
