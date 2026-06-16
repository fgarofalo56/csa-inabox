/**
 * resolve-aml-target — the single cloud-aware resolver for the standalone
 * Azure Machine Learning control plane (computes, datastores, experiments /
 * runs, models, schedules, environments).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The AML control plane is pure ARM — every object below is a child of
 * `Microsoft.MachineLearningServices/workspaces/<ws>`. The ARM host is already
 * sovereign-cloud aware via `cloud-endpoints.ts::armBase()` (Commercial vs
 * `management.usgovcloudapi.net` for GCC-High / IL5), so the CONTROL plane
 * needs no per-cloud branching of its own — it just composes the ARM path.
 *
 * This resolver centralises the workspace COORDINATES (subscription / resource
 * group / workspace / region) so `aml-client.ts` and any future AML BFF route
 * read them from ONE place. It honours the task's dedicated `LOOM_AML_*` vars
 * first, then falls back to the AI Foundry hub env (`LOOM_FOUNDRY_*`) and the
 * shared landing-zone subscription so an already-deployed Loom keeps working
 * without new configuration.
 *
 * Env precedence (verbatim, highest first):
 *   subscription  : LOOM_AML_SUBSCRIPTION → LOOM_SUBSCRIPTION_ID
 *   workspace     : LOOM_AML_WORKSPACE    → LOOM_FOUNDRY_NAME
 *   resourceGroup : LOOM_AML_RESOURCE_GROUP → LOOM_AML_RG → LOOM_FOUNDRY_RG
 *                   → rg-csa-loom-admin-<region>
 *   region        : LOOM_AML_REGION       → LOOM_FOUNDRY_REGION → eastus2
 *
 * The legacy `LOOM_AML_RG` alias is preserved because `mlflow-client.ts`
 * already reads it; `LOOM_AML_RESOURCE_GROUP` is the new, explicit bicep var.
 *
 * NO Fabric / Power BI dependency (per no-fabric-dependency.md). This resolver
 * never reads `fabricWorkspaceId`; the AML path is Azure-native by default and
 * works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
 *
 * Government data-plane note: the AML *data* plane (MLflow tracking) uses the
 * `*.api.ml.azure.us` suffix in Government (vs `*.api.azureml.ms` in
 * Commercial). This resolver covers the CONTROL plane only — that data-plane
 * suffix is documented here for the follow-up MLflow Gov fix and is exposed via
 * `amlDataPlaneHostSuffix()` so future callers don't re-hard-code it.
 */

import { isGovCloud } from './cloud-endpoints';

/** Resolved AML workspace coordinates for the active sovereign cloud. */
export interface AmlTarget {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  region: string;
}

/**
 * Raised when the AML workspace coordinates can't be resolved from env. Carries
 * the exact missing variables so a BFF route can 503 with a precise Fluent
 * MessageBar (per no-vaporware.md) instead of a generic 500.
 */
export class AmlNotConfiguredError extends Error {
  missing: string[];
  hint: string;
  constructor(missing: string[]) {
    super('Azure Machine Learning is not configured in this deployment');
    this.name = 'AmlNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
      `then grant the Console UAMI the "AzureML Data Scientist" role on it. ` +
      `LOOM_AML_WORKSPACE / LOOM_AML_SUBSCRIPTION / LOOM_AML_RESOURCE_GROUP / ` +
      `LOOM_AML_REGION fall back to LOOM_FOUNDRY_NAME / LOOM_SUBSCRIPTION_ID / ` +
      `LOOM_FOUNDRY_RG / LOOM_FOUNDRY_REGION when those are set.`;
  }
}

/**
 * Resolve the AML workspace coordinates from env. Throws
 * `AmlNotConfiguredError` (listing the missing vars) when the subscription or
 * workspace can't be determined — those two are the irreducible minimum; the
 * resource group and region always have a deterministic fallback.
 */
export function resolveAmlTarget(): AmlTarget {
  const missing: string[] = [];

  const subscriptionId =
    process.env.LOOM_AML_SUBSCRIPTION ||
    process.env.LOOM_AML_SUB ||
    process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_AML_SUBSCRIPTION (or LOOM_SUBSCRIPTION_ID)');

  // The standalone AML workspace NAME. Accept LOOM_AML_WORKSPACE and the
  // LOOM_AML_WORKSPACE_NAME alias. Fall back to LOOM_FOUNDRY_NAME ONLY for
  // back-compat with older deployments where the Foundry hub WAS a real ML
  // workspace — in deployments where LOOM_FOUNDRY_NAME points at an Azure
  // OpenAI / AIServices account this fallback resolves to a non-ML resource, so
  // the ML control-plane call will 404 honestly (the caller surfaces that as a
  // real error / honest gate — never a faked success).
  const workspace =
    process.env.LOOM_AML_WORKSPACE ||
    process.env.LOOM_AML_WORKSPACE_NAME ||
    process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)');

  if (missing.length) throw new AmlNotConfiguredError(missing);

  const region =
    process.env.LOOM_AML_REGION ||
    process.env.LOOM_FOUNDRY_REGION ||
    process.env.LOOM_LOCATION ||
    'eastus2';

  const resourceGroup =
    process.env.LOOM_AML_RESOURCE_GROUP ||
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    `rg-csa-loom-admin-${region}`;

  return { subscriptionId: subscriptionId!, resourceGroup, workspace: workspace!, region };
}

/** True when the AML workspace can be resolved (env is set). Lets callers branch without try/catch. */
export function isAmlConfigured(): boolean {
  try {
    resolveAmlTarget();
    return true;
  } catch {
    return false;
  }
}

/**
 * The bare ARM resource path for the workspace (no scheme / host — prepend
 * `armBase()`). Mirrors `foundry-client.ts::workspaceArmBase()` but uses the
 * standalone AML coordinates.
 *
 *   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.MachineLearningServices/workspaces/<ws>
 */
export function amlWorkspaceArmPath(target: AmlTarget = resolveAmlTarget()): string {
  return (
    `/subscriptions/${target.subscriptionId}` +
    `/resourceGroups/${target.resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${target.workspace}`
  );
}

/**
 * AML *data-plane* (MLflow tracking) hostname suffix for the active cloud.
 * Commercial: `api.azureml.ms`; Government (GCC-High / IL5): `api.ml.azure.us`
 * (verified against the AML firewall host list on Microsoft Learn, e.g.
 * `usgovvirginia.api.ml.azure.us`). Exposed so the MLflow client / future
 * data-plane callers select the Gov suffix from one place instead of
 * hard-coding `api.azureml.ms`.
 */
export function amlDataPlaneHostSuffix(): string {
  return isGovCloud() ? 'api.ml.azure.us' : 'api.azureml.ms';
}
