/**
 * Azure Analysis Services (AAS) client — two complementary backends:
 *
 * 1. **Async-refresh** (semantic-layer refresh for the Power Query (M) ingest
 *    path): after an authored M mashup materialises a Delta table in ADLS Gen2
 *    (via ADF WranglingDataFlow → MappingDataFlow), the AAS tabular model —
 *    whose partition source already points at that Delta path — is refreshed so
 *    the table becomes queryable. Invoked through the AAS asynchronous-refresh
 *    REST API (no long-running HTTP connection):
 *
 *      POST https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes
 *      GET  https://<region>.asazure.windows.net/servers/<server>/models/<model>/refreshes/<id>
 *
 * 2. **Data-plane DAX query** (Loom-native default for the Report editor,
 *    LOOM_BI_BACKEND unset): the Azure-native report renderer backend (no Power
 *    BI / Fabric workspace required, per no-fabric-dependency.md). The Report
 *    editor queries the bound AAS tabular model with DAX and renders the rows:
 *
 *      POST https://{region}.asazure.windows.net/servers/{server}/models/{db}/query
 *      Body: { queries: [{ query }], serializerSettings: { includeNulls: true } }
 *
 * Auth: ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
 * DefaultAzureCredential), requesting the AAS audience. Per Microsoft Learn the
 * token audience must be **exactly** `https://*.asazure.windows.net` — the `*`
 * is a LITERAL character, not a wildcard — so the scope is
 * `https://*.asazure.windows.net/.default` (Commercial / GCC) or the
 * usgovcloudapi.net equivalent (GCC-High / IL5 / DoD), derived via aasScope().
 * The Console UAMI must hold the **server administrator** role on the AAS server
 * (set via `Microsoft.AnalysisServices/servers.properties.asAdministrators.members[]`,
 * NOT an Azure RBAC role assignment — see aas.bicep). Database-role membership
 * alone is insufficient for the REST query endpoint.
 *
 * Sovereign clouds: **Azure Analysis Services has no Azure Government offering
 * for the refresh ingest path** — aasConfigGate() returns an honest gate
 * (`AAS_NOT_IN_GOV`) BEFORE any token/network call and the ingest route directs
 * the operator to query the Delta table via Synapse Serverless
 * `OPENROWSET(... FORMAT='DELTA')` instead. The DAX-query path derives its
 * endpoint/scope from aasScope()/aasModelUrl() (isGovCloud-aware) so it uses
 * the correct suffix wherever AAS is available.
 *
 * No mocks. Real AAS REST only.
 *
 * Refs (grounded in Microsoft Learn, sql-analysis-services-2025):
 *   - Async refresh REST API + authentication (audience):
 *     learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh
 */

import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { detectLoomCloud, aasScope, aasModelUrl } from './cloud-endpoints';
import {
  type AasRow,
  type AasTable,
  type AasQueryResult,
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
} from './aas-dax';

// Re-export the pure helpers so existing call sites can keep importing from
// aas-client. The pure logic lives in aas-dax (no @azure/identity) so it stays
// unit-testable without the credential chain.
export {
  resolveAasBinding,
  buildDaxFromVisual,
  flattenAasRows,
};
export type { AasRow, AasTable, AasQueryResult };

// The audience MUST be the literal `https://*.asazure.windows.net` (the `*` is
// not a placeholder). `.default` requests an app-level token whose `aud` claim
// resolves to exactly that audience. Used by the async-refresh path; the DAX
// query path derives its (gov-aware) scope from aasScope() at call time.
const AAS_SCOPE = 'https://*.asazure.windows.net/.default';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/**
 * Honest config gate for the AAS refresh path. Returns the precise blocker so
 * the BFF can surface an exact MessageBar (and the ingest route can skip Phase C
 * with an explanatory warning) instead of erroring. Returns null when AAS is
 * usable. Order matters: the gov-cloud check fires first because AAS simply
 * does not exist there — no env var can satisfy it.
 */
export function aasConfigGate(): { missing: string; reason?: string } | null {
  const cloud = detectLoomCloud();
  if (cloud === 'GCC-High' || cloud === 'DoD') {
    return {
      missing: 'AAS_NOT_IN_GOV',
      reason:
        'Azure Analysis Services is not available in Azure Government (GCC-High / DoD). ' +
        'Query the Delta table directly via Synapse Serverless SQL ' +
        "(OPENROWSET(BULK '<deltaPath>', FORMAT='DELTA')) — set LOOM_SYNAPSE_WORKSPACE to enable it.",
    };
  }
  if (!process.env.LOOM_AAS_SERVER) {
    return {
      missing: 'LOOM_AAS_SERVER',
      reason:
        'Set LOOM_AAS_SERVER to the AAS connection string ' +
        '(asazure://<region>.asazure.windows.net/<serverName>) — deployed by ' +
        'platform/fiab/bicep/modules/landing-zone/aas.bicep.',
    };
  }
  if (!process.env.LOOM_AAS_MODEL) {
    return {
      missing: 'LOOM_AAS_MODEL',
      reason: 'Set LOOM_AAS_MODEL to the tabular model (database) name on the AAS server.',
    };
  }
  return null;
}

/**
 * Parse `LOOM_AAS_SERVER` (asazure://<region>.asazure.windows.net/<serverName>)
 * into the REST host + server name. Accepts a bare `https://…` form too.
 */
function parseServer(): { host: string; server: string } {
  const raw = (process.env.LOOM_AAS_SERVER || '').trim();
  if (!raw) throw new Error('Missing env var: LOOM_AAS_SERVER');
  // asazure://westus.asazure.windows.net/myserver  → host, server
  const m = raw.match(/^(?:asazure|https?):\/\/([^/]+)\/([^/?#]+)/i);
  if (!m) {
    throw new Error(
      `LOOM_AAS_SERVER is malformed: "${raw}". Expected asazure://<region>.asazure.windows.net/<serverName>.`,
    );
  }
  return { host: m[1], server: m[2] };
}

/** Base REST URL for the configured server + model: …/servers/<s>/models/<m>. */
function modelBase(): string {
  const { host, server } = parseServer();
  const model = (process.env.LOOM_AAS_MODEL || '').trim();
  if (!model) throw new Error('Missing env var: LOOM_AAS_MODEL');
  return `https://${host}/servers/${encodeURIComponent(server)}/models/${encodeURIComponent(model)}`;
}

async function authHeader(): Promise<string> {
  const tok = await credential.getToken(AAS_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire Azure Analysis Services token');
  return `Bearer ${tok.token}`;
}

/** A single AAS refresh object to refresh (table, optionally a partition). */
export interface AasRefreshObject {
  table: string;
  partition?: string;
}

export interface AasRefreshOptions {
  /** Processing type — 'full' reloads + recalcs (default). */
  type?: 'full' | 'clearValues' | 'calculate' | 'dataOnly' | 'automatic' | 'defragment';
  /** transactional = all-or-nothing; partialBatch = commit completed batches. */
  commitMode?: 'transactional' | 'partialBatch';
  maxParallelism?: number;
  retryCount?: number;
}

export interface AasRefreshHandle {
  /** The refresh id (the last path segment of the 202 Location header). */
  refreshId: string;
  status: string;
}

/**
 * POST a new asynchronous refresh. Returns the refreshId parsed from the
 * `Location` response header (the AAS async pattern — 202 Accepted + Location).
 * `objects` scopes the refresh to specific tables/partitions; omit to refresh
 * the whole model.
 */
export async function postAasRefresh(
  objects?: AasRefreshObject[],
  opts?: AasRefreshOptions,
): Promise<AasRefreshHandle> {
  const body: Record<string, unknown> = {
    Type: opts?.type || 'full',
    CommitMode: opts?.commitMode || 'transactional',
    MaxParallelism: opts?.maxParallelism ?? 2,
    RetryCount: opts?.retryCount ?? 2,
  };
  if (objects && objects.length) {
    body.Objects = objects.map((o) => (o.partition ? { table: o.table, partition: o.partition } : { table: o.table }));
  }
  const r = await fetch(`${modelBase()}/refreshes`, {
    method: 'POST',
    headers: { authorization: await authHeader(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok && r.status !== 202) {
    throw new Error(`postAasRefresh failed ${r.status}: ${await r.text()}`);
  }
  // 202 Accepted → Location header carries the polling URL whose final segment
  // is the refreshId. Some gateways also echo the id in the JSON body.
  const loc = r.headers.get('location') || r.headers.get('Location') || '';
  let refreshId = loc ? loc.replace(/[/?#].*$/, '').split('/').filter(Boolean).pop() || '' : '';
  if (!refreshId) {
    try {
      const j = (await r.clone().json()) as { refreshId?: string; RefreshId?: string };
      refreshId = j.refreshId || j.RefreshId || '';
    } catch { /* no body */ }
  }
  return { refreshId, status: 'inProgress' };
}

export interface AasRefreshStatus {
  status: 'notStarted' | 'inProgress' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled' | string;
  startTime?: string;
  endTime?: string;
  type?: string;
  error?: string;
}

/** GET the status of a previously-queued refresh. */
export async function getAasRefreshStatus(refreshId: string): Promise<AasRefreshStatus> {
  const r = await fetch(`${modelBase()}/refreshes/${encodeURIComponent(refreshId)}`, {
    headers: { authorization: await authHeader() },
  });
  if (!r.ok) {
    throw new Error(`getAasRefreshStatus failed ${r.status}: ${await r.text()}`);
  }
  const j = (await r.json()) as {
    status?: string;
    startTime?: string;
    endTime?: string;
    type?: string;
    messages?: Array<{ message?: string; type?: string }>;
  };
  const errMsg = (j.messages || [])
    .filter((mm) => (mm.type || '').toLowerCase().includes('error') || (mm.type || '').toLowerCase() === 'warning')
    .map((mm) => mm.message)
    .filter(Boolean)
    .join('; ');
  return {
    status: (j.status as AasRefreshStatus['status']) || 'inProgress',
    startTime: j.startTime,
    endTime: j.endTime,
    type: j.type,
    error: errMsg || undefined,
  };
}

export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

async function getAasToken(): Promise<string> {
  const scope = aasScope();
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for AAS (scope: ${scope})`, 401);
  return t.token;
}

/**
 * Execute a DAX query against an AAS model and return the raw result envelope.
 *
 * @param region     - Azure region of the AAS server (e.g. "eastus2")
 * @param serverName - Short server name (e.g. "my-server")
 * @param database   - Model / database name (e.g. "AdventureWorks")
 * @param daxQuery   - DAX query string (EVALUATE expression)
 */
export async function executeAasQuery(
  region: string,
  serverName: string,
  database: string,
  daxQuery: string,
): Promise<AasQueryResult> {
  const token = await getAasToken();
  const url = `${aasModelUrl(region, serverName, database)}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      queries: [{ query: daxQuery }],
      serializerSettings: { includeNulls: true },
    }),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = (
      json?.error?.message ||
      json?.message ||
      text ||
      'AAS query failed'
    ).toString();
    throw new AasError(msg, res.status, json || text, url);
  }
  return (json as AasQueryResult) ?? { results: [] };
}
