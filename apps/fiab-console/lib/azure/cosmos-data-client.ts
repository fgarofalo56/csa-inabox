/**
 * Azure Cosmos DB **data-plane** client (parity wave — Items Data Explorer).
 *
 * Peer of cosmos-account-client.ts, but for the DATA plane: querying and
 * CRUD-ing the actual JSON documents inside a container. The control-plane
 * client (cosmos-account-client.ts) navigates databases/containers/sprocs over
 * ARM; THIS client talks directly to the account's data endpoint
 * (https://<account>.documents.azure.com) the same way the portal Data
 * Explorer does.
 *
 * Auth: Console UAMI via the SAME ChainedTokenCredential pattern as the
 * control-plane client:
 *   1. ManagedIdentityCredential({ clientId: LOOM_UAMI_CLIENT_ID }) — prod path
 *   2. DefaultAzureCredential — local dev / az login fallback
 *
 * Data-plane AAD ("RBAC") auth — grounded in Microsoft Learn, NOT the HMAC
 * master-key scheme:
 *   https://learn.microsoft.com/rest/api/cosmos-db/access-control-on-cosmosdb-resources#authorization-header
 *   The Authorization header is the *URL-encoded* string
 *     type=aad&ver=1.0&sig=<oauth token>
 *   where <oauth token> is the AAD bearer token acquired for the account's
 *   data-plane scope (https://<account>.documents.azure.com/.default — the same
 *   scope the @azure/cosmos JS SDK uses via `aadCredentials`).
 *
 * Query (POST .../dbs/{db}/colls/{coll}/docs) — grounded in:
 *   https://learn.microsoft.com/rest/api/cosmos-db/query-documents#request
 *     x-ms-documentdb-isquery: true
 *     Content-Type: application/query+json   (NO charset suffix)
 *     body: { query, parameters }
 *     x-ms-documentdb-query-enablecrosspartition: true   (fan-out, no pk filter)
 *     x-ms-max-item-count / x-ms-continuation              (paging)
 *
 * Item CRUD (GET/PUT/DELETE .../docs/{id}) — grounded in:
 *   https://learn.microsoft.com/rest/api/cosmos-db/get-a-document
 *   https://learn.microsoft.com/rest/api/cosmos-db/delete-a-document
 *     x-ms-documentdb-partitionkey: ["<pk value>"]   (JSON array, one element)
 *
 * Common headers — grounded in:
 *   https://learn.microsoft.com/rest/api/cosmos-db/common-cosmosdb-rest-request-headers
 *     x-ms-date  (RFC 1123, lowercase)  +  x-ms-version
 *
 * RU charge comes back on every response in `x-ms-request-charge`; the
 * continuation token (when more pages remain) in `x-ms-continuation`.
 *
 * 403 substatus 5300 ("cannot be authorized by AAD token in data plane") means
 * the UAMI has a control-plane role but is MISSING the Cosmos data-plane RBAC
 * assignment. We throw a typed CosmosDataPlaneRbacError so the BFF can honest-
 * gate with the exact role to grant ("Cosmos DB Built-in Data Contributor"
 * via sqlRoleAssignments) — never a fake document (per no-vaporware.md).
 *   https://learn.microsoft.com/azure/cosmos-db/troubleshoot-forbidden#nondata-operations-aren't-allowed
 *   https://learn.microsoft.com/azure/cosmos-db/how-to-connect-role-based-access-control
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

/** Cosmos data-plane REST API version (stable). */
const COSMOS_DATA_API_VERSION = '2018-12-31';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

// ---------------------------------------------------------------------------
// Account endpoint resolution
// ---------------------------------------------------------------------------

/**
 * The data-plane endpoint for the navigator account. Prefer an explicit
 * LOOM_COSMOS_ACCOUNT_ENDPOINT; otherwise derive the public
 * https://<account>.documents.azure.com endpoint from LOOM_COSMOS_ACCOUNT.
 *
 * (Sovereign clouds use a different documents suffix; an operator can pin the
 * exact endpoint via LOOM_COSMOS_ACCOUNT_ENDPOINT — same env-var convention as
 * the rest of the navigator.)
 */
export function cosmosDataEndpoint(): string {
  const explicit = process.env.LOOM_COSMOS_ACCOUNT_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, '');
  const acct = process.env.LOOM_COSMOS_ACCOUNT;
  if (!acct) throw new Error('Missing env var: LOOM_COSMOS_ACCOUNT');
  return `https://${acct}.documents.azure.com`;
}

/** The AAD scope for the data plane — the account endpoint's `.default`. */
function dataPlaneScope(): string {
  return `${cosmosDataEndpoint()}/.default`;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Generic data-plane REST failure carrying status + parsed body + substatus. */
export class CosmosDataError extends Error {
  status: number;
  substatus?: number;
  body: unknown;
  constructor(status: number, body: unknown, message?: string, substatus?: number) {
    super(message || `Cosmos data-plane call failed (${status})`);
    this.name = 'CosmosDataError';
    this.status = status;
    this.body = body;
    this.substatus = substatus;
  }
}

/**
 * Thrown on 403 from the data plane: the UAMI lacks the Cosmos DB data-plane
 * RBAC role assignment (control-plane "Cosmos DB Operator" is NOT enough). The
 * BFF turns this into an honest gate naming the exact role to grant.
 */
export class CosmosDataPlaneRbacError extends Error {
  status = 403 as const;
  substatus?: number;
  body: unknown;
  /** The exact role the UAMI needs at the account scope. */
  role = 'Cosmos DB Built-in Data Contributor';
  /** Human hint for the honest MessageBar. */
  hint =
    'The Console UAMI can navigate the account (control plane) but is missing ' +
    'the Cosmos DB DATA-plane role. Grant the "Cosmos DB Built-in Data ' +
    'Contributor" data-plane role to the UAMI via a Cosmos DB ' +
    'sqlRoleAssignments (Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments) ' +
    'at the account scope — the control-plane "Cosmos DB Operator" role does ' +
    'not grant document read/write.';
  constructor(body: unknown, message?: string, substatus?: number) {
    super(message || 'Forbidden: missing Cosmos DB data-plane RBAC role assignment');
    this.name = 'CosmosDataPlaneRbacError';
    this.body = body;
    this.substatus = substatus;
  }
}

// ---------------------------------------------------------------------------
// Low-level signed fetch (AAD data-plane auth scheme)
// ---------------------------------------------------------------------------

/**
 * Build the URL-encoded `type=aad&ver=1.0&sig=<token>` Authorization header
 * value from the AAD bearer token. The whole string is URL-encoded per the
 * Learn reference so it carries no invalid header characters.
 */
export function buildAadAuthHeader(aadToken: string): string {
  return encodeURIComponent(`type=aad&ver=1.0&sig=${aadToken}`);
}

interface DataResponse {
  res: Response;
  /** Parsed JSON body (or null on empty / non-JSON). */
  json: any;
  /** RU charge from x-ms-request-charge (0 when absent). */
  requestCharge: number;
  /** Continuation token from x-ms-continuation (null when none). */
  continuation: string | null;
}

async function dataFetch(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<DataResponse> {
  const token = await credential.getToken(dataPlaneScope());
  if (!token?.token) {
    throw new CosmosDataError(401, null, 'Failed to acquire AAD token for the Cosmos DB data plane');
  }
  const url = `${cosmosDataEndpoint()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: buildAadAuthHeader(token.token),
      'x-ms-date': new Date().toUTCString(),
      'x-ms-version': COSMOS_DATA_API_VERSION,
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let json: any = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = text; }
  }
  const requestCharge = Number(res.headers.get('x-ms-request-charge') || 0) || 0;
  const continuation = res.headers.get('x-ms-continuation') || null;

  if (!res.ok) {
    const substatusRaw = res.headers.get('x-ms-substatus');
    const substatus = substatusRaw ? Number(substatusRaw) : undefined;
    const msg =
      (json && typeof json === 'object' && json.message) ||
      (typeof json === 'string' ? json : `Cosmos data-plane ${res.status}`);
    if (res.status === 403) {
      throw new CosmosDataPlaneRbacError(json, msg, substatus);
    }
    throw new CosmosDataError(res.status, json, msg, substatus);
  }
  return { res, json, requestCharge, continuation };
}

function seg(s: string): string {
  // Cosmos resource ids appear in the path verbatim (they're already the
  // user-chosen id); encode each segment so ids with reserved chars are safe.
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Query items
// ---------------------------------------------------------------------------

export interface QueryParameter {
  name: string;
  value: unknown;
}

export interface QueryItemsOptions {
  /** Max items per page (x-ms-max-item-count). Default 100. */
  maxItems?: number;
  /** Allow fan-out across partitions when the query has no pk filter. Default true. */
  crossPartition?: boolean;
  /** Continuation token from a prior page. */
  continuation?: string | null;
  /** Bound parameters for parameterized queries. */
  parameters?: QueryParameter[];
}

export interface QueryItemsResult {
  /** The page of documents returned. */
  documents: Record<string, unknown>[];
  /** Total RU charge for this page (x-ms-request-charge). */
  requestCharge: number;
  /** Continuation token for the next page, or null when the feed is exhausted. */
  continuation: string | null;
  /** Count of documents in this page (server echoes _count too). */
  count: number;
}

/**
 * Run a SQL query against a container's documents feed.
 *
 * POST {endpoint}/dbs/{db}/colls/{coll}/docs
 *   x-ms-documentdb-isquery: true
 *   Content-Type: application/query+json
 *   body: { query, parameters }
 */
export async function queryItems(
  db: string,
  coll: string,
  query: string,
  opts: QueryItemsOptions = {},
): Promise<QueryItemsResult> {
  const { maxItems = 100, crossPartition = true, continuation, parameters = [] } = opts;
  const headers: Record<string, string> = {
    'content-type': 'application/query+json',
    'x-ms-documentdb-isquery': 'true',
    'x-ms-max-item-count': String(maxItems),
  };
  if (crossPartition) headers['x-ms-documentdb-query-enablecrosspartition'] = 'true';
  if (continuation) headers['x-ms-continuation'] = continuation;

  const { json, requestCharge, continuation: nextCont } = await dataFetch(
    `/dbs/${seg(db)}/colls/${seg(coll)}/docs`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, parameters }),
    },
  );
  const documents: Record<string, unknown>[] = (json && json.Documents) || [];
  return {
    documents,
    requestCharge,
    continuation: nextCont,
    count: typeof json?._count === 'number' ? json._count : documents.length,
  };
}

// ---------------------------------------------------------------------------
// Item CRUD
// ---------------------------------------------------------------------------

/** The partition-key header value: a single-element JSON array per the SQL API. */
function partitionKeyHeader(pk: unknown): string {
  return JSON.stringify([pk ?? null]);
}

/**
 * Resolve a document's partition-key VALUE from the container's pk path
 * (e.g. "/tenantId" → doc.tenantId, "/address/zip" → doc.address.zip). Returns
 * undefined when the path is absent on the doc (Cosmos treats that as the
 * "no value" / undefined partition for that document).
 */
export function partitionKeyValueFromDoc(
  doc: Record<string, unknown>,
  pkPath?: string,
): unknown {
  if (!pkPath) return undefined;
  const parts = pkPath.replace(/^\//, '').split('/').filter(Boolean);
  let cur: any = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

export interface ItemResult {
  document: Record<string, unknown> | null;
  requestCharge: number;
}

/**
 * GET {endpoint}/dbs/{db}/colls/{coll}/docs/{id}
 *   x-ms-documentdb-partitionkey: ["<pk>"]
 * Returns null when the document is not found (404).
 */
export async function getItem(
  db: string,
  coll: string,
  id: string,
  pk: unknown,
): Promise<ItemResult> {
  try {
    const { json, requestCharge } = await dataFetch(
      `/dbs/${seg(db)}/colls/${seg(coll)}/docs/${seg(id)}`,
      { method: 'GET', headers: { 'x-ms-documentdb-partitionkey': partitionKeyHeader(pk) } },
    );
    return { document: json ?? null, requestCharge };
  } catch (e) {
    if (e instanceof CosmosDataError && e.status === 404) {
      return { document: null, requestCharge: 0 };
    }
    throw e;
  }
}

/**
 * Upsert a document.
 *
 * POST {endpoint}/dbs/{db}/colls/{coll}/docs
 *   x-ms-documentdb-is-upsert: true
 *   x-ms-documentdb-partitionkey: ["<pk>"]
 *
 * Upsert (rather than separate create/replace) matches the portal Data
 * Explorer's New/Update-document behavior: a New item creates, and Save on an
 * existing id replaces. The partition key value is derived by the caller from
 * the container's pk path and passed explicitly so cross-partition writes are
 * unambiguous.
 */
export async function upsertItem(
  db: string,
  coll: string,
  doc: Record<string, unknown>,
  pk: unknown,
): Promise<ItemResult> {
  const { json, requestCharge } = await dataFetch(
    `/dbs/${seg(db)}/colls/${seg(coll)}/docs`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ms-documentdb-is-upsert': 'true',
        'x-ms-documentdb-partitionkey': partitionKeyHeader(pk),
      },
      body: JSON.stringify(doc),
    },
  );
  return { document: json ?? null, requestCharge };
}

/**
 * DELETE {endpoint}/dbs/{db}/colls/{coll}/docs/{id}
 *   x-ms-documentdb-partitionkey: ["<pk>"]
 * 404 is swallowed (already gone) so the UI is idempotent.
 */
export async function deleteItem(
  db: string,
  coll: string,
  id: string,
  pk: unknown,
): Promise<{ requestCharge: number }> {
  try {
    const { requestCharge } = await dataFetch(
      `/dbs/${seg(db)}/colls/${seg(coll)}/docs/${seg(id)}`,
      { method: 'DELETE', headers: { 'x-ms-documentdb-partitionkey': partitionKeyHeader(pk) } },
    );
    return { requestCharge };
  } catch (e) {
    if (e instanceof CosmosDataError && e.status === 404) return { requestCharge: 0 };
    throw e;
  }
}
