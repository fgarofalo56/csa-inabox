/**
 * Azure Container Apps ARM management-plane client.
 *
 * Targets Microsoft.App/containerApps/{name} + the parent managedEnvironments
 * for workload-profile changes. Scale axis surfaced by Loom:
 *   - workloadProfileName (Consumption | D4 | D8 | D16 | E4 | E8 | E16 — must
 *     pre-exist on the managed environment)
 *   - minReplicas / maxReplicas
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential). The UAMI must
 * hold "Container Apps Contributor" (or broader "Contributor") on the RG so
 * it can PATCH the container app and (for new workload profiles) PATCH the
 * managed environment.
 *
 * Workload profile gotcha: Consumption-only environments do NOT support
 * D-/E-series profiles. Switching requires the environment to be created
 * with --enable-workload-profiles (or upgraded via ARM PATCH). If the env
 * has no workload profile with the requested name, ARM returns 400 with a
 * clear message — we surface it verbatim so the admin sees the bicep
 * change required.
 *
 * No mocks. Real ARM REST only.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const ACA_API = '2024-03-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AcaArmError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Container Apps ARM call failed (${status})`);
    this.name = 'AcaArmError';
    this.status = status;
    this.body = body;
  }
}

export interface AcaConfig {
  subscriptionId: string;
  resourceGroup: string;
}

export class AcaNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Container Apps not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AcaNotConfiguredError';
  }
}

export function readAcaConfig(): AcaConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup = process.env.LOOM_ACA_RG || process.env.LOOM_ADMIN_RG || '';
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_ACA_RG (or LOOM_ADMIN_RG)');
  if (missing.length) throw new AcaNotConfiguredError(missing);
  return { subscriptionId, resourceGroup };
}

function appUrl(cfg: AcaConfig, name: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}`;
}

function rgUrl(cfg: AcaConfig): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps`;
}

async function callArm(url: string, init?: RequestInit): Promise<Response> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new AcaArmError(401, undefined, 'Failed to acquire ARM token');
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${t.token}`,
      'content-type': 'application/json',
    },
  });
}

export interface ContainerAppInfo {
  id: string;
  name: string;
  location: string;
  workloadProfileName?: string;
  minReplicas?: number;
  maxReplicas?: number;
  provisioningState?: string;
}

function shape(raw: any): ContainerAppInfo {
  const props = raw?.properties || {};
  const tmpl = props?.template || {};
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    workloadProfileName: props?.workloadProfileName,
    minReplicas: tmpl?.scale?.minReplicas,
    maxReplicas: tmpl?.scale?.maxReplicas,
    provisioningState: props?.provisioningState,
  };
}

/** List the Loom container apps (Console + MCP + Copilot + Activator + Mirroring + Direct-Lake-Shim). */
export async function listContainerApps(): Promise<ContainerAppInfo[]> {
  const cfg = readAcaConfig();
  const r = await callArm(`${rgUrl(cfg)}?api-version=${ACA_API}`);
  if (!r.ok) throw new AcaArmError(r.status, await r.text(), `listContainerApps failed ${r.status}`);
  const j: any = await r.json();
  return (j.value || []).map(shape);
}

export async function getContainerApp(name: string): Promise<ContainerAppInfo> {
  const cfg = readAcaConfig();
  const r = await callArm(`${appUrl(cfg, name)}?api-version=${ACA_API}`);
  if (!r.ok) throw new AcaArmError(r.status, await r.text(), `getContainerApp(${name}) failed ${r.status}`);
  return shape(await r.json());
}

/**
 * PATCH workloadProfileName + replicas on one container app. workloadProfileName
 * change is GA on Premium ACA environments; switching to a D/E profile on
 * a Consumption-only environment will 400 — caller should surface to admin.
 */
export async function updateContainerAppScale(
  name: string,
  opts: { workloadProfileName?: string; minReplicas?: number; maxReplicas?: number },
): Promise<ContainerAppInfo> {
  const cfg = readAcaConfig();
  const body: any = { properties: {} };
  if (opts.workloadProfileName) body.properties.workloadProfileName = opts.workloadProfileName;
  if (typeof opts.minReplicas === 'number' || typeof opts.maxReplicas === 'number') {
    body.properties.template = {
      scale: {
        minReplicas: opts.minReplicas,
        maxReplicas: opts.maxReplicas,
      },
    };
  }
  const r = await callArm(
    `${appUrl(cfg, name)}?api-version=${ACA_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new AcaArmError(r.status, await r.text(), `updateContainerAppScale(${name}) failed ${r.status}`);
  }
  if (r.status === 202) {
    return {
      id: name, name, location: 'unknown',
      workloadProfileName: opts.workloadProfileName,
      minReplicas: opts.minReplicas, maxReplicas: opts.maxReplicas,
      provisioningState: 'Updating',
    };
  }
  return shape(await r.json());
}
