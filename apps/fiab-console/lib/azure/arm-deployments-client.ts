/**
 * ARM deployments client — the infra-side of the Deployment surface.
 *
 * Lists Microsoft.Resources/deployments (the bicep / ARM-template rollouts)
 * at resource-group scope across the Loom RGs, so the operator can see the
 * platform's own deployment history alongside the Fabric content-promotion
 * pipelines.
 *
 * Backend: ARM REST
 *   GET /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Resources/deployments
 *   GET .../deployments/{name}/operations   (per-resource step detail)
 * Docs: https://learn.microsoft.com/rest/api/resources/deployments/list-by-resource-group
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) — identical to
 * every other Loom ARM client. The UAMI needs at least "Reader" on the Loom
 * subscription / RGs to enumerate deployments.
 *
 * Honest gate: when LOOM_SUBSCRIPTION_ID / Loom RGs aren't configured this
 * throws DeploymentsNotConfiguredError, which the BFF maps to a Fluent
 * MessageBar naming the exact env var. No mocks, no sample data.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

const ARM = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const DEPLOYMENTS_API = '2021-04-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class ArmDeploymentsError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ArmDeploymentsError';
    this.status = status;
    this.body = body;
  }
}

export class DeploymentsNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`ARM deployments not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'DeploymentsNotConfiguredError';
  }
}

export interface DeploymentsConfig {
  subscriptionId: string;
  resourceGroups: string[];
}

/** Read the subscription + the set of Loom resource groups from env. */
export function readDeploymentsConfig(): DeploymentsConfig {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  if (!subscriptionId) throw new DeploymentsNotConfiguredError(['LOOM_SUBSCRIPTION_ID']);
  const rgs = new Set<string>();
  for (const v of [
    process.env.LOOM_ADMIN_RG,
    process.env.LOOM_ACA_RG,
    process.env.LOOM_DLZ_RG,
    process.env.LOOM_AI_SEARCH_RG,
    process.env.LOOM_KUSTO_RG,
    process.env.LOOM_APIM_RG,
    process.env.LOOM_FOUNDRY_RG,
    process.env.LOOM_AOAI_RG,
  ]) {
    if (v && v.trim()) rgs.add(v.trim());
  }
  if (rgs.size === 0) throw new DeploymentsNotConfiguredError(['LOOM_ADMIN_RG (or any Loom *_RG)']);
  return { subscriptionId, resourceGroups: Array.from(rgs) };
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new ArmDeploymentsError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armGet(path: string): Promise<any> {
  const tk = await token();
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${tk}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM GET failed (${res.status})`).toString();
    throw new ArmDeploymentsError(msg, res.status, json || text);
  }
  return json;
}

export interface ArmDeployment {
  id: string;
  name: string;
  resourceGroup: string;
  provisioningState?: string;   // Succeeded | Failed | Running | Canceled | Accepted
  timestamp?: string;
  durationSec?: number;
  mode?: string;                // Incremental | Complete
  correlationId?: string;
  templateHash?: string;
  /** Number of resources the deployment touched (output.outputResources). */
  resourceCount?: number;
  /** First error message when provisioningState is Failed. */
  error?: string;
}

function parseDurationSec(iso?: string): number | undefined {
  if (!iso) return undefined;
  // ARM returns ISO-8601 duration e.g. PT3M12.34S
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso.trim());
  if (!m) return undefined;
  const [, h, min, s] = m;
  return Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

function shape(raw: any, rg: string): ArmDeployment {
  const props = raw?.properties || {};
  const err = props?.error;
  return {
    id: raw?.id,
    name: raw?.name,
    resourceGroup: rg,
    provisioningState: props?.provisioningState,
    timestamp: props?.timestamp,
    durationSec: parseDurationSec(props?.duration),
    mode: props?.mode,
    correlationId: props?.correlationId,
    templateHash: props?.templateHash,
    resourceCount: Array.isArray(props?.outputResources) ? props.outputResources.length : undefined,
    error: err ? (err.message || err.code || JSON.stringify(err)).toString() : undefined,
  };
}

/**
 * List ARM deployments across the Loom resource groups, newest first.
 * `top` caps the per-RG page size (ARM default is 50/page); we page once
 * per RG so the most recent rollouts surface without unbounded fan-out.
 */
export async function listArmDeployments(opts?: { top?: number }): Promise<ArmDeployment[]> {
  const cfg = readDeploymentsConfig();
  const top = Math.min(200, Math.max(1, opts?.top ?? 50));
  const all: ArmDeployment[] = [];
  await Promise.all(
    cfg.resourceGroups.map(async (rg) => {
      const j = await armGet(
        `/subscriptions/${cfg.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Resources/deployments?api-version=${DEPLOYMENTS_API}&$top=${top}`,
      );
      for (const d of j?.value || []) all.push(shape(d, rg));
    }),
  );
  all.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  return all;
}

export interface ArmDeploymentOperation {
  provisioningState?: string;
  timestamp?: string;
  resourceType?: string;
  resourceName?: string;
  statusCode?: string;
  durationSec?: number;
}

/**
 * Per-resource operation detail for one deployment — the "step" breakdown the
 * portal shows when you expand a deployment.
 *   GET .../deployments/{name}/operations
 */
export async function listArmDeploymentOperations(
  resourceGroup: string,
  deploymentName: string,
): Promise<ArmDeploymentOperation[]> {
  const cfg = readDeploymentsConfig();
  const j = await armGet(
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${encodeURIComponent(deploymentName)}/operations?api-version=${DEPLOYMENTS_API}`,
  );
  const out: ArmDeploymentOperation[] = [];
  for (const op of j?.value || []) {
    const p = op?.properties || {};
    const tr = p?.targetResource || {};
    out.push({
      provisioningState: p?.provisioningState,
      timestamp: p?.timestamp,
      resourceType: tr?.resourceType,
      resourceName: tr?.resourceName,
      statusCode: p?.statusCode,
      durationSec: parseDurationSec(p?.duration),
    });
  }
  return out;
}
