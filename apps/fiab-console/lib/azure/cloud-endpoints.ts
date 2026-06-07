/**
 * Sovereign-cloud endpoint resolver.
 *
 * All suffixes derive from the AZURE_CLOUD env var, which Bicep sets to
 * 'AzureUSGovernment' in GCC-High / IL5 (via `boundary == 'GCC-High' ||
 * boundary == 'IL5'`) and to 'AzureCloud' in Commercial / GCC.
 *
 * This module is server-side only (no 'use client'). Browser callers should
 * read NEXT_PUBLIC_LOOM_CLOUD_TIER if they need cloud-awareness.
 */

function isUsGov(): boolean {
  return process.env.AZURE_CLOUD === 'AzureUSGovernment';
}

/**
 * Returns the ADLS Gen2 DFS endpoint suffix for the active cloud.
 *   Commercial / GCC:      dfs.core.windows.net
 *   GCC-High / IL5:        dfs.core.usgovcloudapi.net
 */
export function getDfsSuffix(): string {
  return isUsGov() ? 'dfs.core.usgovcloudapi.net' : 'dfs.core.windows.net';
}

/**
 * Returns the ARM management endpoint for the active cloud.
 *   Commercial / GCC:      https://management.azure.com
 *   GCC-High / IL5:        https://management.usgovcloudapi.net
 */
export function getArmEndpoint(): string {
  return isUsGov() ? 'https://management.usgovcloudapi.net' : 'https://management.azure.com';
}

/**
 * Returns the Kusto (ADX) cluster URI host suffix for the active cloud.
 *   Commercial / GCC:      kusto.windows.net
 *   GCC-High / IL5:        kusto.usgovcloudapi.net
 */
export function getKustoSuffix(): string {
  return isUsGov() ? 'kusto.usgovcloudapi.net' : 'kusto.windows.net';
}
