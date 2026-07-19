/**
 * loom-apps-client — the real Azure backend for the Loom App Runtime (DBX-1,
 * Databricks-Apps-class hosted apps).
 *
 * TWO real Azure control planes, no mocks, no Fabric (no-fabric-dependency.md):
 *   1. ACR quick-build (Microsoft.ContainerRegistry/registries) — build a user
 *      app (template starter or public git repo) into an image in the Loom ACR:
 *        POST .../registries/{acr}/listBuildSourceUploadUrl   → blob SAS + relPath
 *        PUT  <blob SAS>  (gzipped ustar build context)       → upload source
 *        POST .../registries/{acr}/scheduleRun (DockerBuildRequest) → run id
 *        GET  .../registries/{acr}/runs/{runId}               → build status
 *   2. Container Apps (Microsoft.App/containerApps) — deploy the built image as
 *      an autoscale-to-zero, Entra-gated app with a live URL; lifecycle via the
 *      real start/stop action APIs + DELETE; logs via Log Analytics.
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) — the SAME Console
 * UAMI every other Loom ARM client uses. It holds Contributor on the admin RG
 * (covers containerApps write + ACR scheduleRun/listBuildSourceUploadUrl/push)
 * and Managed Identity Operator on uami-loom-mcp (assigns it to the app). The
 * DEPLOYED app carries uami-loom-mcp, which holds AcrPull on the Loom ACR
 * (granted by admin-plane/main.bicep) so it can pull the private image.
 *
 * Honest gate (no-vaporware.md): when LOOM_APPS_CAE_ID / LOOM_APPS_ACR_LOGIN_SERVER
 * are unset (or the boundary runs on AKS, or the UAMI lacks the role) the reader
 * throws LoomAppsNotConfiguredError and the BFF maps it to a Fluent MessageBar
 * naming the exact env var / role / bicep module.
 */

import { gzipSync } from 'node:zlib';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import {
  getLoomAppTemplate,
  assembleBuildContext,
  makeTar,
  buildAcaAppBody,
  buildAuthConfigBody,
  loomAppContainerName,
  isValidLoomAppName,
  type LoomAppEnvVar,
  type LoomAppTemplate,
} from './loom-apps-runtime-templates';

const ARM = armBase();
const ARM_SCOPE = armScope();
const ACR_API = '2019-06-01-preview';       // scheduleRun / listBuildSourceUploadUrl / runs
const ACA_API = '2024-03-01';                // containerApps
const ACA_ACTION_API = '2024-03-01';         // start/stop actions

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class LoomAppsError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'LoomAppsError';
    this.status = status;
    this.body = body;
  }
}

/** Honest infra gate — maps to a MessageBar naming the exact env var / role / bicep. */
export class LoomAppsNotConfiguredError extends Error {
  constructor(public missing: string[], public hint: string) {
    super(hint);
    this.name = 'LoomAppsNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Config + honest gate
// ---------------------------------------------------------------------------

export interface LoomAppsConfig {
  subscriptionId: string;
  /** RG holding the ACR + the container-apps environment (admin RG). */
  resourceGroup: string;
  /** Container Apps managed-environment resource id. */
  caeId: string;
  /** ACR login server, e.g. acrloomxxxx.azurecr.io. */
  acrLoginServer: string;
  /** ACR resource name (derived from the login server). */
  acrName: string;
  location: string;
  /** UAMI assigned to deployed apps (AcrPull + KV Secrets User). */
  appUamiId: string;
  /** MSAL app (client) id for the Entra Easy-Auth wrapper (optional). */
  msalClientId: string;
  /** MSAL tenant id (for the openIdIssuer). */
  msalTenantId: string;
}

/**
 * Read the Loom Apps runtime config from env. Throws LoomAppsNotConfiguredError
 * (→ honest MessageBar) when the Container Apps + ACR platform isn't wired. On
 * AKS boundaries (GCC-High / IL5) Microsoft.App/containerApps has no analog, so
 * this honest-gates with the GitOps-manifest remediation.
 */
export function readLoomAppsConfig(): LoomAppsConfig {
  const platform = (process.env.LOOM_CONTAINER_PLATFORM || 'containerApps').trim();
  if (platform === 'aks') {
    throw new LoomAppsNotConfiguredError(
      ['LOOM_CONTAINER_PLATFORM=containerApps'],
      'The Loom App Runtime targets Azure Container Apps (Commercial / GCC). This deployment runs on ' +
        'AKS (GCC-High / IL5) — host apps via the cluster GitOps manifest path instead.',
    );
  }
  const subscriptionId = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const resourceGroup = (process.env.LOOM_ADMIN_RG || process.env.LOOM_ACA_RG || '').trim();
  // LOOM_APPS_CAE_ID falls back to the shared MCP/console CAE (LOOM_CAE_ID /
  // LOOM_ACA_ENV_ID) — the Loom Apps environment IS the same managed env.
  const caeId = (process.env.LOOM_APPS_CAE_ID || process.env.LOOM_CAE_ID || process.env.LOOM_ACA_ENV_ID || '').trim();
  const acrLoginServer = (process.env.LOOM_APPS_ACR_LOGIN_SERVER || process.env.LOOM_ACR_LOGIN_SERVER || '').trim();
  const appUamiId = (process.env.LOOM_APPS_UAMI_ID || process.env.LOOM_MCP_UAMI_ID || '').trim();

  const missing: string[] = [];
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_ADMIN_RG');
  if (!caeId) missing.push('LOOM_APPS_CAE_ID');
  if (!acrLoginServer) missing.push('LOOM_APPS_ACR_LOGIN_SERVER');
  if (!appUamiId) missing.push('LOOM_APPS_UAMI_ID (or LOOM_MCP_UAMI_ID)');
  if (missing.length) {
    throw new LoomAppsNotConfiguredError(
      missing,
      `The Loom App Runtime is not wired. Set ${missing.join(', ')} on the loom-console container app and ` +
        'grant the Console UAMI Container Apps Contributor + AcrPush on the admin RG. Deployed by ' +
        'platform/fiab/bicep/modules/admin-plane/main.bicep (deployAppsEnabled) — the LOOM_APPS_* env + ' +
        'the uami-loom-mcp AcrPull grant.',
    );
  }
  const acrName = acrLoginServer.split('.')[0];
  return {
    subscriptionId,
    resourceGroup,
    caeId,
    acrLoginServer,
    acrName,
    location: (process.env.LOOM_LOCATION || 'eastus2').trim(),
    appUamiId,
    msalClientId: (process.env.LOOM_MSAL_CLIENT_ID || '').trim(),
    msalTenantId: (process.env.LOOM_MSAL_TENANT_ID || process.env.AZURE_TENANT_ID || '').trim(),
  };
}

/** True when the runtime is fully wired (used by the editor to render the infra state). */
export function loomAppsConfigStatus(): { configured: boolean; missing: string[]; hint?: string } {
  try {
    readLoomAppsConfig();
    return { configured: true, missing: [] };
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return { configured: false, missing: e.missing, hint: e.hint };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// ARM helper
// ---------------------------------------------------------------------------

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new LoomAppsError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armFetch(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const tk = await token();
  const url = path.startsWith('http') ? path : `${ARM}${path}`;
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      authorization: `Bearer ${tk}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = (json?.error?.message || text || `ARM ${method} failed (${res.status})`).toString();
    throw new LoomAppsError(msg, res.status, json || text);
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Build (ACR quick-build) — template starter OR public git source
// ---------------------------------------------------------------------------

export interface BuildAppOptions {
  /** Loom item id (drives the image repo name). */
  itemId: string;
  /** Template id (Streamlit/Dash/Gradio/Flask/Express). Required for template builds. */
  templateId?: string;
  /** User source edits: path → content (overrides starter files). */
  userFiles?: Record<string, string>;
  /**
   * Public git repository URL to build FROM instead of the template context.
   * ACR accepts a git URL (optionally #branch:subdir) as the build sourceLocation.
   * Private repos need a token — honest-gated below (named follow-up).
   */
  gitSource?: string;
  /** Ingress/listen port. Defaults to the template's default port. */
  port?: number;
  /** Image tag (defaults to a time-based tag). */
  tag?: string;
}

export interface BuildAppResult {
  /** ACR run id (poll getBuildStatus with this). */
  runId: string;
  /** Full image reference the build pushes to. */
  image: string;
  /** Repo:tag within the ACR. */
  imageName: string;
  status: string;
  source: 'template' | 'git';
}

/** ACR build-source upload target. */
interface SourceUpload {
  uploadUrl: string;
  relativePath: string;
}

async function acrScheduleRunUrl(cfg: LoomAppsConfig, action: string): Promise<string> {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${cfg.acrName}/${action}?api-version=${ACR_API}`;
}

/**
 * Build a user app into the Loom ACR. Template builds upload a gzipped ustar
 * build context (Dockerfile + starter/edited files); git builds point ACR at a
 * public repo URL. Returns the ACR run id — poll getBuildStatus for completion.
 */
export async function buildApp(opts: BuildAppOptions): Promise<BuildAppResult> {
  const cfg = readLoomAppsConfig();
  const repo = `loom-app-${opts.itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);
  const tag = (opts.tag || `b${Date.now().toString(36)}`).replace(/[^a-z0-9._-]/gi, '').slice(0, 40) || 'latest';
  const imageName = `${repo}:${tag}`;
  const image = `${cfg.acrLoginServer}/${imageName}`;

  let source: 'template' | 'git';
  let sourceLocation: string;
  let dockerFilePath = 'Dockerfile';

  if (opts.gitSource && opts.gitSource.trim()) {
    const git = opts.gitSource.trim();
    // Private-repo auth (token-in-URL / PAT) is a named follow-up — see the PRP
    // DBX-1 "deferred" note. Only public https git URLs are accepted here.
    if (!/^https:\/\/(github\.com|dev\.azure\.com|[a-z0-9.-]+\.visualstudio\.com|gitlab\.com|bitbucket\.org)\//i.test(git)) {
      throw new LoomAppsError(
        'Only public https git repositories (github.com / dev.azure.com / gitlab.com / bitbucket.org) are ' +
          'supported. Private-repo authentication (PAT/OAuth) is a tracked follow-up — use a runtime template ' +
          'or a public repo for now.',
        400,
      );
    }
    // Any '@' means embedded credentials (user:pass@host) or an unsupported
    // scp-style ref — reject outright. A plain includes() check covers every
    // credential form without a backtracking regex (js/polynomial-redos).
    if (git.includes('@')) {
      throw new LoomAppsError('Credentials in the git URL are not accepted (private-repo auth is a tracked follow-up).', 400);
    }
    source = 'git';
    sourceLocation = git; // ACR accepts https://host/org/repo(.git)#branch:subfolder
    // If the user pointed at a subdir with a Dockerfile they can encode it in #branch:dir;
    // when the repo has no Dockerfile the build fails with a real ACR error (honest).
  } else {
    const template = opts.templateId ? getLoomAppTemplate(opts.templateId) : undefined;
    if (!template) {
      throw new LoomAppsError(`Unknown runtime template '${opts.templateId}'. Pick a template or supply a git source.`, 400);
    }
    const port = opts.port && opts.port > 0 ? opts.port : template.defaultPort;
    const files = assembleBuildContext({ template, port, userFiles: opts.userFiles });
    const tar = makeTar(files);
    const gz = gzipSync(tar);
    // 1) ask ACR for a source-upload SAS URL.
    const up = await armFetch('POST', await acrScheduleRunUrl(cfg, 'listBuildSourceUploadUrl'));
    const upload = up.json as SourceUpload;
    if (!upload?.uploadUrl || !upload?.relativePath) {
      throw new LoomAppsError('ACR did not return a source-upload URL', 502, up.json);
    }
    // 2) PUT the gzipped context to the blob SAS URL.
    const putRes = await fetchWithTimeout(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/gzip' },
      body: gz,
    });
    if (!putRes.ok) {
      throw new LoomAppsError(`Build context upload failed (${putRes.status})`, 502, await putRes.text().catch(() => ''));
    }
    source = 'template';
    sourceLocation = upload.relativePath;
  }

  // 3) schedule the DockerBuildRequest (isPushEnabled → pushes to the Loom ACR).
  const runBody = {
    type: 'DockerBuildRequest',
    sourceLocation,
    dockerFilePath,
    imageNames: [imageName],
    isPushEnabled: true,
    noCache: false,
    platform: { os: 'Linux', architecture: 'amd64' },
    agentConfiguration: { cpu: 2 },
  };
  const run = await armFetch('POST', await acrScheduleRunUrl(cfg, 'scheduleRun'), runBody);
  const runId = run.json?.properties?.runId || run.json?.name;
  if (!runId) throw new LoomAppsError('ACR scheduleRun did not return a run id', 502, run.json);
  return { runId, image, imageName, status: run.json?.properties?.status || 'Queued', source };
}

export interface BuildStatus {
  runId: string;
  /** Queued | Started | Running | Succeeded | Failed | Canceled | Error | Timeout */
  status: string;
  finished: boolean;
  succeeded: boolean;
}

/** Poll an ACR build run. */
export async function getBuildStatus(runId: string): Promise<BuildStatus> {
  const cfg = readLoomAppsConfig();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(runId)) throw new LoomAppsError(`Invalid run id '${runId}'.`, 400);
  const { json } = await armFetch(
    'GET',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.ContainerRegistry/registries/${cfg.acrName}/runs/${runId}?api-version=${ACR_API}`,
  );
  const status: string = json?.properties?.status || 'Unknown';
  const terminal = ['Succeeded', 'Failed', 'Canceled', 'Error', 'Timeout'];
  return { runId, status, finished: terminal.includes(status), succeeded: status === 'Succeeded' };
}

// ---------------------------------------------------------------------------
// Deploy (Container Apps) + lifecycle
// ---------------------------------------------------------------------------

function appUrl(cfg: LoomAppsConfig, name: string): string {
  return `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}?api-version=${ACA_API}`;
}

export interface DeployedApp {
  name: string;
  provisioningState: string;
  runningStatus?: string;
  /** Public ingress FQDN. */
  fqdn?: string;
  /** https://<fqdn> */
  url?: string;
  image?: string;
  minReplicas?: number;
  maxReplicas?: number;
  /** True when the Entra Easy-Auth wrapper was configured. */
  authConfigured?: boolean;
}

function shapeApp(json: any, authConfigured?: boolean): DeployedApp {
  const props = json?.properties || {};
  const fqdn: string | undefined = props?.configuration?.ingress?.fqdn || undefined;
  const image: string | undefined = props?.template?.containers?.[0]?.image;
  return {
    name: json?.name,
    provisioningState: props?.provisioningState || 'Unknown',
    runningStatus: props?.runningStatus,
    fqdn,
    url: fqdn ? `https://${fqdn}` : undefined,
    image,
    minReplicas: props?.template?.scale?.minReplicas,
    maxReplicas: props?.template?.scale?.maxReplicas,
    authConfigured,
  };
}

export interface DeployAppOptions {
  itemId: string;
  /** Existing container-app name (redeploy) or undefined to mint a new one. */
  name?: string;
  /** Full image reference (from a completed build). */
  image: string;
  targetPort: number;
  env?: LoomAppEnvVar[];
  minReplicas?: number;
  maxReplicas?: number;
  cpu?: number;
  memory?: string;
}

/**
 * Deploy (create or update) a hosted app. External ingress + autoscale-to-zero
 * (minReplicas default 0). Wires the Entra Easy-Auth wrapper when the Console's
 * MSAL app registration is configured (the app inherits the caller's Loom
 * tenant sign-in). Real ARM PUT; returns the live URL + provisioning state.
 */
/** Cached clientId of the shared apps UAMI (ARM GET on cfg.appUamiId). */
let cachedAppUamiClientId: { rid: string; clientId: string } | null = null;
async function appUamiClientId(rid: string): Promise<string> {
  if (!rid) return '';
  if (cachedAppUamiClientId?.rid === rid) return cachedAppUamiClientId.clientId;
  try {
    const { json } = await armFetch('GET', `${rid}?api-version=2023-01-31`);
    const clientId = (json as any)?.properties?.clientId || '';
    if (clientId) cachedAppUamiClientId = { rid, clientId };
    return clientId;
  } catch {
    return '';
  }
}

export async function deployApp(opts: DeployAppOptions): Promise<DeployedApp> {
  const cfg = readLoomAppsConfig();
  const name = opts.name && isValidLoomAppName(opts.name) ? opts.name : loomAppContainerName(opts.itemId);
  // Auto-inject the app identity's clientId so in-app azure-identity
  // (DefaultAzureCredential) resolves the attached UAMI without boilerplate —
  // the Databricks-Apps "credential injection" parity row. A user-set
  // AZURE_CLIENT_ID binding wins.
  const env = [...(opts.env || [])];
  if (!env.some((e) => e.name === 'AZURE_CLIENT_ID')) {
    const cid = await appUamiClientId(cfg.appUamiId);
    if (cid) env.push({ name: 'AZURE_CLIENT_ID', value: cid }, { name: 'LOOM_APP_CLIENT_ID', value: cid });
  }
  const body = buildAcaAppBody({
    name,
    environmentId: cfg.caeId,
    location: cfg.location,
    uamiId: cfg.appUamiId,
    image: opts.image,
    targetPort: opts.targetPort,
    acrLoginServer: cfg.acrLoginServer,
    env,
    minReplicas: opts.minReplicas,
    maxReplicas: opts.maxReplicas,
    cpu: opts.cpu,
    memory: opts.memory,
    external: true,
    keyVaultUri: (process.env.LOOM_APPS_KEY_VAULT_URI || process.env.LOOM_KEY_VAULT_URI || '').trim() || undefined,
  });
  const { json } = await armFetch('PUT', appUrl(cfg, name), body);

  // OAuth wrapper — Entra Easy Auth via the Console's existing MSAL app reg.
  let authConfigured = false;
  if (cfg.msalClientId && cfg.msalTenantId) {
    try {
      const authBody = buildAuthConfigBody({
        clientId: cfg.msalClientId,
        openIdIssuer: `https://login.microsoftonline.com/${cfg.msalTenantId}/v2.0`,
      });
      await armFetch(
        'PUT',
        `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}/authConfigs/current?api-version=${ACA_API}`,
        authBody,
      );
      authConfigured = true;
    } catch {
      // Non-fatal: the app is deployed; the auth wrapper needs the app's redirect
      // URI registered on the MSAL app reg (one-time admin action). Surface the
      // unconfigured state honestly via authConfigured=false rather than failing.
      authConfigured = false;
    }
  }
  return shapeApp(json, authConfigured);
}

/** GET the live status of a deployed app. */
export async function getApp(name: string): Promise<DeployedApp> {
  const cfg = readLoomAppsConfig();
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  const { json } = await armFetch('GET', appUrl(cfg, name));
  return shapeApp(json);
}

/** Start a stopped app (real ACA start action). */
export async function startApp(name: string): Promise<{ name: string; status: string }> {
  const cfg = readLoomAppsConfig();
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  const { status } = await armFetch(
    'POST',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}/start?api-version=${ACA_ACTION_API}`,
  );
  return { name, status: status === 202 ? 'Starting' : 'Started' };
}

/** Stop a running app (real ACA stop action — the per-app disable / kill). */
export async function stopApp(name: string): Promise<{ name: string; status: string }> {
  const cfg = readLoomAppsConfig();
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  const { status } = await armFetch(
    'POST',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}/stop?api-version=${ACA_ACTION_API}`,
  );
  return { name, status: status === 202 ? 'Stopping' : 'Stopped' };
}

/**
 * Restart a running app's active revision (ACA has no single "restart" action,
 * so this restarts the latest active revision — the Databricks-Apps "Restart"
 * parity, e.g. to pick up a rotated KV secret without a full redeploy).
 */
export async function restartApp(name: string): Promise<{ name: string; revision: string }> {
  const cfg = readLoomAppsConfig();
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  // Find the active (latest) revision.
  const { json } = await armFetch(
    'GET',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}/revisions?api-version=${ACA_ACTION_API}`,
  );
  const revs = ((json as any)?.value || []) as Array<{ name: string; properties?: { active?: boolean } }>;
  const active = revs.find((r) => r.properties?.active) || revs[revs.length - 1];
  if (!active?.name) throw new LoomAppsError(`No active revision to restart for '${name}'.`, 409);
  await armFetch(
    'POST',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}/revisions/${active.name}/restart?api-version=${ACA_ACTION_API}`,
  );
  return { name, revision: active.name };
}

/** DELETE a deployed app (idempotent — a 404 is success). */
export async function deleteApp(name: string): Promise<void> {
  const cfg = readLoomAppsConfig();
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  try {
    await armFetch('DELETE', appUrl(cfg, name));
  } catch (e) {
    if (e instanceof LoomAppsError && e.status === 404) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Logs (Log Analytics — ContainerAppConsoleLogs)
// ---------------------------------------------------------------------------

export interface AppLogLine {
  time: string;
  message: string;
  revision?: string;
}

/**
 * Tail an app's stdout/stderr from Log Analytics (ContainerAppConsoleLogs_CL).
 * Reuses the Monitor client's Log Analytics query path (owner-scoped by the
 * caller-checked item at the route). Honest-gates via MonitorNotConfiguredError
 * when LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset.
 */
export async function tailAppLogs(name: string, opts?: { tail?: number; timespan?: string }): Promise<AppLogLine[]> {
  if (!isValidLoomAppName(name)) throw new LoomAppsError(`Invalid app name '${name}'.`, 400);
  const tail = Math.max(1, Math.min(500, opts?.tail ?? 200));
  // Import lazily to avoid pulling the monitor client graph into the build path.
  const { queryLogs } = await import('@/lib/azure/monitor-client');
  // ContainerAppName_s is the ACA app name; anchor exactly to avoid prefix leaks.
  const kql = `ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "${name.replace(/"/g, '')}"
| project TimeGenerated, Log_s, RevisionName_s
| order by TimeGenerated desc
| take ${tail}`;
  const result = await queryLogs(kql, opts?.timespan || 'PT1H');
  const rows = result?.rows || [];
  const cols: string[] = (result?.columns || []).map((c: any) => (typeof c === 'string' ? c : c?.name));
  const iTime = cols.indexOf('TimeGenerated');
  const iLog = cols.indexOf('Log_s');
  const iRev = cols.indexOf('RevisionName_s');
  return rows
    .map((r: any[]) => ({
      time: iTime >= 0 ? String(r[iTime] ?? '') : '',
      message: iLog >= 0 ? String(r[iLog] ?? '') : '',
      revision: iRev >= 0 ? String(r[iRev] ?? '') : undefined,
    }))
    .reverse();
}

export type { LoomAppTemplate };
export { LOOM_APP_TEMPLATES } from './loom-apps-runtime-templates';
