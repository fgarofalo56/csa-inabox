/**
 * cloud-endpoints-graph — Microsoft Graph endpoint resolution, for every
 * sovereign boundary. THE single source of truth for the Graph host.
 *
 * WHY THIS IS ITS OWN MODULE (#3381)
 * ----------------------------------
 * Graph is the one backing service whose boundary semantics differ from every
 * other Azure endpoint Loom resolves. `detectLoomCloud()` folds `IL5` into
 * `GCC-High` — correct for ARM/Cosmos/SQL, which run on the ordinary Azure
 * Government hosts in an IL5 estate — but Microsoft Graph splits L4 from L5.
 * Keeping that divergence in the same file as the ARM table is what let three
 * separate functions disagree about what "DoD" meant. It now lives in one
 * module with one resolver.
 *
 * Graph has DISTINCT service roots per sovereign cloud (verified against
 * Microsoft Learn — https://learn.microsoft.com/graph/deployments):
 *
 *   | National cloud                       | Microsoft Graph root            |
 *   |--------------------------------------|---------------------------------|
 *   | Global (Commercial / GCC)            | https://graph.microsoft.com     |
 *   | US Government L4 (GCC High)          | https://graph.microsoft.us      |
 *   | US Government L5 (DoD / IL5)         | https://dod-graph.microsoft.us  |
 *
 * From that same page, verbatim: "Access tokens acquired for a national cloud
 * deployment are not interchangeable with those acquired for the global service
 * or any other national cloud." So a wrong root is not a redirect — it is a
 * hard failure, and on the group-membership path this codebase converted it
 * into a silent `false`. A client that hard-codes graph.microsoft.com fails in
 * Gov; `scripts/ci/check-cloud-endpoint-literals.mjs` enforces that, and this
 * file is on its allowlist because it DEFINES the map.
 *
 * Imports only `./cloud-boundary`, so the graph is acyclic:
 *     cloud-boundary <- cloud-endpoints-graph <- cloud-endpoints
 * `cloud-endpoints.ts` re-exports this module's surface, so every existing
 * `from '@/lib/azure/cloud-endpoints'` import keeps working.
 */

import { detectLoomCloud, isGovCloud, type LoomCloud } from './cloud-boundary';

/**
 * Normalise a Graph base to a bare service ROOT — scheme + host, no trailing
 * slash and no version segment. Accepts either shape an operator or a bicep
 * module might supply (`https://graph.microsoft.us` or
 * `https://graph.microsoft.us/v1.0`) so `getGraphHost()` is the root and
 * `graphBase()` can append `/v1.0` exactly once. Idempotent.
 */
function normalizeGraphRoot(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/(v1\.0|beta)$/i, '');
}

/**
 * The boundary that decides the GRAPH host — which is NOT always the boundary
 * that decides the Azure (ARM/Cosmos/SQL) hosts, and that difference is the
 * whole bug behind #3381.
 *
 * `detectLoomCloud()` deliberately folds `IL5` into `GCC-High` because an IL5
 * estate runs on the ordinary Azure Government endpoints
 * (`management.usgovcloudapi.net`, `documents.azure.us`, …) — that fold is
 * correct for ARM and must stay. `platform/fiab/bicep/modules/admin-plane/
 * main.bicep:4743` encodes exactly that:
 *     { name: 'LOOM_CLOUD', value: boundary == 'IL5' ? 'GCC-High' : boundary }
 *
 * So an IL5 estate is invisible to `detectLoomCloud()` and would silently
 * answer with the L4 host.
 *
 * `LOOM_CLOUD_BOUNDARY` is the signal that survives the fold — bicep wires it
 * verbatim (`main.bicep:5393`, `copilot/maf.bicep:105`), so `IL5` stays `IL5`.
 * The repo already treats IL5 as L5 everywhere else it matters:
 * `main.bicep:5363` and `identity-graph-rbac.bicep:50-53` both map
 * `boundary == 'IL5'` to `dod-graph.microsoft.us`, and `cloudBoundaryLabel()`
 * badges it "DoD (IL5/L5)". This resolver makes the runtime agree with them.
 */
function graphBoundary(): LoomCloud {
  switch ((process.env.LOOM_CLOUD_BOUNDARY || '').trim().toLowerCase()) {
    case 'il5':
    case 'dod':
      return 'DoD';
    case 'gcc-high':
    case 'gcchigh':
      return 'GCC-High';
    // Anything else (unset, Commercial, GCC, a value we do not enumerate)
    // falls through to the generic cloud detector.
  }
  return detectLoomCloud();
}

/**
 * Microsoft Graph service ROOT (scheme + host, no trailing slash, NO version
 * segment). THE single source of truth for the Graph host in the console —
 * `graphBase()`, `graphScope()`, `getGraphScope()`, `lib/auth/msal.ts`, and
 * every per-client `graphBase()` derive from this and must not re-implement it.
 *
 * Per Microsoft Learn `graph/deployments`:
 *   Commercial + GCC → https://graph.microsoft.com   (GCC uses the worldwide host)
 *   GCC-High (L4)    → https://graph.microsoft.us
 *   DoD / IL5 (L5)   → https://dod-graph.microsoft.us
 *
 * `LOOM_GRAPH_BASE` wins outright (mirrors `armBase()`'s `LOOM_ARM_ENDPOINT`
 * precedence) so an unenumerated or private-link boundary is reachable without
 * a code change; it is normalised to a root so a value carrying `/v1.0` cannot
 * produce a double-versioned URL.
 */
export function getGraphHost(): string {
  const explicit = process.env.LOOM_GRAPH_BASE;
  if (explicit && explicit.trim()) return normalizeGraphRoot(explicit);
  switch (graphBoundary()) {
    case 'DoD':
      return 'https://dod-graph.microsoft.us';
    case 'GCC-High':
      return 'https://graph.microsoft.us';
    default:
      // Commercial + GCC both use the worldwide Graph endpoint.
      return 'https://graph.microsoft.com';
  }
}

/** AAD `.default` scope for Microsoft Graph tokens (host-derived per cloud). */
export function getGraphScope(): string {
  return `${getGraphHost()}/.default`;
}

/**
 * Microsoft Graph data-plane base URL INCLUDING the `/v1.0` version segment
 * (no trailing slash). Callers append a bare resource path — `${graphBase()}/groups/…`
 * — so the version segment is load-bearing.
 *
 * Derives from `getGraphHost()` (the one Graph resolver) so the boundary split
 * is stated once, and so `LOOM_GRAPH_BASE` is honoured with the SAME
 * normalisation everywhere.
 *
 * TWO DEFECTS THIS SHAPE FIXES (both measured, #3381):
 *   1. The previous body branched on `isGovCloud()`, which folds DoD into
 *      GCC-High — so a DoD boundary got the L4 host `graph.microsoft.us`, and
 *      Learn is explicit that tokens are not interchangeable across roots.
 *   2. The previous `LOOM_GRAPH_BASE` branch returned the override VERBATIM,
 *      dropping `/v1.0`. `main.bicep:5363` sets that variable on EVERY boundary
 *      to a bare root, so on a bicep-wired estate every caller built an
 *      unversioned URL — `<root>/groups/{id}` — which Graph does not serve.
 *      That was a COMMERCIAL defect as much as a Gov one. Appending `/v1.0`
 *      here restores it for every caller at once.
 */
export function graphBase(): string {
  return `${getGraphHost()}/v1.0`;
}

/** AAD `.default` scope for Microsoft Graph tokens (host root, not the /v1.0 path). */
export function graphScope(): string {
  return getGraphScope();
}

/**
 * Whether Microsoft Graph exposes the `/beta/security/dataLossPreventionPolicies`
 * policy-management surface for the active cloud. This preview segment is NOT
 * available in the US Government / DoD Graph roots as of 2026 — DLP policy
 * authoring there remains Purview-compliance-portal + Security & Compliance
 * PowerShell only. DLP ALERTS (`/v1.0/security/alerts_v2`) and restrict-access
 * RBAC enforcement still work in every cloud.
 */
export function graphDlpPolicyApiAvailable(): boolean {
  return !isGovCloud();
}
