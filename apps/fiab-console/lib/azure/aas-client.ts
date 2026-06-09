/**
 * Azure Analysis Services XMLA + async-refresh REST client.
 *
 * Backs the semantic-model "Incremental refresh" surface (hybrid tables +
 * enhanced refresh). AAS is an Azure-native PaaS — NOT Microsoft Fabric — so it
 * is an allowed OPT-IN backend per no-fabric-dependency.md: the semantic model's
 * default backend stays `loom-native`; this client is only reached when the
 * operator sets LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_XMLA_ENDPOINT.
 *
 * Two surface areas backed by the same credential + env:
 *
 *  1. XMLA endpoint (SOAP/TMSL) — used to SET refresh policies (TMSL Alter),
 *     APPLY them (TMSL Refresh with applyRefreshPolicy:true) and DISCOVER the
 *     resulting partition schema (TMSCHEMA_PARTITIONS). Endpoint:
 *       {LOOM_AAS_XMLA_ENDPOINT}/xmla
 *     Content-Type: text/xml (SOAP envelope wrapping a TMSL JSON Statement).
 *
 *  2. Async-refresh REST endpoint — same param shape as the Power BI enhanced
 *     refresh API (commitMode / applyRefreshPolicy / effectiveDate / objects).
 *     Endpoint: {LOOM_AAS_XMLA_ENDPOINT}/refreshes  (Content-Type: application/json)
 *
 * Auth: ChainedTokenCredential(UAMI, DefaultAzureCredential).
 * Scope: aasXmlaScope() — analysis.windows.net (Commercial/GCC) vs
 *        analysis.usgovcloudapi.net (GCC-High / IL5 / DoD).
 *
 * Required env:
 *   LOOM_AAS_XMLA_ENDPOINT — base URL up to and including the model/db segment,
 *     e.g. https://eastus2.asazure.windows.net/servers/loom-aas/models/FiabModel
 *   LOOM_AAS_DATABASE — model (database) name for the XMLA Catalog property.
 *     Defaults to the last path segment of LOOM_AAS_XMLA_ENDPOINT when unset.
 *
 * No mocks. All calls hit real AAS; errors surface verbatim so the BFF can render
 * a precise MessageBar.
 *
 * Docs:
 *   TMSL Alter:    https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 *   Async refresh: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 *   Incremental refresh + real-time data via XMLA:
 *                  https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-xmla
 */
import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { aasXmlaScope } from './cloud-endpoints';

export class AasError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Resolves the XMLA base URL (no trailing slash). Throws if unset. */
function xmlaBase(): string {
  const ep = process.env.LOOM_AAS_XMLA_ENDPOINT;
  if (!ep) throw new AasError('LOOM_AAS_XMLA_ENDPOINT is not set', 503);
  return ep.replace(/\/+$/, '');
}

/** Derives the catalog/database name. Falls back to the last segment of the base URL. */
function catalog(): string {
  const explicit = process.env.LOOM_AAS_DATABASE;
  if (explicit) return explicit;
  const base = process.env.LOOM_AAS_XMLA_ENDPOINT || '';
  return base.replace(/\/+$/, '').split('/').pop() || '';
}

/**
 * Returns `{ missing }` naming the env var that must be set, or null when the
 * AAS backend is configured. The BFF turns a non-null result into an honest
 * `intent="warning"` MessageBar (no fabricated success).
 */
export function aasConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_AAS_XMLA_ENDPOINT) return { missing: 'LOOM_AAS_XMLA_ENDPOINT' };
  return null;
}

async function token(): Promise<string> {
  const t = await credential.getToken(aasXmlaScope());
  if (!t?.token) throw new AasError('Failed to acquire AAS token', 401);
  return t.token;
}

// ============================================================
// XMLA SOAP helpers
// ============================================================

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Build an XMLA Execute SOAP envelope wrapping a TMSL JSON command. */
function soapExecute(tmslJson: object, dbName: string): string {
  const statement = xmlEscape(JSON.stringify(tmslJson));
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>` +
    `<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">` +
    `<Command><Statement>${statement}</Statement></Command>` +
    `<Properties><PropertyList><Catalog>${xmlEscape(dbName)}</Catalog></PropertyList></Properties>` +
    `</Execute>` +
    `</soap:Body></soap:Envelope>`
  );
}

/** Build an XMLA Discover SOAP envelope (e.g. TMSCHEMA_PARTITIONS). */
function soapDiscover(
  requestType: string,
  dbName: string,
  restrictions: Record<string, string> = {},
): string {
  const restrXml = Object.entries(restrictions)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>` +
    `<Discover xmlns="urn:schemas-microsoft-com:xml-analysis">` +
    `<RequestType>${xmlEscape(requestType)}</RequestType>` +
    `<Restrictions><RestrictionList>${restrXml}</RestrictionList></Restrictions>` +
    `<Properties><PropertyList><Catalog>${xmlEscape(dbName)}</Catalog></PropertyList></Properties>` +
    `</Discover>` +
    `</soap:Body></soap:Envelope>`
  );
}

async function xmlaPost(soap: string): Promise<string> {
  const tok = await token();
  const url = `${xmlaBase()}/xmla`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'text/xml',
      accept: 'text/xml',
    },
    body: soap,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new AasError(`AAS XMLA POST failed ${res.status}`, res.status, text);
  // XMLA returns HTTP 200 even for engine errors — they arrive as a SOAP fault
  // or an <Exception> row. Surface the real engine message.
  if (text.includes('<Exception') || text.includes('faultcode') || text.includes('<soap:Fault')) {
    const msg =
      text.match(/<(?:\w+:)?Description>([\s\S]*?)<\/(?:\w+:)?Description>/)?.[1] ||
      text.match(/<(?:\w+:)?faultstring>([\s\S]*?)<\/(?:\w+:)?faultstring>/)?.[1] ||
      text.slice(0, 500);
    throw new AasError(`AAS XMLA fault: ${msg}`, 500, text);
  }
  return text;
}

// ============================================================
// Types
// ============================================================

export type RollingWindowGranularity = 'day' | 'month' | 'quarter' | 'year';

export interface AasRefreshPolicy {
  rollingWindowGranularity: RollingWindowGranularity;
  rollingWindowPeriods: number; // e.g. 3 (keep 3 years)
  incrementalGranularity: RollingWindowGranularity;
  incrementalPeriods: number; // e.g. 10 (refresh last 10 days)
  /** M expression lines filtering by the RangeStart/RangeEnd date params. */
  sourceExpression?: string[];
  /** Detect-changes column M expression (pollingExpression). */
  pollingExpression?: string;
  /** "Hybrid" appends the live DirectQuery partition; "Import" = historical only. */
  mode?: 'Import' | 'Hybrid';
}

export interface AasPartition {
  name: string;
  storageMode: 'Import' | 'DirectQuery' | 'Unknown';
  tableId?: string;
  queryDefinition?: string;
}

// ============================================================
// Public API
// ============================================================

/**
 * tmslExecute — send any TMSL command (Alter / CreateOrReplace / Refresh) to the
 * AAS XMLA endpoint. Returns the raw XML response on success; throws AasError on
 * SOAP fault or HTTP error.
 */
export async function tmslExecute(tmslJson: object): Promise<string> {
  return xmlaPost(soapExecute(tmslJson, catalog()));
}

/**
 * setIncrementalRefreshPolicy — TMSL Alter that writes a refreshPolicy to a
 * table. Hybrid mode (mode:'Hybrid') requires compatibility level >= 1565.
 *
 * Docs: https://learn.microsoft.com/power-bi/connect-data/incremental-refresh-xmla
 */
export async function setIncrementalRefreshPolicy(
  tableName: string,
  policy: AasRefreshPolicy,
): Promise<void> {
  const db = catalog();
  const tmsl = {
    alter: {
      object: { database: db, table: tableName },
      tableProperties: {
        refreshPolicy: {
          policyType: 'basic',
          rollingWindowGranularity: policy.rollingWindowGranularity,
          rollingWindowPeriods: policy.rollingWindowPeriods,
          incrementalGranularity: policy.incrementalGranularity,
          incrementalPeriods: policy.incrementalPeriods,
          ...(policy.sourceExpression ? { sourceExpression: policy.sourceExpression } : {}),
          ...(policy.pollingExpression ? { pollingExpression: policy.pollingExpression } : {}),
          mode: policy.mode ?? 'Import',
        },
      },
    },
  };
  await tmslExecute(tmsl);
}

/**
 * applyRefreshPolicy — TMSL Refresh with applyRefreshPolicy:true. Creates /
 * reshuffles the partition structure per the current policy: on first apply this
 * is a full import of the historical window plus — when mode:'Hybrid' — a live
 * DirectQuery partition for the current period.
 *
 * effectiveDate (ISO date) overrides "today" for the rolling-window calculation.
 */
export async function applyRefreshPolicy(
  tableName: string,
  opts?: { effectiveDate?: string; type?: 'full' | 'dataOnly' | 'automatic' },
): Promise<void> {
  const db = catalog();
  const tmsl = {
    refresh: {
      type: opts?.type ?? 'full',
      applyRefreshPolicy: true,
      ...(opts?.effectiveDate ? { effectiveDate: opts.effectiveDate } : {}),
      objects: [{ database: db, table: tableName }],
    },
  };
  await tmslExecute(tmsl);
}

/**
 * listPartitions — discovers partition schema via the TMSCHEMA_PARTITIONS DMV.
 * Returns name, storage mode (Import vs DirectQuery) and query definition. The
 * DirectQuery partition is the "current period" live-data partition created by
 * Hybrid mode.
 */
export async function listPartitions(tableName?: string): Promise<AasPartition[]> {
  const db = catalog();
  const soap = soapDiscover('TMSCHEMA_PARTITIONS', db, { DatabaseName: db });
  const xml = await xmlaPost(soap);
  const rows = [...xml.matchAll(/<row>([\s\S]*?)<\/row>/g)].map((m) => m[1]);
  const out: AasPartition[] = [];
  for (const row of rows) {
    const name = row.match(/<\[?Name\]?>([\s\S]*?)<\/\[?Name\]?>/i)?.[1]
      || row.match(/<\[?PARTITION_NAME\]?>([\s\S]*?)<\/\[?PARTITION_NAME\]?>/i)?.[1]
      || '';
    const modeRaw = row.match(/<\[?Mode\]?>([\s\S]*?)<\/\[?Mode\]?>/i)?.[1]
      || row.match(/<\[?STORAGE_MODE\]?>([\s\S]*?)<\/\[?STORAGE_MODE\]?>/i)?.[1]
      || '';
    const query = row.match(/<\[?QueryDefinition\]?>([\s\S]*?)<\/\[?QueryDefinition\]?>/i)?.[1]
      || row.match(/<\[?QUERY_DEFINITION\]?>([\s\S]*?)<\/\[?QUERY_DEFINITION\]?>/i)?.[1]
      || '';
    const tableId = row.match(/<\[?TableID\]?>([\s\S]*?)<\/\[?TableID\]?>/i)?.[1]
      || row.match(/<\[?TABLE_ID\]?>([\s\S]*?)<\/\[?TABLE_ID\]?>/i)?.[1]
      || '';
    if (!name) continue;
    if (tableName && !name.toLowerCase().startsWith(tableName.toLowerCase())) continue;
    // TMSCHEMA_PARTITIONS Mode: 0 = Import, 1 = DirectQuery, 2 = Default/Dual.
    const storageMode: AasPartition['storageMode'] =
      modeRaw === '1' || /directquery/i.test(modeRaw) ? 'DirectQuery'
      : modeRaw === '0' || /import/i.test(modeRaw) ? 'Import'
      : 'Unknown';
    out.push({ name, storageMode, tableId, queryDefinition: query });
  }
  return out;
}

/**
 * asyncRefresh — POST to the AAS async-refresh REST API (same body shape as the
 * Power BI enhanced refresh). Returns the requestId parsed from the 202 Location
 * header so the caller can poll GET /refreshes/{requestId}.
 *
 * Docs: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 */
export async function asyncRefresh(body: {
  type?: 'full' | 'dataOnly' | 'automatic' | 'clearValues' | 'calculate' | 'defragment';
  commitMode?: 'transactional' | 'partialBatch';
  maxParallelism?: number;
  retryCount?: number;
  applyRefreshPolicy?: boolean;
  effectiveDate?: string;
  objects?: Array<{ table: string; partition?: string }>;
}): Promise<{ requestId: string; location: string }> {
  const tok = await token();
  const url = `${xmlaBase()}/refreshes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'full', commitMode: 'transactional', ...body }),
    cache: 'no-store',
  });
  if (res.status !== 202) {
    const text = await res.text();
    throw new AasError(`AAS asyncRefresh failed ${res.status}`, res.status, text);
  }
  const location = res.headers.get('location') || res.headers.get('Location') || '';
  const requestId = location.split('/').pop() || '';
  return { requestId, location };
}

/** GET /refreshes — last async refresh operations (newest first). */
export async function listAasRefreshHistory(): Promise<
  Array<{
    requestId: string;
    status: string;
    startTime?: string;
    endTime?: string;
    currentRefreshType?: string;
  }>
> {
  const tok = await token();
  const url = `${xmlaBase()}/refreshes`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${tok}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave */ }
  if (!res.ok) throw new AasError(`AAS listRefreshHistory failed ${res.status}`, res.status, json || text);
  return json?.value || (Array.isArray(json) ? json : []) || [];
}
