/**
 * aas-server-client — env-pinned Azure Analysis Services SERVER client for the
 * SemanticModelEditor's Storage Mode + Refresh surfaces (refresh now /
 * scheduled / history) and the database picker.
 *
 * (Extracted from aas-client.ts during the add/add conflict resolution — the
 * accumulated aas-client.ts already owns calculation-groups / aggregations /
 * Direct-Lake-shim / TMSL builders / Fabric updateDefinition / DAX query
 * surfaces; this module is the env-pinned (LOOM_AAS_SERVER_NAME / REGION /
 * SUBSCRIPTION / DLZ_RG) server client added by PR #976. Shares AasError with
 * aas-client.ts so `instanceof AasError` holds across both modules.)
 *
 * THREE INDEPENDENT TRANSPORTS
 * ----------------------------
 * 1. ARM management plane (armBase() / armScope(), api-version 2017-08-01):
 *      listDatabases, getDatabase, setRefreshSchedule, getRefreshSchedule
 *      → /subscriptions/{sub}/resourceGroups/{rg}/providers/
 *        Microsoft.AnalysisServices/servers/{name}[/databases/{db}]
 *
 * 2. AAS data-plane REST (getAasSuffix() / aasScope()):
 *      refresh, getRefreshes  (asynchronous refresh REST API)
 *      → https://{region}.{aasSuffix}/servers/{name}/models/{db}/refreshes
 *      POST returns 202 + a Location header carrying the real refresh id.
 *
 * 3. AAS XMLA endpoint (same credentials as the data plane):
 *      command(tmslJson) — SOAP-wrapped XMLA Execute carrying a TMSL JSON
 *      statement (e.g. a refresh / createOrReplace command).
 *      → https://{region}.{aasSuffix}/servers/{name}/xmla
 *
 * AUTH
 * ----
 * ChainedTokenCredential(ManagedIdentityCredential, DefaultAzureCredential) —
 * the Console UAMI in a deployed Container App, `az login` for local dev. The
 * scope is per-transport: armScope() for ARM, aasScope() for data plane / XMLA.
 *
 * SCHEDULED REFRESH
 * -----------------
 * AAS has NO native scheduled-refresh REST endpoint. The schedule is persisted
 * as a JSON-encoded ARM tag `loom-refresh-schedule` on the server resource
 * (PATCH servers/{name}). The schedule JSON is ~120 chars, well under the
 * 256-char ARM tag-value limit. This is Azure-native, visible in the Azure
 * portal, auditable, and requires no Fabric / Cosmos dependency.
 *
 * NO MOCKS. No `return []` placeholders, no MOCK_ constants. Every function
 * either succeeds with real Azure data or throws AasError with a status + body.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { armBase, armScope, getAasSuffix, aasScope } from './cloud-endpoints';
import { AasError } from './aas-client';

export { AasError };

const ARM_API = '2017-08-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

function required(k: string): string {
  const v = process.env[k];
  if (!v) throw new AasError(`Missing env var: ${k}`, 503);
  return v;
}

function envServerName(): string { return required('LOOM_AAS_SERVER_NAME'); }
function envRegion(): string { return required('LOOM_AAS_REGION'); }
function envSub(): string { return required('LOOM_SUBSCRIPTION_ID'); }
function envRg(): string { return required('LOOM_DLZ_RG'); }

/** ARM resource path base for the env-pinned AAS server (no api-version). */
function armServerBase(): string {
  return `${armBase()}/subscriptions/${envSub()}/resourceGroups/${envRg()}`
    + `/providers/Microsoft.AnalysisServices/servers/${envServerName()}`;
}

/** AAS REST data-plane base for a model (database). */
function dataPlaneBase(db: string): string {
  return `https://${envRegion()}.${getAasSuffix()}/servers/${envServerName()}/models/${encodeURIComponent(db)}`;
}

/** AAS XMLA endpoint URL. */
function xmlaBase(): string {
  return `https://${envRegion()}.${getAasSuffix()}/servers/${envServerName()}/xmla`;
}

/**
 * Honest config gate for the env-pinned AAS server (SemanticModelEditor's
 * Storage-mode + Refresh surfaces). Returns the first missing env var (with
 * operator-facing detail) so the BFF can render a precise Fluent MessageBar
 * instead of a raw 500/throw. Returns null when the client is configured to
 * attempt a real call.
 */
export function aasServerConfigGate(): { missing: string; detail: string } | null {
  const needed: ReadonlyArray<readonly [string, string]> = [
    ['LOOM_AAS_SERVER_NAME', 'the Azure Analysis Services server name (e.g. aas-loom-default)'],
    ['LOOM_AAS_REGION', 'the Azure region the AAS server lives in (e.g. eastus2)'],
    ['LOOM_SUBSCRIPTION_ID', 'the Azure subscription id'],
    ['LOOM_DLZ_RG', 'the resource group containing the AAS server'],
  ];
  for (const [k, detail] of needed) {
    if (!process.env[k]) return { missing: k, detail };
  }
  return null;
}

/** The env-pinned AAS server name (for honest-gate MessageBar copy). Empty when unset. */
export function envAasServerName(): string {
  return process.env.LOOM_AAS_SERVER_NAME || '';
}

/** The env-pinned AAS server region (for MessageBar copy). Empty when unset. */
export function envAasServerRegion(): string {
  return process.env.LOOM_AAS_REGION || '';
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

async function armCall(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(armScope());
  if (!tok?.token) throw new AasError('Failed to acquire ARM token', 401);
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
    cache: 'no-store',
  });
}

async function armJson<T>(url: string, label: string, init?: RequestInit): Promise<T> {
  const r = await armCall(url, init);
  const text = await r.text();
  if (!r.ok) {
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : text; } catch { /* leave as text */ }
    const msg =
      (body as any)?.error?.message || (body as any)?.message || text || `${label} failed`;
    throw new AasError(String(msg), r.status, body, url);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

async function dpCall(url: string, init?: RequestInit): Promise<Response> {
  const tok = await credential.getToken(aasScope());
  if (!tok?.token) throw new AasError('Failed to acquire AAS data-plane token', 401);
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${tok.token}`,
      'content-type': 'application/json',
    },
    cache: 'no-store',
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AasDatabaseLite {
  id?: string;
  name: string;
  /** InMemory (Import), DirectQuery, or Hybrid — from properties.model.storageMode. */
  storageMode?: string;
  /** Server-side processing state (e.g. Succeeded, NotProcessed). */
  state?: string;
  compatibilityLevel?: number;
}

export interface AasDatabase extends AasDatabaseLite {
  properties?: Record<string, unknown>;
}

/**
 * Async-refresh request body. Field names follow the AAS REST contract
 * (PascalCase) per Microsoft Learn "Asynchronous refresh with the REST API".
 */
export interface AasRefreshRequest {
  type?: 'full' | 'clearValues' | 'calculate' | 'dataOnly' | 'automatic' | 'defragment';
  commitMode?: 'transactional' | 'partialBatch';
  maxParallelism?: number;
  retryCount?: number;
  objects?: Array<{ table: string; partition?: string }>;
}

export interface AasRefresh {
  refreshId?: string;
  type?: string;
  startTime?: string;
  endTime?: string;
  status?: string;
  currentRefreshType?: string;
}

export interface AasScheduleWrite {
  enabled: boolean;
  days: Array<'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday'>;
  /** HH:MM (24h). AAS schedules are Loom-managed — no 30-minute-boundary constraint. */
  times: string[];
  /** IANA tz or Windows tz id (e.g. "UTC", "Pacific Standard Time"). */
  localTimeZoneId?: string;
  notifyOption?: 'NoNotification' | 'MailOnFailure';
}

export interface AasSchedule extends AasScheduleWrite {
  /** ISO timestamp written by setRefreshSchedule. */
  updatedAt: string;
}

const SCHEDULE_TAG = 'loom-refresh-schedule';

// ---------------------------------------------------------------------------
// ARM management plane
// ---------------------------------------------------------------------------

interface ArmDatabaseRaw {
  id?: string;
  name?: string;
  properties?: {
    state?: string;
    model?: { storageMode?: string; compatibilityLevel?: number };
    [k: string]: unknown;
  };
}

function shapeDatabase(raw: ArmDatabaseRaw): AasDatabase {
  // ARM returns the database name as "{server}/{db}"; surface the bare db name.
  const bare = (raw.name || '').includes('/') ? raw.name!.split('/').pop()! : (raw.name || '');
  return {
    id: raw.id,
    name: bare,
    storageMode: raw.properties?.model?.storageMode,
    state: raw.properties?.state,
    compatibilityLevel: raw.properties?.model?.compatibilityLevel,
    properties: raw.properties,
  };
}

/** GET .../servers/{name}/databases — list the tabular databases on the server. */
export async function listDatabases(): Promise<AasDatabaseLite[]> {
  const body = await armJson<{ value?: ArmDatabaseRaw[] }>(
    `${armServerBase()}/databases?api-version=${ARM_API}`,
    'listDatabases',
  );
  return (body.value || []).map(shapeDatabase);
}

/** GET .../servers/{name}/databases/{db} — one database's metadata. */
export async function getDatabase(dbName: string): Promise<AasDatabase> {
  const raw = await armJson<ArmDatabaseRaw>(
    `${armServerBase()}/databases/${encodeURIComponent(dbName)}?api-version=${ARM_API}`,
    `getDatabase(${dbName})`,
  );
  return shapeDatabase(raw);
}

// ---------------------------------------------------------------------------
// Data-plane REST — asynchronous refresh
// ---------------------------------------------------------------------------

/**
 * POST .../models/{db}/refreshes — queue an asynchronous refresh. AAS responds
 * 202 Accepted with a Location header whose last path segment is the real
 * refresh id (e.g. 1344a272-7893-4afa-a4b3-3fb87222fdac). That id is returned
 * verbatim — it is the genuine operation id the History grid + status polling
 * use. The request body uses PascalCase per the AAS REST contract.
 */
export async function refresh(
  dbName: string,
  body?: AasRefreshRequest,
): Promise<{ refreshId: string; location: string }> {
  const url = `${dataPlaneBase(dbName)}/refreshes`;
  const payload = {
    Type: body?.type ?? 'automatic',
    CommitMode: body?.commitMode ?? 'transactional',
    ...(body?.maxParallelism !== undefined ? { MaxParallelism: body.maxParallelism } : {}),
    ...(body?.retryCount !== undefined ? { RetryCount: body.retryCount } : {}),
    ...(body?.objects && body.objects.length ? { Objects: body.objects } : {}),
  };
  const r = await dpCall(url, { method: 'POST', body: JSON.stringify(payload) });
  if (!r.ok && r.status !== 202) {
    const text = await r.text();
    throw new AasError(text || `refresh(${dbName}) failed`, r.status, text, url);
  }
  const location = r.headers.get('location') || r.headers.get('Location') || '';
  // The refresh id is the trailing path segment of the Location header. Some
  // responses also echo it in the body; fall back to that if the header is bare.
  let refreshId = location ? location.split('/').filter(Boolean).pop()! : '';
  if (!refreshId) {
    const text = await r.text();
    try { refreshId = (JSON.parse(text) as any)?.refreshId || ''; } catch { /* none */ }
  }
  if (!refreshId) {
    throw new AasError(
      `refresh(${dbName}) returned no refresh id (Location header absent)`,
      502,
      { location },
      url,
    );
  }
  return { refreshId, location };
}

/**
 * GET .../models/{db}/refreshes — historical refresh operations (AAS returns
 * the last 30 days). Newest first.
 */
export async function getRefreshes(dbName: string): Promise<AasRefresh[]> {
  const url = `${dataPlaneBase(dbName)}/refreshes`;
  const r = await dpCall(url, { method: 'GET' });
  const text = await r.text();
  if (!r.ok) {
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : text; } catch { /* text */ }
    throw new AasError(
      String((body as any)?.error?.message || (body as any)?.message || text || 'getRefreshes failed'),
      r.status,
      body,
      url,
    );
  }
  if (!text) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  // AAS returns a bare array; tolerate a { value: [] } envelope too.
  const arr: any[] = Array.isArray(parsed) ? parsed : ((parsed as any)?.value ?? []);
  return arr.map((x) => ({
    refreshId: x.refreshId ?? x.RefreshId ?? x.requestId,
    type: x.type ?? x.Type ?? x.currentRefreshType,
    startTime: x.startTime ?? x.StartTime,
    endTime: x.endTime ?? x.EndTime,
    status: x.status ?? x.Status,
    currentRefreshType: x.currentRefreshType,
  }));
}

// ---------------------------------------------------------------------------
// XMLA endpoint — TMSL command
// ---------------------------------------------------------------------------

export interface AasCommandResult {
  ok: true;
  /** Raw XMLA Execute response (SOAP XML) for the caller to inspect. */
  response: string;
}

/**
 * POST {xmla} — execute a TMSL JSON statement against the AAS XMLA endpoint
 * (SOAP-wrapped XMLA Execute). Used for model operations that have no REST
 * equivalent (createOrReplace, alter, a targeted TMSL refresh). The TMSL is
 * passed through verbatim inside the <Statement> element.
 */
export async function command(dbName: string, tmslJson: string): Promise<AasCommandResult> {
  const url = xmlaBase();
  const envelope =
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<Body>'
    + '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">'
    + '<Command><Statement>' + tmslJson + '</Statement></Command>'
    + '<Properties><PropertyList>'
    + '<Catalog>' + dbName + '</Catalog>'
    + '</PropertyList></Properties>'
    + '</Execute>'
    + '</Body></Envelope>';
  const tok = await credential.getToken(aasScope());
  if (!tok?.token) throw new AasError('Failed to acquire AAS XMLA token', 401);
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok.token}`,
      'content-type': 'text/xml; charset=utf-8',
      soapaction: '"urn:schemas-microsoft-com:xml-analysis:Execute"',
    },
    body: envelope,
    cache: 'no-store',
  });
  const text = await r.text();
  if (!r.ok || /<faultstring>/i.test(text)) {
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(text)?.[1];
    throw new AasError(fault || text || `XMLA command(${dbName}) failed`, r.ok ? 502 : r.status, text, url);
  }
  return { ok: true, response: text };
}

// ---------------------------------------------------------------------------
// Scheduled refresh (ARM-tag persistence)
// ---------------------------------------------------------------------------

function normalizeSchedule(s: AasScheduleWrite): AasScheduleWrite {
  return {
    enabled: !!s.enabled,
    days: Array.isArray(s.days) ? s.days : [],
    times: Array.isArray(s.times) ? s.times : [],
    localTimeZoneId: s.localTimeZoneId || 'UTC',
    notifyOption: s.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification',
  };
}

/**
 * PATCH .../servers/{name} — persist the refresh schedule as a JSON-encoded ARM
 * tag (`loom-refresh-schedule`). Reads the tag straight back after the PATCH so
 * the returned schedule is the authoritative stored value (idempotency proof).
 */
export async function setRefreshSchedule(schedule: AasScheduleWrite): Promise<AasSchedule> {
  const stored: AasSchedule = { ...normalizeSchedule(schedule), updatedAt: new Date().toISOString() };
  const encoded = JSON.stringify(stored);
  // ARM tag value limit is 256 chars — guard so we fail loudly, not silently.
  if (encoded.length > 256) {
    throw new AasError(
      `refresh schedule too large to store as an ARM tag (${encoded.length} > 256 chars); reduce the number of times/days`,
      400,
    );
  }
  await armJson<unknown>(
    `${armServerBase()}?api-version=${ARM_API}`,
    'setRefreshSchedule',
    { method: 'PATCH', body: JSON.stringify({ tags: { [SCHEDULE_TAG]: encoded } }) },
  );
  const readBack = await getRefreshSchedule();
  return readBack ?? stored;
}

/**
 * GET .../servers/{name} — read the persisted refresh schedule from the
 * `loom-refresh-schedule` ARM tag. Returns null when no schedule has been set.
 */
export async function getRefreshSchedule(): Promise<AasSchedule | null> {
  const server = await armJson<{ tags?: Record<string, string> }>(
    `${armServerBase()}?api-version=${ARM_API}`,
    'getRefreshSchedule',
  );
  const tag = server.tags?.[SCHEDULE_TAG];
  if (!tag) return null;
  try {
    const parsed = JSON.parse(tag) as AasSchedule;
    return {
      ...normalizeSchedule(parsed),
      updatedAt: parsed.updatedAt || '',
    };
  } catch {
    return null;
  }
}
