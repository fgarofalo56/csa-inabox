/**
 * Power Platform REST client — v3 editor families:
 *   - Environments       (BAP admin API)
 *   - Dataverse tables   (per-environment Dataverse Web API)
 *   - Power Apps         (powerapps API)
 *   - Power Automate     (flow API)
 *   - Power Pages        (Dataverse mspp_website / powerpages portal API)
 *   - AI Builder models  (Dataverse msdyn_aimodels)
 *
 * Auth: Console UAMI (LOOM_UAMI_CLIENT_ID) via ManagedIdentityCredential,
 * chained with DefaultAzureCredential for local dev. SP must be in the
 * "Service principals can use Power Platform APIs" allow group (same SP
 * setting that gates Power BI / Fabric APIs).
 *
 * Scopes:
 *   - BAP admin    : https://api.bap.microsoft.com/.default
 *   - PowerApps    : https://service.powerapps.com/.default
 *   - Flow         : https://service.flow.microsoft.com/.default
 *   - Dataverse    : https://<org>.crm.dynamics.com/.default (per env)
 *
 * All errors surface as PowerPlatformError(status, body, endpoint) so the
 * BFF + editor can render a clean MessageBar with remediation hint.
 */

import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential,
  ClientSecretCredential, type TokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

const BAP_BASE = process.env.LOOM_BAP_BASE || 'https://api.bap.microsoft.com';
const POWERAPPS_BASE = process.env.LOOM_POWERAPPS_BASE || 'https://api.powerapps.com';
const FLOW_BASE = process.env.LOOM_FLOW_BASE || 'https://api.flow.microsoft.com';

const BAP_SCOPE = 'https://api.bap.microsoft.com/.default';
const POWERAPPS_SCOPE = 'https://service.powerapps.com/.default';
const FLOW_SCOPE = 'https://service.flow.microsoft.com/.default';

// UAMI credential — used for BAP / PowerApps / Flow control-plane calls.
const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const uamiCredential: TokenCredential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

// Dataverse credential — UAMIs aren't valid Dataverse Application Users
// (Microsoft platform restriction), so we use the MSAL Web App SP
// (LOOM_DATAVERSE_CLIENT_ID / _CLIENT_SECRET / _TENANT_ID) for any
// `<org>.crm.dynamics.com/.default` scope. The SP must be registered as
// a Dataverse Application User with the System Administrator (or
// equivalent) security role on every env Loom needs to read.
const dataverseClientId = process.env.LOOM_DATAVERSE_CLIENT_ID;
const dataverseClientSecret = process.env.LOOM_DATAVERSE_CLIENT_SECRET;
const dataverseTenantId = process.env.LOOM_DATAVERSE_TENANT_ID || process.env.AZURE_TENANT_ID;
const dataverseCredential: TokenCredential | null =
  (dataverseClientId && dataverseClientSecret && dataverseTenantId)
    ? new ClientSecretCredential(dataverseTenantId, dataverseClientId, dataverseClientSecret)
    : null;

const isDataverseScope = (scope: string) => /\.crm[0-9]*\.dynamics\.com\/\.default$/.test(scope);

/** Legacy alias — most call sites still reference `credential`. */
const credential = uamiCredential;

/**
 * Honest config gate for the Power Platform navigator routes.
 *
 * Power Platform control-plane APIs (BAP / PowerApps / Flow) authenticate with
 * the Console UAMI (LOOM_UAMI_CLIENT_ID) chained to DefaultAzureCredential.
 * Without a UAMI client id AND outside a credentialed dev context there is no
 * identity to mint a token with, so the navigator can't reach any API. We treat
 * a missing UAMI client id as the honest "not configured" signal so each BFF
 * route can 503 with `code: 'not_configured'` and a precise MessageBar (mirrors
 * databricksConfigGate / synapseConfigGate). When LOOM_UAMI_CLIENT_ID is set we
 * return null and let the real call surface any 401/403 with its remediation
 * hint (SP not in the "Service principals can use Power Platform APIs" allow
 * group, or not a Dataverse Application User).
 *
 * Note: in local dev DefaultAzureCredential (az login) can mint these tokens
 * even without a UAMI, so callers may set LOOM_POWERPLATFORM_ASSUME_CRED=1 to
 * bypass the gate and exercise the real APIs with the developer identity.
 */
export function powerPlatformConfigGate(): { missing: string } | null {
  if (process.env.LOOM_UAMI_CLIENT_ID) return null;
  if (process.env.LOOM_POWERPLATFORM_ASSUME_CRED === '1') return null;
  return { missing: 'LOOM_UAMI_CLIENT_ID' };
}

/**
 * Separate gate for Dataverse-scoped groups (tables). UAMI-issued tokens are
 * NOT valid Dataverse Application Users (Microsoft platform restriction), so
 * those groups additionally require the dedicated MSAL Web App SP
 * (LOOM_DATAVERSE_CLIENT_ID / _CLIENT_SECRET / _TENANT_ID) registered as an
 * Application User on the target environment. Returns the missing var so the
 * Dataverse-tables group can render an honest sub-gate even when the control
 * plane is reachable.
 */
export function dataverseConfigGate(): { missing: string } | null {
  if (process.env.LOOM_DATAVERSE_CLIENT_ID && process.env.LOOM_DATAVERSE_CLIENT_SECRET) return null;
  if (!process.env.LOOM_DATAVERSE_CLIENT_ID) return { missing: 'LOOM_DATAVERSE_CLIENT_ID' };
  return { missing: 'LOOM_DATAVERSE_CLIENT_SECRET' };
}

/**
 * Power Pages admin API gate — ALWAYS "not configured" for Loom's identity.
 *
 * The Power Pages admin REST API (api.powerplatform.com/powerpages) — provision
 * / delete / restart website, WAF, allowed-IPs, scan — does NOT support the
 * service-principal (client-credentials) flow; it only accepts username/password
 * (delegated) auth (Microsoft Learn: power-pages/admin/admin-api,
 * programmability-authentication-v2). Loom authenticates with a UAMI service
 * principal, so it cannot mint a valid token for that API. This is an honest,
 * documented platform limitation (NOT a removed banner). Site METADATA edits via
 * the Dataverse mspp_* tables remain possible under the Dataverse SP.
 */
export function powerPagesAdminConfigGate(): { reason: string } {
  return {
    reason: 'The Power Pages admin API (api.powerplatform.com/powerpages) requires username/password (delegated) authentication and does not support the service-principal flow Loom uses. Site provisioning, restart, WAF, and allowed-IP management must be performed in the Power Platform admin centre or with a user credential.',
  };
}

export class PowerPlatformError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  hint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string, hint?: string) {
    super(message);
    this.name = 'PowerPlatformError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.hint = hint;
  }
}

async function getToken(scope: string): Promise<string> {
  // Route Dataverse-scope tokens through the MSAL Web App SP when
  // configured (Dataverse refuses UAMI-issued tokens — the SP must
  // be registered as an Application User on the env). Falls back to
  // UAMI credential if the dedicated Dataverse SP isn't configured,
  // which then surfaces a 403 with "user is not a member of the
  // organization" — actionable.
  const cred = (isDataverseScope(scope) && dataverseCredential) ? dataverseCredential : uamiCredential;
  const t = await cred.getToken(scope);
  if (!t?.token) throw new PowerPlatformError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
}

async function call<T = any>(url: string, scope: string, opts: CallOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const token = await getToken(scope);
  let full = url;
  if (opts.query) {
    const qs = new URLSearchParams();
    Object.entries(opts.query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) qs.append(k, String(v));
    });
    const s = qs.toString();
    if (s) full += (full.includes('?') ? '&' : '?') + s;
  }
  const res = await fetchWithTimeout(full, {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `${method} ${url} failed`).toString();
    let hint: string | undefined;
    if (res.status === 401 || res.status === 403) {
      hint = 'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow group in Power Platform admin centre, and (for Dataverse) added as an Application User in the target environment with the System Administrator role.';
    }
    throw new PowerPlatformError(msg, res.status, json || text, full, hint);
  }
  return (json as T) ?? ({} as T);
}

// ============================================================
// Types
// ============================================================

export interface PpEnvironment {
  name: string;          // env GUID (used in URLs)
  id?: string;           // full ARM-style id
  displayName: string;
  location?: string;
  environmentSku?: string;     // Production / Sandbox / Trial / Developer / Default
  state?: string;              // Ready / NotReady
  isDefault?: boolean;
  organizationDomain?: string; // <org>.crm.dynamics.com
  instanceUrl?: string;        // https://<org>.crm.dynamics.com/
  capacity?: any;
  securityGroup?: { id?: string; displayName?: string } | null;
  dlpPolicySummary?: { count: number; names: string[] } | null;
}

export interface DataverseTable {
  MetadataId: string;
  LogicalName: string;
  SchemaName?: string;
  DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  IsCustomEntity?: boolean;
  EntitySetName?: string;
  PrimaryIdAttribute?: string;
  PrimaryNameAttribute?: string;
}

export interface DataverseAttribute {
  MetadataId: string;
  LogicalName: string;
  SchemaName?: string;
  AttributeType?: string;
  RequiredLevel?: { Value?: string };
  DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  IsCustomAttribute?: boolean;
  IsPrimaryId?: boolean;
  IsPrimaryName?: boolean;
}

export interface DataverseSolution {
  solutionid: string;
  uniquename: string;
  friendlyname?: string;
  version?: string;
  ismanaged?: boolean;
  installedon?: string;
  publisherid?: any;
}

export interface PowerAppConnectionRef {
  /** Connector id, e.g. shared_sharepointonline. */
  id?: string;
  displayName?: string;
  iconUri?: string;
  dataSources?: string[];
}

export interface PowerApp {
  name: string;            // GUID — the real Power Apps app id
  id?: string;
  displayName: string;
  description?: string;
  appType?: string;        // CanvasApp / ModelDrivenApp
  owner?: { displayName?: string; email?: string; userPrincipalName?: string };
  createdTime?: string;
  lastModifiedTime?: string;
  appOpenUri?: string;          // maker-provided play URL (when present)
  appOpenProtocolUri?: string;
  environmentName?: string;
  /** Resolved play/embed URL for an iframe (canvas) or deep link (model-driven). */
  playerEmbedUri?: string;
  /** Connectors / data sources the app uses (from connectionReferences). */
  connectionReferences?: PowerAppConnectionRef[];
  appVersion?: string;
  isFeaturedApp?: boolean;
  bypassConsent?: boolean;
  sharedGroupsCount?: number;
  sharedUsersCount?: number;
}

export interface PowerAutomateFlow {
  name: string;            // GUID
  id?: string;
  displayName: string;
  state?: string;          // Started / Stopped / Suspended
  triggerType?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  definitionSummary?: any;
  flowFailureAlertSubscribed?: boolean;
}

export interface FlowRun {
  name: string;
  id?: string;
  status?: string;         // Succeeded / Failed / Running / Cancelled
  startTime?: string;
  endTime?: string;
  trigger?: { name?: string; outputsLink?: any };
  errorCode?: string;
  errorMessage?: string;
}

export interface PowerPage {
  websiteid?: string;
  name: string;
  primarydomainname?: string;
  websiteurl?: string;
  status?: string;
  type?: string;
  createdon?: string;
  modifiedon?: string;
  templatename?: string;
}

export interface AiBuilderModel {
  msdyn_aimodelid: string;
  msdyn_name: string;
  msdyn_modelcreationcontext?: string;
  msdyn_templateid_value?: string;
  templateName?: string;        // resolved from template lookup
  msdyn_typename?: string;
  statecode?: number;           // 0 Active / 1 Inactive
  statuscode?: number;          // 1 Draft / 2 Trained / 3 Published etc.
  createdon?: string;
  modifiedon?: string;
}

// ============================================================
// Environments (BAP admin API)
// ============================================================

const ENV_API_VERSION = '2020-10-01';

export async function listEnvironments(): Promise<PpEnvironment[]> {
  const j = await call<{ value: any[] }>(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments`,
    BAP_SCOPE,
    { query: { 'api-version': ENV_API_VERSION } },
  );
  return (j.value || []).map(mapEnvironment);
}

export async function getEnvironment(name: string): Promise<PpEnvironment> {
  const j = await call<any>(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(name)}`,
    BAP_SCOPE,
    { query: { 'api-version': ENV_API_VERSION, '$expand': 'permissions,properties/billingPolicy' } },
  );
  return mapEnvironment(j);
}

// ------------------------------------------------------------
// Environment lifecycle (create / update / delete) — real BAP REST.
//
// Grounded in Microsoft Learn. The Power Platform BAP admin control plane
// exposes the same operations the `Microsoft.PowerApps.Administration.PowerShell`
// module wraps (New-/Set-/Remove-AdminPowerAppEnvironment) and the admin-centre
// New/Edit/Delete commands:
//
//   - Create : POST  https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments?api-version=2021-04-01
//              body { properties: { displayName, environmentSku, ... linkedEnvironmentMetadata } }
//              (New-AdminPowerAppEnvironment — -DisplayName/-Location/-EnvironmentSku
//               /-ProvisionDatabase/-CurrencyName/-LanguageName/-Templates/-SecurityGroupId).
//              The env GUID is server-assigned, so the BAP control plane uses POST
//              (not PUT-by-id). Returns 202 Accepted with an `Operation-Location`
//              (or `Location`) header for the async lifecycle operation to poll.
//   - Update : PATCH .../scopes/admin/environments/{id}?api-version=2021-04-01
//              body { properties: { displayName, ... } }  (Set-AdminPowerAppEnvironmentDisplayName etc.)
//   - Delete : DELETE .../scopes/admin/environments/{id}?api-version=2021-04-01
//              (Remove-AdminPowerAppEnvironment) — async; 202 + Location header, or 404
//              once the soft-delete completes. Soft-deletes (recoverable window).
//   - Poll   : GET <operation url> — terminal state when status ∈ {Succeeded, Failed, Canceled}.
//
// Refs (Learn):
//   power-platform/admin/list-environments (host/path/api-version)
//   powershell/.../new-adminpowerappenvironment (create params → properties)
//   powershell/.../remove-adminpowerappenvironment (delete is async)
//   power-platform/admin/delete-environment (soft-delete + recovery window)
// ------------------------------------------------------------

/** Modern stable BAP control-plane api-version for lifecycle ops. */
const ENV_LIFECYCLE_API_VERSION = process.env.LOOM_BAP_LIFECYCLE_API_VERSION || '2021-04-01';

export interface CreateEnvironmentSpec {
  displayName: string;
  /** Trial | Sandbox | Production | SubscriptionBasedTrial | Teams | Developer */
  environmentSku: string;
  /** Power Platform location, e.g. "unitedstates", "europe". Get-AdminPowerAppEnvironmentLocations. */
  location: string;
  description?: string;
  /** When provided, a Dataverse database is provisioned with the given metadata. */
  dataverse?: {
    /** LCID for the base language, e.g. 1033 (en-US). */
    baseLanguage?: number;
    /** ISO currency code, e.g. "USD". */
    currency?: string;
    /** Provisioning template ids, e.g. ["D365_Sales"]. */
    templates?: string[];
    /** Entra security group object id restricting Dataverse membership. */
    securityGroupId?: string;
  };
}

export interface EnvironmentLifecycleOperation {
  /** Operation status: Running / NotStarted / Succeeded / Failed / Canceled (when reported). */
  status?: string;
  /** URL to poll for the async operation (Operation-Location or Location header). */
  operationUrl?: string;
  /** Raw response body (env doc or operation doc) for surfacing detail. */
  body?: any;
  /** Set when the operation has reached a terminal state. */
  done: boolean;
  /** Optional error detail when status === 'Failed'. */
  error?: { code?: string; message?: string };
}

const TERMINAL_OP_STATES = new Set(['succeeded', 'failed', 'canceled', 'cancelled']);

function isTerminalOpStatus(status?: string): boolean {
  return !!status && TERMINAL_OP_STATES.has(status.toLowerCase());
}

/**
 * Issue a BAP control-plane call and return the parsed body PLUS the async
 * operation URL from the response headers (the standard `call()` helper drops
 * headers; lifecycle ops need them to poll). Mirrors `call()`'s auth + error
 * handling so 401/403/4xx surface as a PowerPlatformError with the same hint.
 */
async function bapCallWithHeaders<T = any>(
  url: string,
  opts: CallOpts = {},
): Promise<{ body: T; status: number; operationUrl?: string }> {
  const method = opts.method ?? 'GET';
  const token = await getToken(BAP_SCOPE);
  let full = url;
  if (opts.query) {
    const qs = new URLSearchParams();
    Object.entries(opts.query).forEach(([k, v]) => { if (v !== undefined && v !== null) qs.append(k, String(v)); });
    const s = qs.toString();
    if (s) full += (full.includes('?') ? '&' : '?') + s;
  }
  const res = await fetchWithTimeout(full, {
    method,
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (json?.error?.message || json?.message || text || `${method} ${url} failed`).toString();
    let hint: string | undefined;
    if (res.status === 401 || res.status === 403) {
      hint = 'Confirm the Console UAMI SP is added to the "Service principals can use Power Platform APIs" allow group in Power Platform admin centre, and that it holds the Power Platform Administrator role required to create/edit/delete environments.';
    }
    throw new PowerPlatformError(msg, res.status, json || text, full, hint);
  }
  const operationUrl = res.headers.get('operation-location')
    || res.headers.get('location')
    || res.headers.get('azure-asyncoperation')
    || undefined;
  return { body: (json as T) ?? ({} as T), status: res.status, operationUrl };
}

/**
 * Create a Power Platform environment via the BAP admin control plane.
 *
 * POST .../scopes/admin/environments?api-version=2021-04-01 with a
 * `{ properties: {...} }` body. When `spec.dataverse` is set a Dataverse
 * database is provisioned (linkedEnvironmentMetadata) — currency + base
 * language are required by the platform in that case. Returns the async
 * lifecycle operation handle (202 + Operation-Location header).
 */
export async function createEnvironment(spec: CreateEnvironmentSpec): Promise<EnvironmentLifecycleOperation> {
  const properties: Record<string, any> = {
    displayName: spec.displayName,
    environmentSku: spec.environmentSku,
  };
  if (spec.description) properties.description = spec.description;
  if (spec.dataverse) {
    const linked: Record<string, any> = {};
    if (spec.dataverse.baseLanguage !== undefined) linked.baseLanguage = spec.dataverse.baseLanguage;
    if (spec.dataverse.currency) linked.currency = { code: spec.dataverse.currency };
    if (spec.dataverse.templates && spec.dataverse.templates.length) linked.templates = spec.dataverse.templates;
    if (spec.dataverse.securityGroupId) linked.securityGroupId = spec.dataverse.securityGroupId;
    properties.linkedEnvironmentMetadata = linked;
  }
  const { body, operationUrl } = await bapCallWithHeaders<any>(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments`,
    {
      method: 'POST',
      query: { 'api-version': ENV_LIFECYCLE_API_VERSION, location: spec.location },
      body: { properties },
    },
  );
  const status = body?.properties?.provisioningState || body?.status;
  return {
    status,
    operationUrl,
    body,
    done: isTerminalOpStatus(status),
    error: body?.error ? { code: body.error.code, message: body.error.message } : undefined,
  };
}

/**
 * Update an existing environment's mutable properties (rename, description,
 * security group). PATCH .../environments/{id}?api-version=2021-04-01 with a
 * `{ properties: {...} }` body. Wraps the admin-centre "Edit" command.
 */
export async function updateEnvironment(
  id: string,
  patch: { displayName?: string; description?: string; securityGroupId?: string },
): Promise<EnvironmentLifecycleOperation> {
  const properties: Record<string, any> = {};
  if (patch.displayName !== undefined) properties.displayName = patch.displayName;
  if (patch.description !== undefined) properties.description = patch.description;
  if (patch.securityGroupId !== undefined) {
    properties.linkedEnvironmentMetadata = { securityGroupId: patch.securityGroupId };
  }
  const { body, operationUrl } = await bapCallWithHeaders<any>(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      query: { 'api-version': ENV_LIFECYCLE_API_VERSION },
      body: { properties },
    },
  );
  const status = body?.properties?.provisioningState || body?.status || 'Succeeded';
  return { status, operationUrl, body, done: isTerminalOpStatus(status) };
}

/**
 * Delete (soft-delete) an environment. DELETE .../environments/{id}?api-version=2021-04-01.
 * Async — returns a 202 + Location header for the lifecycle operation to poll
 * (or completes synchronously). The default environment can't be deleted
 * (the platform returns a 4xx, surfaced as a PowerPlatformError).
 */
export async function deleteEnvironment(id: string): Promise<EnvironmentLifecycleOperation> {
  const { body, operationUrl, status: httpStatus } = await bapCallWithHeaders<any>(
    `${BAP_BASE}/providers/Microsoft.BusinessAppPlatform/scopes/admin/environments/${encodeURIComponent(id)}`,
    { method: 'DELETE', query: { 'api-version': ENV_LIFECYCLE_API_VERSION } },
  );
  const status = body?.properties?.provisioningState || body?.status || (httpStatus === 202 ? 'Running' : 'Succeeded');
  return { status, operationUrl, body, done: isTerminalOpStatus(status) };
}

/**
 * Poll an async environment lifecycle operation (create/delete) by its
 * Operation-Location URL. GET the operation; terminal when status ∈
 * {Succeeded, Failed, Canceled}. A 404 from a delete-op URL means the
 * environment was fully removed — treated as a terminal Succeeded.
 */
export async function getEnvironmentLifecycleOperation(operationUrl: string): Promise<EnvironmentLifecycleOperation> {
  try {
    const { body } = await bapCallWithHeaders<any>(operationUrl, { method: 'GET' });
    const status = body?.status || body?.properties?.provisioningState;
    return {
      status,
      operationUrl,
      body,
      done: isTerminalOpStatus(status),
      error: body?.error ? { code: body.error.code, message: body.error.message } : undefined,
    };
  } catch (e) {
    if (e instanceof PowerPlatformError && e.status === 404) {
      return { status: 'Succeeded', operationUrl, done: true };
    }
    throw e;
  }
}

function mapEnvironment(e: any): PpEnvironment {
  const props = e.properties || {};
  const linkedEnv = props.linkedEnvironmentMetadata || {};
  return {
    name: e.name,
    id: e.id,
    displayName: props.displayName || e.name,
    location: e.location,
    environmentSku: props.environmentSku,
    state: props.states?.management?.id || props.provisioningState,
    isDefault: !!props.isDefault,
    organizationDomain: linkedEnv.domainName,
    instanceUrl: linkedEnv.instanceUrl,
    capacity: props.addons || props.capacity,
    securityGroup: props.linkedEnvironmentMetadata?.securityGroupId
      ? { id: linkedEnv.securityGroupId, displayName: linkedEnv.securityGroupName }
      : null,
    dlpPolicySummary: null,
  };
}

/** Dataverse base URL for an environment (https://<org>.crm.dynamics.com). */
async function dataverseBase(envId: string): Promise<{ url: string; scope: string }> {
  const env = await getEnvironment(envId);
  const url = env.instanceUrl?.replace(/\/$/, '');
  if (!url) {
    throw new PowerPlatformError(
      `Environment ${envId} has no Dataverse instance — only environments with Dataverse provisioned expose tables, apps, flows, pages, AI Builder.`,
      404, null, undefined,
      'Create a Dataverse-enabled environment in Power Platform admin centre (or pick a different env).',
    );
  }
  return { url, scope: `${url}/.default` };
}

// ============================================================
// Dataverse: solutions + tables (EntityDefinitions) + schema
// ============================================================

export async function listSolutions(envId: string): Promise<DataverseSolution[]> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: DataverseSolution[] }>(
    `${url}/api/data/v9.2/solutions`,
    scope,
    { query: { '$select': 'solutionid,uniquename,friendlyname,version,ismanaged,installedon' } },
  );
  return j.value || [];
}

export async function listTables(envId: string): Promise<DataverseTable[]> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: DataverseTable[] }>(
    `${url}/api/data/v9.2/EntityDefinitions`,
    scope,
    { query: { '$select': 'MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity,EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute' } },
  );
  return j.value || [];
}

export async function getTable(envId: string, logicalName: string): Promise<DataverseTable> {
  const { url, scope } = await dataverseBase(envId);
  return call<DataverseTable>(
    `${url}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`,
    scope,
  );
}

export async function getTableSchema(envId: string, logicalName: string): Promise<DataverseAttribute[]> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: DataverseAttribute[] }>(
    `${url}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')/Attributes`,
    scope,
    { query: { '$select': 'MetadataId,LogicalName,SchemaName,AttributeType,RequiredLevel,DisplayName,IsCustomAttribute,IsPrimaryId,IsPrimaryName' } },
  );
  return j.value || [];
}

// ------------------------------------------------------------
// Dataverse table designer: keys, relationships, views, business rules, data
// ------------------------------------------------------------

export interface DataverseKey {
  MetadataId: string;
  LogicalName: string;
  SchemaName?: string;
  DisplayName?: { UserLocalizedLabel?: { Label?: string } };
  KeyAttributes?: string[];
  EntityKeyIndexStatus?: string;
}

export interface DataverseRelationship {
  MetadataId: string;
  SchemaName: string;
  RelationshipType: '1:N' | 'N:1' | 'N:N' | string;
  ReferencingEntity?: string;
  ReferencingAttribute?: string;
  ReferencedEntity?: string;
  ReferencedAttribute?: string;
  Entity1LogicalName?: string;
  Entity2LogicalName?: string;
  IntersectEntityName?: string;
}

export interface DataverseView {
  savedqueryid?: string;
  userqueryid?: string;
  name: string;
  isdefault?: boolean;
  querytype?: number;
  returnedtypecode?: string;
  isuserview?: boolean;
  fetchxml?: string;
  modifiedon?: string;
}

export interface DataverseBusinessRule {
  workflowid: string;
  name: string;
  statecode?: number;       // 0 Draft / 1 Activated
  statecodeLabel?: string;
  scope?: number;
  primaryentity?: string;
  modifiedon?: string;
}

/** Alternate keys for a table (EntityKeyMetadata). */
export async function getTableKeys(envId: string, logicalName: string): Promise<DataverseKey[]> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: DataverseKey[] }>(
    `${url}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')/Keys`,
    scope,
    { query: { '$select': 'MetadataId,LogicalName,SchemaName,DisplayName,KeyAttributes,EntityKeyIndexStatus' } },
  );
  return j.value || [];
}

/** 1:N, N:1 and N:N relationships for a table. */
export async function getTableRelationships(envId: string, logicalName: string): Promise<DataverseRelationship[]> {
  const { url, scope } = await dataverseBase(envId);
  const base = `${url}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')`;
  const [otm, mto, mtm] = await Promise.all([
    call<{ value: any[] }>(`${base}/OneToManyRelationships`, scope,
      { query: { '$select': 'MetadataId,SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntity,ReferencedAttribute' } }),
    call<{ value: any[] }>(`${base}/ManyToOneRelationships`, scope,
      { query: { '$select': 'MetadataId,SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntity,ReferencedAttribute' } }),
    call<{ value: any[] }>(`${base}/ManyToManyRelationships`, scope,
      { query: { '$select': 'MetadataId,SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName' } }),
  ]);
  const out: DataverseRelationship[] = [];
  for (const r of otm.value || []) out.push({ ...r, RelationshipType: '1:N' });
  for (const r of mto.value || []) out.push({ ...r, RelationshipType: 'N:1' });
  for (const r of mtm.value || []) out.push({ ...r, RelationshipType: 'N:N' });
  return out;
}

/** System + personal views for a table (savedquery + userquery). */
export async function getTableViews(envId: string, logicalName: string): Promise<DataverseView[]> {
  const { url, scope } = await dataverseBase(envId);
  const [sys, usr] = await Promise.all([
    call<{ value: any[] }>(`${url}/api/data/v9.2/savedqueries`, scope, {
      query: {
        '$select': 'savedqueryid,name,isdefault,querytype,returnedtypecode,fetchxml,modifiedon',
        '$filter': `returnedtypecode eq '${logicalName}'`,
        '$orderby': 'name',
      },
    }),
    call<{ value: any[] }>(`${url}/api/data/v9.2/userqueries`, scope, {
      query: {
        '$select': 'userqueryid,name,querytype,returnedtypecode,fetchxml,modifiedon',
        '$filter': `returnedtypecode eq '${logicalName}'`,
        '$orderby': 'name',
      },
    }).catch(() => ({ value: [] as any[] })),
  ]);
  const out: DataverseView[] = [];
  for (const v of sys.value || []) out.push({ ...v, isuserview: false });
  for (const v of usr.value || []) out.push({ ...v, isuserview: true });
  return out;
}

/** Business rules (processes with category 2) targeting a table. */
export async function getTableBusinessRules(envId: string, logicalName: string): Promise<DataverseBusinessRule[]> {
  const { url, scope } = await dataverseBase(envId);
  // category 2 = Business Rule; type 1 = Definition (not the activation copy).
  const j = await call<{ value: any[] }>(`${url}/api/data/v9.2/workflows`, scope, {
    query: {
      '$select': 'workflowid,name,statecode,scope,primaryentity,modifiedon',
      '$filter': `category eq 2 and type eq 1 and primaryentity eq '${logicalName}'`,
      '$orderby': 'name',
    },
  });
  return (j.value || []).map((w: any) => ({
    workflowid: w.workflowid,
    name: w.name,
    statecode: w.statecode,
    statecodeLabel: w['statecode@OData.Community.Display.V1.FormattedValue'] || (w.statecode === 1 ? 'Activated' : 'Draft'),
    scope: w.scope,
    primaryentity: w.primaryentity,
    modifiedon: w.modifiedon,
  }));
}

// ------------------------------------------------------------
// Dataverse table authoring — create a column (real Web API write).
//
// Grounded in Microsoft Learn (create-update-column-definitions-using-web-api):
//   POST <org>/api/data/v9.2/EntityDefinitions(LogicalName='{table}')/Attributes
//   body = an AttributeMetadata document with the concrete @odata.type:
//     - String   → Microsoft.Dynamics.CRM.StringAttributeMetadata   (+ MaxLength, FormatName.Value)
//     - Memo     → Microsoft.Dynamics.CRM.MemoAttributeMetadata     (+ MaxLength)
//     - Integer  → Microsoft.Dynamics.CRM.IntegerAttributeMetadata  (+ MinValue/MaxValue/Format)
//     - Decimal  → Microsoft.Dynamics.CRM.DecimalAttributeMetadata  (+ Precision)
//     - Money    → Microsoft.Dynamics.CRM.MoneyAttributeMetadata    (+ Precision)
//     - Boolean  → Microsoft.Dynamics.CRM.BooleanAttributeMetadata  (+ OptionSet TrueOption/FalseOption)
//     - DateTime → Microsoft.Dynamics.CRM.DateTimeAttributeMetadata (+ Format, DateTimeBehavior)
//   DisplayName / Description are Label objects (LocalizedLabels[] + LanguageCode).
//   RequiredLevel is an AttributeRequiredLevelManagedProperty.
//   The platform returns 204 No Content with the new attribute URI in the
//   OData-EntityId response header — we surface that as metadataId.
//
// Uses the dedicated Dataverse SP (LOOM_DATAVERSE_CLIENT_ID) — the SP must be a
// Dataverse Application User with a role that grants prvCreateAttribute (System
// Administrator / System Customizer). No new Azure resource; no Fabric path.
// ------------------------------------------------------------

export type DataverseColumnType =
  | 'String' | 'Memo' | 'Integer' | 'Decimal' | 'Money' | 'Boolean' | 'DateTime';

export interface AddColumnSpec {
  /** Schema name including the publisher prefix, e.g. "new_Rating". */
  schemaName: string;
  displayName: string;
  attributeType: DataverseColumnType;
  /** None | Recommended | ApplicationRequired (default None). */
  requiredLevel?: 'None' | 'Recommended' | 'ApplicationRequired';
  description?: string;
  /** String / Memo only — character cap (default 100 for String, 2000 for Memo). */
  maxLength?: number;
  /** Decimal / Money only — number of decimal places (default 2). */
  precision?: number;
  /** Integer only — Format: None | Duration | TimeZone | Language (default None). */
  integerFormat?: 'None' | 'Duration' | 'TimeZone' | 'Language';
  /** DateTime only — Format: DateOnly | DateAndTime (default DateAndTime). */
  dateTimeFormat?: 'DateOnly' | 'DateAndTime';
  /** Base language LCID for labels (default 1033 / en-US). */
  languageCode?: number;
}

function label(text: string, lcid: number) {
  return { '@odata.type': 'Microsoft.Dynamics.CRM.Label', LocalizedLabels: [
    { '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: lcid },
  ] };
}

function requiredLevelProp(value: string) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.AttributeRequiredLevelManagedProperty',
    Value: value, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings',
  };
}

/** Build the AttributeMetadata document for the requested column type. */
export function buildAttributeMetadata(spec: AddColumnSpec): Record<string, any> {
  const lcid = spec.languageCode ?? 1033;
  const base: Record<string, any> = {
    SchemaName: spec.schemaName,
    DisplayName: label(spec.displayName, lcid),
    RequiredLevel: requiredLevelProp(spec.requiredLevel || 'None'),
  };
  if (spec.description) base.Description = label(spec.description, lcid);

  switch (spec.attributeType) {
    case 'String':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        MaxLength: spec.maxLength ?? 100,
        FormatName: { Value: 'Text' },
      };
    case 'Memo':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
        MaxLength: spec.maxLength ?? 2000,
        Format: 'TextArea',
      };
    case 'Integer':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
        Format: spec.integerFormat || 'None',
        MinValue: -2147483648, MaxValue: 2147483647,
      };
    case 'Decimal':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
        Precision: spec.precision ?? 2,
        MinValue: -100000000000, MaxValue: 100000000000,
      };
    case 'Money':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata',
        Precision: spec.precision ?? 2, PrecisionSource: 2,
        MinValue: -922337203685477, MaxValue: 922337203685477,
      };
    case 'Boolean':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
        OptionSet: {
          '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
          TrueOption: { Value: 1, Label: label('Yes', lcid) },
          FalseOption: { Value: 0, Label: label('No', lcid) },
        },
        DefaultValue: false,
      };
    case 'DateTime':
      return {
        ...base, '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        Format: spec.dateTimeFormat || 'DateAndTime',
        DateTimeBehavior: { Value: 'UserLocal' },
      };
    default:
      throw new PowerPlatformError(`Unsupported column type: ${spec.attributeType}`, 400);
  }
}

/**
 * Create a column on an existing Dataverse table. POSTs the AttributeMetadata
 * document to the table's Attributes navigation property. Returns the new
 * attribute URI from the OData-EntityId response header (204 No Content).
 *
 * Validation mirrors the Maker portal: a schema name with a publisher prefix
 * is required (e.g. "new_Rating"); a bare name like "Rating" would be rejected
 * by the platform with a 400, so we surface a precise hint up front.
 */
export async function addColumn(
  envId: string, logicalName: string, spec: AddColumnSpec,
): Promise<{ ok: true; metadataId?: string; entityId?: string }> {
  if (!/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/.test(spec.schemaName)) {
    throw new PowerPlatformError(
      `Schema name "${spec.schemaName}" must include a publisher prefix, e.g. "new_Rating".`,
      400, null, undefined,
      'Use your environment publisher prefix followed by an underscore and the column name (e.g. new_Rating, contoso_Score).',
    );
  }
  const { url, scope } = await dataverseBase(envId);
  const body = buildAttributeMetadata(spec);
  const endpoint = `${url}/api/data/v9.2/EntityDefinitions(LogicalName='${encodeURIComponent(logicalName)}')/Attributes`;
  // Use the raw fetch path so we can read the OData-EntityId header on the 204.
  const token = await getToken(scope);
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
    const msg = (json?.error?.message || json?.message || text || `POST ${endpoint} failed`).toString();
    let hint: string | undefined;
    if (res.status === 401 || res.status === 403) {
      hint = 'The Dataverse SP (LOOM_DATAVERSE_CLIENT_ID) must be a Dataverse Application User with the System Administrator or System Customizer role on this environment to create columns.';
    }
    throw new PowerPlatformError(msg, res.status, json || text, endpoint, hint);
  }
  const entityId = res.headers.get('odata-entityid') || res.headers.get('OData-EntityId') || undefined;
  const metadataId = entityId?.match(/Attributes\(([^)]+)\)/)?.[1];
  return { ok: true, metadataId, entityId };
}

// ------------------------------------------------------------
// Dataverse table authoring — create a NEW custom table (real Web API write).
//
// Grounded in Microsoft Learn (create-update-entity-definitions-using-web-api):
//   POST <org>/api/data/v9.2/EntityDefinitions
//   body = an EntityMetadata document:
//     SchemaName            "<prefix>_<Name>"  (publisher prefix required)
//     DisplayName           Label
//     DisplayCollectionName Label (plural)
//     Description           Label (optional)
//     OwnershipType         "UserOwned" | "OrganizationOwned"
//     HasNotes              bool   (Notes/attachments)
//     HasActivities         bool   (Activities)
//     IsActivity            false
//     (optional) TableType:"Elastic" via the same doc (Dataverse elastic table)
//     Attributes            [ one StringAttributeMetadata with IsPrimaryName:true ]
//   The platform returns 204 No Content with the new entity URI in the
//   OData-EntityId response header.
//
// Uses the dedicated Dataverse SP (LOOM_DATAVERSE_CLIENT_ID) — the SP must be a
// Dataverse Application User with a role that grants prvCreateEntity (System
// Administrator / System Customizer). No new Azure resource; no Fabric path.
// ------------------------------------------------------------

export interface CreateTableSpec {
  /** Schema name including the publisher prefix, e.g. "new_Invoice". */
  schemaName: string;
  /** Singular display name, e.g. "Invoice". */
  displayName: string;
  /** Plural display name, e.g. "Invoices". */
  displayCollectionName: string;
  description?: string;
  /** UserOwned (default) | OrganizationOwned. */
  ownershipType?: 'UserOwned' | 'OrganizationOwned';
  /** Primary-name column display name (default "Name"). */
  primaryNameDisplayName?: string;
  /** Primary-name column schema name (default "<prefix>_Name" derived from table prefix). */
  primaryNameSchemaName?: string;
  /** Primary-name column max length (default 100). */
  primaryNameMaxLength?: number;
  /** Enable Notes (attachments). Default false. */
  hasNotes?: boolean;
  /** Enable Activities. Default false. */
  hasActivities?: boolean;
  /** Standard | Elastic (default Standard). Elastic = NoSQL-style Dataverse table. */
  tableType?: 'Standard' | 'Elastic';
  /** Base language LCID for labels (default 1033 / en-US). */
  languageCode?: number;
}

/** Validate a Dataverse schema name carries a publisher prefix (e.g. new_Invoice). */
function assertPrefixedSchema(schemaName: string, what: string) {
  if (!/^[a-z][a-z0-9]*_[A-Za-z0-9]+$/.test(schemaName)) {
    throw new PowerPlatformError(
      `${what} schema name "${schemaName}" must include a publisher prefix, e.g. "new_Invoice".`,
      400, null, undefined,
      'Use your environment publisher prefix followed by an underscore and the name (e.g. new_Invoice, contoso_Order).',
    );
  }
}

/** Build the EntityMetadata document for a new custom table. */
export function buildEntityMetadata(spec: CreateTableSpec): Record<string, any> {
  const lcid = spec.languageCode ?? 1033;
  const prefix = spec.schemaName.split('_')[0];
  const primaryName = spec.primaryNameSchemaName || `${prefix}_Name`;
  const body: Record<string, any> = {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: spec.schemaName,
    DisplayName: label(spec.displayName, lcid),
    DisplayCollectionName: label(spec.displayCollectionName, lcid),
    OwnershipType: spec.ownershipType || 'UserOwned',
    HasNotes: !!spec.hasNotes,
    HasActivities: !!spec.hasActivities,
    IsActivity: false,
    Attributes: [
      {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        SchemaName: primaryName,
        DisplayName: label(spec.primaryNameDisplayName || 'Name', lcid),
        RequiredLevel: requiredLevelProp('None'),
        MaxLength: spec.primaryNameMaxLength ?? 100,
        FormatName: { Value: 'Text' },
        IsPrimaryName: true,
      },
    ],
  };
  if (spec.description) body.Description = label(spec.description, lcid);
  if (spec.tableType === 'Elastic') body.TableType = 'Elastic';
  return body;
}

/**
 * Create a new custom Dataverse table. POSTs the EntityMetadata document to
 * EntityDefinitions; returns the new entity URI from the OData-EntityId
 * response header (204 No Content).
 */
export async function createTable(
  envId: string, spec: CreateTableSpec,
): Promise<{ ok: true; metadataId?: string; entityId?: string }> {
  assertPrefixedSchema(spec.schemaName, 'Table');
  const primaryName = spec.primaryNameSchemaName;
  if (primaryName) assertPrefixedSchema(primaryName, 'Primary-name column');
  const { url, scope } = await dataverseBase(envId);
  const body = buildEntityMetadata(spec);
  const endpoint = `${url}/api/data/v9.2/EntityDefinitions`;
  const token = await getToken(scope);
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
    const msg = (json?.error?.message || json?.message || text || `POST ${endpoint} failed`).toString();
    let hint: string | undefined;
    if (res.status === 401 || res.status === 403) {
      hint = 'The Dataverse SP (LOOM_DATAVERSE_CLIENT_ID) must be a Dataverse Application User with the System Administrator or System Customizer role on this environment to create tables.';
    }
    throw new PowerPlatformError(msg, res.status, json || text, endpoint, hint);
  }
  const entityId = res.headers.get('odata-entityid') || res.headers.get('OData-EntityId') || undefined;
  const metadataId = entityId?.match(/EntityDefinitions\(([^)]+)\)/)?.[1];
  return { ok: true, metadataId, entityId };
}

/** Top-N data rows for a table (real business data via the entity set). */
export async function getTableData(
  envId: string,
  entitySetName: string,
  top = 25,
): Promise<{ columns: string[]; rows: Record<string, any>[] }> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: any[] }>(`${url}/api/data/v9.2/${entitySetName}`, scope, {
    query: { '$top': top },
    headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' },
  });
  const rows = j.value || [];
  // Derive a stable, readable column set: skip OData annotation keys, navigation
  // formatted-value keys, lookup `_x_value` keys, and @odata.etag.
  const colSet = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (k.includes('@') || k.startsWith('_')) continue;
      colSet.add(k);
    }
  }
  const columns = Array.from(colSet).slice(0, 12);
  return { columns, rows };
}

// ============================================================
// Power Apps
// ============================================================

const APPS_API_VERSION = '2016-11-01';

/**
 * Power Apps web-player base. Commercial = apps.powerapps.com; GCC/Gov set
 * LOOM_POWERAPPS_PLAYER_BASE=https://apps.gov.powerapps.us. The canvas embed
 * URL is `<base>/play/<appId>?source=iframe` (Microsoft Learn:
 * power-apps/maker/canvas-apps/embed-apps-dev).
 */
const POWERAPPS_PLAYER_BASE = process.env.LOOM_POWERAPPS_PLAYER_BASE || 'https://apps.powerapps.com';

/**
 * Build the play/embed URI for an app.
 *   - Canvas apps   → web-player iframe URL `<player>/play/<appId>?source=iframe`
 *   - Model-driven  → main.aspx deep link on the env instance URL (cannot iframe;
 *     the caller surfaces an "Open in new tab" affordance).
 * Falls back to the maker-provided `appOpenUri` when present.
 */
export function powerAppPlayerEmbedUri(
  app: { name: string; appType?: string; appOpenUri?: string },
  opts?: { instanceUrl?: string },
): string | undefined {
  const type = (app.appType || '').toLowerCase();
  if (type.includes('modeldriven')) {
    const base = opts?.instanceUrl?.replace(/\/$/, '');
    if (base) return `${base}/main.aspx?appid=${encodeURIComponent(app.name)}`;
    return app.appOpenUri;
  }
  // Canvas (default): embeddable iframe player URL.
  if (app.name) return `${POWERAPPS_PLAYER_BASE}/play/${encodeURIComponent(app.name)}?source=iframe`;
  return app.appOpenUri;
}

export async function listPowerApps(envId: string): Promise<PowerApp[]> {
  const j = await call<{ value: any[] }>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/apps`,
    POWERAPPS_SCOPE,
    { query: { 'api-version': APPS_API_VERSION } },
  );
  return (j.value || []).map((a) => mapPowerApp(a));
}

export async function getPowerApp(envId: string, name: string, opts?: { instanceUrl?: string }): Promise<PowerApp> {
  const j = await call<any>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/apps/${encodeURIComponent(name)}`,
    POWERAPPS_SCOPE,
    { query: { 'api-version': APPS_API_VERSION } },
  );
  return mapPowerApp(j, opts);
}

/**
 * Publish the latest saved revision of a canvas app so shared users run it.
 * Power Apps exposes the action `publishAppRevision` on the app management
 * surface (the same operation as `Publish-AdminPowerApp` / the Studio publish
 * button). Returns the action body (often empty / the refreshed app doc).
 */
export async function publishPowerApp(envId: string, name: string): Promise<{ ok: true; body?: any }> {
  const body = await call<any>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/environments/${encodeURIComponent(envId)}/apps/${encodeURIComponent(name)}/publishAppRevision`,
    POWERAPPS_SCOPE,
    { method: 'POST', query: { 'api-version': APPS_API_VERSION }, body: {} },
  );
  return { ok: true, body };
}

function mapConnectionRefs(refs: any): PowerAppConnectionRef[] {
  if (!refs || typeof refs !== 'object') return [];
  return Object.entries(refs).map(([connectorId, v]: [string, any]) => ({
    id: connectorId,
    displayName: v?.displayName || connectorId,
    iconUri: v?.iconUri,
    dataSources: Array.isArray(v?.dataSources) ? v.dataSources : undefined,
  }));
}

function mapPowerApp(a: any, opts?: { instanceUrl?: string }): PowerApp {
  const p = a.properties || {};
  const app: PowerApp = {
    name: a.name,
    id: a.id,
    displayName: p.displayName || a.name,
    description: p.description,
    appType: p.appType,
    owner: p.owner ? {
      displayName: p.owner.displayName,
      email: p.owner.email,
      userPrincipalName: p.owner.userPrincipalName,
    } : undefined,
    createdTime: p.createdTime,
    lastModifiedTime: p.lastModifiedTime,
    appOpenUri: p.appOpenUri,
    appOpenProtocolUri: p.appOpenProtocolUri,
    environmentName: p.environment?.name,
    connectionReferences: mapConnectionRefs(p.connectionReferences),
    appVersion: p.appVersion,
    isFeaturedApp: p.isFeaturedApp,
    bypassConsent: p.bypassConsent,
    sharedGroupsCount: p.sharedGroupsCount,
    sharedUsersCount: p.sharedUsersCount,
  };
  app.playerEmbedUri = powerAppPlayerEmbedUri(app, opts);
  return app;
}

// ============================================================
// Power Automate (Flows)
// ============================================================

const FLOW_API_VERSION = '2016-11-01';

export async function listFlows(envId: string): Promise<PowerAutomateFlow[]> {
  // List Flows as Admin (V2). The V1 path (.../environments/{env}/flows) was
  // retired by Microsoft ("The List Flows as Admin API is no longer supported.
  // Please use the List Flows as Admin (V2) API."). V2 inserts /v2/ before
  // /flows and returns identifying info only (displayName/state/timestamps);
  // the full definition is fetched per-flow via getFlow/getFlowDefinition.
  const j = await call<{ value: any[] }>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/scopes/admin/environments/${encodeURIComponent(envId)}/v2/flows`,
    FLOW_SCOPE,
    { query: { 'api-version': FLOW_API_VERSION } },
  );
  return (j.value || []).map(mapFlow);
}

export async function getFlow(envId: string, name: string): Promise<PowerAutomateFlow> {
  const j = await call<any>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/scopes/admin/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(name)}`,
    FLOW_SCOPE,
    { query: { 'api-version': FLOW_API_VERSION } },
  );
  return mapFlow(j);
}

function mapFlow(f: any): PowerAutomateFlow {
  const p = f.properties || {};
  return {
    name: f.name,
    id: f.id,
    displayName: p.displayName || f.name,
    state: p.state,
    triggerType: p.definitionSummary?.triggers?.[0]?.type,
    createdTime: p.createdTime,
    lastModifiedTime: p.lastModifiedTime,
    definitionSummary: p.definitionSummary,
    flowFailureAlertSubscribed: p.flowFailureAlertSubscribed,
  };
}

export async function runFlow(envId: string, name: string, inputs?: Record<string, unknown>): Promise<{ ok: true; runName?: string }> {
  // Admin trigger — uses the manual trigger if present.
  const res = await call<any>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(name)}/triggers/manual/run`,
    FLOW_SCOPE,
    { method: 'POST', query: { 'api-version': FLOW_API_VERSION }, body: inputs ?? {} },
  );
  return { ok: true, runName: res?.name };
}

export async function listFlowRuns(envId: string, name: string, top = 50): Promise<FlowRun[]> {
  const j = await call<{ value: any[] }>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/scopes/admin/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(name)}/runs`,
    FLOW_SCOPE,
    { query: { 'api-version': FLOW_API_VERSION, '$top': top } },
  );
  return (j.value || []).map((r: any) => ({
    name: r.name,
    id: r.id,
    status: r.properties?.status,
    startTime: r.properties?.startTime,
    endTime: r.properties?.endTime,
    trigger: r.properties?.trigger,
    errorCode: r.properties?.error?.code,
    errorMessage: r.properties?.error?.message,
  }));
}

// ------------------------------------------------------------
// Cloud flow authoring — real Dataverse Web API writes (workflow rows).
//
// Grounded in Microsoft Learn (power-automate/manage-flows-with-code):
//   A modern cloud flow is a Dataverse `workflow` row:
//     category      5   (Modern Flow)
//     type          1   (Definition)
//     primaryentity "none"
//     statecode     0=Draft / 1=Activated     statuscode 1=Draft / 2=Activated
//     clientdata    string-encoded JSON: { schemaVersion, properties:{
//                     definition: <Logic Apps workflow definition>,
//                     connectionReferences: { ... } } }
//   Create : POST  <org>/api/data/v9.2/workflows  (returns 204 + OData-EntityId)
//   Update : PATCH <org>/api/data/v9.2/workflows({id})  { clientdata, name? }
//   State  : PATCH <org>/api/data/v9.2/workflows({id})  { statecode, statuscode }
//
// Uses the dedicated Dataverse SP (LOOM_DATAVERSE_CLIENT_ID), which must be a
// Dataverse Application User with a customizing role. Azure-native; no Fabric.
//
// This is genuine in-product authoring of the flow DEFINITION (the same JSON the
// drag-drop designer compiles to). The visual designer itself can't be embedded
// (needs a delegated JWT), so it stays an honest "open visual designer" gate —
// but the structured definition + connection references are authored in Loom.
// ------------------------------------------------------------

export interface FlowConnectionReference {
  /** connectionName / logical name, e.g. "shared_sharepointonline". */
  connectionName?: string;
  /** Connector id path, e.g. "/providers/Microsoft.PowerApps/apis/shared_sharepointonline". */
  id?: string;
  /** Connection source — Embedded / Invoker / NotSpecified. */
  source?: string;
}

export interface FlowDefinition {
  /** Logic Apps workflow definition ($schema, triggers, actions, ...). */
  definition: Record<string, any>;
  /** Map of reference key → connection reference. */
  connectionReferences?: Record<string, FlowConnectionReference>;
}

export interface FlowAuthoringDoc {
  workflowid: string;
  name: string;
  category?: number;
  statecode?: number;
  statuscode?: number;
  primaryentity?: string;
  /** Parsed clientdata (definition + connectionReferences). Null when unparseable. */
  clientdata?: FlowDefinition | null;
  /** Raw clientdata string (for diagnostics). */
  clientdataRaw?: string;
  modifiedon?: string;
}

/** A minimal valid modern-flow clientdata skeleton for a brand-new flow. */
export function emptyFlowDefinition(): FlowDefinition {
  return {
    definition: {
      $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
      contentVersion: '1.0.0.0',
      parameters: {
        $connections: { defaultValue: {}, type: 'Object' },
        $authentication: { defaultValue: {}, type: 'SecureObject' },
      },
      triggers: {
        manual: {
          type: 'Request',
          kind: 'Button',
          inputs: { schema: {} },
        },
      },
      actions: {},
    },
    connectionReferences: {},
  };
}

/**
 * Validate a flow definition is a well-formed Logic Apps workflow definition with
 * the structured shape Power Automate expects (NOT a free blob — loom-no-freeform-config).
 * Throws PowerPlatformError(400) with a precise message on any structural problem.
 */
export function validateFlowDefinition(input: unknown): FlowDefinition {
  if (!input || typeof input !== 'object') {
    throw new PowerPlatformError('Flow definition must be a JSON object.', 400);
  }
  const doc = input as Record<string, any>;
  const def = doc.definition;
  if (!def || typeof def !== 'object') {
    throw new PowerPlatformError('Flow definition must contain a `definition` object (the Logic Apps workflow definition).', 400);
  }
  if (typeof def.$schema !== 'string' || !def.$schema.includes('workflowdefinition.json')) {
    throw new PowerPlatformError('`definition.$schema` must be the Logic Apps workflowdefinition.json schema URL.', 400);
  }
  if (!def.triggers || typeof def.triggers !== 'object' || Object.keys(def.triggers).length === 0) {
    throw new PowerPlatformError('`definition.triggers` must define at least one trigger.', 400);
  }
  if (def.actions !== undefined && (typeof def.actions !== 'object' || def.actions === null)) {
    throw new PowerPlatformError('`definition.actions` must be an object when present.', 400);
  }
  const refs = doc.connectionReferences;
  if (refs !== undefined && (typeof refs !== 'object' || refs === null || Array.isArray(refs))) {
    throw new PowerPlatformError('`connectionReferences` must be an object map when present.', 400);
  }
  return { definition: def, connectionReferences: refs || {} };
}

function parseClientData(clientdata?: string | null): { parsed: FlowDefinition | null; raw?: string } {
  if (!clientdata) return { parsed: null };
  try {
    const obj = JSON.parse(clientdata);
    // Power Automate stores { schemaVersion, properties: { definition, connectionReferences } }
    const props = obj?.properties || obj;
    const definition = props?.definition;
    const connectionReferences = props?.connectionReferences;
    if (definition) return { parsed: { definition, connectionReferences: connectionReferences || {} }, raw: clientdata };
    return { parsed: null, raw: clientdata };
  } catch {
    return { parsed: null, raw: clientdata };
  }
}

/** Wrap a FlowDefinition back into the clientdata string Power Automate stores. */
function encodeClientData(def: FlowDefinition): string {
  return JSON.stringify({
    schemaVersion: '1.0.0.0',
    properties: {
      connectionReferences: def.connectionReferences || {},
      definition: def.definition,
    },
  });
}

/** Read a modern cloud flow's authoring document (clientdata definition) from Dataverse. */
export async function getFlowDefinition(envId: string, workflowId: string): Promise<FlowAuthoringDoc> {
  const { url, scope } = await dataverseBase(envId);
  const w = await call<any>(
    `${url}/api/data/v9.2/workflows(${encodeURIComponent(workflowId)})`,
    scope,
    { query: { '$select': 'workflowid,name,category,type,statecode,statuscode,primaryentity,clientdata,modifiedon' } },
  );
  const { parsed, raw } = parseClientData(w.clientdata);
  return {
    workflowid: w.workflowid,
    name: w.name,
    category: w.category,
    statecode: w.statecode,
    statuscode: w.statuscode,
    primaryentity: w.primaryentity,
    clientdata: parsed,
    clientdataRaw: raw,
    modifiedon: w.modifiedon,
  };
}

/**
 * Create a new modern cloud flow (Dataverse workflow row). The flow is created
 * in Draft (statecode 0) so the operator can review before turning it on.
 * Returns the new workflow id from the OData-EntityId header.
 */
export async function createFlow(
  envId: string, spec: { name: string; definition: FlowDefinition },
): Promise<{ ok: true; workflowId?: string; entityId?: string }> {
  const def = validateFlowDefinition(spec.definition);
  if (!spec.name || !spec.name.trim()) {
    throw new PowerPlatformError('Flow name is required.', 400);
  }
  const { url, scope } = await dataverseBase(envId);
  const endpoint = `${url}/api/data/v9.2/workflows`;
  const body = {
    name: spec.name.trim(),
    category: 5,          // Modern Flow
    type: 1,              // Definition
    primaryentity: 'none',
    description: '',
    statecode: 0,         // Draft
    statuscode: 1,        // Draft
    clientdata: encodeClientData(def),
  };
  const token = await getToken(scope);
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
    const msg = (json?.error?.message || json?.message || text || `POST ${endpoint} failed`).toString();
    let hint: string | undefined;
    if (res.status === 401 || res.status === 403) {
      hint = 'The Dataverse SP (LOOM_DATAVERSE_CLIENT_ID) must be a Dataverse Application User with the System Administrator or System Customizer role on this environment to create flows.';
    }
    throw new PowerPlatformError(msg, res.status, json || text, endpoint, hint);
  }
  const entityId = res.headers.get('odata-entityid') || res.headers.get('OData-EntityId') || undefined;
  const workflowId = entityId?.match(/workflows\(([^)]+)\)/)?.[1];
  return { ok: true, workflowId, entityId };
}

/**
 * Update a modern cloud flow's definition (clientdata) and/or name via PATCH.
 * Validates the definition structurally before writing.
 */
export async function updateFlowDefinition(
  envId: string, workflowId: string, patch: { definition?: FlowDefinition; name?: string },
): Promise<{ ok: true }> {
  const { url, scope } = await dataverseBase(envId);
  const body: Record<string, any> = {};
  if (patch.definition) body.clientdata = encodeClientData(validateFlowDefinition(patch.definition));
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new PowerPlatformError('Flow name cannot be empty.', 400);
    body.name = patch.name.trim();
  }
  if (Object.keys(body).length === 0) {
    throw new PowerPlatformError('Nothing to update — provide a definition and/or name.', 400);
  }
  await call<any>(
    `${url}/api/data/v9.2/workflows(${encodeURIComponent(workflowId)})`,
    scope,
    {
      method: 'PATCH',
      body,
      headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
    },
  );
  return { ok: true };
}

/**
 * Turn a modern cloud flow on/off via Dataverse statecode (alternative to the
 * Flow admin start/stop endpoints). on → statecode 1 / statuscode 2 (Activated);
 * off → statecode 0 / statuscode 1 (Draft).
 */
export async function setFlowStateViaDataverse(
  envId: string, workflowId: string, on: boolean,
): Promise<{ ok: true }> {
  const { url, scope } = await dataverseBase(envId);
  await call<any>(
    `${url}/api/data/v9.2/workflows(${encodeURIComponent(workflowId)})`,
    scope,
    {
      method: 'PATCH',
      body: on ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 },
      headers: { 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
    },
  );
  return { ok: true };
}

// ============================================================
// Power Pages (Power Platform portals — Dataverse mspp_website)
// ============================================================

export async function listPowerPages(envId: string): Promise<PowerPage[]> {
  const { url, scope } = await dataverseBase(envId);
  // mspp_website is the Power Pages site table. Schema (verified 2026-05-26):
  //   mspp_websiteid, mspp_name, mspp_primarydomainname, mspp_partialurl,
  //   mspp_website_version, statecode, statuscode, createdon, modifiedon.
  // Older portals (adx_website) also exist; we try mspp_ first, fall back on 404.
  try {
    const j = await call<{ value: any[] }>(
      `${url}/api/data/v9.2/mspp_websites`,
      scope,
      // Power Pages overrides the standard createdon/modifiedon audit fields
      // with mspp_-prefixed versions because IsAuditEnabled=false on this entity.
      { query: { '$select': 'mspp_websiteid,mspp_name,mspp_primarydomainname,mspp_partialurl,statecode,statuscode,mspp_createdon,mspp_modifiedon' } },
    );
    return (j.value || []).map((w: any) => ({
      websiteid: w.mspp_websiteid,
      name: w.mspp_name,
      primarydomainname: w.mspp_primarydomainname,
      // websiteurl is derived: https://<primarydomain>/<partialurl>
      websiteurl: w.mspp_primarydomainname
        ? `https://${w.mspp_primarydomainname}${w.mspp_partialurl ? '/' + w.mspp_partialurl.replace(/^\//, '') : ''}`
        : undefined,
      status: w['statuscode@OData.Community.Display.V1.FormattedValue'] || String(w.statuscode ?? ''),
      type: w['statecode@OData.Community.Display.V1.FormattedValue'] || String(w.statecode ?? ''),
      createdon: w.mspp_createdon,
      modifiedon: w.mspp_modifiedon,
    }));
  } catch (e) {
    if (e instanceof PowerPlatformError && e.status === 404) {
      // legacy adx_ tables
      const j = await call<{ value: any[] }>(
        `${url}/api/data/v9.2/adx_websites`,
        scope,
        { query: { '$select': 'adx_websiteid,adx_name,adx_primarydomainname,adx_websiteurl,statuscode,createdon,modifiedon' } },
      );
      return (j.value || []).map((w: any) => ({
        websiteid: w.adx_websiteid,
        name: w.adx_name,
        primarydomainname: w.adx_primarydomainname,
        websiteurl: w.adx_websiteurl,
        status: w['statuscode@OData.Community.Display.V1.FormattedValue'] || String(w.statuscode ?? ''),
        type: 'adx_website (legacy)',
        createdon: w.createdon,
        modifiedon: w.modifiedon,
      }));
    }
    throw e;
  }
}

export async function getPowerPage(envId: string, websiteId: string): Promise<PowerPage> {
  const { url, scope } = await dataverseBase(envId);
  try {
    const w = await call<any>(`${url}/api/data/v9.2/mspp_websites(${encodeURIComponent(websiteId)})`, scope);
    return {
      websiteid: w.mspp_websiteid,
      name: w.mspp_name,
      primarydomainname: w.mspp_primarydomainname,
      websiteurl: w.mspp_websiteurl,
      status: String(w.statuscode ?? ''),
      type: String(w.mspp_type ?? ''),
      createdon: w.createdon,
      modifiedon: w.modifiedon,
    };
  } catch (e) {
    if (e instanceof PowerPlatformError && e.status === 404) {
      const w = await call<any>(`${url}/api/data/v9.2/adx_websites(${encodeURIComponent(websiteId)})`, scope);
      return {
        websiteid: w.adx_websiteid,
        name: w.adx_name,
        primarydomainname: w.adx_primarydomainname,
        websiteurl: w.adx_websiteurl,
        status: String(w.statuscode ?? ''),
        type: 'adx_website (legacy)',
        createdon: w.createdon,
        modifiedon: w.modifiedon,
      };
    }
    throw e;
  }
}

// ============================================================
// AI Builder models (Dataverse msdyn_aimodel)
// ============================================================

export async function listAiBuilderModels(envId: string): Promise<AiBuilderModel[]> {
  const { url, scope } = await dataverseBase(envId);
  const j = await call<{ value: any[] }>(
    `${url}/api/data/v9.2/msdyn_aimodels`,
    scope,
    {
      query: {
        '$select': 'msdyn_aimodelid,msdyn_name,msdyn_modelcreationcontext,msdyn_typename,_msdyn_templateid_value,statecode,statuscode,createdon,modifiedon',
        '$expand': 'msdyn_TemplateId($select=msdyn_name)',
      },
    },
  );
  return (j.value || []).map((m: any) => ({
    msdyn_aimodelid: m.msdyn_aimodelid,
    msdyn_name: m.msdyn_name,
    msdyn_modelcreationcontext: m.msdyn_modelcreationcontext,
    msdyn_templateid_value: m._msdyn_templateid_value,
    templateName: m.msdyn_TemplateId?.msdyn_name,
    msdyn_typename: m.msdyn_typename,
    statecode: m.statecode,
    statuscode: m.statuscode,
    createdon: m.createdon,
    modifiedon: m.modifiedon,
  }));
}

export async function getAiBuilderModel(envId: string, modelId: string): Promise<AiBuilderModel> {
  const { url, scope } = await dataverseBase(envId);
  const m = await call<any>(
    `${url}/api/data/v9.2/msdyn_aimodels(${encodeURIComponent(modelId)})`,
    scope,
    { query: { '$expand': 'msdyn_TemplateId($select=msdyn_name)' } },
  );
  return {
    msdyn_aimodelid: m.msdyn_aimodelid,
    msdyn_name: m.msdyn_name,
    msdyn_modelcreationcontext: m.msdyn_modelcreationcontext,
    msdyn_templateid_value: m._msdyn_templateid_value,
    templateName: m.msdyn_TemplateId?.msdyn_name,
    msdyn_typename: m.msdyn_typename,
    statecode: m.statecode,
    statuscode: m.statuscode,
    createdon: m.createdon,
    modifiedon: m.modifiedon,
  };
}

/**
 * Train an AI Builder model. Dataverse exposes the bound action
 * `Microsoft.Dynamics.CRM.msdyn_AIModelTrain` on `msdyn_aimodel`. Returns
 * the async-operation handle (training runs server-side).
 */
export async function trainAiBuilderModel(envId: string, modelId: string): Promise<{ ok: true; body?: any }> {
  const { url, scope } = await dataverseBase(envId);
  const body = await call<any>(
    `${url}/api/data/v9.2/msdyn_aimodels(${encodeURIComponent(modelId)})/Microsoft.Dynamics.CRM.msdyn_AIModelTrain`,
    scope,
    { method: 'POST', body: {} },
  );
  return { ok: true, body };
}

/**
 * Publish a trained AI Builder model so predictions can run. Bound action
 * `Microsoft.Dynamics.CRM.msdyn_AIConfigurationActivate` activates the
 * latest trained version's configuration.
 */
export async function publishAiBuilderModel(envId: string, modelId: string): Promise<{ ok: true; body?: any }> {
  const { url, scope } = await dataverseBase(envId);
  const body = await call<any>(
    `${url}/api/data/v9.2/msdyn_aimodels(${encodeURIComponent(modelId)})/Microsoft.Dynamics.CRM.msdyn_AIConfigurationActivate`,
    scope,
    { method: 'POST', body: {} },
  );
  return { ok: true, body };
}

/**
 * Run a real-time prediction against a published AI Builder model. Dataverse
 * exposes the unbound action `Microsoft.Dynamics.CRM.Predict` (predict by
 * reference). `request` is the model-specific input payload — e.g. for a
 * prediction model `{ "V2": { "<column>": <value>, ... } }`.
 */
export async function predictAiBuilderModel(
  envId: string,
  modelId: string,
  request: Record<string, unknown>,
): Promise<{ ok: true; result: any }> {
  const { url, scope } = await dataverseBase(envId);
  const result = await call<any>(
    `${url}/api/data/v9.2/Predict`,
    scope,
    {
      method: 'POST',
      body: {
        Request: {
          '@odata.type': 'Microsoft.Dynamics.CRM.expando',
          ModelId: modelId,
          Request: request,
        },
      },
    },
  );
  return { ok: true, result };
}

// ============================================================
// Connections + custom connectors (Power Apps admin API)
//
// The Power Apps admin surface exposes per-environment API connections and
// tenant/env custom connectors via the same powerapps.com control plane used
// for apps (scope https://service.powerapps.com/.default). These back the
// "Connections" tab under Dataverse in make.powerapps.com and are listed by
// the "Power Apps for Admins" connector (Get-AdminPowerAppConnection /
// Get-AdminPowerAppConnector). Real REST — no mocks.
//   Connections : GET .../scopes/admin/environments/{env}/connections
//   Connectors  : GET .../scopes/admin/environments/{env}/apis
// ============================================================

export interface PowerConnection {
  name: string;               // connection id (GUID)
  id?: string;
  displayName: string;        // connector display name
  connectorId?: string;       // e.g. shared_sharepointonline
  status?: string;            // Connected / Error / etc.
  createdBy?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  iconUri?: string;
  testLinkError?: string;
}

export interface PowerConnector {
  name: string;               // connector id (GUID for custom, shared_* for built-ins)
  id?: string;
  displayName: string;
  description?: string;
  isCustomApi?: boolean;
  tier?: string;              // Standard / Premium
  publisher?: string;
  iconUri?: string;
  createdTime?: string;
}

export async function listConnections(envId: string): Promise<PowerConnection[]> {
  const j = await call<{ value: any[] }>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/connections`,
    POWERAPPS_SCOPE,
    { query: { 'api-version': APPS_API_VERSION } },
  );
  return (j.value || []).map((c: any) => {
    const p = c.properties || {};
    const statuses = Array.isArray(p.statuses) ? p.statuses : [];
    return {
      name: c.name,
      id: c.id,
      displayName: p.displayName || p.apiId?.split('/').pop() || c.name,
      connectorId: (p.apiId || '').split('/').pop(),
      status: statuses[0]?.status || (p.statuses?.length ? 'Unknown' : 'Connected'),
      createdBy: p.createdBy?.displayName || p.createdBy?.userPrincipalName,
      createdTime: p.createdTime,
      lastModifiedTime: p.lastModifiedTime,
      iconUri: p.iconUri,
      testLinkError: statuses.find((s: any) => s?.error)?.error?.message,
    } as PowerConnection;
  });
}

export async function listConnectors(envId: string): Promise<PowerConnector[]> {
  // The admin "apis" endpoint lists connectors visible in the environment.
  // We surface CUSTOM connectors prominently (isCustomApi) but return all so
  // the count + filter match the maker portal Connectors list.
  const j = await call<{ value: any[] }>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/apis`,
    POWERAPPS_SCOPE,
    { query: { 'api-version': APPS_API_VERSION, '$filter': "environment eq '" + envId + "'" } },
  ).catch(async (e) => {
    // Some tenants reject the $filter form; retry without it.
    if (e instanceof PowerPlatformError && (e.status === 400 || e.status === 404)) {
      return call<{ value: any[] }>(
        `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/apis`,
        POWERAPPS_SCOPE,
        { query: { 'api-version': APPS_API_VERSION } },
      );
    }
    throw e;
  });
  return (j.value || []).map((a: any) => {
    const p = a.properties || {};
    return {
      name: a.name,
      id: a.id,
      displayName: p.displayName || a.name,
      description: p.description,
      isCustomApi: !!p.isCustomApi,
      tier: p.tier,
      publisher: p.publisher,
      iconUri: p.iconUri,
      createdTime: p.createdTime,
    } as PowerConnector;
  });
}

/** Delete an API connection (real Power Apps admin REST). */
export async function deleteConnection(envId: string, connectorId: string, connectionName: string): Promise<{ ok: true }> {
  await call<any>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/connections/${encodeURIComponent(connectorId)}/${encodeURIComponent(connectionName)}`,
    POWERAPPS_SCOPE,
    { method: 'DELETE', query: { 'api-version': APPS_API_VERSION } },
  );
  return { ok: true };
}

/** Delete a Power App (real Power Apps admin REST). */
export async function deletePowerApp(envId: string, name: string): Promise<{ ok: true }> {
  await call<any>(
    `${POWERAPPS_BASE}/providers/Microsoft.PowerApps/scopes/admin/environments/${encodeURIComponent(envId)}/apps/${encodeURIComponent(name)}`,
    POWERAPPS_SCOPE,
    { method: 'DELETE', query: { 'api-version': APPS_API_VERSION } },
  );
  return { ok: true };
}

/** Delete a cloud flow (real Power Automate admin REST). */
export async function deleteFlow(envId: string, name: string): Promise<{ ok: true }> {
  await call<any>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/scopes/admin/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(name)}`,
    FLOW_SCOPE,
    { method: 'DELETE', query: { 'api-version': FLOW_API_VERSION } },
  );
  return { ok: true };
}

/** Start/stop a cloud flow (real Power Automate admin REST: turnOn / turnOff). */
export async function setFlowState(envId: string, name: string, on: boolean): Promise<{ ok: true }> {
  await call<any>(
    `${FLOW_BASE}/providers/Microsoft.ProcessSimple/scopes/admin/environments/${encodeURIComponent(envId)}/flows/${encodeURIComponent(name)}/${on ? 'start' : 'stop'}`,
    FLOW_SCOPE,
    { method: 'POST', query: { 'api-version': FLOW_API_VERSION }, body: {} },
  );
  return { ok: true };
}
