/**
 * ESTATE PAUSE / RESUME - the tier, resume-time and resume-order tables.
 *
 * Extracted from `./pause-orchestrator` (#4876) to keep that file under the
 * 1500-LOC monolith ceiling (`scripts/ci/check-file-size.mjs`), the same way
 * `./pause-actuator` was. Pure data and pure helpers only. The orchestrator
 * re-exports every symbol here, so existing importers and `vi.mock` paths are
 * unchanged.
 */

// ---------------------------------------------------------------------------
// The tier this slice actuates
// ---------------------------------------------------------------------------

/**
 * The ARM types this PAUSE slice will actuate, lower-cased.
 *
 * A type in `PAUSABLE_RESOURCE_TYPES` but NOT here is reported in the dry-run
 * as `out-of-tier` — visible, explained, and left running. That is deliberately
 * noisier than silently dropping it: a resource that disappears from both the
 * "would pause" and "left running" lists is a resource nobody reviewed.
 *
 * Container Apps are in the tier but each passes `containerAppPauseGuard`
 * (invariant 5 in the orchestrator header). Stream Analytics jobs and Web sites
 * that would save nothing come back from the actuator as disclosed no-ops.
 */
export const ESTATE_PAUSE_TIER: readonly string[] = [
  'microsoft.synapse/workspaces/sqlpools',
  'microsoft.kusto/clusters',
  'microsoft.analysisservices/servers',
  'microsoft.compute/virtualmachinescalesets',
  // Widened by operator decision (#4876 step 2). Every addition has a stated
  // safety rule below; Container Apps have a per-app guard (see
  // `containerAppPauseGuard`) because the Loom console IS a Container App.
  'microsoft.compute/virtualmachines',
  'microsoft.containerservice/managedclusters',
  'microsoft.app/containerapps',
  'microsoft.streamanalytics/streamingjobs',
  'microsoft.web/sites',
  'microsoft.databricks/workspaces',
];

/**
 * Why a Loom-owned, pausable-typed resource is nevertheless out of this tier.
 * Every pausable type is now in the tier, so this is empty by design; it stays
 * as the seam `planPause` consults for any future type held back.
 */
export const OUT_OF_TIER_REASONS: Readonly<Record<string, string>> = {};

/**
 * TYPICAL resume time per type, in seconds. Used ONLY to draw a progress bar.
 *
 * Every figure is Microsoft's own published language, converted to a number so
 * a bar can move; none of them is a guarantee, and the UI says so. Microsoft's
 * Fabric pause/resume page publishes NO duration at all, so an honest estimate
 * with a stated basis is already better than the model we are copying.
 */
export const TYPICAL_RESUME_SECONDS: Readonly<Record<string, number>> = {
  // Learn: "several minutes", and the API reports ONLINE 2-3 min before it serves.
  'microsoft.synapse/workspaces/sqlpools': 420,
  // Learn: ~10 minutes to start, plus UNBOUNDED hot-cache rehydration.
  'microsoft.kusto/clusters': 600,
  // Resume returns quickly; the model must then be re-attached/queried.
  'microsoft.analysisservices/servers': 240,
  // VM allocation in a healthy region.
  'microsoft.compute/virtualmachinescalesets': 300,
  // VM allocation + guest-agent heartbeat.
  'microsoft.compute/virtualmachines': 300,
  // AKS start re-provisions the control plane and nodes.
  'microsoft.containerservice/managedclusters': 600,
  // Scale from zero is seconds; revision activation is the long pole.
  'microsoft.app/containerapps': 90,
  'microsoft.streamanalytics/streamingjobs': 120,
  'microsoft.web/sites': 60,
  // Warehouses start in minutes; classic clusters 5-10.
  'microsoft.databricks/workspaces': 420,
};

/**
 * Resume dispatch order: platform first, then data services, then the things
 * that consume them. Lower rank dispatches earlier.
 *
 *   0  platform   AKS clusters (workloads cannot schedule without one)
 *   1  data       ADX, Synapse pools, AAS, Stream Analytics
 *   2  consumers  Container Apps, VMs, VM scale sets, Web sites
 *
 * An unrecognised type ranks with the consumers (last) rather than first, so
 * a type this table has not been taught never jumps ahead of a data service.
 * The sort is stable: within a rank the snapshot's own order is preserved.
 * NOTE this orders DISPATCH only. Each verb returns once ARM accepts it, so a
 * rank is not guaranteed to be fully up before the next starts; `pollResume`
 * is what establishes that each resource is actually serving.
 */
const RESUME_RANK: Readonly<Record<string, number>> = {
  'microsoft.containerservice/managedclusters': 0,
  'microsoft.kusto/clusters': 1,
  'microsoft.synapse/workspaces/sqlpools': 1,
  'microsoft.analysisservices/servers': 1,
  'microsoft.streamanalytics/streamingjobs': 1,
  'microsoft.databricks/workspaces': 1,
  'microsoft.app/containerapps': 2,
  'microsoft.compute/virtualmachines': 2,
  'microsoft.compute/virtualmachinescalesets': 2,
  'microsoft.web/sites': 2,
};

export function resumeRank(resourceType: string): number {
  return RESUME_RANK[String(resourceType || '').toLowerCase()] ?? 2;
}

export function orderForResume<T extends { resourceType: string }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => resumeRank(a.entry.resourceType) - resumeRank(b.entry.resourceType) || a.index - b.index)
    .map((x) => x.entry);
}
