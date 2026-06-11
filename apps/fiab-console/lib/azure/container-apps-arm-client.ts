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

/** GET the full (unshaped) container app resource — needed when a caller must
 * read + mutate `properties.template` (e.g. env-var edits, which the shaped
 * accessor does not expose). */
async function getContainerAppRaw(name: string): Promise<any> {
  const cfg = readAcaConfig();
  const r = await callArm(`${appUrl(cfg, name)}?api-version=${ACA_API}`);
  if (!r.ok) throw new AcaArmError(r.status, await r.text(), `getContainerApp(${name}) failed ${r.status}`);
  return r.json();
}

/** ACA secret names: lowercase alphanumerics + '-' only (RFC 1123-ish). Map an
 * env-var key (e.g. SESSION_SECRET) to a valid secret name (session-secret). */
export function envKeyToSecretName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export interface EnvUpdateResult {
  name: string;
  provisioningState: string;
  /** Env var keys whose value changed (plain). */
  changed: string[];
  /** Secret-typed env var keys whose backing ACA secret was set. */
  secretsChanged: string[];
}

/**
 * Set environment variables on an existing container app, creating a NEW
 * REVISION (env vars are a revision-scope change — Azure Learn:
 * "the only way to update the Container App environment variables is by
 * creating a new revision"). Unlike `az containerapp update --set-env-vars`
 * (which merges), the ARM PATCH replaces `properties.template.containers`
 * wholesale — so we GET the full template, mutate the matching container's
 * `env` array in place, and PATCH the complete template back. Existing env
 * vars are preserved (merge semantics, matching the CLI).
 *
 * Secret-typed values (passed via `opts.secrets`) are stored as Container Apps
 * secrets first, then referenced via `secretRef`. To avoid clobbering OTHER
 * existing secrets (a PATCH of `configuration.secrets` replaces the array, and
 * GET returns secrets without values), we POST `listSecrets` to read the full
 * current set WITH values, upsert the changed ones, and PATCH the merged list.
 */
export async function updateContainerAppEnv(
  name: string,
  changes: Record<string, string>,
  opts?: { secrets?: Record<string, string> },
): Promise<EnvUpdateResult> {
  const cfg = readAcaConfig();
  const secrets = opts?.secrets || {};
  const changeKeys = Object.keys(changes);
  const secretKeys = Object.keys(secrets);
  if (changeKeys.length === 0 && secretKeys.length === 0) {
    throw new AcaArmError(400, undefined, 'updateContainerAppEnv: no changes supplied');
  }

  const raw = await getContainerAppRaw(name);
  const props = raw.properties || (raw.properties = {});
  const tmpl = props.template || (props.template = {});
  const containers: any[] = Array.isArray(tmpl.containers) ? tmpl.containers : [];
  if (containers.length === 0) {
    throw new AcaArmError(500, raw, `Container app ${name} has no containers in its template.`);
  }
  // Match the primary container by name (== app name) else fall back to first.
  const container = containers.find((c) => c?.name === name) || containers[0];
  const envArr: any[] = Array.isArray(container.env) ? container.env : (container.env = []);

  const upsertEnv = (key: string, patch: Record<string, unknown>) => {
    const existing = envArr.find((e) => e?.name === key);
    if (existing) {
      delete existing.value; delete existing.secretRef;
      Object.assign(existing, { name: key, ...patch });
    } else {
      envArr.push({ name: key, ...patch });
    }
  };

  // Plain env values.
  for (const k of changeKeys) upsertEnv(k, { value: changes[k] });

  // Secret-typed env values → ACA secrets + secretRef.
  let secretsChanged: string[] = [];
  if (secretKeys.length > 0) {
    const cfgObj = props.configuration || (props.configuration = {});
    // Read the full current secret set WITH values so we don't wipe them.
    let current: Array<{ name: string; value?: string }> = [];
    try {
      const lr = await callArm(`${appUrl(cfg, name)}/listSecrets?api-version=${ACA_API}`, { method: 'POST' });
      if (lr.ok) {
        const lj: any = await lr.json();
        current = Array.isArray(lj?.value) ? lj.value : [];
      }
    } catch { /* no secrets yet */ }
    const byName = new Map(current.map((s) => [s.name, { name: s.name, value: s.value }]));
    for (const k of secretKeys) {
      const sn = envKeyToSecretName(k);
      byName.set(sn, { name: sn, value: secrets[k] });
      upsertEnv(k, { secretRef: sn });
      secretsChanged.push(k);
    }
    cfgObj.secrets = Array.from(byName.values());
  }

  const body: any = { properties: { template: tmpl } };
  if (secretKeys.length > 0) body.properties.configuration = props.configuration;

  const r = await callArm(
    `${appUrl(cfg, name)}?api-version=${ACA_API}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 202) {
    throw new AcaArmError(r.status, await r.text(), `updateContainerAppEnv(${name}) failed ${r.status}`);
  }
  let provisioningState = 'Updating';
  if (r.status !== 202) {
    try { provisioningState = (await r.json())?.properties?.provisioningState || 'Updating'; } catch { /* keep */ }
  }
  return { name, provisioningState, changed: changeKeys, secretsChanged };
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
