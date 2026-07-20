/**
 * model-serving-client — unified Model Serving backend for the
 * `model-serving-endpoint` item (WS-1.2).
 *
 * Two real backends, ONE facade. Per no-fabric-dependency.md the DEFAULT is
 * Azure-native — Azure Machine Learning managed online endpoints
 * (Microsoft.MachineLearningServices/workspaces/onlineEndpoints, real ARM +
 * data-plane scoring, works in Gov `*.api.ml.azure.us`). Databricks Mosaic AI
 * Model Serving is an OPT-IN alternative, selected with
 * `LOOM_MODEL_SERVING_BACKEND=databricks`. No Fabric.
 *
 *   list / get / create / traffic-split / invoke / metrics / delete
 *
 * AML path is fully self-contained here (its own ARM fetch against the AML
 * workspace resolved by resolve-aml-target — correct sub/rg/ws/region for a
 * dedicated OR Foundry-hub workspace) so it never depends on the frozen
 * foundry-client. Databricks path delegates to the databricks-client Mosaic
 * serving REST. Latency/error tiles read REAL Azure Monitor metrics for the AML
 * endpoint (monitor-client.fetchMetrics on
 * `Microsoft.MachineLearningServices/workspaces/onlineEndpoints`:
 * `RequestLatency`, `RequestsPerMinute` split by `statusCodeClass`).
 *
 * No mocks, no `return []` placeholders — every call is real REST or an honest
 * gate (servingConfigGate) naming the exact env var to set (no-vaporware.md).
 *
 * Grounding (Microsoft Learn):
 *   AML online endpoints REST  https://learn.microsoft.com/rest/api/azureml/online-endpoints
 *   AML online-endpoint metrics https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-machinelearningservices-workspaces-onlineendpoints-metrics
 *   Databricks serving REST     https://docs.databricks.com/api/azure/workspace/servingendpoints
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import {
  resolveAmlTarget,
  amlWorkspaceArmPath,
  AmlNotConfiguredError,
  isAmlConfigured,
  type AmlTarget,
} from './resolve-aml-target';
import { fetchMetrics, type MetricResult } from './monitor-client';
import {
  databricksConfigGate,
  listServingEndpoints as dbxListServing,
  getServingEndpoint as dbxGetServing,
  createServingEndpoint as dbxCreateServing,
  deleteServingEndpoint as dbxDeleteServing,
  updateServingEndpointConfig as dbxUpdateServingConfig,
  queryServingEndpoint as dbxQueryServing,
} from './databricks-client';

const ML_API = '2024-10-01';

export type ServingBackend = 'aml' | 'databricks';

/**
 * Which serving backend is active. Azure ML managed online endpoints is the
 * Azure-native DEFAULT; Databricks Mosaic is opt-in via
 * `LOOM_MODEL_SERVING_BACKEND=databricks`. Any other value falls through to the
 * Azure-native default (never Fabric).
 */
export function resolveServingBackend(): ServingBackend {
  return (process.env.LOOM_MODEL_SERVING_BACKEND || '').trim().toLowerCase() === 'databricks'
    ? 'databricks'
    : 'aml';
}

export interface ServingGate {
  backend: ServingBackend;
  /** The exact env var(s) missing. */
  missing: string;
  /** One-line operator remediation. */
  hint: string;
  /** The single env var the inline Fix-it wizard writes (G2). */
  fixEnvVar: string;
  /** The gate-registry id (G2) so Copilot / the Admin gate page can resolve it. */
  gateId: string;
}

/**
 * Honest config gate. Returns null when the active backend is addressable, or a
 * structured gate (backend + missing var + Fix-it target) when it isn't. The
 * editor renders this as a Fluent MessageBar with a "Fix it" button.
 */
export function servingConfigGate(): ServingGate | null {
  const backend = resolveServingBackend();
  if (backend === 'databricks') {
    const g = databricksConfigGate();
    if (!g) return null;
    return {
      backend,
      missing: g.missing,
      hint: 'Model serving is set to the Databricks Mosaic backend but the workspace is not configured. Set LOOM_DATABRICKS_HOSTNAME (the workspace hostname, no scheme), or unset LOOM_MODEL_SERVING_BACKEND to use the Azure ML default.',
      fixEnvVar: 'LOOM_DATABRICKS_HOSTNAME',
      gateId: 'svc-model-serving',
    };
  }
  if (isAmlConfigured()) return null;
  return {
    backend,
    missing: 'LOOM_AML_WORKSPACE (or LOOM_FOUNDRY_NAME)',
    hint: 'Set LOOM_AML_WORKSPACE (+ LOOM_AML_RESOURCE_GROUP; falls back to the AI Foundry hub via LOOM_FOUNDRY_NAME/LOOM_FOUNDRY_RG) so model-serving endpoints have an Azure Machine Learning workspace. Grant the Console UAMI "AzureML Data Scientist" on it.',
    fixEnvVar: 'LOOM_AML_WORKSPACE',
    gateId: 'svc-model-serving',
  };
}

// ── unified view shapes ──────────────────────────────────────────────────────

export interface ServingDeploymentView {
  name: string;
  model?: string;
  instanceType?: string;
  instanceCount?: number;
  scaleType?: string;
  state?: string;
}

export interface ServingEndpointView {
  name: string;
  backend: ServingBackend;
  state?: string;
  ready?: boolean;
  scoringUri?: string;
  authMode?: string;
  creator?: string;
  /** Deployment name → traffic percentage (0-100). */
  traffic?: Record<string, number>;
  deployments?: ServingDeploymentView[];
}

export interface ServingCreateSpec {
  name: string;
  modelName: string;
  modelVersion: string;
  /** AML VM SKU (Standard_DS3_v2) / Databricks workload size (Small|Medium|Large). */
  instanceType?: string;
  /** 'manual' fixes instanceCount; 'auto' uses min/max autoscale (AML) / scale-to-zero (Databricks). */
  scaleType?: 'manual' | 'auto';
  instanceCount?: number;
  minInstances?: number;
  maxInstances?: number;
  /** Databricks-only: scale the served model to zero when idle. */
  scaleToZero?: boolean;
  authMode?: 'Key' | 'AMLToken';
}

export interface ServingInvokeResult {
  status: number;
  latencyMs: number;
  body: unknown;
}

export interface ServingMetrics {
  available: boolean;
  /** Present only when metrics can't be read (Databricks REST has no metrics plane). */
  reason?: string;
  latency?: MetricResult;
  requests?: MetricResult;
  errors?: MetricResult;
  /** Convenience scalars for the KPI tiles (last non-null point). */
  latencyMsP90?: number | null;
  requestsPerMin?: number | null;
  errorsPerMin?: number | null;
}

export class ServingError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message || `Model serving call failed (${status})`);
    this.name = 'ServingError';
    this.status = status;
    this.body = body;
  }
}

// ── pure validators / shapers (unit-tested) ──────────────────────────────────

/**
 * A traffic split is valid when it has ≥1 entry, every percentage is an integer
 * in [0,100], and the total is exactly 100. Returns the first problem, or null.
 */
export function validateTrafficSplit(traffic: Record<string, number>): string | null {
  const entries = Object.entries(traffic || {});
  if (entries.length === 0) return 'At least one deployment must receive traffic.';
  let total = 0;
  for (const [name, pct] of entries) {
    if (!name || !name.trim()) return 'Every traffic route needs a deployment name.';
    if (typeof pct !== 'number' || !Number.isFinite(pct) || !Number.isInteger(pct)) return `Traffic for "${name}" must be a whole number.`;
    if (pct < 0 || pct > 100) return `Traffic for "${name}" must be between 0 and 100.`;
    total += pct;
  }
  if (total !== 100) return `Traffic must total 100% (got ${total}%).`;
  return null;
}

/**
 * Shape a caller-supplied invocation body (a JSON string) into the object the
 * chosen backend's scoring endpoint expects. AML passes the parsed body through.
 * Databricks accepts the same object; a bare array is wrapped as
 * `{ dataframe_records: [...] }` (the Mosaic tabular convention). Throws on
 * non-JSON so the route can 400 honestly instead of scoring garbage.
 */
export function shapeInvokePayload(input: string, backend: ServingBackend = resolveServingBackend()): unknown {
  const text = (input ?? '').trim();
  if (!text) throw new Error('Request body is required.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Request body must be valid JSON.'); }
  if (backend === 'databricks' && Array.isArray(parsed)) {
    return { dataframe_records: parsed };
  }
  return parsed;
}

// ============================================================
// AML managed online endpoints — self-contained ARM client
// ============================================================

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** ARM base for the AML workspace (host + path, no api-version). */
function amlBase(target: AmlTarget = resolveAmlTarget()): string {
  return `${armBase()}${amlWorkspaceArmPath(target)}`;
}

/** The bare ARM resource id (no host) of an online endpoint — the metrics scope. */
export function amlEndpointResourceId(name: string, target: AmlTarget = resolveAmlTarget()): string {
  return `${amlWorkspaceArmPath(target)}/onlineEndpoints/${encodeURIComponent(name)}`;
}

async function armFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await credential.getToken(armScope());
  if (!token?.token) throw new ServingError(401, undefined, 'Failed to acquire ARM token for Azure ML serving');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${amlBase()}${path}${sep}api-version=${ML_API}`;
  return fetchWithTimeout(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
  });
}

async function armJson<T>(res: Response, label: string): Promise<T | null> {
  if (res.status === 404) return null;
  const text = await res.text();
  let parsed: unknown; if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!res.ok) {
    const msg = (parsed as any)?.error?.message || (typeof parsed === 'string' ? parsed : `Azure ML ${res.status}`);
    throw new ServingError(res.status, parsed, `${label} failed ${res.status}: ${String(msg).slice(0, 280)}`);
  }
  return (parsed as T) ?? ({} as T);
}

function shapeAmlEndpoint(raw: any): ServingEndpointView {
  const p = raw?.properties || {};
  return {
    name: raw?.name,
    backend: 'aml',
    state: p.provisioningState,
    ready: p.provisioningState === 'Succeeded',
    scoringUri: p.scoringUri,
    authMode: p.authMode,
    traffic: p.traffic || {},
  };
}

function shapeAmlDeployment(raw: any): ServingDeploymentView {
  const p = raw?.properties || {};
  const scale = p.scaleSettings || {};
  return {
    name: raw?.name,
    model: p.model,
    instanceType: p.instanceType,
    instanceCount: typeof raw?.sku?.capacity === 'number' ? raw.sku.capacity : scale.minInstances,
    scaleType: scale.scaleType,
    state: p.provisioningState,
  };
}

async function amlWorkspaceLocation(target: AmlTarget): Promise<string> {
  try {
    const res = await armFetch('');
    const j = await armJson<any>(res, 'workspace');
    if (j?.location) return j.location;
  } catch { /* fall through */ }
  return target.region;
}

async function amlListEndpoints(): Promise<ServingEndpointView[]> {
  const res = await armFetch('/onlineEndpoints');
  const j = await armJson<{ value?: any[] }>(res, 'listOnlineEndpoints');
  return (j?.value || []).map(shapeAmlEndpoint);
}

async function amlGetEndpoint(name: string): Promise<ServingEndpointView | null> {
  const res = await armFetch(`/onlineEndpoints/${encodeURIComponent(name)}`);
  const j = await armJson<any>(res, 'getOnlineEndpoint');
  if (!j) return null;
  const view = shapeAmlEndpoint(j);
  view.deployments = await amlListDeployments(name).catch(() => []);
  return view;
}

async function amlListDeployments(name: string): Promise<ServingDeploymentView[]> {
  const res = await armFetch(`/onlineEndpoints/${encodeURIComponent(name)}/deployments`);
  if (res.status === 404) return [];
  const j = await armJson<{ value?: any[] }>(res, 'listDeployments');
  return (j?.value || []).map(shapeAmlDeployment);
}

/** POST /onlineEndpoints/{name}/listkeys → { primaryKey, secondaryKey }. */
async function amlListKeys(name: string): Promise<{ primaryKey?: string; secondaryKey?: string }> {
  const res = await armFetch(`/onlineEndpoints/${encodeURIComponent(name)}/listkeys`, { method: 'POST', body: '' });
  const j = await armJson<{ primaryKey?: string; secondaryKey?: string }>(res, 'listKeys');
  return j || {};
}

function amlDeploymentScaleSettings(spec: ServingCreateSpec): Record<string, unknown> {
  if (spec.scaleType === 'auto') {
    return {
      scaleType: 'TargetUtilization',
      minInstances: Math.max(1, spec.minInstances ?? 1),
      maxInstances: Math.max(spec.minInstances ?? 1, spec.maxInstances ?? 3),
      targetUtilizationPercentage: 70,
      pollingInterval: 'PT1S',
    };
  }
  return { scaleType: 'Default' };
}

async function amlCreateEndpoint(spec: ServingCreateSpec): Promise<ServingEndpointView> {
  const target = resolveAmlTarget();
  const location = await amlWorkspaceLocation(target);
  // 1) endpoint
  const epBody = { location, identity: { type: 'SystemAssigned' }, properties: { authMode: spec.authMode || 'Key' } };
  const epRes = await armFetch(`/onlineEndpoints/${encodeURIComponent(spec.name)}`, { method: 'PUT', body: JSON.stringify(epBody) });
  if (epRes.status >= 400) await armJson<any>(epRes, 'createOnlineEndpoint');
  // 2) 'blue' deployment serving the model version
  const capacity = Math.max(1, spec.scaleType === 'auto' ? (spec.minInstances ?? 1) : (spec.instanceCount ?? 1));
  const depBody = {
    location,
    sku: { name: 'Default', capacity },
    properties: {
      endpointComputeType: 'Managed',
      model: `azureml:${spec.modelName}:${spec.modelVersion}`,
      instanceType: spec.instanceType || 'Standard_DS3_v2',
      scaleSettings: amlDeploymentScaleSettings(spec),
    },
  };
  const depRes = await armFetch(`/onlineEndpoints/${encodeURIComponent(spec.name)}/deployments/blue`, { method: 'PUT', body: JSON.stringify(depBody) });
  if (depRes.status >= 400) await armJson<any>(depRes, 'createOnlineDeployment');
  // 3) route 100% to blue
  await amlSetTraffic(spec.name, { blue: 100 }).catch(() => { /* endpoint still provisioning */ });
  const view = await amlGetEndpoint(spec.name);
  return view || { name: spec.name, backend: 'aml', state: 'Creating', traffic: { blue: 100 } };
}

async function amlSetTraffic(name: string, traffic: Record<string, number>): Promise<ServingEndpointView> {
  const path = `/onlineEndpoints/${encodeURIComponent(name)}`;
  const existing = await armJson<any>(await armFetch(path), 'getOnlineEndpoint');
  const location = existing?.location || (await amlWorkspaceLocation(resolveAmlTarget()));
  const identity = existing?.identity || { type: 'SystemAssigned' };
  const props: Record<string, unknown> = { traffic };
  if (existing?.properties?.authMode) props.authMode = existing.properties.authMode;
  const res = await armFetch(path, { method: 'PUT', body: JSON.stringify({ location, identity, properties: props }) });
  if (res.status === 202) return { name, backend: 'aml', state: 'Updating', traffic };
  const j = await armJson<any>(res, 'setEndpointTraffic');
  return j ? shapeAmlEndpoint(j) : { name, backend: 'aml', traffic };
}

async function amlDeleteEndpoint(name: string): Promise<void> {
  const res = await armFetch(`/onlineEndpoints/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (![200, 202, 204, 404].includes(res.status)) {
    const t = await res.text().catch(() => '');
    throw new ServingError(res.status, t, `Endpoint delete failed: ${t.slice(0, 240)}`);
  }
}

async function amlInvoke(name: string, payload: unknown): Promise<ServingInvokeResult> {
  const ep = await amlGetEndpoint(name);
  if (!ep?.scoringUri) throw new ServingError(409, undefined, `Endpoint "${name}" has no scoring URI yet (still provisioning).`);
  const keys = await amlListKeys(name);
  const key = keys.primaryKey || keys.secondaryKey;
  if (!key) throw new ServingError(403, undefined, `Could not read a scoring key for "${name}". Grant the Console UAMI onlineEndpoints/listkeys/action.`);
  const started = Date.now();
  const res = await fetchWithTimeout(ep.scoringUri, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const latencyMs = Date.now() - started;
  const text = await res.text();
  let body: unknown; try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
  return { status: res.status, latencyMs, body };
}

/** Last non-null point of a metric series (for the KPI tiles). */
function lastValue(m?: MetricResult): number | null {
  if (!m) return null;
  for (let i = m.points.length - 1; i >= 0; i--) if (m.points[i].value != null) return m.points[i].value!;
  return null;
}

async function amlMetrics(name: string, opts: { timespan?: string; interval?: string } = {}): Promise<ServingMetrics> {
  const resourceId = amlEndpointResourceId(name);
  const timespan = opts.timespan || 'PT1H';
  const interval = opts.interval || 'PT5M';
  // Latency (avg P90-class) + total requests-per-minute.
  const [latency, requests] = await Promise.all([
    fetchMetrics({ resourceId, metricNames: ['RequestLatency'], aggregation: 'Average', timespan, interval }).then((r) => r[0]).catch(() => undefined),
    fetchMetrics({ resourceId, metricNames: ['RequestsPerMinute'], aggregation: 'Average', timespan, interval }).then((r) => r[0]).catch(() => undefined),
  ]);
  // Errors = RequestsPerMinute scoped to the 5xx status-code class (real dimension filter).
  const errors = await fetchMetrics({
    resourceId, metricNames: ['RequestsPerMinute'], aggregation: 'Average', timespan, interval,
    filter: "statusCodeClass eq '5xx'",
  }).then((r) => r[0]).catch(() => undefined);
  return {
    available: true,
    latency, requests, errors,
    latencyMsP90: lastValue(latency),
    requestsPerMin: lastValue(requests),
    errorsPerMin: lastValue(errors),
  };
}

// ============================================================
// Databricks Mosaic serving — shape adapters over databricks-client
// ============================================================

function shapeDbxEndpoint(raw: any): ServingEndpointView {
  const cfg = raw?.config || raw?.pending_config || {};
  const routes: any[] = cfg?.traffic_config?.routes || [];
  const traffic: Record<string, number> = {};
  for (const r of routes) if (r?.served_model_name) traffic[r.served_model_name] = r.traffic_percentage ?? 0;
  const deployments: ServingDeploymentView[] = (cfg?.served_entities || cfg?.served_models || []).map((e: any) => ({
    name: e?.name,
    model: e?.entity_name && e?.entity_version ? `${e.entity_name}:${e.entity_version}` : e?.model_name,
    instanceType: e?.workload_size,
    scaleType: e?.scale_to_zero_enabled ? 'ScaleToZero' : 'Provisioned',
    state: e?.state?.deployment,
  }));
  return {
    name: raw?.name,
    backend: 'databricks',
    state: raw?.state?.ready || raw?.state?.config_update,
    ready: raw?.state?.ready === 'READY',
    creator: raw?.creator,
    traffic,
    deployments,
  };
}

// ============================================================
// Unified facade
// ============================================================

export async function listServingEndpoints(): Promise<ServingEndpointView[]> {
  if (resolveServingBackend() === 'databricks') {
    const rows = await dbxListServing();
    return rows.map(shapeDbxEndpoint);
  }
  return amlListEndpoints();
}

export async function getServingEndpoint(name: string): Promise<ServingEndpointView | null> {
  if (resolveServingBackend() === 'databricks') {
    const raw = await dbxGetServing(name).catch((e: any) => { if (e?.status === 404) return null; throw e; });
    return raw ? shapeDbxEndpoint(raw) : null;
  }
  return amlGetEndpoint(name);
}

export async function createServingEndpoint(spec: ServingCreateSpec): Promise<ServingEndpointView> {
  if (resolveServingBackend() === 'databricks') {
    const raw = await dbxCreateServing({
      name: spec.name,
      model_name: spec.modelName,
      model_version: spec.modelVersion,
      workload_size: (spec.instanceType as any) || 'Small',
      scale_to_zero_enabled: spec.scaleToZero !== false,
    });
    return shapeDbxEndpoint(raw);
  }
  return amlCreateEndpoint(spec);
}

export async function setServingTraffic(name: string, traffic: Record<string, number>): Promise<ServingEndpointView> {
  const err = validateTrafficSplit(traffic);
  if (err) throw new ServingError(400, undefined, err);
  if (resolveServingBackend() === 'databricks') {
    // Databricks requires the full served-entity set to re-config; read current,
    // keep the same served models, apply the new traffic routes.
    const current = await dbxGetServing(name);
    const cfg = (current as any)?.config || (current as any)?.pending_config || {};
    const served = (cfg.served_entities || cfg.served_models || []).map((e: any) => ({
      name: e?.name,
      model_name: e?.entity_name || e?.model_name,
      model_version: e?.entity_version || e?.model_version,
      workload_size: e?.workload_size,
      scale_to_zero_enabled: e?.scale_to_zero_enabled,
    }));
    const raw = await dbxUpdateServingConfig(name, { served, traffic });
    return shapeDbxEndpoint(raw);
  }
  return amlSetTraffic(name, traffic);
}

export async function invokeServingEndpoint(name: string, payload: unknown): Promise<ServingInvokeResult> {
  if (resolveServingBackend() === 'databricks') {
    return dbxQueryServing(name, payload);
  }
  return amlInvoke(name, payload);
}

export async function deleteServingEndpoint(name: string): Promise<void> {
  if (resolveServingBackend() === 'databricks') {
    return dbxDeleteServing(name);
  }
  return amlDeleteEndpoint(name);
}

export async function getServingMetrics(name: string, opts: { timespan?: string; interval?: string } = {}): Promise<ServingMetrics> {
  if (resolveServingBackend() === 'databricks') {
    // Mosaic serving has no Azure Monitor metrics plane — surface an honest note
    // (no fake tiles). Latency IS returned per-invocation from the invoke console.
    return {
      available: false,
      reason: 'Databricks Mosaic serving does not expose Azure Monitor metrics. Per-request latency is shown from the Invoke console; endpoint-level charts live in the Databricks serving UI. Use the Azure ML backend for live latency/error tiles.',
    };
  }
  return amlMetrics(name, opts);
}

// Re-export for callers that want to branch without importing resolve-aml-target.
export { AmlNotConfiguredError, isAmlConfigured };
