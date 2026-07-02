/**
 * Azure Deployment Environments (DevCenter) client — the Azure-native backend
 * for release-environment "Promote". Creates a real environment in a DevCenter
 * project via the DevCenter **data-plane** REST:
 *
 *   PUT {endpoint}/projects/{project}/users/me/environments/{name}?api-version=2023-04-01
 *   body: { environmentType, catalogName, environmentDefinitionName, parameters? }
 *
 * Docs: https://learn.microsoft.com/rest/api/devcenter/developer/environments/create-or-update-environment
 *
 * Auth: the same UAMI→DefaultAzureCredential chain every Loom Azure client uses.
 * The Console UAMI needs the "Deployment Environments User" role on the project.
 * A 401/403 surfaces verbatim so the UI names the role to grant (no-vaporware).
 *
 * Honest gate: when the DevCenter env vars are absent this throws
 * DevCenterNotConfiguredError; the BFF maps it to a Fluent MessageBar naming the
 * exact env var. Azure-native — no Microsoft Fabric required.
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

const DEVCENTER_API = '2023-04-01';

export class DevCenterError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'DevCenterError'; this.status = status; }
}

export class DevCenterNotConfiguredError extends Error {
  constructor(public missing: string[]) {
    super(`Azure Deployment Environments not configured. Missing env: ${missing.join(', ')}`);
    this.name = 'DevCenterNotConfiguredError';
  }
}

export interface DevCenterConfig {
  /** DevCenter data-plane endpoint, e.g. https://{guid}-mydevcenter.{region}.devcenter.azure.com */
  endpoint: string;
  project: string;
  /** Default environment type (dev/test/prod) when the promotion doesn't specify one. */
  environmentType: string;
  /** Catalog that holds the environment definitions. */
  catalogName: string;
  /** AAD scope (sovereign-cloud override). */
  scope: string;
}

/** Is the DevCenter backend even partially configured (drives the editor flag)? */
export function devCenterConfigured(): boolean {
  return !!process.env.LOOM_DEVCENTER_PROJECT;
}

/** Read + validate the full DevCenter config, or throw a precise missing-env error. */
export function readDevCenterConfig(): DevCenterConfig {
  const missing: string[] = [];
  const project = process.env.LOOM_DEVCENTER_PROJECT || '';
  const endpoint = (process.env.LOOM_DEVCENTER_URI || '').replace(/\/+$/, '');
  const environmentType = process.env.LOOM_DEVCENTER_ENV_TYPE || 'dev';
  const catalogName = process.env.LOOM_DEVCENTER_CATALOG || '';
  if (!project) missing.push('LOOM_DEVCENTER_PROJECT');
  if (!endpoint) missing.push('LOOM_DEVCENTER_URI');
  if (!catalogName) missing.push('LOOM_DEVCENTER_CATALOG');
  if (missing.length) throw new DevCenterNotConfiguredError(missing);
  const scope = process.env.LOOM_DEVCENTER_SCOPE || 'https://devcenter.azure.com/.default';
  return { endpoint, project, environmentType, catalogName, scope };
}

async function token(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new DevCenterError('Failed to acquire DevCenter token', 401);
  return t.token;
}

export interface CreateEnvironmentInput {
  environmentName: string;
  environmentDefinitionName: string;
  environmentType?: string;
  parameters?: Record<string, unknown>;
}

export interface CreateEnvironmentResult {
  name: string;
  provisioningState: string;
  environmentType: string;
  environmentDefinitionName: string;
  /** ARM resource group the environment provisions into (when returned). */
  resourceGroupId?: string;
  /** LRO operation status URL (when the create is async). */
  operationLocation?: string;
}

/**
 * Create (or update) a deployment environment in the configured DevCenter project.
 * The create is a long-running ARM operation; we return the initial state +
 * operation location so the caller can record the promotion against a real env.
 */
export async function createDeploymentEnvironment(input: CreateEnvironmentInput): Promise<CreateEnvironmentResult> {
  const cfg = readDevCenterConfig();
  const url = `${cfg.endpoint}/projects/${encodeURIComponent(cfg.project)}/users/me/environments/${encodeURIComponent(input.environmentName)}?api-version=${DEVCENTER_API}`;
  const body = {
    environmentType: input.environmentType || cfg.environmentType,
    catalogName: cfg.catalogName,
    environmentDefinitionName: input.environmentDefinitionName,
    ...(input.parameters ? { parameters: input.parameters } : {}),
  };
  const res = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${await token(cfg.scope)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok && res.status !== 201 && res.status !== 202) {
    throw new DevCenterError(json?.error?.message || text || `DevCenter create failed (${res.status})`, res.status);
  }
  return {
    name: input.environmentName,
    provisioningState: json?.provisioningState || (res.status === 202 ? 'Accepted' : 'Succeeded'),
    environmentType: body.environmentType,
    environmentDefinitionName: input.environmentDefinitionName,
    resourceGroupId: json?.resourceGroupId,
    operationLocation: res.headers.get('operation-location') || res.headers.get('azure-asyncoperation') || undefined,
  };
}
