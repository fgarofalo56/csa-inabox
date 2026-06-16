/**
 * Cosmos Gremlin client — connects to the Cosmos DB Apache Gremlin API
 * via the gremlin npm package. Auth is AAD-based when AAD-RBAC is enabled
 * on the account (Microsoft.DocumentDB/databaseAccounts with capability
 * EnableGremlinRoleBased); otherwise we fall back to the account key
 * from an env var.
 *
 * v3 scope: real Gremlin traversal execution + a simple "vertices/edges
 * preview" helper. Visualization (force-directed layout) is deferred to
 * v3.x — the editor renders the edge/node tables.
 *
 * NOTE: gremlin requires WebSocket. The npm `gremlin` package is added in
 * package.json; if not installed at runtime, the route returns a 503 with
 * a clear deferred-reason MessageBar surfaced to the editor.
 */

import { ChainedTokenCredential, DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';

export class GremlinError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'GremlinError';
    this.status = status;
    this.body = body;
  }
}

export interface GremlinResult {
  rows: unknown[];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

const MAX_ROWS = 5_000;

function endpoint(): string {
  const v = process.env.LOOM_COSMOS_GREMLIN_ENDPOINT;
  if (!v) throw new GremlinError(
    'Cosmos Gremlin runtime is not provisioned in this deployment. Set LOOM_COSMOS_GREMLIN_ENDPOINT '
    + '(e.g. wss://<account>.gremlin.cosmos.azure.com:443/) on the Console Container App, optionally '
    + 'LOOM_COSMOS_GREMLIN_DATABASE / LOOM_COSMOS_GREMLIN_GRAPH, and grant the Console UAMI the '
    + 'Cosmos DB Built-in Data Contributor role (or set LOOM_COSMOS_GREMLIN_KEY).',
    503,
  );
  return v;
}

function gremlinDatabase(): string {
  return process.env.LOOM_COSMOS_GREMLIN_DATABASE || 'graphdb';
}

function gremlinGraph(): string {
  return process.env.LOOM_COSMOS_GREMLIN_GRAPH || 'graph';
}

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(new AcaManagedIdentityCredential(), new ManagedIdentityCredential({ clientId: uamiClientId }), new DefaultAzureCredential())
  : new DefaultAzureCredential();

/**
 * Run a Gremlin traversal string against the configured graph.
 * Returns { rows, rowCount, executionMs }. Result rows are the raw
 * GraphSON objects (typed maps with id/label/type/properties).
 */
export async function executeGremlin(query: string): Promise<GremlinResult> {
  // Lazy require — the `gremlin` package is a peer dep. If it's missing we
  // throw a 503 so the route handler can surface a clean deferred message.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let gremlin: any;
  try {
    gremlin = require('gremlin');
  } catch {
    throw new GremlinError(
      'gremlin npm package not installed in this build — add `gremlin` to apps/fiab-console/package.json and redeploy to enable Cosmos Gremlin runtime.',
      503,
    );
  }

  const ep = endpoint();
  const db = gremlinDatabase();
  const graph = gremlinGraph();
  const username = `/dbs/${db}/colls/${graph}`;

  // Prefer AAD token. Cosmos Gremlin SDK takes the token as the password
  // when SASL auth is set to `SaslAuthenticator` with `aad` mechanism.
  // Some account configs still require the account key — we surface that
  // via LOOM_COSMOS_GREMLIN_KEY.
  let password = process.env.LOOM_COSMOS_GREMLIN_KEY || '';
  if (!password) {
    const tok = await credential.getToken('https://cosmos.azure.com/.default');
    if (!tok?.token) throw new GremlinError('Failed to acquire AAD token for Cosmos Gremlin', 401);
    password = tok.token;
  }

  const authenticator = new gremlin.driver.auth.PlainTextSaslAuthenticator(username, password);
  const client = new gremlin.driver.Client(ep, {
    authenticator,
    traversalsource: 'g',
    rejectUnauthorized: true,
    mimeType: 'application/vnd.gremlin-v2.0+json',
  });

  const started = Date.now();
  try {
    const result = await client.submit(query);
    const rows = Array.isArray(result._items) ? result._items : Array.from(result);
    return {
      rows: rows.slice(0, MAX_ROWS),
      rowCount: rows.length,
      executionMs: Date.now() - started,
      truncated: rows.length > MAX_ROWS,
    };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}
