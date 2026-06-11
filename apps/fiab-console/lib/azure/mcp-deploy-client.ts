/**
 * mcp-deploy-client — provisions, inspects, and tears down catalog MCP servers
 * as Azure Container Apps via the ARM control plane.
 *
 * Backend: ARM REST (Microsoft.App/containerApps)
 *   PUT    /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/containerApps/{name}
 *   GET    .../containerApps/{name}
 *   DELETE .../containerApps/{name}
 * Docs: https://learn.microsoft.com/rest/api/containerapps/container-apps
 * Azure Files volume mount: https://learn.microsoft.com/azure/container-apps/storage-mounts-azure-files
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) — identical to
 * every other Loom ARM client. The Console UAMI needs Contributor (or Container
 * Apps Contributor) on LOOM_ADMIN_RG to create/delete container apps; real ARM
 * 403s are surfaced honestly (no swallowed errors, no mock success).
 *
 * Honest gate: when the subscription / RG / Container Apps environment aren't
 * configured, or the boundary runs on AKS instead of Container Apps, the reader
 * throws McpDeployNotConfiguredError and the BFF maps it to a Fluent MessageBar
 * naming the exact env var / boundary constraint. No Fabric dependency — these
 * are plain Azure Container Apps (no-fabric-dependency.md).
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';
import { getCatalogEntry, resolveCatalogImage, type McpCatalogEntry } from './mcp-catalog';

const ARM = armBase();
const ARM_SCOPE = armScope();
// Match the Container Apps api-version used by the platform bicep (app-deployments.bicep).
const CONTAINERAPPS_API = '2025-02-02-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class McpDeployError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'McpDeployError';
    this.status = status;
    this.body = body;
  }
}

export class McpDeployNotConfiguredError extends Error {
  constructor(public hint: string, public missing: string[] = []) {
    super(hint);
    this.name = 'McpDeployNotConfiguredError';
  }
}

export interface McpDeployConfig {
  subscriptionId: string;
  resourceGroup: string;
  /** Container Apps managed-environment resource id (managedEnvironmentId). */
  caeId: string;
  /** Container Apps managed-environment name (for FQDN composition / display). */
  caeName: string;
  /** CAE default domain (`<env>.<region>.azurecontainerapps.io`) for internal FQDNs. */
  caeDefaultDomain: string;
  /** Deployment region (container-app `location`). */
  location: string;
  /** ACR login server (used only when an image is pulled from the Loom ACR). */
  acrLoginServer: string;
  /** MCP UAMI resource id (UserAssigned identity bound to every deployed server). */
  mcpUamiId: string;
  /** MCP UAMI client id (AZURE_CLIENT_ID inside the container). */
  mcpUamiClientId: string;
  /** Key Vault base URI (for secretRef resolution). Empty disables KV-backed secrets. */
  keyVaultUri: string;
  /** managedEnvironments/storages name for the Azure Files mount. Empty disables volumes. */
  storageName: string;
}

/**
 * Read the deploy config from env. Throws McpDeployNotConfiguredError with a
 * precise hint when the Container Apps platform isn't wired. The deploy surface
 * only works on the Container Apps boundary (Commercial / GCC); AKS boundaries
 * (GCC-High / IL5) honest-gate because Microsoft.App/containerApps has no AKS
 * analog — those clouds deploy MCP workloads via the GitOps manifest path.
 */
export function readMcpDeployConfig(): McpDeployConfig {
  const platform = (process.env.LOOM_CONTAINER_PLATFORM || 'containerApps').trim();
  if (platform === 'aks') {
    throw new McpDeployNotConfiguredError(
      'MCP catalog deploy targets Azure Container Apps and is available on the ' +
        'Container Apps boundaries (Commercial / GCC). This deployment runs on AKS ' +
        '(GCC-High / IL5) — deploy MCP workloads via the cluster GitOps manifest path instead.',
      ['LOOM_CONTAINER_PLATFORM=containerApps'],
    );
  }
  const subscriptionId = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const resourceGroup = (process.env.LOOM_ADMIN_RG || process.env.LOOM_ACA_RG || '').trim();
  const caeId = (process.env.LOOM_CAE_ID || '').trim();
  const missing: string[] = [];
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_ADMIN_RG');
  if (!caeId) missing.push('LOOM_CAE_ID');
  if (missing.length) {
    throw new McpDeployNotConfiguredError(
      `MCP catalog deploy is not configured. Set ${missing.join(', ')} on the loom-console container app ` +
        '(wired by platform/fiab/bicep/modules/admin-plane/main.bicep).',
      missing,
    );
  }
  return {
    subscriptionId,
    resourceGroup,
    caeId,
    caeName: (process.env.LOOM_CAE_NAME || '').trim(),
    caeDefaultDomain: (process.env.LOOM_CAE_DEFAULT_DOMAIN || '').trim(),
    location: (process.env.LOOM_LOCATION || 'eastus2').trim(),
    acrLoginServer: (process.env.LOOM_ACR_LOGIN_SERVER || '').trim(),
    mcpUamiId: (process.env.LOOM_MCP_UAMI_ID || '').trim(),
    mcpUamiClientId: (process.env.LOOM_MCP_UAMI_CLIENT_ID || '').trim(),
    keyVaultUri: (process.env.KEYVAULT_URI || process.env.LOOM_KEY_VAULT_URL || '').trim(),
    storageName: (process.env.LOOM_MCP_STORAGE_NAME || '').trim(),
  };
}

async function token(): Promise<string> {
  const t = await credential.getToken(ARM_SCOPE);
  if (!t?.token) throw new McpDeployError('Failed to acquire ARM token', 401);
  return t.token;
}

async function armFetch(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
    throw new McpDeployError(msg, res.status, json || text);
  }
  return { status: res.status, json };
}

/**
 * Container-app names: lowercase alphanumerics + single hyphens, must start
 * with a letter and end alphanumeric, ≤ 32 chars. Build a DNS-safe name from
 * the catalog id with a short random suffix for uniqueness within the env.
 */
export function mcpContainerAppName(catalogId: string): string {
  const stem = `mcp-${catalogId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const base = stem.slice(0, 32 - rand.length - 1).replace(/-+$/, '');
  return `${base}-${rand}`;
}

export interface DeployMcpResult {
  name: string;
  catalogId: string;
  image: string;
  provisioningState: string;
  runningStatus?: string;
  fqdn?: string;
  endpoint?: string;
}

function shapeStatus(json: any, cfg: McpDeployConfig): DeployMcpResult {
  const props = json?.properties || {};
  const fqdn: string | undefined = props?.configuration?.ingress?.fqdn || undefined;
  const internalFqdn = fqdn
    || (cfg.caeDefaultDomain && json?.name ? `${json.name}.internal.${cfg.caeDefaultDomain}` : undefined);
  return {
    name: json?.name,
    catalogId: (json?.tags?.['loom-mcp-catalog-id'] as string) || '',
    image: props?.template?.containers?.[0]?.image || '',
    provisioningState: props?.provisioningState || 'Unknown',
    runningStatus: props?.runningStatus,
    fqdn: internalFqdn,
    endpoint: internalFqdn ? `https://${internalFqdn}` : undefined,
  };
}

/**
 * Deploy a catalog MCP server as a Container App. Validates the catalog id
 * against the vetted allow-list, builds the container-app body (UAMI identity,
 * internal ingress, optional ACR registry, optional Azure Files volume, optional
 * KV-backed secret env), and PUTs it to ARM. Returns the live provisioning state.
 */
export async function deployMcpContainerApp(opts: {
  catalogId: string;
  /** Optional caller-supplied name (defaults to a generated DNS-safe name). */
  name?: string;
  /** Optional Key Vault secret NAME (not value) for a secret-gated server. */
  keyVaultSecretName?: string;
}): Promise<DeployMcpResult & { entry: McpCatalogEntry }> {
  const cfg = readMcpDeployConfig();
  const entry = getCatalogEntry(opts.catalogId);
  if (!entry) {
    throw new McpDeployError(`'${opts.catalogId}' is not in the vetted MCP catalog.`, 400);
  }
  const name = (opts.name && /^[a-z][a-z0-9-]{1,31}$/.test(opts.name)) ? opts.name : mcpContainerAppName(entry.id);
  const image = resolveCatalogImage(entry);

  // Only attach an ACR registry credential when the image is pulled from the
  // Loom ACR (private). Public images (mcr.microsoft.com, docker.io/mcp) need none.
  const usesAcr = !!cfg.acrLoginServer && image.startsWith(cfg.acrLoginServer);

  // Base env: telemetry + UAMI client id (so the in-container Azure SDK auths).
  const env: any[] = [
    { name: 'AZURE_CLIENT_ID', value: cfg.mcpUamiClientId },
    { name: 'CSA_LOOM_BOUNDARY', value: process.env.CSA_LOOM_BOUNDARY || '' },
    { name: 'MCP_TRANSPORT', value: 'http' },
    { name: 'PORT', value: String(entry.port) },
  ];

  // KV-backed secret → Container Apps secret (resolved by the MCP UAMI, which
  // holds Key Vault Secrets User) projected into the server's secret env var.
  const secrets: any[] = [];
  if (entry.secretEnv && opts.keyVaultSecretName) {
    if (!cfg.keyVaultUri) {
      throw new McpDeployError(
        `${entry.name} needs a Key Vault secret but KEYVAULT_URI is not configured on the console.`,
        503,
      );
    }
    const secretName = opts.keyVaultSecretName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    secrets.push({
      name: secretName,
      keyVaultUrl: `${cfg.keyVaultUri.replace(/\/+$/, '')}/secrets/${opts.keyVaultSecretName.trim()}`,
      identity: cfg.mcpUamiId,
    });
    env.push({ name: entry.secretEnv, secretRef: secretName });
  }

  // Optional Azure Files volume for servers that benefit from persistence.
  const volumes: any[] = [];
  const volumeMounts: any[] = [];
  if (entry.needsStorage && cfg.storageName) {
    volumes.push({ name: 'mcp-data', storageType: 'AzureFile', storageName: cfg.storageName });
    volumeMounts.push({ volumeName: 'mcp-data', mountPath: '/data' });
  }

  const body = {
    location: cfg.location,
    tags: {
      'csa-loom': 'mcp-catalog',
      'loom-mcp-catalog-id': entry.id,
      'loom-mcp-egress': entry.egress,
    },
    identity: {
      type: 'UserAssigned',
      userAssignedIdentities: { [cfg.mcpUamiId]: {} },
    },
    properties: {
      managedEnvironmentId: cfg.caeId,
      configuration: {
        activeRevisionsMode: 'Single',
        ingress: {
          external: false,
          targetPort: entry.port,
          transport: 'auto',
          allowInsecure: false,
          traffic: [{ latestRevision: true, weight: 100 }],
        },
        ...(usesAcr ? { registries: [{ server: cfg.acrLoginServer, identity: cfg.mcpUamiId }] } : {}),
        ...(secrets.length ? { secrets } : {}),
      },
      template: {
        containers: [
          {
            name: entry.id,
            image,
            env,
            resources: { cpu: 0.5, memory: '1Gi' },
            ...(volumeMounts.length ? { volumeMounts } : {}),
          },
        ],
        scale: {
          minReplicas: 0,
          maxReplicas: 3,
          rules: [{ name: 'http-rule', http: { metadata: { concurrentRequests: '50' } } }],
        },
        ...(volumes.length ? { volumes } : {}),
      },
    },
  };

  const { json } = await armFetch(
    'PUT',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}?api-version=${CONTAINERAPPS_API}`,
    body,
  );
  return { ...shapeStatus(json, cfg), catalogId: entry.id, entry };
}

/** GET the live status of a deployed MCP container app. */
export async function getMcpContainerAppStatus(name: string): Promise<DeployMcpResult> {
  const cfg = readMcpDeployConfig();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new McpDeployError(`Invalid container-app name '${name}'.`, 400);
  }
  const { json } = await armFetch(
    'GET',
    `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}?api-version=${CONTAINERAPPS_API}`,
  );
  return shapeStatus(json, cfg);
}

/** DELETE a deployed MCP container app. Idempotent — a 404 is treated as success. */
export async function deleteMcpContainerApp(name: string): Promise<void> {
  const cfg = readMcpDeployConfig();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new McpDeployError(`Invalid container-app name '${name}'.`, 400);
  }
  try {
    await armFetch(
      'DELETE',
      `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.App/containerApps/${name}?api-version=${CONTAINERAPPS_API}`,
    );
  } catch (e) {
    if (e instanceof McpDeployError && e.status === 404) return;
    throw e;
  }
}
