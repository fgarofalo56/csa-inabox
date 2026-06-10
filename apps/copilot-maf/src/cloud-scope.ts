/**
 * Sovereign-cloud token scopes for the MAF tier. Minimal standalone copy of the
 * two Gov-critical helpers from the Console's `cloud-endpoints.ts` (the MAF app
 * is a separate package and must not import the Next.js dependency graph).
 *
 * The MAF tier only ever runs in an Azure Government boundary (GCC-High / IL5),
 * so the Gov scopes are the DEFAULT here; `AZURE_CLOUD` is still honoured so the
 * same image can run a Commercial smoke test. `LOOM_AOAI_AUDIENCE` overrides the
 * AOAI audience outright for clouds we don't enumerate.
 */

function cloud(): string {
  return (process.env.AZURE_CLOUD || 'AzureUSGovernment').toLowerCase();
}

/** AAD `.default` scope for Azure OpenAI / Cognitive Services tokens. */
export function cogScope(): string {
  const override = process.env.LOOM_AOAI_AUDIENCE;
  if (override) return `${override.replace(/\/+$/, '')}/.default`;
  const c = cloud();
  return c === 'azureusgovernment' || c === 'azuredod'
    ? 'https://cognitiveservices.azure.us/.default'
    : 'https://cognitiveservices.azure.com/.default';
}

/** True when running in an Azure Government boundary. */
export function isGovCloud(): boolean {
  const c = cloud();
  return c === 'azureusgovernment' || c === 'azuredod';
}
