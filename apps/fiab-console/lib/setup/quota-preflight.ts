/**
 * Azure compute-quota pre-flight (rel-T42).
 *
 * Live history: a DLZ provision was blocked opaquely because the target
 * subscription's **Total Regional vCPUs** quota was 0 in the chosen region
 * (`Insufficient regional vcpu quota left … left regional vcpu quota 0`). Azure
 * enforces vCPU quota in TWO tiers per subscription-per-region: the aggregate
 * *Total Regional vCPUs* and each *VM-family* tier (e.g. `standardDDSv5Family`).
 * A deploy fails if EITHER tier is exceeded — and the failure only surfaces
 * mid-`az deployment sub create`, long after the operator committed.
 *
 * This module predicts that failure BEFORE the deploy fires, using the read-only
 * Compute usages API (Reader is enough — the same right the wizard already needs
 * to list subscriptions):
 *
 *   GET {arm}/subscriptions/{sub}/providers/Microsoft.Compute/locations/{loc}/usages
 *   → [{ name: { value, localizedValue }, currentValue, limit }, …]
 *
 * The pure pieces here ({@link requiredComputeForDeploy}, {@link evaluateQuota})
 * are exported separately from the ARM I/O in the route so they can be unit
 * tested without a live subscription (per no-vaporware.md: the route still hits
 * real ARM; the topology→SKU math is verifiable in isolation).
 *
 * Topology → SKU mapping (grounded in platform/fiab/bicep):
 *   - Gov (GCC-High / IL5) container platform = **AKS** → provisions two node
 *     pools at deploy time: system 3× Standard_D4ds_v5 (4 vCPU) + apps
 *     3× Standard_D8ds_v5 (8 vCPU) = 36 vCPU in the **Ddsv5** family
 *     (`standardDDSv5Family`). This is always-on compute consumed the moment the
 *     cluster is created.
 *     (platform/fiab/bicep/modules/admin-plane/container-platform.bicep)
 *   - Commercial / GCC container platform = **Azure Container Apps** (serverless)
 *     → consumes NO dedicated VM-family quota. The absence of an AKS row for
 *     Commercial is the topology mapping working, not a gap.
 *   - Every DLZ provisions a **Self-hosted Integration Runtime** VMSS
 *     (Standard_D4s_v5, **Dsv5** family `standardDSv5Family`) created at
 *     scale-to-ZERO (0 instances) — so it consumes no quota at deploy, but the
 *     operator needs family headroom to later run pipelines/data movement. It is
 *     reported as an advisory (`scaleToZero`) row, not a deploy-time blocker.
 *     (platform/fiab/bicep/modules/landing-zone/shir.bicep — VMSS at 0)
 *
 * ADX (Real-Time / eventhouse) and Databricks compute are governed by their own
 * resource-provider quotas (Microsoft.Kusto / Microsoft.Databricks), not by the
 * Microsoft.Compute vCPU tiers, so they are surfaced as a capacity-scaled note
 * with a portal link rather than a Compute-usages row we cannot honestly source.
 */

export type QuotaBoundary = 'Commercial' | 'GCC' | 'GCC-High' | 'IL5';
export type QuotaMode = 'single-sub' | 'multi-sub';

/** One VM-family compute requirement the selected topology's deploy consumes. */
export interface SkuRequirement {
  /** Compute usages `name.value` this maps to (matched case-insensitively). */
  family: string;
  /** Human label for the family tier. */
  familyLabel: string;
  /** Representative VM size that lands in this family. */
  vmSize: string;
  /** Total vCores this deploy needs from the family (max-scale for VMSS rows). */
  requiredVCores: number;
  /** What in the topology consumes it. */
  reason: string;
  /**
   * true → the resource is created at 0 instances (VMSS scale-to-0), so it does
   * NOT consume quota at deploy; the requirement is advisory headroom for when
   * the operator scales it up. Excluded from the Total Regional vCPUs subtotal.
   */
  scaleToZero?: boolean;
}

/** vCores per representative VM size (Microsoft VM size series). */
const VCORES: Record<string, number> = {
  Standard_D4ds_v5: 4,
  Standard_D8ds_v5: 8,
  Standard_D4s_v5: 4,
  Standard_DS3_v2: 4,
};

function isGovBoundary(b?: QuotaBoundary): boolean {
  return b === 'GCC-High' || b === 'IL5';
}

/**
 * PURE: the compute a single target subscription's DLZ deploy consumes, by
 * VM-family tier. `role` distinguishes a target that carries the container
 * platform (Gov AKS) from a spoke that only carries the DLZ increment.
 *
 * - `full`  — the target hosts the admin/container platform too (single-sub, or
 *   a first-run hub). Gov → AKS Ddsv5 rows.
 * - `spoke` — the target only receives the DLZ increment (SHIR VMSS scale-to-0).
 *
 * Commercial/GCC never emit an AKS row (Container Apps is serverless).
 */
export function requiredComputeForDeploy(opts: {
  boundary?: QuotaBoundary;
  role?: 'full' | 'spoke';
}): SkuRequirement[] {
  const role = opts.role ?? 'full';
  const reqs: SkuRequirement[] = [];

  // Gov container platform = AKS: two node pools, always-on at deploy.
  if (role === 'full' && isGovBoundary(opts.boundary)) {
    const system = 3 * VCORES.Standard_D4ds_v5; // system pool: 3× D4ds_v5
    const apps = 3 * VCORES.Standard_D8ds_v5; //   apps pool:   3× D8ds_v5
    reqs.push({
      family: 'standardDDSv5Family',
      familyLabel: 'Standard DDSv5 Family (Ddsv5)',
      vmSize: 'Standard_D4ds_v5 / Standard_D8ds_v5',
      requiredVCores: system + apps, // 12 + 24 = 36
      reason: 'AKS system + apps node pools (Gov container platform, always-on)',
    });
  }

  // Every DLZ provisions a SHIR VMSS created at scale-to-0 (advisory headroom).
  reqs.push({
    family: 'standardDSv5Family',
    familyLabel: 'Standard DSv5 Family (Dsv5)',
    vmSize: 'Standard_D4s_v5',
    requiredVCores: 4 * VCORES.Standard_D4s_v5, // 4-node max cluster × 4 vCPU
    reason: 'Self-hosted Integration Runtime cluster (scale-to-0; needed to run pipelines / data movement)',
    scaleToZero: true,
  });

  return reqs;
}

/** A single Compute usages entry (subset of the ARM response we consume). */
export interface ComputeUsageEntry {
  name?: { value?: string; localizedValue?: string };
  currentValue?: number;
  limit?: number;
}

/** Evaluation of one family tier (or the regional aggregate) against usage. */
export interface QuotaFamilyResult {
  family: string;
  familyLabel: string;
  vmSize?: string;
  reason?: string;
  scaleToZero?: boolean;
  /** vCores the deploy needs from this tier. */
  required: number;
  /** Current consumed vCores (from ARM). undefined when the tier wasn't found. */
  current?: number;
  /** Quota limit (from ARM). undefined when the tier wasn't found. */
  limit?: number;
  /**
   * true  → current + required ≤ limit (headroom available).
   * false → the tier would be exceeded.
   * undefined → the tier was not present in the usages response (can't verify).
   */
  sufficient?: boolean;
}

/** Full quota evaluation for one subscription + region target. */
export interface QuotaEvaluation {
  subscriptionId: string;
  subscriptionName?: string;
  location: string;
  /** The Total Regional vCPUs aggregate tier. */
  regional: QuotaFamilyResult;
  /** Per-VM-family tiers the topology consumes. */
  families: QuotaFamilyResult[];
  /** true when every non-advisory tier has headroom (or couldn't be verified). */
  ok: boolean;
}

/** Find a usages entry by its `name.value` (case-insensitive). */
function findUsage(usages: ComputeUsageEntry[], familyValue: string): ComputeUsageEntry | undefined {
  const want = familyValue.toLowerCase();
  return usages.find((u) => (u.name?.value || '').toLowerCase() === want);
}

/**
 * PURE: evaluate the required compute against a Compute usages response for one
 * subscription + region. Total Regional vCPUs required = the sum of the
 * non-scale-to-0 family requirements (scale-to-0 rows are advisory headroom, not
 * deploy-time consumption). A tier missing from the response yields
 * `sufficient: undefined` (unverifiable) rather than a false failure.
 */
export function evaluateQuota(opts: {
  subscriptionId: string;
  subscriptionName?: string;
  location: string;
  required: SkuRequirement[];
  usages: ComputeUsageEntry[];
}): QuotaEvaluation {
  const { subscriptionId, subscriptionName, location, required, usages } = opts;

  const families: QuotaFamilyResult[] = required.map((r) => {
    const u = findUsage(usages, r.family);
    const current = typeof u?.currentValue === 'number' ? u.currentValue : undefined;
    const limit = typeof u?.limit === 'number' ? u.limit : undefined;
    const sufficient =
      current === undefined || limit === undefined ? undefined : current + r.requiredVCores <= limit;
    return {
      family: r.family,
      familyLabel: r.familyLabel,
      vmSize: r.vmSize,
      reason: r.reason,
      scaleToZero: r.scaleToZero,
      required: r.requiredVCores,
      current,
      limit,
      sufficient,
    };
  });

  // Total Regional vCPUs required = deploy-time (non-scale-to-0) vCores only.
  const regionalRequired = required
    .filter((r) => !r.scaleToZero)
    .reduce((sum, r) => sum + r.requiredVCores, 0);
  const regionalUsage = findUsage(usages, 'cores');
  const regionalCurrent =
    typeof regionalUsage?.currentValue === 'number' ? regionalUsage.currentValue : undefined;
  const regionalLimit = typeof regionalUsage?.limit === 'number' ? regionalUsage.limit : undefined;
  const regionalSufficient =
    regionalCurrent === undefined || regionalLimit === undefined
      ? undefined
      : regionalCurrent + regionalRequired <= regionalLimit;
  const regional: QuotaFamilyResult = {
    family: 'cores',
    familyLabel: 'Total Regional vCPUs',
    required: regionalRequired,
    current: regionalCurrent,
    limit: regionalLimit,
    sufficient: regionalSufficient,
  };

  // ok = no non-advisory tier is a hard failure. undefined (unverifiable) does
  // not fail the gate — it degrades to a "could not verify" note.
  const hardFail =
    regional.sufficient === false ||
    families.some((f) => f.sufficient === false && !f.scaleToZero);

  return { subscriptionId, subscriptionName, location, regional, families, ok: !hardFail };
}

/** The portal blade for requesting a quota increase (cloud-aware). */
export function quotaPortalLink(isGov: boolean): string {
  const host = isGov ? 'portal.azure.us' : 'portal.azure.com';
  return `https://${host}/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas`;
}
