/**
 * cloud-boundary — the sovereign-boundary DISCRIMINATOR, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Split out of `cloud-endpoints.ts` by #3381. Two things forced it:
 *
 *   1. `cloud-endpoints.ts` crossed the 1500-LOC monolith-creep threshold
 *      (`scripts/ci/check-file-size.mjs`).
 *   2. More importantly, that PR established that the boundary which decides
 *      the ARM/Cosmos/SQL hosts is NOT always the boundary that decides the
 *      Graph host — IL5 folds to `GCC-High` for ARM (it runs on the ordinary
 *      Azure Government endpoints) but must resolve to the L5 Graph root. Two
 *      consumers with genuinely different boundary semantics is an argument for
 *      the discriminator being its own module rather than a private detail of
 *      the endpoint table.
 *
 * This module has NO imports, which keeps the dependency graph acyclic:
 *
 *      cloud-boundary  <--  cloud-endpoints-graph  <--  cloud-endpoints
 *              ^________________________________________/
 *
 * `cloud-endpoints.ts` re-exports everything here, so every existing
 * `from '@/lib/azure/cloud-endpoints'` import — and the vitest mocks keyed to
 * that path — keep working unchanged.
 */

export type CloudName = 'AzureCloud' | 'AzureUSGovernment' | 'AzureDOD';

/**
 * The four sovereign boundaries Loom targets, as a single canonical
 * discriminator. Unlike `CloudName` (which collapses GCC into `AzureCloud`
 * because GCC runs on Commercial Azure endpoints), `LoomCloud` keeps GCC
 * distinct so the console can badge it correctly and `getGraphHost()` can make
 * the 3-way Graph split (Commercial+GCC share, GCC-High differs, DoD differs
 * again).
 */
export type LoomCloud = 'Commercial' | 'GCC' | 'GCC-High' | 'DoD';

/**
 * Detect the active sovereign boundary. `LOOM_CLOUD` is the canonical, enum
 * signal (`Commercial | GCC | GCC-High | DoD`; `IL5` is accepted as an alias of
 * `GCC-High` since both run on `AzureUSGovernment` endpoints). When `LOOM_CLOUD`
 * is absent we fall back to the legacy `AZURE_CLOUD` value so existing
 * deployments keep their exact behaviour. Unknown values default to Commercial
 * (never crash — this is a host resolver, not a validator).
 *
 * THE `il5 -> GCC-High` FOLD IS DELIBERATE AND MUST STAY. An IL5 estate runs on
 * the ordinary Azure Government ARM/Cosmos/SQL hosts, and
 * `platform/fiab/bicep/modules/admin-plane/main.bicep:4743` encodes exactly
 * that. Widening it would move ARM to `management.azure.microsoft.scloud`,
 * which is NOT where an IL5 estate lives. Microsoft Graph is the ONE service
 * where L4 and L5 diverge; that divergence is handled in
 * `cloud-endpoints-graph.ts`, not here (#3381).
 */
export function detectLoomCloud(): LoomCloud {
  const lc = (process.env.LOOM_CLOUD || '').trim().toLowerCase();
  if (lc) {
    switch (lc) {
      case 'commercial':
        return 'Commercial';
      case 'gcc':
        return 'GCC';
      case 'gcc-high':
      case 'gcchigh':
      case 'il5':
        return 'GCC-High';
      case 'dod':
        return 'DoD';
      // Unknown LOOM_CLOUD value — fall through to AZURE_CLOUD below.
    }
  }
  switch ((process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase()) {
    case 'azureusgovernment':
      return 'GCC-High';
    case 'azuredod':
      return 'DoD';
    default:
      return 'Commercial';
  }
}

/** Normalise to the Azure-endpoint cloud (GCC collapses to Commercial). */
export function detectCloud(): CloudName {
  switch (detectLoomCloud()) {
    case 'GCC-High':
      return 'AzureUSGovernment';
    case 'DoD':
      return 'AzureDOD';
    default:
      // Commercial + GCC both run on Commercial Azure endpoints.
      return 'AzureCloud';
  }
}

/** True when running in an Azure Government boundary (GCC-High / IL5 / DoD). */
export function isGovCloud(): boolean {
  const c = detectCloud();
  return c === 'AzureUSGovernment' || c === 'AzureDOD';
}

/** Friendly cloud-boundary label for UI/MessageBar copy (e.g. "GCC High (L4)"). */
export function cloudBoundaryLabel(): string {
  // Prefer the explicit deployment boundary when bicep wires it through; this
  // distinguishes GCC-High from IL5 (both map to AzureUSGovernment otherwise).
  const explicit = (process.env.LOOM_CLOUD_BOUNDARY || '').trim();
  if (explicit) {
    switch (explicit.toLowerCase()) {
      case 'commercial': return 'Commercial';
      case 'gcc': return 'GCC';
      case 'gcc-high': case 'gcchigh': return 'GCC High (L4)';
      case 'il5': case 'dod': return 'DoD (IL5/L5)';
      default: return explicit;
    }
  }
  switch (detectCloud()) {
    case 'AzureUSGovernment': return 'US Government (GCC High / IL5)';
    case 'AzureDOD': return 'DoD (IL5/L5)';
    default: return 'Commercial';
  }
}
