/**
 * connection-probe — the ONE credential-aware reachability probe for Loom
 * Connections, shared by:
 *   • POST /api/connections/test        (pre-save: test the builder's form values)
 *   • POST /api/connections/[id]/test   (post-save: test a stored connection)
 *
 * Every branch calls a REAL per-type Azure client (no fabricated success):
 *   • SQL family (azure-sql, synapse-dedicated/serverless, databricks-sql,
 *     generic-sql, postgres) → real TDS catalog SELECT via listTablesWithAuth.
 *   • adx                    → real Kusto `print 1` via kusto-client.
 *   • storage-adls           → real ADLS list-filesystems via adls-client (proves
 *                              the account resolves AND the identity can read it).
 *   • event-hub / service-bus / key-vault / cosmos → real network+TLS
 *     reachability via fetchWithTimeout (any HTTP response proves the
 *     namespace/vault/account resolves; per-entity authorization is validated at
 *     item-bind time — an honest caveat, never a fake "connected").
 *
 * The caller resolves any secret (from the builder form OR the stored KV
 * secretRef) and passes it as plaintext `secret` — this module never reads Key
 * Vault or Cosmos. Any secret is redacted out of returned error text so a driver
 * message can never echo a connection string back to the client.
 */
import { listTablesWithAuth } from './sql-objects-client';
import {
  executeQuery as kustoExecuteQuery,
  defaultDatabase as kustoDefaultDatabase,
  normalizeClusterUri,
} from './kusto-client';
import { getServiceClientFor } from './adls-client';
import { fetchWithTimeout } from './fetch-with-timeout';
import { statusToken } from './status-token';
import type { SqlExplicitAuth } from './azure-sql-client';
import type { ConnectionType, AuthMethod } from './connections-store';

export interface ProbeInput {
  type: ConnectionType;
  authMethod: AuthMethod;
  host?: string;
  database?: string;
  username?: string;
  /** Resolved plaintext secret (builder form or KV). NEVER logged or echoed. */
  secret?: string;
}

/** Reachability outcome — success (real backend reached) or a honest failure. */
export interface ProbeOk { ok: true; reachable: boolean; tableCount?: number; detail: string }
export interface ProbeErr { ok: false; status: number; error: string; hint?: string }
export type ProbeResult = ProbeOk | ProbeErr;

/** Connection types that support a pre-flight TDS reachability test. */
const SQL_TESTABLE = new Set<ConnectionType>([
  'azure-sql', 'synapse-dedicated', 'synapse-serverless',
  'databricks-sql', 'generic-sql', 'postgres',
]);
/** Types reachable via a plain HTTPS round-trip (namespace / vault / account host). */
const HTTP_REACHABLE = new Set<ConnectionType>(['event-hub', 'service-bus', 'key-vault', 'cosmos']);

const HTTP_LABEL: Partial<Record<ConnectionType, string>> = {
  'event-hub': 'Event Hubs namespace',
  'service-bus': 'Service Bus namespace',
  'key-vault': 'Key Vault',
  'cosmos': 'Cosmos DB account',
};

/** Strip scheme + trailing slash from a host so it can be normalized/compared. */
function stripScheme(host: string): string {
  return host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}
function toHttpsUrl(host: string): string {
  return /^https?:\/\//i.test(host) ? host : `https://${stripScheme(host)}`;
}
/** Storage account name from a bare account or an FQDN (`acct` | `acct.dfs.core.windows.net`). */
function adlsAccountFromHost(host: string): string {
  return stripScheme(host).split('.')[0];
}

export async function probeConnection(input: ProbeInput): Promise<ProbeResult> {
  const type = input.type;
  const host = (input.host || '').trim();
  // Redact the secret from any driver/network error so a connection string can
  // never be echoed back to the client.
  const redact = (msg: string): string =>
    input.secret ? msg.split(input.secret).join('***') : msg;

  const needHost = (): ProbeErr => ({
    ok: false, status: 400,
    error: 'a host/server is required to test this connection',
    hint: 'Enter the host and try again.',
  });

  // ── Azure Data Explorer (Kusto) ────────────────────────────────────────────
  if (type === 'adx') {
    const cluster = host
      ? (normalizeClusterUri(host) || normalizeClusterUri(`https://${host}`))
      : null;
    if (host && !cluster) {
      return {
        ok: false, status: 400,
        error: `"${host}" is not a valid Kusto cluster URI`,
        hint: 'Use the full cluster URI, e.g. https://mycluster.eastus.kusto.windows.net.',
      };
    }
    const adxDb = input.database || kustoDefaultDatabase();
    try {
      const r = await kustoExecuteQuery(adxDb, 'print ping = 1', cluster ? { clusterUri: cluster } : undefined);
      return {
        ok: true, reachable: r.rowCount >= 1,
        detail: `Connected to the ADX cluster. Database "${adxDb}" is reachable (${r.executionMs} ms).`,
      };
    } catch (e) { return classifySqlError(e, redact); }
  }

  // ── ADLS Gen2 / Storage ────────────────────────────────────────────────────
  if (type === 'storage-adls') {
    if (!host) return needHost();
    const account = adlsAccountFromHost(host);
    try {
      // Real data-plane round-trip: enumerate one filesystem. Proves the account
      // resolves AND the Console identity can read it; a 403 is an honest,
      // actionable "grant Storage Blob Data Reader" gate.
      const svc = getServiceClientFor(account);
      await svc.listFileSystems().byPage({ maxPageSize: 1 }).next();
      return {
        ok: true, reachable: true,
        detail: `Reached storage account "${account}". The Console identity can list its filesystems.`,
      };
    } catch (e) { return classifyReachError(e, redact, 'storage account'); }
  }

  // ── SQL family (real TDS probe) ─────────────────────────────────────────────
  if (SQL_TESTABLE.has(type)) {
    if (!host) return needHost();
    let auth: SqlExplicitAuth | undefined;
    if (input.authMethod === 'sql-password') {
      if (!input.secret) return { ok: false, status: 400, error: 'a password is required to test SQL password auth', hint: 'Enter the password before testing.' };
      if (!input.username) return { ok: false, status: 400, error: 'a username is required for SQL password auth', hint: 'Enter the username before testing.' };
      auth = { user: input.username, password: input.secret };
    } else if (input.authMethod === 'connection-string') {
      if (!input.secret) return { ok: false, status: 400, error: 'a connection string is required to test', hint: 'Enter the connection string before testing.' };
      auth = { connectionString: input.secret };
    } else if (input.authMethod === 'entra-mi') {
      auth = undefined; // UAMI AAD-token path
    } else {
      // service-principal / account-key: not a standalone TDS auth path.
      return {
        ok: true, reachable: false,
        detail: `The "${input.authMethod}" auth method is validated when the connection is bound to an item, not via a standalone probe.`,
      };
    }
    try {
      const tables = await listTablesWithAuth(host, input.database || 'master', auth);
      return {
        ok: true, reachable: true, tableCount: tables.length,
        detail: `Connected successfully. ${tables.length} table${tables.length !== 1 ? 's' : ''} visible in ${input.database || 'master'}.`,
      };
    } catch (e) { return classifySqlError(e, redact); }
  }

  // ── HTTPS-reachable hosts (Event Hubs / Service Bus / Key Vault / Cosmos) ────
  // ── Snowflake ──────────────────────────────────────────────────────────────
  // The account identifier (`myorg-account123`) resolves to a real host,
  // `<accountIdentifier>.snowflakecomputing.com`. A DNS + TLS round-trip against
  // it is a genuine check of the single field Snowflake connections most often
  // get wrong, so it is worth doing rather than deferring everything to bind
  // time. It proves REACHABILITY only — the login itself is exercised by the
  // ADF linked service, and this message says so rather than implying more
  // than it established (deploy-integrity.md R7).
  if (type === 'snowflake') {
    if (!host) return needHost();
    const account = stripScheme(host).replace(/\.snowflakecomputing\.com$/i, '');
    if (/[^A-Za-z0-9_.-]/.test(account)) {
      return {
        ok: false, status: 400,
        error: `"${account}" is not a valid Snowflake account identifier.`,
        hint: 'Use the organization-account form, e.g. myorg-account123 — not the full https://….snowflakecomputing.com URL.',
      };
    }
    try {
      const res = await fetchWithTimeout(
        `https://${account}.snowflakecomputing.com`, { method: 'GET', redirect: 'manual' }, 8_000,
      );
      return {
        ok: true, reachable: true,
        detail: `Snowflake account "${account}" resolves and is reachable over the network (HTTP ${res.status}). The login, warehouse, and role are validated by the ADF Snowflake linked service when the mirror starts.`,
      };
    } catch (e) { return classifyReachError(e, redact, 'Snowflake account'); }
  }

  if (HTTP_REACHABLE.has(type)) {

    if (!host) return needHost();
    try {
      const res = await fetchWithTimeout(toHttpsUrl(host), { method: 'GET', redirect: 'manual' }, 8_000);
      return {
        ok: true, reachable: true,
        detail: `${HTTP_LABEL[type] || 'Host'} "${stripScheme(host)}" is reachable over the network (HTTP ${res.status}). Credential authorization is validated when the connection is bound to an item.`,
      };
    } catch (e) { return classifyReachError(e, redact, HTTP_LABEL[type] || 'host'); }
  }

  // Union-exhaustive fallback — honest, never a fake success.
  return {
    ok: true, reachable: false,
    detail: `${type} connections are validated when the connection is bound to an item.`,
  };
}

/** Classify common TDS/Kusto auth+connectivity failures into an actionable hint.
 *
 *  Exported for direct test: the `hint` is only ever attached when a branch
 *  matched, and `undefined` otherwise. That "no branch matched ⇒ no advice"
 *  property is the whole R7 guarantee here, and it is not observable through
 *  `probeConnection` without a live driver. */
export function classifySqlError(e: unknown, redact: (m: string) => string): ProbeErr {
  const msg = redact(e instanceof Error ? e.message : String(e));
  let hint: string | undefined;
  if (/login failed|cannot open.*database|token-identified principal|authentication failed/i.test(msg)) {
    hint = 'Verify the username, password, and that the principal has been granted database access on the target server.';
  } else if (/connection.*refused|could not connect|timeout|getaddrinfo|enotfound/i.test(msg)) {
    hint = "The server may be behind a firewall or the host is wrong. Ensure the Console identity's outbound IP is in the server's firewall allowlist.";
  } else if (/ssl|certificate/i.test(msg)) {
    hint = 'TLS handshake failed. Check that the server accepts encrypted connections with a valid certificate.';
  }
  return { ok: false, status: 502, error: msg, ...(hint ? { hint } : {}) };
}

/**
 * A refusal, matched as an ANCHORED status token rather than as bare digits.
 *
 * `/403/` matches inside `stloom403`, `kv-403-prod`, and any GUID segment that
 * happens to contain the run — which would tell an operator whose storage
 * account is named `st403data` that a DNS failure was a missing role
 * assignment. Same defect `_az-failure-class.mjs` shipped as `\b503\b` and had
 * to fix; `\b` does not help, because it treats `-` as a boundary.
 */
const REACH_DENIED = new RegExp(
  [statusToken('40[13]'), 'forbidden', 'authorization', 'not authorized'].join('|'),
  'i',
);

/**
 * Classify a reachability (network/permission) failure for HTTP/ADLS probes.
 *
 * THE TRANSPORT BRANCHES ARE TESTED FIRST (#4048 F5), and the order is the fix.
 *
 * `REACH_DENIED` used to run first. Its NUMERIC half was anchored by
 * `statusToken` (the `st403data` defect this module's own docstring describes),
 * but `forbidden` / `authorization` / `not authorized` were left as BARE
 * SUBSTRINGS — so a DNS failure on a host whose NAME contains one of those words
 * produced confident, false role-grant advice. Measured before this change:
 *
 * These are MEASURED strings, kept verbatim because a paraphrased hostname would
 * not demonstrate the substring collision that caused the defect. Each carries
 * the inline ratchet marker: they are documentation of an observed failure, not
 * a Commercial host this module ever resolves.
 *
 *     getaddrinfo ENOTFOUND authorization-api.contoso.com -> "not authorized. Grant it …"
 *     getaddrinfo ENOTFOUND kv-authorization-prod.vault.azure.net -> same   cloud-endpoint-literal-ok: measured example string, not a resolved host
 *     getaddrinfo ENOTFOUND stforbidden.dfs.core.windows.net -> same   cloud-endpoint-literal-ok: measured example string, not a resolved host
 *     connect ECONNREFUSED loom-forbidden-eh.servicebus… -> same   cloud-endpoint-literal-ok: measured example string, not a resolved host
 *     getaddrinfo ENOTFOUND stloom403.dfs.core.windows.net -> "host could not be resolved"   cloud-endpoint-literal-ok: measured example string, not a resolved host
 *     (the digits case was already fixed by statusToken)
 *
 * That is `deploy-integrity.md` R7: the message asserts a cause the code did not
 * establish, and it costs an operator a role assignment they did not need.
 *
 * THE FIX NEEDS NO REGEX WORK. A `getaddrinfo` / `ENOTFOUND` / `ECONNREFUSED`
 * token is POSITIVE evidence of a transport failure and cannot co-occur with an
 * HTTP 403 body — there is no response to carry one. So the transport branches
 * are asked first and `REACH_DENIED` is asked only of what is left. Checked
 * against all four pre-existing `REACH_DENIED` fixtures: they still pass,
 * because none of them carries a transport token.
 */
export function classifyReachError(e: unknown, redact: (m: string) => string, subject: string): ProbeErr {
  const msg = redact(e instanceof Error ? e.message : String(e));
  let hint: string | undefined;
  if (/getaddrinfo|enotfound|dns/i.test(msg)) {
    hint = `The ${subject} host could not be resolved. Check the host name for typos.`;
  } else if (/timeout|timed out|abort|econnrefused|refused/i.test(msg)) {
    hint = `The ${subject} did not respond. It may be behind a firewall or private endpoint the Console cannot reach.`;
  } else if (REACH_DENIED.test(msg)) {
    hint = `Reached the ${subject}, but the Console identity is not authorized. Grant it the appropriate data-plane role (e.g. Storage Blob Data Reader / Data Receiver).`;
  }
  return { ok: false, status: 502, error: msg || `could not reach the ${subject}`, ...(hint ? { hint } : {}) };
}
