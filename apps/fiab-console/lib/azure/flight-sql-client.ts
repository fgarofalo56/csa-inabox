/**
 * N3 — Arrow Flight SQL serving wire: ticket minting + connection snippets.
 * SERVER-ONLY (node:crypto + the Cosmos audit trail).
 *
 * ## Why Flight
 *
 * ODBC/JDBC spend 60–90% of a large transfer serializing row-by-row. Flight SQL
 * streams the SAME Arrow RecordBatches the engine produced — no re-encode, no
 * row conversion — over gRPC/HTTP2. `apps/loom-duckdb` serves the wire off the
 * SAME embedded DuckDB process that answers the HTTP tier, so an external ADBC
 * client and Loom's own grid read identical Arrow batches.
 *
 * ## Tickets: short-lived, Entra-scoped, audited — never a long-lived secret
 *
 * The BFF mints a ticket ONLY from a verified Entra session. The token carries
 * the caller's Entra identity (oid / upn / tid), the granted scope, a ticket id
 * and an expiry of minutes (default 5, hard-capped at 60). It is HMAC-SHA256
 * signed with a Key-Vault-injected key that never leaves the boundary, and it is
 * single-audience (`loom-flightsql`) so it cannot be replayed elsewhere.
 *
 * Issuance AND session creation are audited ({@link logFlightAccess}); the
 * serving tier logs one structured line per redemption carrying the same
 * `ticketId`, so an ATO reviewer joins mint → redeem on one key.
 *
 * The grammar is shared verbatim with the server verifier
 * (`apps/loom-duckdb/app/tickets.py`) and both sides have unit tests over it:
 *
 *     v1.<base64url(payload_json)>.<base64url(hmac_sha256(key, "v1." + payload))>
 *
 * ## Snippets never carry a secret and never name an internal host
 *
 * {@link buildFlightSnippets} emits ADBC / Flight / JDBC connection code that
 * reads the ticket from the user's own environment variable and targets the
 * PUBLISHED, audited endpoint. When no public Flight endpoint is published the
 * builder says so honestly instead of leaking the `*.internal.*` container FQDN.
 *
 * IL5: gRPC/HTTP2 on Container Apps works in Commercial and Gov; in IL5 the
 * service stays internal-ingress and the ticket is minted in-boundary by this
 * console, so the whole capability runs disconnected.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const FLIGHTSQL_GATE_ID = 'svc-flight-sql';

/** Token grammar version + audience, shared with the Python verifier. */
export const TICKET_VERSION = 'v1';
export const TICKET_AUDIENCE = 'loom-flightsql';

/** Default ticket lifetime (seconds) and the hard ceiling. */
export const DEFAULT_TICKET_TTL_S = 300;
export const MAX_TICKET_TTL_S = 3600;

/** Hosts that must never appear in a copy-paste snippet. */
// NOTE the `[a-z0-9.-]+` (dots ALLOWED) between `.internal.` and
// `.azurecontainerapps.`: a real ACA internal FQDN is
// `<app>.internal.<env>.<region>.azurecontainerapps.io` — TWO labels, not one.
// A single-label pattern (`[a-z0-9-]+`) silently fails to match, which would
// classify an internal container address as `published` and print it to users
// as a connect target (leaking internal topology + handing out a URI that can
// never resolve for them). Same `.internal.` CAE gotcha bitten before.
const INTERNAL_HOST_RE = /(\.internal\.[a-z0-9.-]+\.azurecontainerapps\.(io|us)|\.svc\.cluster\.local|^localhost$|^127\.)/i;

/** Honest config signal — the missing env var, or null when the wire is wired. */
export function flightSqlConfigGate(): { missing: string } | null {
  return (process.env.LOOM_FLIGHTSQL_URL || '').trim() ? null : { missing: 'LOOM_FLIGHTSQL_URL' };
}

/** True when the Flight SQL wire is deployed + wired. */
export function isFlightSqlConfigured(): boolean {
  return flightSqlConfigGate() === null;
}

/** How reachable the Flight endpoint is from where the caller sits. */
export type FlightExposure = 'published' | 'in-vnet' | 'not-deployed';

export interface FlightEndpointInfo {
  /** The URI a client connects to. Empty unless `exposure === 'published'`. */
  uri: string;
  exposure: FlightExposure;
  /** Operator-facing explanation, rendered verbatim in the Connect tab. */
  note: string;
}

/**
 * Resolve the endpoint a snippet may name.
 *
 * `LOOM_FLIGHTSQL_PUBLIC_URL` is the operator-published, externally reachable
 * URI (behind Front Door / a private-link listener). `LOOM_FLIGHTSQL_URL` is
 * the INTERNAL container address the BFF uses; it is deliberately never echoed
 * into a snippet, because handing a user an unreachable internal FQDN is worse
 * than telling them the truth.
 */
export function resolveFlightEndpoint(): FlightEndpointInfo {
  const published = (process.env.LOOM_FLIGHTSQL_PUBLIC_URL || '').trim();
  if (published && !INTERNAL_HOST_RE.test(hostOf(published))) {
    return {
      uri: published,
      exposure: 'published',
      note: 'Connect directly with any ADBC / Flight SQL client. Every session is authenticated by the ticket you mint here and audited on redemption.',
    };
  }
  if (isFlightSqlConfigured()) {
    return {
      uri: '',
      exposure: 'in-vnet',
      note:
        'The Flight SQL wire is deployed but reachable only from inside the deployment VNet (internal ingress). '
        + 'Run your client from a peered network, a Loom notebook, or the jump host — or publish an external '
        + 'listener and set LOOM_FLIGHTSQL_PUBLIC_URL so this tab can hand out a directly usable URI. '
        + 'The internal container address is deliberately not printed here: it would not resolve for you.',
    };
  }
  return {
    uri: '',
    exposure: 'not-deployed',
    note:
      'The Flight SQL wire is not deployed in this environment. Loom still serves Arrow over the audited HTTP '
      + 'tier (identical batches, one extra hop), so nothing here is blocked — deploying it removes that hop '
      + 'for very large results.',
  };
}

function hostOf(uri: string): string {
  const stripped = String(uri).replace(/^[a-z0-9+.-]+:\/\//i, '');
  return stripped.split('/')[0].split(':')[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket minting
// ─────────────────────────────────────────────────────────────────────────────

/** The claims a minted ticket carries. Mirrors `FlightPrincipal` on the server. */
export interface FlightTicketClaims {
  aud: typeof TICKET_AUDIENCE;
  /** Entra object id of the signed-in caller. */
  oid: string;
  /** Entra UPN of the signed-in caller. */
  upn: string;
  /** Entra tenant id. */
  tid: string;
  /** The abfss:// prefixes / item ids this ticket may read. */
  scope: string[];
  /** Ticket id — the join key between the mint audit row and the redemption log. */
  jti: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

export interface MintedTicket {
  token: string;
  claims: FlightTicketClaims;
  /** True when a signing key was configured (otherwise: in-VNet trust). */
  signed: boolean;
  expiresAt: string;
  ttlSeconds: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signingKey(): string {
  return (process.env.LOOM_FLIGHT_TICKET_SECRET || '').trim();
}

/**
 * Mint a short-lived Flight ticket for an already-authenticated principal.
 *
 * The caller MUST have been authenticated by the route wrapper — this function
 * signs whatever principal it is given and never performs authentication
 * itself. `ttlSeconds` is clamped to [30, {@link MAX_TICKET_TTL_S}] so a caller
 * cannot request an effectively permanent credential.
 */
export function mintFlightTicket(principal: {
  oid: string;
  upn: string;
  tenantId: string;
  scope?: string[];
  ttlSeconds?: number;
  now?: number;
}): MintedTicket {
  const now = Math.floor((principal.now ?? Date.now()) / 1000);
  const ttlSeconds = Math.max(30, Math.min(principal.ttlSeconds ?? DEFAULT_TICKET_TTL_S, MAX_TICKET_TTL_S));
  const claims: FlightTicketClaims = {
    aud: TICKET_AUDIENCE,
    oid: principal.oid,
    upn: principal.upn,
    tid: principal.tenantId,
    scope: (principal.scope || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 32),
    jti: randomUUID(),
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = b64url(JSON.stringify(claims));
  const signed = `${TICKET_VERSION}.${payload}`;
  const key = signingKey();
  const mac = key ? createHmac('sha256', key).update(signed).digest() : Buffer.alloc(0);
  return {
    token: `${signed}.${b64url(mac)}`,
    claims,
    signed: !!key,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    ttlSeconds,
  };
}

/**
 * Verify a ticket this console minted (used by the Connect tab's "check my
 * ticket" affordance and by the tests that pin the shared grammar). Returns the
 * claims, or null when the token is malformed, unsigned-but-required, expired
 * or minted for another audience.
 */
export function verifyFlightTicket(token: string, now = Date.now()): FlightTicketClaims | null {
  const parts = String(token || '').trim().replace(/^bearer\s+/i, '').split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) return null;
  const key = signingKey();
  if (key) {
    const expected = createHmac('sha256', key).update(`${TICKET_VERSION}.${parts[1]}`).digest();
    const presented = Buffer.from(parts[2], 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  }
  let claims: FlightTicketClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as FlightTicketClaims;
  } catch {
    return null;
  }
  if (claims.aud !== TICKET_AUDIENCE) return null;
  if (!claims.exp || claims.exp * 1000 <= now) return null;
  return claims;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection snippets (read-only, NO secrets, never an internal host)
// ─────────────────────────────────────────────────────────────────────────────

export interface FlightSnippet {
  id: 'adbc-python' | 'flight-python' | 'jdbc' | 'adbc-go' | 'curl-ticket';
  label: string;
  language: string;
  note: string;
  code: string;
}

export interface FlightSnippetInput {
  endpoint: FlightEndpointInfo;
  /** Absolute, audited console URL that mints a ticket (never an internal host). */
  ticketMintUrl: string;
  /** An example statement, so the snippet is runnable as pasted. */
  sampleSql?: string;
}

/**
 * Build the Connect-tab snippets. Every snippet:
 *   - reads the ticket from the reader's OWN env var (`LOOM_FLIGHT_TICKET`),
 *     so nothing secret is ever rendered, copied or screenshotted;
 *   - targets the PUBLISHED endpoint, or explains the in-VNet reality; and
 *   - points ticket acquisition at the audited console route.
 */
export function buildFlightSnippets(input: FlightSnippetInput): FlightSnippet[] {
  const uri = input.endpoint.uri || '<published Flight SQL endpoint — see the note above>';
  const sql = input.sampleSql || 'SELECT 1 AS hello';
  const mintUrl = input.ticketMintUrl;

  return [
    {
      id: 'curl-ticket',
      label: 'Mint a ticket',
      language: 'bash',
      note: 'Tickets are short-lived and scoped to you. This call is authenticated by your Loom session and written to the audit trail.',
      code: [
        '# Sign in to Loom in your browser first — this uses your session cookie.',
        `export LOOM_FLIGHT_TICKET="$(curl -sS -X POST '${mintUrl}' \\`,
        "  -H 'content-type: application/json' \\",
        `  --data '{"ttlSeconds":300}' | python -c 'import json,sys; print(json.load(sys.stdin)["ticket"])')"`,
        '',
        '# The ticket expires in minutes. Re-run this when a client reports "ticket expired".',
      ].join('\n'),
    },
    {
      id: 'adbc-python',
      label: 'ADBC (Python)',
      language: 'python',
      note: 'The ADBC Flight SQL driver streams Arrow RecordBatches straight into pandas/Polars — no row-by-row conversion.',
      code: [
        'import os',
        'import adbc_driver_flightsql.dbapi as flight_sql',
        '',
        'conn = flight_sql.connect(',
        `    uri="${uri}",`,
        '    db_kwargs={"adbc.flight.sql.authorization_header": f"Bearer {os.environ[\'LOOM_FLIGHT_TICKET\']}"},',
        ')',
        'with conn.cursor() as cur:',
        `    cur.execute(${JSON.stringify(sql)})`,
        '    table = cur.fetch_arrow_table()   # zero-copy Arrow, not row tuples',
        'print(table.num_rows, table.schema)',
      ].join('\n'),
    },
    {
      id: 'flight-python',
      label: 'Flight (PyArrow)',
      language: 'python',
      note: 'The raw Flight client, for when you want the RecordBatch stream itself.',
      code: [
        'import os',
        'import pyarrow.flight as flight',
        '',
        `client = flight.connect("${uri}")`,
        'options = flight.FlightCallOptions(',
        '    headers=[(b"authorization", f"Bearer {os.environ[\'LOOM_FLIGHT_TICKET\']}".encode())],',
        ')',
        `descriptor = flight.FlightDescriptor.for_command(${JSON.stringify(sql)}.encode())`,
        'info = client.get_flight_info(descriptor, options)',
        'reader = client.do_get(info.endpoints[0].ticket, options)',
        'table = reader.read_all()',
        'print(table.num_rows)',
      ].join('\n'),
    },
    {
      id: 'jdbc',
      label: 'JDBC',
      language: 'text',
      note: 'Apache Arrow Flight SQL JDBC driver — drop-in for any JDBC tool. The token comes from your environment, never from this string.',
      code: [
        '# Driver: org.apache.arrow.driver.jdbc.ArrowFlightJdbcDriver',
        `jdbc:arrow-flight-sql://${hostOf(uri) || '<host>'}:443?useEncryption=true&token=$\{LOOM_FLIGHT_TICKET}`,
        '',
        '# Most tools expand ${LOOM_FLIGHT_TICKET} from the environment. If yours does not,',
        '# paste the ticket into the tool\'s password field — it expires in minutes either way.',
      ].join('\n'),
    },
    {
      id: 'adbc-go',
      label: 'ADBC (Go)',
      language: 'go',
      note: 'Same wire from Go — useful for a service that needs to pull large result sets.',
      code: [
        'import (',
        '    "os"',
        '    "github.com/apache/arrow-adbc/go/adbc"',
        '    "github.com/apache/arrow-adbc/go/adbc/driver/flightsql"',
        ')',
        '',
        'drv := flightsql.NewDriver(memory.DefaultAllocator)',
        'db, err := drv.NewDatabase(map[string]string{',
        `    adbc.OptionKeyURI: "${uri}",`,
        '    "adbc.flight.sql.authorization_header": "Bearer " + os.Getenv("LOOM_FLIGHT_TICKET"),',
        '})',
      ].join('\n'),
    },
  ];
}

/** True when a snippet body is safe to render (no signing key, no ticket value). */
export function snippetIsSecretFree(code: string): boolean {
  const key = signingKey();
  if (key && code.includes(key)) return false;
  // A literal minted ticket would start with the version prefix followed by a
  // base64url payload; the snippets only ever reference the ENV VAR.
  return !/\bv1\.[A-Za-z0-9_-]{20,}\./.test(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited ticket issuance
// ─────────────────────────────────────────────────────────────────────────────

export type FlightAccessOperation = 'flight.ticket.mint' | 'flight.session.create';

export interface FlightAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  operation: FlightAccessOperation;
  ticketId: string;
  scope: string[];
  ttlSeconds: number;
  signed: boolean;
  exposure: FlightExposure;
  outcome: 'success' | 'failure';
  itemId?: string;
  detail?: string;
}

/**
 * Write ONE `_auditLog` row for a ticket mint / session creation and fan it out
 * through the SIEM stream. The row carries `ticketId`, which the serving tier
 * repeats on every redemption line — that pair IS the Flight audit trail.
 */
export async function logFlightAccess(ev: FlightAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const summary =
    `Flight SQL ${ev.operation} for ${ev.actorUpn} (ticket ${ev.ticketId}, ${ev.ttlSeconds}s`
    + `${ev.signed ? ', signed' : ', in-VNet trust'})`
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'flight-sql',
      itemType: 'flight-sql',
      action: ev.operation,
      summary,
      ticketId: ev.ticketId,
      scope: ev.scope,
      ttlSeconds: ev.ttlSeconds,
      signed: ev.signed,
      exposure: ev.exposure,
      outcome: ev.outcome,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[flight-sql] audit row write failed:', (e as Error)?.message || e);
  }

  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: ev.operation,
      targetType: 'flight-sql',
      targetId: ev.ticketId,
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        scope: ev.scope,
        ttlSeconds: ev.ttlSeconds,
        signed: ev.signed,
        exposure: ev.exposure,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
