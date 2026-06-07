/**
 * Azure Machine Learning — Environment management (ARM management plane).
 *
 * Fabric notebooks have a per-workspace "Environment" (libraries: PyPI / Conda
 * packages, custom .jar / wheel attachments, Spark runtime). The Azure-native
 * 1:1 for a *curated, registered, reusable* environment is an Azure ML
 * **Environment** asset — a named, versioned image + conda spec registered
 * under an AML workspace. This is the DEFAULT backend (no Fabric workspace
 * required); see `.claude/rules/no-fabric-dependency.md`.
 *
 * Real ARM REST (api-version 2024-10-01, GA — same version foundry-client uses
 * for /models, /data, /jobs). Grounded in Learn:
 *   GET  {arm}/.../workspaces/{ws}/environments                       → list containers
 *   GET  {arm}/.../workspaces/{ws}/environments/{name}/versions       → list versions
 *   GET  {arm}/.../workspaces/{ws}/environments/{name}/versions/{v}   → one version
 *   PUT  {arm}/.../workspaces/{ws}/environments/{name}/versions/{v}   → create/register
 * Each version's `properties.condaFile` is a raw conda YAML string carrying the
 * pip + conda dependency lists (the real packages the environment installs).
 * https://learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces/environments/versions
 *
 * Auth: ARM `.default` (sovereign-cloud) token minted from the Console UAMI via
 * ChainedTokenCredential — identical to foundry-client.ts / mlflow-client.ts.
 * UAMI role: AzureML Data Scientist (f6c7c914-...) on the workspace (granted in
 * ai-foundry.bicep) — read + register environment versions.
 *
 * Honest infra-gate: when the workspace can't be resolved from env,
 * `amlEnvConfig()` throws `AmlEnvNotConfiguredError` carrying the exact env vars
 * to set. Routes surface that as a Fluent MessageBar; the editor surface still
 * renders fully (per no-vaporware.md).
 */
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';
import { extractPackages, buildCondaYaml, type AmlPackage, type PackageSource } from './aml-environment-conda';

export { extractPackages, buildCondaYaml };
export type { AmlPackage, PackageSource };

const ARM_SCOPE = armScope();
const ML_API = '2024-10-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Raised when the AML workspace needed for environment management isn't configured. */
export class AmlEnvNotConfiguredError extends Error {
  hint: string;
  missing: string[];
  notDeployed = true;
  constructor(missing: string[]) {
    super('Azure ML environment management is not configured in this deployment');
    this.name = 'AmlEnvNotConfiguredError';
    this.missing = missing;
    this.hint =
      `Set ${missing.join(' + ')} to a deployed Azure Machine Learning workspace, ` +
      `then grant the Console UAMI the AzureML Data Scientist role on it. ` +
      `LOOM_AML_WORKSPACE / LOOM_AML_RG fall back to LOOM_FOUNDRY_NAME / ` +
      `LOOM_FOUNDRY_RG when those are set (ai-foundry.bicep deploys the hub).`;
  }
}

/** Non-404 ARM failure surfacing status + body for the route. */
export class AmlEnvError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `AML environment call failed (${status})`);
    this.name = 'AmlEnvError';
    this.status = status;
    this.body = body;
  }
}

interface AmlEnvConfig {
  subscriptionId: string;
  resourceGroup: string;
  workspace: string;
  /** ARM-relative base under the workspace (no api-version). */
  base: string;
}

/**
 * Resolve the AML workspace from env. Workspace + RG honor the task's dedicated
 * vars first, then fall back to the Foundry hub env so an already-configured
 * Loom keeps working without new vars. NEVER reads Fabric workspace ids.
 */
export function amlEnvConfig(): AmlEnvConfig {
  const missing: string[] = [];
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID;
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');

  const workspace = process.env.LOOM_AML_WORKSPACE || process.env.LOOM_FOUNDRY_NAME;
  if (!workspace) missing.push('LOOM_AML_WORKSPACE');

  if (missing.length) throw new AmlEnvNotConfiguredError(missing);

  const resourceGroup =
    process.env.LOOM_AML_RG ||
    process.env.LOOM_FOUNDRY_RG ||
    'rg-csa-loom-admin-eastus2';

  const base =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.MachineLearningServices/workspaces/${workspace}` +
    `/environments`;

  return { subscriptionId: subscriptionId!, resourceGroup, workspace: workspace!, base };
}

/** True when env management can be reached (env is set). */
export function isAmlEnvConfigured(): boolean {
  try { amlEnvConfig(); return true; } catch { return false; }
}

async function armFetch(
  fullPath: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for AML environments');
  const sep = fullPath.includes('?') ? '&' : '?';
  const query = init.query ? '&' + new URLSearchParams(init.query).toString() : '';
  const url = `${armBase()}${fullPath}${sep}api-version=${ML_API}${query}`;
  const { query: _q, ...rest } = init;
  return fetch(url, {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
}

async function readJson<T>(res: Response): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `AML environments ${res.status}`);
    throw new AmlEnvError(res.status, parsed, `AML environments ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

// ---------------- Conda YAML → package list ----------------
// `extractPackages` + `buildCondaYaml` live in ./aml-environment-conda (no Azure
// imports → unit-testable in isolation) and are re-exported above.

// ---------------- Shaped entities ----------------

export interface AmlEnvironment {
  name: string;
  latestVersion?: string;
  image?: string;
  osType?: string;
  description?: string;
  isArchived?: boolean;
  stage?: string;
  condaFile?: string;
  packages: AmlPackage[];
}

function shapeContainer(raw: any): { name: string; latestVersion?: string; description?: string } {
  const p = raw?.properties || {};
  return { name: raw?.name, latestVersion: p.latestVersion, description: p.description };
}

function shapeVersion(name: string, raw: any): AmlEnvironment {
  const p = raw?.properties || {};
  return {
    name,
    latestVersion: raw?.name,           // version asset name == the version string
    image: p.image,
    osType: p.osType,
    description: p.description,
    isArchived: p.isArchived,
    stage: p.stage,
    condaFile: p.condaFile,
    packages: extractPackages(p.condaFile),
  };
}

async function pagedList(path: string): Promise<any[]> {
  const out: any[] = [];
  let res = await armFetch(path);
  let j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  while (j) {
    if (Array.isArray(j.value)) out.push(...j.value);
    if (!j.nextLink) break;
    const token = await credential.getToken(ARM_SCOPE);
    res = await fetch(j.nextLink, { headers: { authorization: `Bearer ${token!.token}` } });
    j = await readJson<{ value?: any[]; nextLink?: string }>(res);
  }
  return out;
}

// ---------------- Public API ----------------

/**
 * List the workspace's environments. For each non-archived container we resolve
 * its latest version to attach the real image + package list (extracted from the
 * version's condaFile). Curated AzureML-* environments and custom ones both
 * surface here — no Fabric dependency. Returns [] when the workspace simply has
 * no environments yet (a real, empty-but-reachable state — not an error).
 */
export async function listEnvironments(): Promise<AmlEnvironment[]> {
  const cfg = amlEnvConfig();
  const containers = (await pagedList(cfg.base)).map(shapeContainer);
  const out: AmlEnvironment[] = [];
  for (const c of containers) {
    if (!c.name) continue;
    let version = c.latestVersion;
    let detail: AmlEnvironment | null = null;
    try {
      if (!version) {
        // No latestVersion on the container — list versions and take the newest.
        const versions = await pagedList(`${cfg.base}/${encodeURIComponent(c.name)}/versions`);
        const newest = versions[0];
        if (newest) detail = shapeVersion(c.name, newest);
      } else {
        const res = await armFetch(`${cfg.base}/${encodeURIComponent(c.name)}/versions/${encodeURIComponent(version)}`);
        const vj = await readJson<any>(res);
        if (vj) detail = shapeVersion(c.name, vj);
      }
    } catch (e) {
      if (!(e instanceof AmlEnvError && e.status === 404)) throw e;
    }
    if (detail) {
      if (detail.isArchived) continue;   // hide archived environments
      out.push({ ...detail, description: detail.description || c.description });
    } else {
      out.push({ name: c.name, latestVersion: version, description: c.description, packages: [] });
    }
  }
  return out;
}

/** Get one environment (latest or a specific version) with its real packages. */
export async function getEnvironment(name: string, version?: string): Promise<AmlEnvironment | null> {
  const cfg = amlEnvConfig();
  let ver = version;
  if (!ver) {
    const res = await armFetch(`${cfg.base}/${encodeURIComponent(name)}`);
    const cj = await readJson<any>(res);
    if (!cj) return null;
    ver = cj?.properties?.latestVersion;
    if (!ver) {
      const versions = await pagedList(`${cfg.base}/${encodeURIComponent(name)}/versions`);
      ver = versions[0]?.name;
    }
  }
  if (!ver) return null;
  const vres = await armFetch(`${cfg.base}/${encodeURIComponent(name)}/versions/${encodeURIComponent(ver)}`);
  const vj = await readJson<any>(vres);
  return vj ? shapeVersion(name, vj) : null;
}

/** List all versions (name + image + package count) of one environment. */
export async function listEnvironmentVersions(name: string): Promise<AmlEnvironment[]> {
  const cfg = amlEnvConfig();
  const rows = await pagedList(`${cfg.base}/${encodeURIComponent(name)}/versions`);
  return rows.map((v) => shapeVersion(name, v));
}

/**
 * Register (create or update) an environment version. The caller supplies a base
 * image + a structured package selection that we render into a conda YAML — the
 * UI never asks the user to hand-author YAML (per loom_no_freeform_config rule).
 */
export async function createEnvironment(body: {
  name: string;
  version?: string;
  image: string;
  description?: string;
  condaPackages?: string[];
  pipPackages?: string[];
  /** Pre-rendered conda YAML (when the caller already has one). */
  condaFile?: string;
}): Promise<AmlEnvironment> {
  const cfg = amlEnvConfig();
  const ver = (body.version || '1').trim();
  const condaFile = body.condaFile || buildCondaYaml({
    condaPackages: body.condaPackages,
    pipPackages: body.pipPackages,
  });
  const armBody = {
    properties: {
      image: body.image,
      osType: 'Linux',
      description: body.description || '',
      ...(condaFile ? { condaFile } : {}),
    },
  };
  const res = await armFetch(
    `${cfg.base}/${encodeURIComponent(body.name)}/versions/${encodeURIComponent(ver)}`,
    { method: 'PUT', body: JSON.stringify(armBody) },
  );
  const j = await readJson<any>(res);
  if (!j) throw new AmlEnvError(res.status, null, 'Environment create returned no body');
  return shapeVersion(body.name, j);
}
