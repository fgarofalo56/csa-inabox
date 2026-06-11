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

/**
 * Workload profiles selectable for a Loom container app. Kept in lockstep with
 * the route-layer allowlist (app/api/admin/scaling/container-apps/route.ts) so
 * the structured deploy/scale options never accept a free-form profile string.
 */
export const ACA_WORKLOAD_PROFILES = new Set([
  'Consumption', 'D4', 'D8', 'D16', 'D32', 'E4', 'E8', 'E16', 'E32',
]);

/**
 * Allowlisted env-var name prefixes the MCP deploy path accepts. Per
 * loom-no-freeform-config.md the deploy method never takes an arbitrary
 * env/secrets blob — every env name must match one of these prefixes (or the
 * standard telemetry/identity keys app-deployments.bicep already injects), so
 * a caller cannot inject an unrelated variable through the structured options.
 */
const MCP_ENV_NAME_RE = /^(LOOM_|MCP_|AZURE_|APPLICATIONINSIGHTS_|KEYVAULT_|CSA_LOOM_)[A-Z0-9_]*$/;

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

/** managedEnvironments/{env}/storages/{name} URL — the Azure Files mount registration. */
function storageUrl(cfg: AcaConfig, envName: string, storageName: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/managedEnvironments/${envName}/storages/${storageName}`;
}

const STORAGE_API = '2023-01-01';

/** Microsoft.Storage/storageAccounts/{name}/listKeys URL. */
function storageListKeysUrl(cfg: AcaConfig, account: string, rg: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${account}/listKeys`;
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

// ---------------------------------------------------------------------------
// MCP deploy + Azure Files mount (persistence)
// ---------------------------------------------------------------------------
//
// Mounting an Azure Files share into a Loom container app is a TWO-resource
// operation (Microsoft Learn — "Use storage mounts in Azure Container Apps"):
//   1. Register the share on the managed environment as a
//      Microsoft.App/managedEnvironments/{env}/storages/{name} resource.
//   2. Add a `template.volumes[]` entry (storageType: AzureFile) + per-container
//      `volumeMounts[]` to the container app and roll a new revision.
//
// CRITICAL Azure constraint (Learn): Container Apps does NOT support
// identity-based access to Azure file shares — the storage-account KEY is
// mandatory on the storages resource (a secure-string property; not a Key
// Vault secretRef on the 2024-03-01 api-version). The app's *env* secrets stay
// Key Vault-backed. We surface this honestly rather than attempting an identity
// mount that silently fails. With activeRevisionsMode 'Single' the new revision
// replaces the old one — expect a brief MCP connection drop on apply.

export type AcaAccessMode = 'ReadWrite' | 'ReadOnly';

/** A Key Vault-backed env secret (the `{ name, keyVaultUrl, identity }` shape app-deployments.bicep emits). */
export interface AcaKvSecretRef {
  /** Secret name referenced by an env `secretRef`. */
  name: string;
  /** Full Key Vault secret URL, e.g. https://<kv>.vault.azure.net/secrets/<name>. */
  keyVaultUrl: string;
}

/** A structured env var — either a literal value OR a reference to a declared KV secret. */
export interface McpEnvVar {
  name: string;
  value?: string;
  secretRef?: string;
}

/** Honest gate raised when the active boundary runs MCP on AKS, not Container Apps. */
export class AcaPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcaPlatformError';
  }
}

/**
 * True when this boundary runs Loom workloads on AKS (GCC-High / IL5 / DoD)
 * rather than Container Apps. The ACA deploy + Azure Files mount path does not
 * apply there — the MCP workload is an AKS Deployment with an Azure Files PVC.
 */
function isAksPlatform(): boolean {
  return (
    (process.env.LOOM_CONTAINER_PLATFORM || '').toLowerCase() === 'aks' ||
    !!process.env.LOOM_AKS_CLUSTER_NAME
  );
}

function assertAcaPlatform(): void {
  if (isAksPlatform()) {
    throw new AcaPlatformError(
      'This deployment runs MCP on AKS (GCC-High / IL5 / DoD), not Azure Container Apps. ' +
        'Persist MCP state with an Azure Files PersistentVolumeClaim on the AKS workload ' +
        '(platform/fiab/bicep/modules/admin-plane/app-deployments.bicep — gitopsManifest path) ' +
        'rather than a managedEnvironments/storages mount. The Container Apps storage-mount ' +
        'path is Commercial / GCC only.',
    );
  }
}

export interface UpsertEnvStorageOptions {
  /** Managed-environment (CAE) name — defaults to LOOM_ACA_ENVIRONMENT. */
  envName?: string;
  /** managedEnvironments/storages resource name. */
  storageName: string;
  /** Azure Files storage account name. */
  accountName: string;
  /**
   * Storage account key. Required — Container Apps does NOT support
   * identity-based access to Azure file shares (Learn). Resolve from Key Vault
   * (kv-client) or a storage-account listKeys ARM call before calling.
   */
  accountKey: string;
  /** Azure file share name. */
  shareName: string;
  /** Mount access mode. Defaults to ReadWrite. */
  accessMode?: AcaAccessMode;
}

export interface EnvStorageInfo {
  name: string;
  provisioningState?: string;
}

/**
 * PUT a managedEnvironments/storages resource registering an Azure Files share
 * on the managed environment so container apps in that environment can mount
 * it. The storage-account key is passed inline (identity mounts are
 * unsupported — see module header).
 */
export async function upsertEnvStorage(opts: UpsertEnvStorageOptions): Promise<EnvStorageInfo> {
  assertAcaPlatform();
  const cfg = readAcaConfig();
  const envName = opts.envName || process.env.LOOM_ACA_ENVIRONMENT || '';
  if (!envName) {
    throw new AcaNotConfiguredError(['LOOM_ACA_ENVIRONMENT (managed environment name)']);
  }
  if (!opts.storageName) throw new AcaArmError(400, undefined, 'storageName required');
  if (!opts.accountName) throw new AcaArmError(400, undefined, 'accountName required');
  if (!opts.accountKey) {
    throw new AcaArmError(
      400, undefined,
      'accountKey required — Container Apps cannot mount Azure Files with a managed identity.',
    );
  }
  if (!opts.shareName) throw new AcaArmError(400, undefined, 'shareName required');
  const accessMode: AcaAccessMode = opts.accessMode || 'ReadWrite';
  if (accessMode !== 'ReadWrite' && accessMode !== 'ReadOnly') {
    throw new AcaArmError(400, undefined, `accessMode must be ReadWrite or ReadOnly (got ${accessMode})`);
  }
  const body = {
    properties: {
      azureFile: {
        accountName: opts.accountName,
        accountKey: opts.accountKey,
        shareName: opts.shareName,
        accessMode,
      },
    },
  };
  const r = await callArm(
    `${storageUrl(cfg, envName, opts.storageName)}?api-version=${ACA_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 201 && r.status !== 202) {
    throw new AcaArmError(r.status, await r.text(), `upsertEnvStorage(${opts.storageName}) failed ${r.status}`);
  }
  if (r.status === 202) return { name: opts.storageName, provisioningState: 'Updating' };
  const j: any = await r.json().catch(() => ({}));
  return { name: j?.name || opts.storageName, provisioningState: j?.properties?.provisioningState || 'Succeeded' };
}

export interface McpDeployOptions {
  /** Container app name. Defaults to 'loom-mcp'. */
  name?: string;
  /** managedEnvironments/storages resource name to mount (must already exist — call upsertEnvStorage first). */
  storageName: string;
  /** Absolute mount path inside the MCP container, e.g. '/data'. */
  mountPath: string;
  /** Volume name in the app template. Defaults to '<storageName>-vol'. */
  volumeName?: string;
  /** Optional subPath within the share. Must NOT start with '/' (Learn). */
  subPath?: string;
  /** Optional new image (e.g. 'loom-mcp:v0.2'). When set, rolls the container to this image. */
  image?: string;
  /** Optional workload-profile change (validated against ACA_WORKLOAD_PROFILES). */
  workloadProfileName?: string;
  /** Optional Key Vault-backed env secrets to merge into configuration.secrets. */
  secrets?: AcaKvSecretRef[];
  /** Optional env vars to merge into the MCP container (names allowlisted). */
  env?: McpEnvVar[];
}

/**
 * Deploy / re-deploy the MCP container app with an Azure Files volume mounted
 * for persistence. Reads the existing app (GET) and layers the volume,
 * volumeMount, optional image/profile/secret/env changes onto it before PUTting
 * the full resource back — so the bicep-declared shape (managedEnvironmentId,
 * ingress, registries, probes, scale) is preserved and only the mount + any
 * explicit changes are applied. Mirrors the real "mount persistence" admin
 * action. With activeRevisionsMode 'Single' a new revision replaces the old.
 */
export async function deployMcpContainerApp(opts: McpDeployOptions): Promise<ContainerAppInfo> {
  assertAcaPlatform();
  const cfg = readAcaConfig();
  const name = opts.name || 'loom-mcp';
  if (!opts.storageName) throw new AcaArmError(400, undefined, 'storageName required');
  if (!opts.mountPath || !opts.mountPath.startsWith('/')) {
    throw new AcaArmError(400, undefined, `mountPath must be an absolute path (got ${opts.mountPath || 'empty'})`);
  }
  if (opts.subPath && opts.subPath.startsWith('/')) {
    throw new AcaArmError(400, undefined, 'subPath must not start with "/" (Azure Files mount constraint)');
  }
  if (opts.workloadProfileName && !ACA_WORKLOAD_PROFILES.has(opts.workloadProfileName)) {
    throw new AcaArmError(
      400, undefined,
      `workloadProfileName must be one of ${[...ACA_WORKLOAD_PROFILES].join(', ')}`,
    );
  }
  for (const e of opts.env || []) {
    if (!MCP_ENV_NAME_RE.test(e.name)) {
      throw new AcaArmError(400, undefined, `env name "${e.name}" is not allowlisted for the MCP deploy path`);
    }
    if (e.value !== undefined && e.secretRef !== undefined) {
      throw new AcaArmError(400, undefined, `env "${e.name}" cannot set both value and secretRef`);
    }
  }
  for (const sref of opts.secrets || []) {
    if (!sref.name || !sref.keyVaultUrl) {
      throw new AcaArmError(400, undefined, 'each secret requires { name, keyVaultUrl }');
    }
  }

  // GET the existing app so we preserve every bicep-declared property.
  const getR = await callArm(`${appUrl(cfg, name)}?api-version=${ACA_API}`);
  if (!getR.ok) throw new AcaArmError(getR.status, await getR.text(), `deployMcpContainerApp: GET ${name} failed ${getR.status}`);
  const app: any = await getR.json();
  const props = app.properties = app.properties || {};
  const config = props.configuration = props.configuration || {};
  const template = props.template = props.template || {};
  const containers: any[] = template.containers = template.containers || [];

  const volumeName = opts.volumeName || `${opts.storageName}-vol`;

  // Merge the volume (idempotent on volumeName).
  const volumes: any[] = template.volumes = template.volumes || [];
  const existingVol = volumes.find((v) => v?.name === volumeName);
  const volEntry = { name: volumeName, storageType: 'AzureFile', storageName: opts.storageName };
  if (existingVol) Object.assign(existingVol, volEntry);
  else volumes.push(volEntry);

  // Merge the volumeMount onto the MCP container (the first / matching container).
  const target = containers.find((c) => c?.name === name) || containers[0];
  if (!target) throw new AcaArmError(500, undefined, `container app ${name} has no containers to mount into`);
  const mounts: any[] = target.volumeMounts = target.volumeMounts || [];
  const mountEntry: any = { volumeName, mountPath: opts.mountPath };
  if (opts.subPath) mountEntry.subPath = opts.subPath;
  const existingMount = mounts.find((m) => m?.volumeName === volumeName);
  if (existingMount) Object.assign(existingMount, mountEntry);
  else mounts.push(mountEntry);

  // Optional image roll.
  if (opts.image) target.image = opts.image;

  // Optional workload-profile change.
  if (opts.workloadProfileName) props.workloadProfileName = opts.workloadProfileName;

  // Merge Key Vault-backed secrets (keyVaultUrl + the app's own UAMI identity).
  if (opts.secrets?.length) {
    const identityId = Object.keys(app.identity?.userAssignedIdentities || {})[0];
    const secrets: any[] = config.secrets = config.secrets || [];
    for (const sref of opts.secrets) {
      const entry: any = { name: sref.name, keyVaultUrl: sref.keyVaultUrl };
      if (identityId) entry.identity = identityId;
      const existing = secrets.find((s) => s?.name === sref.name);
      if (existing) Object.assign(existing, entry);
      else secrets.push(entry);
    }
  }

  // Merge env (allowlisted names).
  if (opts.env?.length) {
    const env: any[] = target.env = target.env || [];
    for (const e of opts.env) {
      const entry: any = { name: e.name };
      if (e.secretRef !== undefined) entry.secretRef = e.secretRef;
      else entry.value = e.value ?? '';
      const existing = env.find((x) => x?.name === e.name);
      if (existing) { delete existing.value; delete existing.secretRef; Object.assign(existing, entry); }
      else env.push(entry);
    }
  }

  // PUT the merged resource back (full replace — new revision).
  const r = await callArm(
    `${appUrl(cfg, name)}?api-version=${ACA_API}`,
    { method: 'PUT', body: JSON.stringify(app) },
  );
  if (!r.ok && r.status !== 201 && r.status !== 202) {
    throw new AcaArmError(r.status, await r.text(), `deployMcpContainerApp(${name}) failed ${r.status}`);
  }
  if (r.status === 202) {
    return {
      id: app.id || name, name, location: app.location || 'unknown',
      workloadProfileName: opts.workloadProfileName || props.workloadProfileName,
      provisioningState: 'Updating',
    };
  }
  return shape(await r.json());
}

/** A Key Vault-backed Container App secret (per the MCP catalog deploy). */
export interface AcaSecretRef {
  /** Secret name as referenced by `secretRef` in env. */
  name: string;
  /** Full Key Vault secret URL: `<vaultUrl>/secrets/<secretName>`. */
  keyVaultUrl: string;
  /** UAMI resource id that resolves the secret (must hold KV Secrets User). */
  identity: string;
}

/** A Container App env entry: a plain value OR a secretRef to an AcaSecretRef. */
export type AcaEnvVar = { name: string; value: string } | { name: string; secretRef: string };

export interface CreateMcpContainerAppOpts {
  /** Container App name (DNS-label safe: lowercase letters/digits/dashes). */
  name: string;
  /** Managed-environment (CAE) resource id. */
  environmentId: string;
  /** Deployment region (ARM `location`). */
  location: string;
  /** UAMI resource id assigned to the app (resolves KV secrets + pulls image). */
  uamiId: string;
  /** Container image reference. */
  image: string;
  /** Internal ingress target port. */
  targetPort: number;
  /** Env vars (plain + secretRef). */
  env: AcaEnvVar[];
  /** Key Vault-backed secrets. */
  secrets: AcaSecretRef[];
  /** Optional entrypoint override. */
  command?: string[];
  /** Optional args. */
  args?: string[];
  /** Optional ACR/registry login server (for private registries). */
  registryServer?: string;
}

/**
 * Create (PUT) a Container App for a catalog-deployed MCP server. Internal
 * ingress only (reachable from the console + copilot on the CAE VNet, never
 * public). Secrets are Key Vault-backed and resolved by the assigned UAMI.
 *
 * Real ARM REST — `PUT Microsoft.App/containerApps/{name}`. Returns the shaped
 * app info; a 201/202 (async create) returns a provisioning placeholder. Throws
 * AcaArmError verbatim on failure so the route surfaces the precise ARM message.
 */
export async function createMcpContainerApp(opts: CreateMcpContainerAppOpts): Promise<ContainerAppInfo> {
  const cfg = readAcaConfig();
  const container: any = {
    name: opts.name,
    image: opts.image,
    env: opts.env,
    resources: { cpu: 0.5, memory: '1Gi' },
  };
  if (opts.command && opts.command.length) container.command = opts.command;
  if (opts.args && opts.args.length) container.args = opts.args;

  const body: any = {
    location: opts.location,
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: { [opts.uamiId]: {} },
    },
    properties: {
      environmentId: opts.environmentId,
      configuration: {
        activeRevisionsMode: 'Single',
        ingress: {
          external: false,
          targetPort: opts.targetPort,
          transport: 'auto',
        },
        secrets: opts.secrets.map((s) => ({
          name: s.name,
          keyVaultUrl: s.keyVaultUrl,
          identity: s.identity,
        })),
        ...(opts.registryServer
          ? { registries: [{ server: opts.registryServer, identity: opts.uamiId }] }
          : {}),
      },
      template: {
        containers: [container],
        scale: { minReplicas: 1, maxReplicas: 2 },
      },
    },
  };

  const r = await callArm(
    `${appUrl(cfg, opts.name)}?api-version=${ACA_API}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  if (!r.ok && r.status !== 201 && r.status !== 202) {
    throw new AcaArmError(r.status, await r.text(), `createMcpContainerApp(${opts.name}) failed ${r.status}`);
  }
  if (r.status === 202) {
    return {
      id: opts.name, name: opts.name, location: opts.location,
      provisioningState: 'Provisioning',
    };
  }
  return shape(await r.json());
}

// ---------------------------------------------------------------------------
// MCP Azure Files persistence config (env-wired by admin-plane/main.bicep)
// ---------------------------------------------------------------------------

export interface McpFilesConfig {
  /** Azure Files storage account name. */
  storageAccount: string;
  /** Resource group holding the storage account (defaults to the ACA RG). */
  resourceGroup: string;
  /** Azure file share name. */
  shareName: string;
  /** managedEnvironments/storages resource name. */
  storageName: string;
  /** Mount path inside the MCP container. */
  mountPath: string;
}

export class McpFilesNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(
      'MCP Azure Files persistence not configured. Missing env: ' +
        missing.join(', ') +
        '. Deploy the MCP file share via platform/fiab/bicep/modules/admin-plane/main.bicep ' +
        '(mcpPersistenceEnabled) which sets LOOM_MCP_FILES_ACCOUNT / LOOM_MCP_FILES_SHARE / ' +
        'LOOM_MCP_STORAGE_NAME on loom-console.',
    );
    this.name = 'McpFilesNotConfiguredError';
  }
}

/**
 * Read the MCP Azure Files persistence config from env. These are wired onto
 * loom-console by admin-plane/main.bicep when mcpPersistenceEnabled is true.
 * Throws McpFilesNotConfiguredError (→ honest 503 gate) when unset.
 */
export function readMcpFilesConfig(): McpFilesConfig {
  const missing: string[] = [];
  const storageAccount = process.env.LOOM_MCP_FILES_ACCOUNT || '';
  const shareName = process.env.LOOM_MCP_FILES_SHARE || '';
  const storageName = process.env.LOOM_MCP_STORAGE_NAME || 'mcp-data';
  const mountPath = process.env.LOOM_MCP_DATA_DIR || '/data';
  const resourceGroup =
    process.env.LOOM_MCP_FILES_RG ||
    process.env.LOOM_ACA_RG ||
    process.env.LOOM_ADMIN_RG ||
    '';
  if (!storageAccount) missing.push('LOOM_MCP_FILES_ACCOUNT');
  if (!shareName) missing.push('LOOM_MCP_FILES_SHARE');
  if (!resourceGroup) missing.push('LOOM_MCP_FILES_RG (or LOOM_ACA_RG / LOOM_ADMIN_RG)');
  if (missing.length) throw new McpFilesNotConfiguredError(missing);
  return { storageAccount, resourceGroup, shareName, storageName, mountPath };
}

/**
 * POST Microsoft.Storage/storageAccounts/{account}/listKeys to fetch the
 * primary account key. Container Apps cannot mount Azure Files with a managed
 * identity (Learn), so the key must be supplied inline to upsertEnvStorage.
 * The Console UAMI needs Microsoft.Storage/storageAccounts/listkeys/action
 * (covered by Contributor on the admin RG — scaling-rbac.bicep).
 */
export async function getStorageAccountKey(account: string, resourceGroup?: string): Promise<string> {
  assertAcaPlatform();
  const cfg = readAcaConfig();
  const rg = resourceGroup || cfg.resourceGroup;
  const r = await callArm(
    `${storageListKeysUrl(cfg, account, rg)}?api-version=${STORAGE_API}`,
    { method: 'POST' },
  );
  if (!r.ok) throw new AcaArmError(r.status, await r.text(), `listKeys(${account}) failed ${r.status}`);
  const j: any = await r.json();
  const key = j?.keys?.[0]?.value;
  if (!key) throw new AcaArmError(500, j, `listKeys(${account}) returned no keys`);
  return key;
}
