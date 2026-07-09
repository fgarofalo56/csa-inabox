/**
 * AIF-11 — Azure OpenAI / Foundry Models deployment TYPES (pure, testable).
 *
 * The Deploy dialog offers a deployment-type selector sourced from the model
 * card's supported SKUs. Each SKU maps to one of three kinds:
 *   • standard    — pay-as-you-go token billing (K tokens-per-minute capacity)
 *   • provisioned — reserved throughput; capacity is a PTU count; billed HOURLY
 *                   from the moment the deployment is created (disclose this).
 *   • batch       — high-volume async (~50% cheaper, 24h window); capacity is
 *                   enqueued-token throughput.
 *
 * Gov GA: only a subset is Generally Available in Azure Government
 * (AzureUSGovernment / DoD). Provisioned "ProvisionedManaged" (regional) and
 * regional "Standard" are Gov-GA; Global / Data-Zone variants and BATCH are not
 * Gov-supported, so the Deploy dialog honest-gates them in a Gov boundary
 * (per PRP-azure-ai-foundry-integration.md AIF-11 §Gov notes /
 * appendix-scale-aoai-ptu.md §2.4). Verify per Gov region before relying on GA.
 *
 * The ARM create call is identical for every kind — `PUT accounts/{a}/
 * deployments/{d}` with `sku.name` + `sku.capacity` — only the semantics of the
 * capacity number and the billing disclosure differ. No Fabric dependency.
 */

export type DeployKind = 'standard' | 'provisioned' | 'batch';
export type CapacityUnit = 'K-TPM' | 'PTU' | 'K-enqueued';

export interface DeploymentTypeInfo {
  /** ARM `sku.name`. */
  sku: string;
  label: string;
  kind: DeployKind;
  /** Generally Available in an Azure Government boundary. */
  govGA: boolean;
  /** Provisioned SKUs bill hourly from creation — the UI must disclose this. */
  hourlyBilled: boolean;
  /** How to label + interpret the capacity number for this SKU. */
  capacityUnit: CapacityUnit;
  /** Minimum capacity accepted (PTU floor for provisioned; 1 otherwise). */
  minCapacity: number;
  /** Default capacity pre-filled in the dialog. */
  defaultCapacity: number;
  /** One-line help shown under the selector. */
  hint: string;
}

/**
 * The canonical Azure OpenAI deployment-type catalog. The Deploy dialog
 * intersects this with the model card's supported SKUs (and always keeps the
 * two Standard defaults so a model that reports no SKUs is still deployable).
 */
export const DEPLOYMENT_TYPES: DeploymentTypeInfo[] = [
  {
    sku: 'Standard', label: 'Standard (Regional)', kind: 'standard',
    govGA: true, hourlyBilled: false, capacityUnit: 'K-TPM',
    minCapacity: 1, defaultCapacity: 10,
    hint: 'Regional pay-as-you-go. Capacity is thousands of tokens-per-minute (TPM).',
  },
  {
    sku: 'GlobalStandard', label: 'Global Standard', kind: 'standard',
    govGA: false, hourlyBilled: false, capacityUnit: 'K-TPM',
    minCapacity: 1, defaultCapacity: 10,
    hint: 'Global pay-as-you-go with the highest default quota. Capacity is thousands of TPM.',
  },
  {
    sku: 'DataZoneStandard', label: 'Data Zone Standard', kind: 'standard',
    govGA: false, hourlyBilled: false, capacityUnit: 'K-TPM',
    minCapacity: 1, defaultCapacity: 10,
    hint: 'Data-residency-bounded pay-as-you-go (EU / US zone). Capacity is thousands of TPM.',
  },
  {
    sku: 'GlobalProvisioned', label: 'Global Provisioned (PTU)', kind: 'provisioned',
    govGA: false, hourlyBilled: true, capacityUnit: 'PTU',
    minCapacity: 15, defaultCapacity: 15,
    hint: 'Reserved global throughput. Capacity is a PTU count; billed hourly from creation.',
  },
  {
    sku: 'DataZoneProvisioned', label: 'Data Zone Provisioned (PTU)', kind: 'provisioned',
    govGA: false, hourlyBilled: true, capacityUnit: 'PTU',
    minCapacity: 15, defaultCapacity: 15,
    hint: 'Reserved data-zone throughput. Capacity is a PTU count; billed hourly from creation.',
  },
  {
    sku: 'ProvisionedManaged', label: 'Regional Provisioned (PTU)', kind: 'provisioned',
    govGA: true, hourlyBilled: true, capacityUnit: 'PTU',
    minCapacity: 15, defaultCapacity: 15,
    hint: 'Reserved regional throughput. Capacity is a PTU count; billed hourly from creation.',
  },
  {
    sku: 'GlobalBatch', label: 'Global Batch', kind: 'batch',
    govGA: false, hourlyBilled: false, capacityUnit: 'K-enqueued',
    minCapacity: 1, defaultCapacity: 10,
    hint: 'Async high-volume (~50% cheaper, 24h window). Capacity is thousands of enqueued tokens.',
  },
  {
    sku: 'DataZoneBatch', label: 'Data Zone Batch', kind: 'batch',
    govGA: false, hourlyBilled: false, capacityUnit: 'K-enqueued',
    minCapacity: 1, defaultCapacity: 10,
    hint: 'Data-zone async high-volume (~50% cheaper, 24h window). Capacity is thousands of enqueued tokens.',
  },
];

const BY_SKU: Record<string, DeploymentTypeInfo> = Object.fromEntries(
  DEPLOYMENT_TYPES.map((d) => [d.sku.toLowerCase(), d]),
);

/** The two Standard SKUs always offered even when a model reports no SKUs. */
const ALWAYS_OFFERED = ['GlobalStandard', 'Standard'];

/** Look up a deployment-type descriptor by ARM sku name (case-insensitive). */
export function deploymentTypeFor(sku: string | undefined | null): DeploymentTypeInfo | undefined {
  if (!sku) return undefined;
  return BY_SKU[String(sku).toLowerCase()];
}

export function isProvisioned(sku: string | undefined | null): boolean {
  return deploymentTypeFor(sku)?.kind === 'provisioned';
}

export function isBatch(sku: string | undefined | null): boolean {
  return deploymentTypeFor(sku)?.kind === 'batch';
}

/** The capacity unit label for a SKU (defaults to K-TPM for unknowns). */
export function capacityUnitFor(sku: string | undefined | null): CapacityUnit {
  return deploymentTypeFor(sku)?.capacityUnit ?? 'K-TPM';
}

/**
 * Build the ordered, de-duplicated list of deployment types to offer for a
 * model, given its supported SKUs and the current cloud. In a Gov boundary,
 * SKUs that are not Gov-GA are still RETURNED (so the full surface renders) but
 * flagged `govGated:true` so the dialog disables + explains them (honest gate,
 * never a hidden control). Order: the model's own SKUs first (catalog order),
 * then the always-offered Standard defaults.
 */
export interface OfferedDeploymentType extends DeploymentTypeInfo {
  /** True when this SKU is not Gov-GA and we are in a Gov boundary. */
  govGated: boolean;
}

export function offeredDeploymentTypes(
  modelSkus: string[] | undefined | null,
  opts: { isGov?: boolean } = {},
): OfferedDeploymentType[] {
  const isGov = !!opts.isGov;
  const wanted: string[] = [];
  const push = (sku: string) => {
    const info = deploymentTypeFor(sku);
    if (info && !wanted.some((w) => w.toLowerCase() === info.sku.toLowerCase())) {
      wanted.push(info.sku);
    }
  };
  for (const s of modelSkus || []) push(s);
  for (const s of ALWAYS_OFFERED) push(s);
  return wanted
    .map((sku) => deploymentTypeFor(sku)!)
    .map((info) => ({ ...info, govGated: isGov && !info.govGA }));
}

// ── AIF-12 — Model Router deployment (a MODEL, not a SKU) ────────────────────

/**
 * The Azure OpenAI **Model Router** model name. It is deployed via the SAME
 * `PUT accounts/{a}/deployments/{d}` REST as any other model (a Standard SKU) —
 * it is a special *model*, not a new deployment TYPE — and at inference time it
 * auto-selects the best underlying model per request (Quality vs Cost mode).
 *
 * Gov: Model Router is **not available in Azure Government** (Learn Gov feature
 * table), so the Deploy dialog honest-gates it in a Gov boundary and points the
 * operator at Loom's app-layer tier router (Admin → Copilot & Agents → Model
 * tiers) instead — same intent, Gov-native.
 */
export const MODEL_ROUTER_MODEL = 'model-router';

/** True when a model name is the Azure OpenAI Model Router (case-insensitive). */
export function isModelRouterModel(modelName: string | undefined | null): boolean {
  return (modelName || '').trim().toLowerCase() === MODEL_ROUTER_MODEL;
}

/** Routing preference offered when deploying a Model Router. */
export type RouterMode = 'quality' | 'cost';

export const ROUTER_MODES: { value: RouterMode; label: string; hint: string }[] = [
  { value: 'quality', label: 'Quality', hint: 'Prefer the strongest model that fits the request.' },
  { value: 'cost', label: 'Cost', hint: 'Prefer the cheapest model that can answer the request.' },
];

export interface ModelRouterAvailability {
  /** False in a Gov boundary — the managed Model Router is not Gov-GA. */
  available: boolean;
  /** Honest-gate copy when unavailable (names the Loom-native alternative). */
  reason?: string;
}

/**
 * Whether the managed Model Router deployment kind is offerable in this cloud.
 * Gov boundaries get an honest gate pointing at the app-layer tier router.
 */
export function modelRouterAvailability(isGov: boolean): ModelRouterAvailability {
  if (isGov) {
    return {
      available: false,
      reason:
        'Azure OpenAI Model Router is not available in Azure Government. Use Loom’s built-in ' +
        'tier router instead (Admin → Copilot & Agents → Model tiers) — it routes cheap ' +
        'requests to a mini deployment and hard requests to a strong one, Gov-native.',
    };
  }
  return { available: true };
}

export interface PtuValidation {
  ok: boolean;
  /** Present when ok=false — a human-readable reason for the form gate. */
  error?: string;
}

/**
 * Validate a PTU / capacity value for a chosen SKU. Provisioned SKUs enforce
 * the documented PTU minimum; all SKUs require a positive integer.
 */
export function validateCapacity(sku: string, capacity: number): PtuValidation {
  const info = deploymentTypeFor(sku);
  const min = info?.minCapacity ?? 1;
  const unit = info?.capacityUnit ?? 'K-TPM';
  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isInteger(capacity)) {
    return { ok: false, error: 'Capacity must be a positive whole number.' };
  }
  if (capacity < min) {
    const noun = unit === 'PTU' ? 'PTU' : 'units';
    return { ok: false, error: `${info?.label || sku} requires at least ${min} ${noun}.` };
  }
  return { ok: true };
}
