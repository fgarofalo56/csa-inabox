/**
 * Azure Analysis Services (AAS) ARM control-plane client.
 *
 * Provisions (idempotent PUT) an AAS tabular server as the Azure-native
 * semantic-model equivalent for migrated datamarts. No Fabric / Power BI
 * Premium dependency — AAS is a first-party Azure PaaS resource available in
 * Commercial, GCC (Commercial ARM), GCC-High and IL5/DoD (DoD IL5 PA scope).
 *
 * ARM API: Microsoft.AnalysisServices/servers@2017-08-01
 *   PUT  {armBase}/subscriptions/{sub}/resourceGroups/{rg}/providers/
 *        Microsoft.AnalysisServices/servers/{name}?api-version=2017-08-01
 *   GET  same path
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential) — ARM scope via
 * armScope() (cloud-correct host), identical to monitor-client / kusto-arm-client.
 *
 * Required env:
 *   LOOM_SUBSCRIPTION_ID   — subscription
 *   LOOM_AAS_RG            — resource group for AAS servers (fallback: LOOM_DLZ_RG,
 *                            then LOOM_ADMIN_RG)
 *   LOOM_AAS_LOCATION      — Azure region (fallback: LOOM_LOCATION, then 'eastus2')
 *   LOOM_AAS_SKU           — SKU name (default 'B1'; 'S1' etc. for Standard tier)
 *   LOOM_UAMI_CLIENT_ID    — UAMI clientId for ManagedIdentityCredential
 *
 * UAMI ARM role:  Contributor on the AAS resource group (granted in aas.bicep).
 * UAMI AAS admin: set via properties.asAdministrators.members using the SP
 *   identifier format `app:<applicationId>@<tenantId>` — the correct format for
 *   service principals in AAS (UPNs + SP `app:` identifiers only; SP object IDs
 *   are NOT supported by AAS asAdministrators).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope, aasConnectionUri } from './cloud-endpoints';
import { sanitizeAasName, skuTier } from './aas-naming';

// Re-export the pure naming helpers (defined in aas-naming.ts so they stay
// unit-testable without the ARM SDK) for back-compat with existing callers.
export { sanitizeAasName, skuTier } from './aas-naming';

const AAS_API_VERSION = '2017-08-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

export class AasClientError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasClientError';
    this.status = status;
    this.body = body;
  }
}

export class AasNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`AAS not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'AasNotConfiguredError';
  }
}

export interface AasConfig {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  sku: string;
}

/** Read AAS config from env, throwing AasNotConfiguredError (→ honest 503 gate). */
export function readAasConfig(): AasConfig {
  const subscriptionId = process.env.LOOM_SUBSCRIPTION_ID || '';
  const resourceGroup =
    process.env.LOOM_AAS_RG || process.env.LOOM_DLZ_RG || process.env.LOOM_ADMIN_RG || '';
  const location = process.env.LOOM_AAS_LOCATION || process.env.LOOM_LOCATION || 'eastus2';
  const missing: string[] = [];
  if (!subscriptionId) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!resourceGroup) missing.push('LOOM_AAS_RG (or LOOM_DLZ_RG / LOOM_ADMIN_RG)');
  if (missing.length) throw new AasNotConfiguredError(missing);
  return { subscriptionId, resourceGroup, location, sku: process.env.LOOM_AAS_SKU || 'B1' };
}

async function armToken(): Promise<string> {
  const t = await credential.getToken(armScope());
  if (!t?.token) throw new AasClientError('Failed to acquire ARM token for AAS', 401);
  return t.token;
}

export interface AasServer {
  name: string;
  id: string;
  provisioningState: string;
  state: string;
  serverFullName: string;
  connectionUri: string;
  location: string;
  sku: string;
}

/**
 * Sanitize a datamart display name into a valid AAS server name.
 * (Implementation lives in aas-naming.ts; re-exported above.)
 */

function serverPath(cfg: AasConfig, serverName: string): string {
  return `${armBase()}/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.AnalysisServices/servers/${serverName}?api-version=${AAS_API_VERSION}`;
}

function shapeServer(j: any, cfg: AasConfig, serverName: string): AasServer {
  const props = j?.properties || {};
  return {
    name: serverName,
    id: j?.id || '',
    provisioningState: props.provisioningState || 'Unknown',
    state: props.state || 'Unknown',
    serverFullName: props.serverFullName || aasConnectionUri(serverName, cfg.location),
    connectionUri: aasConnectionUri(serverName, cfg.location),
    location: j?.location || cfg.location,
    sku: j?.sku?.name || cfg.sku,
  };
}

/**
 * Provision (idempotent PUT) an AAS server. Returns when ARM accepts the request
 * (200/201/202 — provisioning then continues async). Poll via getAasServer()
 * until provisioningState === 'Succeeded'. The console UAMI's SP identifier
 * (`app:<appId>@<tenantId>`) must be in asAdministrators for data-plane access.
 */
export async function provisionAasServer(opts: {
  serverName: string;
  /** AAS admin SP identifier — `app:<applicationId>@<tenantId>`. */
  adminSpIdentifier: string;
}): Promise<AasServer> {
  const cfg = readAasConfig();
  const tok = await armToken();
  const body = {
    location: cfg.location,
    sku: { name: cfg.sku, tier: skuTier(cfg.sku), capacity: 1 },
    properties: {
      asAdministrators: { members: [opts.adminSpIdentifier] },
      managedMode: 1,
    },
    tags: { 'loom-managed': 'true', 'loom-purpose': 'datamart-migration' },
  };
  const res = await fetch(serverPath(cfg, opts.serverName), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  if (!res.ok && res.status !== 202) {
    const msg = j?.error?.message || text || `ARM AAS PUT failed (${res.status})`;
    throw new AasClientError(String(msg), res.status, j);
  }
  return shapeServer(j, cfg, opts.serverName);
}

/** GET an AAS server. Returns null on 404. */
export async function getAasServer(serverName: string): Promise<AasServer | null> {
  const cfg = readAasConfig();
  const tok = await armToken();
  const res = await fetch(serverPath(cfg, serverName), {
    headers: { authorization: `Bearer ${tok}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    throw new AasClientError(j?.error?.message || `ARM GET AAS failed (${res.status})`, res.status, j);
  }
  return shapeServer(j, cfg, serverName);
}
