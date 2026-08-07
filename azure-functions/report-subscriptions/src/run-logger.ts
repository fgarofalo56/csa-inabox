/**
 * Minimal structured logger for the one-shot Container App Job entrypoint.
 *
 * B-FN migration (C3, 2026-08-06): report-subscriptions used to run as a Y1
 * Consumption Function and logged through `InvocationContext`. The
 * Function-hosted runtime on this estate executes nothing — measured
 * 2026-08-06, FunctionExecutionCount (2026-07-25→08-06, P1D Total) sums to ZERO
 * for all seven Function Apps in rg-csa-loom-admin-centralus (errorCode=Success,
 * 13/13 datapoints with an explicit total of 0.0, none absent), and func-rptsub-…
 * indexes no functions at all. The delivery runtime is now an in-VNet
 * `Microsoft.App/jobs` execution.
 *
 * This interface is the exact log/error subset the handler used, so the body
 * ported unchanged. Mirrors azure-functions/secret-expiry-monitor/src/run-logger.ts.
 *
 * Container App Job executions stream stdout/stderr to the CAE's Log Analytics
 * workspace (ContainerAppConsoleLogs_CL) — the same place the loom-uat,
 * lineage-extractor and secret-expiry-monitor jobs land.
 */

export interface RunLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** stdout/stderr logger — what the ACA job execution captures. */
export const consoleLogger: RunLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};
