/**
 * Minimal structured logger for the one-shot Container App Job entrypoint.
 *
 * B-FN migration (2026-07-27): the S1 monitor used to run as a Y1 Consumption
 * Function and logged through `InvocationContext`. Y1 is structurally broken on
 * this estate (Azure Policy seals the storage data-plane — publicNetworkAccess
 * Disabled, AAD-only, no private endpoint — and the multitenant Y1 runtime is
 * not a trusted service, so host keys / timer leases fail), so the monitor is
 * now an in-VNet `Microsoft.App/jobs` execution. This interface is the exact
 * log/warn/error subset the core used, so the handler body ported unchanged.
 *
 * Container App Job executions stream stdout/stderr to the CAE's Log Analytics
 * workspace (ContainerAppConsoleLogs_CL) — the same place the loom-uat and
 * lineage-extractor jobs land.
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
