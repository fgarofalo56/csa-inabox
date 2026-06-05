/**
 * Capacity sizing equivalence — Fabric F-SKU ↔ Azure-native compute.
 *
 * CSA Loom uses Fabric's familiar F-SKU labels as a *sizing equivalence* so
 * existing Fabric capacity-planning guides apply, but it provisions compute on
 * Azure-native services (Synapse Spark / Databricks / ADX / Synapse SQL). This
 * module is the single source of truth for what a chosen F-SKU maps onto.
 *
 * Two tiers of fidelity, kept HONEST per .claude/rules/no-vaporware.md:
 *
 *   1. MICROSOFT-OFFICIAL equivalences (grounded in Microsoft Learn):
 *      - F-SKU → Capacity Units (CU): F2=2 … F2048=2048.
 *        https://learn.microsoft.com/fabric/enterprise/plan-capacity
 *      - Spark vCores = CU × 2 ("one CU translates to two Spark vCores … an F64
 *        SKU → 128 Spark v-cores").
 *        https://learn.microsoft.com/fabric/enterprise/optimize-capacity
 *      - Power BI v-cores = CU ÷ 8 (F8=1, F64=8, F512=64).
 *        https://learn.microsoft.com/fabric/enterprise/licenses#capacity
 *      - Warehouse SQL vCores/sec — official SKU table.
 *        https://learn.microsoft.com/fabric/database/sql/usage-reporting
 *
 *   2. LOOM SIZING GUIDELINES (NOT official Microsoft equivalences — Databricks
 *      DBU and ADX cluster SKUs have no published Fabric F-SKU equivalence). We
 *      derive a recommended Azure resource shape from the official Spark-vCore
 *      figure and band it. These are labelled as guidelines in the UI and the
 *      operator is pointed at the official estimator for authoritative cost.
 *
 * Cost is intentionally NOT a fabricated dollar figure (it varies by region,
 * reservation, and instance family). We expose a relative tier + deep links to
 * the official Microsoft Fabric Capacity Estimator and Azure pricing.
 */

export interface CapacityEquivalence {
  sku: string;
  /** Fabric Capacity Units (official). */
  cu: number;
  /** Synapse Spark / Spark-pool vCores = CU × 2 (official). */
  sparkVCores: number;
  /** Power BI v-cores = CU ÷ 8 (official). */
  powerBiVCores: number;
  /** Fabric Warehouse SQL vCores/second (official table). */
  warehouseSqlVCoresPerSec: number;
  /** Loom guideline: recommended Databricks worker shape for this band. */
  databricksGuideline: string;
  /** Loom guideline: recommended ADX cluster SKU for this band. */
  adxGuideline: string;
  /** Loom guideline: recommended Synapse dedicated SQL pool DWU for warehouse. */
  synapseDwuGuideline: string;
  /** Relative cost tier 1–5 (1 = smallest spend). Qualitative only. */
  costTier: number;
}

/** Official Warehouse SQL vCores/sec per SKU (Microsoft Learn usage-reporting). */
const SQL_VCORES_PER_SEC: Record<number, number> = {
  2: 0.766,
  4: 1.532,
  8: 3.064,
  16: 6.128,
  32: 12.256,
  64: 24.512,
  128: 49.024,
  256: 98.048,
  512: 196.096,
  1024: 392.192,
  2048: 784.384,
};

/** Band a CU value → relative cost tier (1..5), qualitative. */
function costTierFor(cu: number): number {
  if (cu <= 4) return 1;
  if (cu <= 16) return 2;
  if (cu <= 64) return 3;
  if (cu <= 256) return 4;
  return 5;
}

/** Loom guideline: a sensible Databricks worker shape for the Spark-vCore band. */
function databricksGuidelineFor(sparkVCores: number): string {
  if (sparkVCores <= 8) return `~${sparkVCores} worker vCores · 1–2× Standard_DS3_v2 (single-node/dev)`;
  if (sparkVCores <= 32) return `~${sparkVCores} worker vCores · 2–4× Standard_DS4_v2 (autoscaling)`;
  if (sparkVCores <= 128) return `~${sparkVCores} worker vCores · 4–8× Standard_DS5_v2 (autoscaling pool)`;
  if (sparkVCores <= 512) return `~${sparkVCores} worker vCores · 8–16× Standard_DS5_v2 (autoscaling pool)`;
  return `~${sparkVCores} worker vCores · large autoscaling pool (Standard_E-series)`;
}

/** Loom guideline: a sensible ADX cluster SKU for the capacity band. */
function adxGuidelineFor(cu: number): string {
  if (cu <= 8) return 'Dev/Test (no SLA) · 1× Standard_E2ads_v5';
  if (cu <= 32) return 'Standard · 2× Standard_E4ads_v5';
  if (cu <= 128) return 'Standard · 2–4× Standard_E8ads_v5';
  return 'Standard · 4–8× Standard_E16ads_v5';
}

/** Loom guideline: Synapse dedicated SQL pool DWU for the warehouse backend. */
function synapseDwuFor(cu: number): string {
  if (cu <= 4) return 'DW100c (pause when idle)';
  if (cu <= 8) return 'DW200c';
  if (cu <= 32) return 'DW500c';
  if (cu <= 64) return 'DW1000c';
  if (cu <= 128) return 'DW1500c';
  if (cu <= 256) return 'DW3000c';
  return 'DW6000c+';
}

/** Compute the full equivalence for an F-SKU label (e.g. "F8"). */
export function getCapacityEquivalence(sku: string): CapacityEquivalence | null {
  const m = /^F(\d+)$/.exec(sku.trim().toUpperCase());
  if (!m) return null;
  const cu = Number(m[1]);
  if (!Number.isFinite(cu) || cu <= 0) return null;
  const sparkVCores = cu * 2;
  return {
    sku: `F${cu}`,
    cu,
    sparkVCores,
    powerBiVCores: cu / 8,
    warehouseSqlVCoresPerSec: SQL_VCORES_PER_SEC[cu] ?? Number((cu * 0.383).toFixed(3)),
    databricksGuideline: databricksGuidelineFor(sparkVCores),
    adxGuideline: adxGuidelineFor(cu),
    synapseDwuGuideline: synapseDwuFor(cu),
    costTier: costTierFor(cu),
  };
}

/** Official Microsoft Learn references surfaced in the UI for grounding. */
export const CAPACITY_LEARN_REFS = {
  planCapacity: 'https://learn.microsoft.com/fabric/enterprise/plan-capacity',
  optimizeCapacity: 'https://learn.microsoft.com/fabric/enterprise/optimize-capacity',
  licenses: 'https://learn.microsoft.com/fabric/enterprise/licenses#capacity',
  estimator: 'https://www.microsoft.com/microsoft-fabric/capacity-estimator',
  azurePricing: 'https://azure.microsoft.com/pricing/details/microsoft-fabric/',
} as const;
