/**
 * Azure API Management (APIM) management-plane client.
 *
 * Targets the Loom Console UAMI via ChainedTokenCredential:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — production path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Calls the ARM REST API for the APIM service:
 *   https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{name}/...
 *
 * Auth scope: https://management.azure.com/.default
 * UAMI role:  "API Management Service Contributor" at the APIM service scope
 *             (granted via scripts/csa-loom/grant-apim-rbac.sh).
 *
 * 404 returns `null` so callers can branch cleanly. All other non-2xx
 * responses throw an `ApimError` carrying the status + parsed body so the
 * BFF can surface APIM's own validation messages to the editor UI.
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';

const ARM_SCOPE = 'https://management.azure.com/.default';
const APIM_API = '2024-06-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env var: ${k}`);
  return v;
}

function apimBase(): string {
  const sub = required('LOOM_SUBSCRIPTION_ID');
  const rg = process.env.LOOM_APIM_RG || 'rg-csa-loom-admin-eastus2';
  const name = process.env.LOOM_APIM_NAME || 'apim-csa-loom-eastus2';
  return `https://management.azure.com/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service/${name}`;
}

export class ApimError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `APIM call failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function apimFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<Response> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for APIM');
  const sep = path.includes('?') ? '&' : '?';
  const query = init.query
    ? '&' + new URLSearchParams(init.query).toString()
    : '';
  const url = `${apimBase()}${path}${sep}api-version=${APIM_API}${query}`;
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
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg =
      (parsed as any)?.error?.message ||
      (typeof parsed === 'string' ? parsed : `APIM ${res.status}`);
    throw new ApimError(res.status, parsed, msg);
  }
  return (parsed as T) ?? ({} as T);
}

// ---------------- Service (top-level SKU + capacity) ----------------

export interface ApimServiceShape {
  id?: string;
  name?: string;
  location?: string;
  sku: { name: string; capacity: number };
  provisioningState?: string;
}

function shapeService(raw: any): ApimServiceShape {
  return {
    id: raw?.id,
    name: raw?.name,
    location: raw?.location,
    sku: {
      name: raw?.sku?.name || 'unknown',
      capacity: raw?.sku?.capacity ?? 1,
    },
    provisioningState: raw?.properties?.provisioningState,
  };
}

/**
 * GET the APIM service resource itself (not a child like /apis or /products).
 * We hit the parent path by calling the empty suffix.
 */
export async function getApimService(): Promise<ApimServiceShape | null> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for APIM');
  const url = `${apimBase()}?api-version=${APIM_API}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
  });
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg = (parsed as any)?.error?.message || `APIM ${res.status}`;
    throw new ApimError(res.status, parsed, msg);
  }
  return shapeService(parsed);
}

/**
 * PATCH the APIM service SKU + capacity. Valid sku.name values:
 *   - Developer     (no SLA, no scale-out, lowest cost)
 *   - Basic         (capacity 1-2)
 *   - Standard      (capacity 1-4)
 *   - Premium       (capacity 1-10 per region, multi-region)
 *   - BasicV2 / StandardV2 (stv2 architecture)
 * Tier mirrors name for ARM compatibility.
 *
 * Scale operation is async (PATCH returns 202 + Azure-AsyncOperation
 * header); polling is the caller's responsibility.
 */
export async function updateApimSku(
  newSku: string,
  capacity = 1,
): Promise<ApimServiceShape> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token?.token) throw new Error('Failed to acquire ARM token for APIM');
  const url = `${apimBase()}?api-version=${APIM_API}`;
  const body = { sku: { name: newSku, capacity } };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text();
    throw new ApimError(res.status, t, `updateApimSku failed ${res.status}: ${t.slice(0, 200)}`);
  }
  if (res.status === 202) {
    return { sku: { name: newSku, capacity }, provisioningState: 'Updating' };
  }
  return shapeService(await res.json());
}

// ---------------- APIs ----------------

export interface ApimApiSummary {
  id: string;
  name: string;
  displayName: string;
  path: string;
  protocols: string[];
  serviceUrl?: string;
  subscriptionRequired?: boolean;
  type?: string;
}

export interface ApimApiBody {
  displayName: string;
  path: string;
  protocols?: string[];
  subscriptionRequired?: boolean;
  serviceUrl?: string;
  description?: string;
  format?: string;
  value?: string;
  apiType?: string;
}

function shapeApi(raw: any): ApimApiSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    path: p.path,
    protocols: p.protocols || [],
    serviceUrl: p.serviceUrl,
    subscriptionRequired: p.subscriptionRequired,
    type: p.type || p.apiType,
  };
}

export async function listApis(): Promise<ApimApiSummary[]> {
  const res = await apimFetch(`/apis`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeApi);
}

export async function getApi(apiId: string): Promise<ApimApiSummary | null> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}`);
  const j = await readJson<any>(res);
  return j ? shapeApi(j) : null;
}

export async function upsertApi(
  apiId: string,
  body: ApimApiBody,
): Promise<ApimApiSummary> {
  const properties: any = {
    displayName: body.displayName,
    path: body.path,
    protocols: body.protocols && body.protocols.length ? body.protocols : ['https'],
    subscriptionRequired: body.subscriptionRequired ?? true,
  };
  if (body.serviceUrl) properties.serviceUrl = body.serviceUrl;
  if (body.description) properties.description = body.description;
  if (body.format) properties.format = body.format;
  if (body.value) properties.value = body.value;
  if (body.apiType) properties.apiType = body.apiType;
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim api returned null');
  return shapeApi(j);
}

export async function deleteApi(apiId: string): Promise<void> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}`, {
    method: 'DELETE',
  });
  if (res.status === 404 || res.ok) return;
  await readJson<unknown>(res);
}

export interface ApimOperation {
  id: string;
  name: string;
  displayName: string;
  method: string;
  urlTemplate: string;
}

export async function listOperations(apiId: string): Promise<ApimOperation[]> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}/operations`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.properties?.displayName,
    method: r.properties?.method,
    urlTemplate: r.properties?.urlTemplate,
  }));
}

/**
 * Returns the OpenAPI export for an API as a JSON/YAML string,
 * or null if the API has no spec / does not exist.
 */
export async function getApiSpec(
  apiId: string,
  format: 'openapi' | 'openapi+json' | 'swagger' = 'openapi+json',
): Promise<{ format: string; value: string } | null> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}`, {
    query: { format, export: 'true' },
  });
  const j = await readJson<any>(res);
  if (!j) return null;
  const value = j?.properties?.value;
  const fmt = j?.properties?.format || format;
  if (typeof value !== 'string') return null;
  return { format: fmt, value };
}

// ---------------- Products ----------------

export interface ApimProductSummary {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  subscriptionRequired?: boolean;
  approvalRequired?: boolean;
  state?: 'published' | 'notPublished' | string;
}

export interface ApimProductBody {
  displayName: string;
  description?: string;
  subscriptionRequired?: boolean;
  approvalRequired?: boolean;
  state?: 'published' | 'notPublished';
  terms?: string;
}

function shapeProduct(raw: any): ApimProductSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    description: p.description,
    subscriptionRequired: p.subscriptionRequired,
    approvalRequired: p.approvalRequired,
    state: p.state,
  };
}

export async function listProducts(): Promise<ApimProductSummary[]> {
  const res = await apimFetch(`/products`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeProduct);
}

export async function getProduct(id: string): Promise<ApimProductSummary | null> {
  const res = await apimFetch(`/products/${encodeURIComponent(id)}`);
  const j = await readJson<any>(res);
  return j ? shapeProduct(j) : null;
}

export async function upsertProduct(
  id: string,
  body: ApimProductBody,
): Promise<ApimProductSummary> {
  const properties: any = {
    displayName: body.displayName,
    description: body.description ?? '',
    subscriptionRequired: body.subscriptionRequired ?? true,
    state: body.state || 'notPublished',
  };
  // approvalRequired only valid when subscriptionRequired === true
  if (properties.subscriptionRequired) {
    properties.approvalRequired = body.approvalRequired ?? false;
    properties.subscriptionsLimit = 100;
  }
  if (body.terms) properties.terms = body.terms;
  const res = await apimFetch(`/products/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim product returned null');
  return shapeProduct(j);
}

export async function deleteProduct(id: string): Promise<void> {
  const res = await apimFetch(
    `/products/${encodeURIComponent(id)}?deleteSubscriptions=true`,
    { method: 'DELETE' },
  );
  if (res.status === 404 || res.ok) return;
  await readJson<unknown>(res);
}

// ---------------- Policies ----------------

/**
 * Scope is either:
 *   'service'             — global policy
 *   'apis/{apiId}'        — API-level policy
 *   'products/{productId}'— product-level policy
 *
 * APIM URL convention:
 *   /policies/policy      — global
 *   /apis/{id}/policies/policy
 *   /products/{id}/policies/policy
 */
export type PolicyScope = string;

function policyPath(scope: PolicyScope): string {
  if (scope === 'service' || scope === '') return `/policies/policy`;
  return `/${scope}/policies/policy`;
}

export async function getPolicy(
  scope: PolicyScope,
): Promise<{ value: string; format: string } | null> {
  const res = await apimFetch(policyPath(scope), {
    query: { format: 'xml' },
  });
  const j = await readJson<any>(res);
  if (!j) return null;
  return {
    value: j?.properties?.value || '',
    format: j?.properties?.format || 'xml',
  };
}

export async function upsertPolicy(
  scope: PolicyScope,
  value: string,
): Promise<{ value: string; format: string }> {
  const res = await apimFetch(policyPath(scope), {
    method: 'PUT',
    body: JSON.stringify({
      properties: { format: 'xml', value },
    }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim policy returned null');
  return {
    value: j?.properties?.value || value,
    format: j?.properties?.format || 'xml',
  };
}

// ---------------- Subscriptions (APIM consumer subscriptions) ----------------

export interface ApimSubscriptionSummary {
  id: string;
  name: string;
  displayName?: string;
  scope?: string;
  state?: string;
  createdDate?: string;
}

function shapeSubscription(raw: any): ApimSubscriptionSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    scope: p.scope,
    state: p.state,
    createdDate: p.createdDate,
  };
}

export async function listSubscriptions(): Promise<ApimSubscriptionSummary[]> {
  const res = await apimFetch(`/subscriptions`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeSubscription);
}

export async function getSubscription(
  id: string,
): Promise<ApimSubscriptionSummary | null> {
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(id)}`);
  const j = await readJson<any>(res);
  return j ? shapeSubscription(j) : null;
}

// ---------------- API revisions + releases ----------------

export interface ApimApiRevision {
  apiId: string;
  apiRevision: string;
  isCurrent?: boolean;
  isOnline?: boolean;
  description?: string;
  createdDateTime?: string;
  updatedDateTime?: string;
}

/** GET /apis/{id}/revisions — all revisions of an API. */
export async function listApiRevisions(apiId: string): Promise<ApimApiRevision[]> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}/revisions`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((r) => ({
    apiId: r.apiId,
    apiRevision: r.apiRevision,
    isCurrent: r.isCurrent,
    isOnline: r.isOnline,
    description: r.description,
    createdDateTime: r.createdDateTime,
    updatedDateTime: r.updatedDateTime,
  }));
}

/**
 * Create a new API revision by copying an existing one. APIM revisions are
 * created by PUTting /apis/{id};rev={n} with sourceApiId pointing at the
 * current revision. Returns the shaped new revision API.
 */
export async function createApiRevision(
  apiId: string,
  apiRevision: string,
  opts: { sourceApiRevision?: string; description?: string } = {},
): Promise<ApimApiSummary> {
  // Determine the source revision id. If a source revision is given, target
  // its ;rev= suffix; otherwise APIM clones the current revision.
  const sourceRev = opts.sourceApiRevision
    ? `;rev=${opts.sourceApiRevision}`
    : '';
  const sourceApiId = `${apimBase().replace('https://management.azure.com', '')}/apis/${encodeURIComponent(apiId)}${sourceRev}`;
  const targetId = `${encodeURIComponent(apiId)};rev=${encodeURIComponent(apiRevision)}`;
  const res = await apimFetch(`/apis/${targetId}`, {
    method: 'PUT',
    body: JSON.stringify({
      properties: {
        sourceApiId,
        apiRevisionDescription: opts.description || `Revision ${apiRevision}`,
      },
    }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'create revision returned null');
  return shapeApi(j);
}

export interface ApimApiRelease {
  id: string;
  name: string;
  apiId?: string;
  notes?: string;
  createdDateTime?: string;
}

/** GET /apis/{id}/releases — change-log releases for the API. */
export async function listApiReleases(apiId: string): Promise<ApimApiRelease[]> {
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}/releases`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((r) => ({
    id: r.id,
    name: r.name,
    apiId: r.properties?.apiId,
    notes: r.properties?.notes,
    createdDateTime: r.properties?.createdDateTime,
  }));
}

/**
 * Create a release of a revision — makes that revision current and adds a
 * change-log entry. PUT /apis/{id}/releases/{releaseId}.
 */
export async function createApiRelease(
  apiId: string,
  apiRevision: string,
  notes?: string,
): Promise<ApimApiRelease> {
  const releaseId = `rel-${Date.now()}`;
  const fullApiId = `${apimBase().replace('https://management.azure.com', '')}/apis/${encodeURIComponent(apiId)};rev=${encodeURIComponent(apiRevision)}`;
  const res = await apimFetch(`/apis/${encodeURIComponent(apiId)}/releases/${encodeURIComponent(releaseId)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties: { apiId: fullApiId, notes: notes || '' } }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'create release returned null');
  return { id: j.id, name: j.name, apiId: j.properties?.apiId, notes: j.properties?.notes, createdDateTime: j.properties?.createdDateTime };
}

// ---------------- Product ↔ API associations ----------------

/** GET /products/{id}/apis — APIs associated with a product. */
export async function listProductApis(productId: string): Promise<ApimApiSummary[]> {
  const res = await apimFetch(`/products/${encodeURIComponent(productId)}/apis`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeApi);
}

/** PUT /products/{pid}/apis/{aid} — add an API to a product. */
export async function addApiToProduct(productId: string, apiId: string): Promise<void> {
  const res = await apimFetch(
    `/products/${encodeURIComponent(productId)}/apis/${encodeURIComponent(apiId)}`,
    { method: 'PUT', body: JSON.stringify({}) },
  );
  if (res.ok || res.status === 201) return;
  await readJson<unknown>(res);
}

/** DELETE /products/{pid}/apis/{aid} — remove an API from a product. */
export async function removeApiFromProduct(productId: string, apiId: string): Promise<void> {
  const res = await apimFetch(
    `/products/${encodeURIComponent(productId)}/apis/${encodeURIComponent(apiId)}`,
    { method: 'DELETE' },
  );
  if (res.status === 404 || res.ok || res.status === 204) return;
  await readJson<unknown>(res);
}

/** GET /products/{id}/subscriptions — subscriptions scoped to a product. */
export async function listProductSubscriptions(productId: string): Promise<ApimSubscriptionSummary[]> {
  const res = await apimFetch(`/products/${encodeURIComponent(productId)}/subscriptions`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeSubscription);
}

// ---------------- Test console (gateway call) ----------------

/**
 * List subscription keys for a subscription via POST .../listSecrets. Used to
 * fetch the all-access (master) key for the in-portal test console.
 */
export async function getSubscriptionKeys(subscriptionId: string): Promise<{ primaryKey?: string; secondaryKey?: string }> {
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}/listSecrets`, { method: 'POST' });
  const j = await readJson<any>(res);
  return { primaryKey: j?.primaryKey, secondaryKey: j?.secondaryKey };
}

/**
 * Execute a test request through the APIM gateway, exactly as the portal Test
 * console does: gateway URL + the API path + operation urlTemplate, with the
 * Ocp-Apim-Subscription-Key header set from the all-access subscription
 * (subscriptionId "master"). Returns status, headers, and body text.
 */
export async function testApiCall(args: {
  apiPath: string;
  urlTemplate: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  query?: Record<string, string>;
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string; gatewayUrl: string }> {
  const svc = await getServiceInfo();
  const gatewayUrl = svc?.gatewayUrl;
  if (!gatewayUrl) throw new ApimError(502, null, 'Could not resolve APIM gateway URL');

  // The built-in all-access subscription is named "master".
  let key: string | undefined;
  try {
    const keys = await getSubscriptionKeys('master');
    key = keys.primaryKey;
  } catch { /* fall through — call may be anonymous (subscriptionRequired=false) */ }

  // Compose: gateway + path + urlTemplate. Strip a leading slash on the
  // template; replace {path-params} with empty (caller bakes them into query).
  const cleanPath = args.apiPath.replace(/^\/+|\/+$/g, '');
  const cleanTpl = args.urlTemplate.replace(/^\/+/, '');
  const qs = args.query && Object.keys(args.query).length ? `?${new URLSearchParams(args.query).toString()}` : '';
  const url = `${gatewayUrl.replace(/\/+$/, '')}/${cleanPath}/${cleanTpl}${qs}`.replace(/([^:])\/{2,}/g, '$1/');

  const headers: Record<string, string> = { ...(args.headers || {}) };
  if (key) headers['Ocp-Apim-Subscription-Key'] = key;

  const res = await fetch(url, {
    method: args.method || 'GET',
    headers,
    body: ['GET', 'HEAD'].includes((args.method || 'GET').toUpperCase()) ? undefined : args.body,
  });
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { respHeaders[k] = v; });
  const text = await res.text();
  return { status: res.status, statusText: res.statusText, headers: respHeaders, body: text, gatewayUrl };
}

// ---------------- Service / health ----------------

export async function getServiceInfo(): Promise<{
  name: string;
  rg: string;
  state?: string;
  gatewayUrl?: string;
} | null> {
  const res = await apimFetch('');
  const j = await readJson<any>(res);
  if (!j) return null;
  return {
    name: j?.name,
    rg: process.env.LOOM_APIM_RG || 'rg-csa-loom-admin-eastus2',
    state: j?.properties?.provisioningState,
    gatewayUrl: j?.properties?.gatewayUrl,
  };
}
