/**
 * Sovereign-cloud-aware ARM endpoint resolver.
 *
 * Single source of truth for the Azure Resource Manager host so every
 * management-plane client targets the correct endpoint for the deployment's
 * cloud (Commercial / GCC-High / IL5 / IL6 DoD). Mirrors the inline pattern in
 * adf-client.ts; extracted so new clients (kusto data connections, IoT Hub
 * policies) don't each re-hardcode `management.azure.com`.
 *
 * Selection order:
 *   1. LOOM_ARM_ENDPOINT (explicit override, e.g. air-gapped clouds)
 *   2. AZURE_CLOUD (AzureUSGovernment / AzureDod)
 *   3. Commercial (default)
 */

export function armBase(): string {
  const explicit = process.env.LOOM_ARM_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  switch ((process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase()) {
    case 'azureusgovernment': return 'https://management.usgovcloudapi.net';
    case 'azuredod':          return 'https://management.azure.microsoft.scloud';
    default:                  return 'https://management.azure.com';
  }
}

/** OAuth scope for ARM tokens in the resolved cloud. */
export function armScope(): string {
  return `${armBase()}/.default`;
}

/** Bare ARM host (no scheme) for call sites that build their own URL string. */
export function armHost(): string {
  return armBase().replace(/^https?:\/\//, '');
}
