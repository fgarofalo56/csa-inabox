/**
 * Azure API Management (APIM) management-plane client.
 *
 * Targets the Loom Console UAMI via ChainedTokenCredential:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — production path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Calls the ARM REST API for the APIM service:
 *   {ARM}/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{name}/...
 *
 * Auth scope: the sovereign-cloud ARM `.default` scope (cloud-endpoints.armScope()).
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
import { armBase, armScope, stripArmBase } from './cloud-endpoints';

const ARM_SCOPE = armScope();
const APIM_API = '2024-06-01-preview';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
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

/**
 * Resolve the APIM subscription. Honors LOOM_APIM_SUB (a reused APIM service in
 * another subscription, set by the BYO wizard) and falls back to
 * LOOM_SUBSCRIPTION_ID (the deployment sub) when empty — so cross-sub reuse
 * targets the right ARM scope instead of silently 403/404-ing against the
 * deployment sub. Required: throws when neither is set.
 */
function apimSub(): string {
  const v = process.env.LOOM_APIM_SUB || process.env.LOOM_SUBSCRIPTION_ID;
  if (!v) throw new Error('Missing env var: LOOM_APIM_SUB or LOOM_SUBSCRIPTION_ID');
  return v;
}

function apimBase(): string {
  const sub = apimSub();
  const rg = process.env.LOOM_APIM_RG || 'rg-csa-loom-admin-eastus2';
  const name = process.env.LOOM_APIM_NAME || 'apim-csa-loom-eastus2';
  return `${armBase()}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service/${name}`;
}

/**
 * Honest infra-gate: the APIM navigator/editor requires LOOM_SUBSCRIPTION_ID +
 * a target APIM service. Sub is hard-required (no default); RG + name fall back
 * to the deployment defaults but are surfaced here so the UI can name them.
 * Returns the precise missing env var, or null when configured. Mirrors
 * databricksConfigGate / synapseConfigGate so BFF routes can 503 cleanly.
 */
export function apimConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_APIM_SUB && !process.env.LOOM_SUBSCRIPTION_ID) return { missing: 'LOOM_SUBSCRIPTION_ID' };
  // RG + name have deployment defaults; only flag when neither default nor
  // override resolves (defaults always resolve, so this is future-proofing for
  // deployments that null them out explicitly).
  if (process.env.LOOM_APIM_NAME === '') return { missing: 'LOOM_APIM_NAME' };
  if (process.env.LOOM_APIM_RG === '') return { missing: 'LOOM_APIM_RG' };
  return null;
}

/** The resolved APIM target, for surfacing in the UI. */
export function apimTarget(): { subscriptionId?: string; resourceGroup: string; name: string } {
  return {
    subscriptionId: process.env.LOOM_APIM_SUB || process.env.LOOM_SUBSCRIPTION_ID,
    resourceGroup: process.env.LOOM_APIM_RG || 'rg-csa-loom-admin-eastus2',
    name: process.env.LOOM_APIM_NAME || 'apim-csa-loom-eastus2',
  };
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

/**
 * Import (create or replace) an API from an OpenAPI / Swagger definition —
 * the "Create from definition → OpenAPI" flow in the Azure portal's APIM blade.
 *
 * Does a real ARM PUT to
 *   .../service/{apim}/apis/{apiId}?api-version=2024-06-01-preview
 * with the standard APIM import body:
 *   { properties: { format, value, path, displayName? } }
 *
 * `format` selects how APIM interprets `value`:
 *   - 'openapi' / 'openapi+json' → `value` is the INLINE spec document (YAML/JSON)
 *   - 'swagger-link-json' / 'openapi-link' → `value` is a URL APIM fetches
 *
 * APIM parses the spec and materialises the API's operations + schemas. The
 * resolves to the shaped, created/updated API (id, name, path, displayName,…).
 * Honors apimConfigGate (throws the same Error other methods would when the
 * service is unconfigured) and surfaces APIM's own validation via ApimError.
 */
export async function importApiFromOpenApi(opts: {
  apiId: string;
  displayName?: string;
  path: string;
  format: 'openapi' | 'openapi+json' | 'swagger-link-json' | 'openapi-link';
  value: string;
}): Promise<ApimApiSummary> {
  const gate = apimConfigGate();
  if (gate) throw new Error(`APIM service not configured: set ${gate.missing}.`);
  const properties: any = {
    format: opts.format,
    value: opts.value,
    path: opts.path,
  };
  if (opts.displayName) properties.displayName = opts.displayName;
  const res = await apimFetch(`/apis/${encodeURIComponent(opts.apiId)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'import OpenAPI returned null');
  return shapeApi(j);
}

/**
 * An APIM URL-template / query / header parameter (ParameterContract). Mirrors
 * https://learn.microsoft.com/rest/api/apimanagement/api-operation/create-or-update
 * → properties.templateParameters[] / request.queryParameters[] / request.headers[].
 */
export interface ApimParameter {
  name: string;
  type?: string;          // 'string' | 'number' | 'integer' | 'boolean' | …
  required?: boolean;
  description?: string;
  defaultValue?: string;
  values?: string[];
}

/** A request/response body example by content type (RepresentationContract). */
export interface ApimRepresentation {
  contentType: string;            // e.g. 'application/json'
  example?: string;               // sample payload (string; JSON serialised by caller)
  schemaId?: string;
  typeName?: string;
}

/** RequestContract — query/header params + representations for the operation. */
export interface ApimOperationRequest {
  description?: string;
  queryParameters?: ApimParameter[];
  headers?: ApimParameter[];
  representations?: ApimRepresentation[];
}

/** ResponseContract — one declared HTTP status the operation can return. */
export interface ApimOperationResponse {
  statusCode: number;
  description?: string;
  representations?: ApimRepresentation[];
  headers?: ApimParameter[];
}

export interface ApimOperation {
  id: string;
  name: string;
  displayName: string;
  method: string;
  urlTemplate: string;
  description?: string;
  templateParameters?: ApimParameter[];
  request?: ApimOperationRequest;
  responses?: ApimOperationResponse[];
}

/** Body accepted by upsertOperation — the authorable subset of OperationContract. */
export interface ApimOperationBody {
  displayName: string;
  method: string;
  urlTemplate: string;
  description?: string;
  templateParameters?: ApimParameter[];
  request?: ApimOperationRequest;
  responses?: ApimOperationResponse[];
}

function shapeParameter(raw: any): ApimParameter {
  return {
    name: raw?.name,
    type: raw?.type,
    required: raw?.required,
    description: raw?.description,
    defaultValue: raw?.defaultValue,
    values: raw?.values,
  };
}

function shapeRepresentation(raw: any): ApimRepresentation {
  return {
    contentType: raw?.contentType,
    example: typeof raw?.example === 'string' ? raw.example : (raw?.example != null ? JSON.stringify(raw.example) : undefined),
    schemaId: raw?.schemaId,
    typeName: raw?.typeName,
  };
}

function shapeOperation(raw: any): ApimOperation {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    method: p.method,
    urlTemplate: p.urlTemplate,
    description: p.description,
    templateParameters: Array.isArray(p.templateParameters) ? p.templateParameters.map(shapeParameter) : [],
    request: p.request
      ? {
          description: p.request.description,
          queryParameters: (p.request.queryParameters || []).map(shapeParameter),
          headers: (p.request.headers || []).map(shapeParameter),
          representations: (p.request.representations || []).map(shapeRepresentation),
        }
      : undefined,
    responses: Array.isArray(p.responses)
      ? p.responses.map((r: any) => ({
          statusCode: r.statusCode,
          description: r.description,
          representations: (r.representations || []).map(shapeRepresentation),
          headers: (r.headers || []).map(shapeParameter),
        }))
      : [],
  };
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
    description: r.properties?.description,
  }));
}

/** GET a single operation with its full template/request/response detail. */
export async function getOperation(apiId: string, operationId: string): Promise<ApimOperation | null> {
  const res = await apimFetch(
    `/apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}`,
  );
  const j = await readJson<any>(res);
  return j ? shapeOperation(j) : null;
}

/**
 * Build the ParameterContract / RepresentationContract / RequestContract /
 * ResponseContract[] payload for an operation PUT, dropping empty arrays so we
 * don't transmit noise APIM would reject (e.g. a representation with no
 * contentType). Method is upper-cased — APIM stores GET/POST/… in caps.
 */
function operationProperties(body: ApimOperationBody): any {
  const cleanParams = (params?: ApimParameter[]): ApimParameter[] | undefined => {
    const out = (params || [])
      .filter((p) => p.name && p.name.trim())
      .map((p) => {
        const o: ApimParameter = { name: p.name.trim(), type: p.type || 'string', required: !!p.required };
        if (p.description) o.description = p.description;
        if (p.defaultValue) o.defaultValue = p.defaultValue;
        if (p.values && p.values.length) o.values = p.values;
        return o;
      });
    return out.length ? out : undefined;
  };
  const cleanReps = (reps?: ApimRepresentation[]): ApimRepresentation[] | undefined => {
    const out = (reps || [])
      .filter((r) => r.contentType && r.contentType.trim())
      .map((r) => {
        const o: ApimRepresentation = { contentType: r.contentType.trim() };
        if (r.example) o.example = r.example;
        if (r.schemaId) o.schemaId = r.schemaId;
        if (r.typeName) o.typeName = r.typeName;
        return o;
      });
    return out.length ? out : undefined;
  };

  const properties: any = {
    displayName: body.displayName,
    method: (body.method || 'GET').toUpperCase(),
    urlTemplate: body.urlTemplate || '/',
  };
  if (body.description) properties.description = body.description;

  const tps = cleanParams(body.templateParameters);
  // APIM requires a templateParameter entry for every {token} in urlTemplate.
  properties.templateParameters = tps || [];

  if (body.request) {
    const request: any = {};
    if (body.request.description) request.description = body.request.description;
    const q = cleanParams(body.request.queryParameters);
    const h = cleanParams(body.request.headers);
    const r = cleanReps(body.request.representations);
    if (q) request.queryParameters = q;
    if (h) request.headers = h;
    if (r) request.representations = r;
    if (Object.keys(request).length) properties.request = request;
  }

  const responses = (body.responses || [])
    .filter((r) => Number.isFinite(r.statusCode))
    .map((r) => {
      const o: any = { statusCode: r.statusCode };
      if (r.description) o.description = r.description;
      const reps = cleanReps(r.representations);
      const hdrs = cleanParams(r.headers);
      if (reps) o.representations = reps;
      if (hdrs) o.headers = hdrs;
      return o;
    });
  if (responses.length) properties.responses = responses;

  return properties;
}

/**
 * PUT /apis/{apiId}/operations/{operationId} — create or replace an API
 * operation. Real ARM REST (api-version 2024-06-01-preview), mirroring the
 * portal's API → Design → "+ Add operation" / edit-operation surface.
 *
 * Grounded in Microsoft Learn (OperationContract /
 * OperationUpdateContractProperties): properties = { displayName, method,
 * urlTemplate, description?, templateParameters[], request?, responses[] }.
 */
export async function upsertOperation(
  apiId: string,
  operationId: string,
  body: ApimOperationBody,
): Promise<ApimOperation> {
  const res = await apimFetch(
    `/apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ properties: operationProperties(body) }),
    },
  );
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim operation returned null');
  return shapeOperation(j);
}

/** DELETE /apis/{apiId}/operations/{operationId}. If-Match '*' = any ETag. */
export async function deleteOperation(apiId: string, operationId: string): Promise<void> {
  const res = await apimFetch(
    `/apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}`,
    { method: 'DELETE', headers: { 'If-Match': '*' } },
  );
  if (res.status === 404 || res.ok || res.status === 204) return;
  await readJson<unknown>(res);
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

/**
 * Build the fully-qualified ARM scope string a subscription requires.
 * APIM accepts an absolute ARM id; the portal sends the absolute id, so we
 * mirror that. Scope kinds:
 *   product:{id}  → .../products/{id}
 *   api:{id}      → .../apis/{id}
 *   allApis       → .../apis   (all APIs)
 */
export function subscriptionScope(target: { product?: string; api?: string; allApis?: boolean }): string {
  const base = stripArmBase(apimBase());
  if (target.product) return `${base}/products/${encodeURIComponent(target.product)}`;
  if (target.api) return `${base}/apis/${encodeURIComponent(target.api)}`;
  return `${base}/apis`;
}

export function slugSid(s: string): string {
  const base = s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return base ? `sub-${base}` : `sub-${Date.now()}`;
}

export interface CreateSubscriptionInput {
  /** Subscription entity id (sid). Generated from displayName when omitted. */
  sid?: string;
  displayName: string;
  /** One of product / api / allApis must be provided. */
  product?: string;
  api?: string;
  allApis?: boolean;
  /** /users/{id} relative path; the owner the subscription is created for. */
  ownerId?: string;
  /**
   * Initial state. APIM defaults to 'submitted' (pending approval). A
   * marketplace where the caller is an admin may pass 'active' to auto-grant.
   */
  state?: 'submitted' | 'active';
  allowTracing?: boolean;
}

/**
 * PUT /subscriptions/{sid} — request/create a subscription to a product or API.
 * Mirrors the developer-portal "Subscribe" flow. When the product has
 * approvalRequired=true and the request is created with 'submitted' state, the
 * subscription stays pending until an administrator approves it. Returns the
 * shaped subscription (keys are NOT returned here — use getSubscriptionKeys).
 */
export async function createSubscription(input: CreateSubscriptionInput): Promise<ApimSubscriptionSummary> {
  const sid = input.sid || slugSid(input.displayName);
  const scope = subscriptionScope({ product: input.product, api: input.api, allApis: input.allApis });
  const properties: any = { displayName: input.displayName, scope };
  if (input.ownerId) properties.ownerId = input.ownerId;
  if (input.state) properties.state = input.state;
  if (typeof input.allowTracing === 'boolean') properties.allowTracing = input.allowTracing;
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(sid)}`, {
    method: 'PUT',
    query: { notify: 'true' },
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim subscription returned null');
  return shapeSubscription(j);
}

export async function deleteSubscription(sid: string): Promise<void> {
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(sid)}`, {
    method: 'DELETE',
    headers: { 'If-Match': '*' },
  });
  if (res.status === 404 || res.ok || res.status === 204) return;
  await readJson<unknown>(res);
}

/**
 * PATCH /subscriptions/{sid} — edit a subscription's display name and/or state.
 * State transitions (active ⇄ suspended, → cancelled) mirror the portal's
 * subscription management. Returns the updated subscription.
 */
export async function updateSubscription(
  sid: string,
  patch: { displayName?: string; state?: 'active' | 'suspended' | 'cancelled' },
): Promise<ApimSubscriptionSummary> {
  const properties: any = {};
  if (patch.displayName) properties.displayName = patch.displayName;
  if (patch.state) properties.state = patch.state;
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(sid)}`, {
    method: 'PATCH',
    headers: { 'If-Match': '*' },
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (j) return shapeSubscription(j);
  // PATCH can return 204 No Content — re-read for the updated entity.
  const got = await getSubscription(sid);
  if (got) return got;
  throw new ApimError(res.status, null, 'PATCH apim subscription returned no entity');
}

/**
 * Regenerate a subscription's primary or secondary key.
 *   POST .../subscriptions/{sid}/regeneratePrimaryKey | regenerateSecondaryKey
 * Keys are not returned by this call — re-fetch via getSubscriptionKeys.
 */
export async function regenerateSubscriptionKey(sid: string, which: 'primary' | 'secondary'): Promise<void> {
  const op = which === 'secondary' ? 'regenerateSecondaryKey' : 'regeneratePrimaryKey';
  const res = await apimFetch(`/subscriptions/${encodeURIComponent(sid)}/${op}`, { method: 'POST' });
  if (res.ok || res.status === 204) return;
  await readJson<unknown>(res);
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
  const sourceApiId = `${stripArmBase(apimBase())}/apis/${encodeURIComponent(apiId)}${sourceRev}`;
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
  const fullApiId = `${stripArmBase(apimBase())}/apis/${encodeURIComponent(apiId)};rev=${encodeURIComponent(apiRevision)}`;
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

// ---------------- Named values ----------------

export interface ApimNamedValueSummary {
  id: string;
  name: string;
  displayName: string;
  secret?: boolean;
  /** Present only for non-secret values (GET omits secret values). */
  value?: string;
  tags?: string[];
}

export interface ApimNamedValueBody {
  displayName: string;
  value: string;
  secret?: boolean;
  tags?: string[];
}

function shapeNamedValue(raw: any): ApimNamedValueSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    displayName: p.displayName,
    secret: p.secret,
    value: p.value,          // null on secret GETs — use listSecrets to reveal
    tags: p.tags,
  };
}

export async function listNamedValues(): Promise<ApimNamedValueSummary[]> {
  const res = await apimFetch(`/namedValues`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeNamedValue);
}

export async function getNamedValue(id: string): Promise<ApimNamedValueSummary | null> {
  const res = await apimFetch(`/namedValues/${encodeURIComponent(id)}`);
  const j = await readJson<any>(res);
  return j ? shapeNamedValue(j) : null;
}

/**
 * PUT /namedValues/{id} — create or update a named value (APIM "property").
 * displayName must match ^[A-Za-z0-9-._]+$. When secret=true the value is
 * encrypted at rest and not returned on subsequent GETs.
 */
export async function upsertNamedValue(
  id: string,
  body: ApimNamedValueBody,
): Promise<ApimNamedValueSummary> {
  const properties: any = {
    displayName: body.displayName,
    value: body.value,
    secret: body.secret ?? false,
  };
  if (body.tags && body.tags.length) properties.tags = body.tags;
  const res = await apimFetch(`/namedValues/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim namedValue returned null');
  return shapeNamedValue(j);
}

export async function deleteNamedValue(id: string): Promise<void> {
  // APIM requires an If-Match header for namedValue delete; '*' = any ETag.
  const res = await apimFetch(`/namedValues/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'If-Match': '*' },
  });
  if (res.status === 404 || res.ok || res.status === 204) return;
  await readJson<unknown>(res);
}

/** POST /namedValues/{id}/listValue — reveal a secret named value's plaintext. */
export async function getNamedValueSecret(id: string): Promise<{ value?: string }> {
  const res = await apimFetch(`/namedValues/${encodeURIComponent(id)}/listValue`, { method: 'POST' });
  const j = await readJson<any>(res);
  return { value: j?.value };
}

// ---------------- Backends ----------------

export interface ApimBackendSummary {
  id: string;
  name: string;
  url: string;
  protocol: 'http' | 'soap' | string;
  title?: string;
  description?: string;
  resourceId?: string;
}

export interface ApimBackendBody {
  url: string;
  protocol?: 'http' | 'soap';
  title?: string;
  description?: string;
  resourceId?: string;
}

function shapeBackend(raw: any): ApimBackendSummary {
  const p = raw?.properties || {};
  return {
    id: raw?.id,
    name: raw?.name,
    url: p.url,
    protocol: p.protocol || 'http',
    title: p.title,
    description: p.description,
    resourceId: p.resourceId,
  };
}

export async function listBackends(): Promise<ApimBackendSummary[]> {
  const res = await apimFetch(`/backends`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map(shapeBackend);
}

export async function getBackend(id: string): Promise<ApimBackendSummary | null> {
  const res = await apimFetch(`/backends/${encodeURIComponent(id)}`);
  const j = await readJson<any>(res);
  return j ? shapeBackend(j) : null;
}

/**
 * PUT /backends/{id} — create or update a backend. url + protocol are required
 * for a Single backend; protocol defaults to 'http'.
 */
export async function upsertBackend(
  id: string,
  body: ApimBackendBody,
): Promise<ApimBackendSummary> {
  const properties: any = {
    url: body.url,
    protocol: body.protocol || 'http',
  };
  if (body.title) properties.title = body.title;
  if (body.description) properties.description = body.description;
  if (body.resourceId) properties.resourceId = body.resourceId;
  const res = await apimFetch(`/backends/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ properties }),
  });
  const j = await readJson<any>(res);
  if (!j) throw new ApimError(404, null, 'PUT apim backend returned null');
  return shapeBackend(j);
}

export async function deleteBackend(id: string): Promise<void> {
  const res = await apimFetch(`/backends/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'If-Match': '*' },
  });
  if (res.status === 404 || res.ok || res.status === 204) return;
  await readJson<unknown>(res);
}

// ---------------- Gateways (self-hosted gateways — read-only here) ----------------

export interface ApimGatewaySummary {
  id: string;
  name: string;
  description?: string;
  region?: string;
}

/** GET /gateways — self-hosted gateway registrations. Read-only in the navigator. */
export async function listGateways(): Promise<ApimGatewaySummary[]> {
  const res = await apimFetch(`/gateways`);
  const j = await readJson<{ value: any[] }>(res);
  return (j?.value || []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.properties?.description,
    region: r.properties?.locationData?.name,
  }));
}

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
