/**
 * N7e — Trino / Starburst **Federated SQL** engine client. SERVER-ONLY
 * (imports the Cosmos audit trail + the Entra credential chain).
 *
 * ## The tier (the single OPT-IN carve-out of the Openness program)
 *
 * Trino OSS (Apache-2.0) runs as a private cluster on **AKS in the deployment's
 * own VNet** (`platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep`),
 * registered against N1's **Iceberg REST Catalog** (`LOOM_ICEBERG_CATALOG_URL`)
 * plus any external connectors (PostgreSQL, MySQL, Kafka, MongoDB, …). It is a
 * heavy-infra ADDITIVE engine: one SQL statement can JOIN a Loom Iceberg table
 * with an external Postgres table, which the light default (DuckDB N2b) does not
 * do.
 *
 * ## Why this is the ONE opt-in item (loom_default_on_opt_out, round-3 decision)
 *
 * Every other Loom capability is default-ON. Trino is the documented exception:
 * it stands up a full AKS cluster (real, disclosed cost), so it is **opt-in**,
 * selected explicitly by wiring `LOOM_TRINO_URL`. It gates NO feature — SQL Lab
 * is fully functional without it because **DuckDB N2b is the default engine**;
 * Trino only adds a "Federated SQL (Trino)" choice alongside it. The unset state
 * is therefore the intended default posture, disclosed per the G2 gate registry
 * with a Fix-it wizard that names the AKS cost at enable time. Because the light
 * DuckDB path stays fully default-ON, the opt-in posture does not breach
 * loom_default_on_opt_out (the operator's round-3 carve-out).
 *
 * ## Never public
 *
 * The Trino coordinator has INTERNAL ingress only (in-VNet AKS service). The
 * only door is this Console BFF at `/api/sql/trino`, which authenticates the
 * caller (session cookie) and forwards the principal as the Trino user so the
 * cluster's access control + query log attribute every statement. A pre-shared
 * bearer (`LOOM_TRINO_TOKEN`, injected via Key Vault secretRef) is used when the
 * cluster is configured for token auth; otherwise the in-VNet perimeter is the
 * trust boundary (identical posture to the sibling loom-duckdb / iceberg-catalog
 * internal services).
 *
 * ## Audited data plane (ATO)
 *
 * A federated query is an external data-access event, so {@link logTrinoAccess}
 * writes an `_auditLog` row (principal, statement scope, catalogs, rows,
 * outcome, ts) and fans out through `emitAuditEvent`. The audit write is awaited
 * before the response is sent — there is no unaudited path to the cluster.
 *
 * IL5 / SOVEREIGN MOAT: Trino is a self-hosted OSS container on the deployment's
 * own AKS cluster inside the VNet, reading the deployment's own ADLS Gen2 (via
 * the N1 Iceberg catalog) and in-boundary external sources. There is NO SaaS
 * query federation (no Starburst Galaxy, no Athena) in the path, so the whole
 * capability runs disconnected in an air-gapped enclave. No Microsoft Fabric /
 * OneLake / Power BI is reachable from any path here
 * (.claude/rules/no-fabric-dependency.md).
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import { quoteIdent } from '@/lib/sql/quoting';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const TRINO_GATE_ID = 'svc-loom-trino';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const TRINO_FLAG_ID = 'n7e-trino-federation';

/** Honest config gate — the missing env var, or null when the cluster is wired. */
export function trinoConfigGate(): { missing: string } | null {
  return (process.env.LOOM_TRINO_URL || '').trim() ? null : { missing: 'LOOM_TRINO_URL' };
}

/** True when the opt-in Trino federation cluster is deployed + wired. */
export function isTrinoConfigured(): boolean {
  return trinoConfigGate() === null;
}

/** Base URL of the internal Trino coordinator (no trailing slash, scheme-normalized). */
export function trinoBase(): string {
  const raw = (process.env.LOOM_TRINO_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * The Trino catalog name that fronts the Loom Iceberg REST Catalog on the
 * cluster (code default `iceberg`, overridable so an operator whose Trino
 * catalog properties file names it differently still resolves). This is the
 * catalog a federated join references for Loom lake tables.
 */
export function trinoIcebergCatalog(): string {
  return (process.env.LOOM_TRINO_ICEBERG_CATALOG || 'iceberg').trim() || 'iceberg';
}

export class TrinoError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'TrinoError';
    this.status = status;
    this.code = code;
  }
}

/** One column of a Trino result, with its engine-reported type. */
export interface TrinoColumn {
  name: string;
  type: string;
}

/** The normalized result shape (aligned with SqlLabResult so the UI is shared). */
export interface TrinoQueryResult {
  engine: 'trino';
  columns: TrinoColumn[];
  rows: unknown[][];
  rowCount: number;
  /** Wall-clock time the BFF measured, including every statement hop. */
  totalMs: number;
  truncated: boolean;
  maxRows: number;
  /** Distinct Trino catalogs the planner touched — federation receipt material. */
  catalogs: string[];
  /** Why this engine answered — surfaced verbatim in the UI status bar. */
  note?: string;
}

/** Shape of one page of the Trino client REST protocol (`/v1/statement`). */
interface TrinoStatementResponse {
  id?: string;
  nextUri?: string;
  columns?: Array<{ name?: string; type?: string }>;
  data?: unknown[][];
  error?: { message?: string; errorName?: string; errorCode?: number };
  stats?: { state?: string };
}

/**
 * The Entra bearer / static token forwarded on the coordinator hop. A pre-shared
 * bearer (`LOOM_TRINO_TOKEN`, Key Vault secretRef) takes precedence for a Trino
 * configured with token auth; otherwise an Entra token scoped to the cluster's
 * audience is acquired through the shared ACA-first UAMI credential chain. When
 * NEITHER is resolvable the hop proceeds unauthenticated — the cluster has
 * internal ingress and the VNet is the perimeter — but the failure is logged so
 * it is never silent (identical posture to iceberg-catalog-client).
 */
export async function trinoAuthHeader(): Promise<Record<string, string>> {
  const preShared = (process.env.LOOM_TRINO_TOKEN || '').trim();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const audience = (process.env.LOOM_TRINO_AUDIENCE || '').trim()
    || (process.env.LOOM_MSAL_CLIENT_ID ? `api://${process.env.LOOM_MSAL_CLIENT_ID}/.default` : '');
  if (!audience) return {};

  try {
    const token = await uamiArmCredential().getToken(audience);
    if (token?.token) return { authorization: `Bearer ${token.token}` };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[trino] Entra token for %s unavailable: %s', audience, (e as Error)?.message || e);
  }
  return {};
}

/** A safe Trino `X-Trino-User` — the coordinator rejects control chars / spaces. */
function trinoUser(upn: string | undefined): string {
  const u = String(upn || 'loom-console').replace(/[^\w.@-]/g, '_').slice(0, 128);
  return u || 'loom-console';
}

/** GET/POST one page of the statement protocol, mapping failure to TrinoError. */
async function trinoFetch(
  url: string,
  init: { method: 'POST' | 'GET'; body?: string; headers: Record<string, string> },
): Promise<TrinoStatementResponse> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch (e) {
    throw new TrinoError(
      `The Trino coordinator at ${trinoBase()} was unreachable: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  const text = await res.text();
  let body: TrinoStatementResponse | null = null;
  try { body = text ? (JSON.parse(text) as TrinoStatementResponse) : null; } catch { body = null; }
  // 503 with a nextUri is Trino back-pressure (retry the same URI) — the caller
  // loop handles it; only a hard non-2xx WITHOUT a body is a transport failure.
  if (!res.ok && res.status !== 503) {
    throw new TrinoError(
      body?.error?.message || text.slice(0, 400) || `Trino request failed (HTTP ${res.status})`,
      res.status,
      body?.error?.errorName || 'query_failed',
    );
  }
  return body ?? {};
}

/**
 * Run one federated statement on the opt-in Trino cluster via the client REST
 * protocol: POST `/v1/statement`, then follow `nextUri` until the query drains,
 * accumulating columns + rows (bounded by `maxRows` and a hard page cap so a
 * runaway federation can never spin the BFF). Throws {@link TrinoError} —
 * including 503 `not_configured` when `LOOM_TRINO_URL` is unset, so the route
 * renders the honest opt-in gate rather than a fabricated result.
 */
export async function runTrinoQuery(
  sql: string,
  opts: { maxRows?: number; actorUpn?: string; catalog?: string; schema?: string },
): Promise<TrinoQueryResult> {
  if (!isTrinoConfigured()) {
    throw new TrinoError(
      'The Trino federation cluster is not deployed in this environment (LOOM_TRINO_URL is unset). '
      + 'Trino is the one opt-in engine — SQL Lab still runs on DuckDB / Synapse Serverless by default. '
      + 'Deploy platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep and set LOOM_TRINO_URL to enable '
      + 'cross-source Federated SQL.',
      503,
      'not_configured',
    );
  }
  const started = Date.now();
  const maxRows = Math.max(1, Math.min(opts.maxRows ?? 5_000, 200_000));
  const headers: Record<string, string> = {
    'content-type': 'text/plain',
    accept: 'application/json',
    'x-trino-user': trinoUser(opts.actorUpn),
    'x-trino-source': 'csa-loom-sql-lab',
    ...(opts.catalog ? { 'x-trino-catalog': opts.catalog } : {}),
    ...(opts.schema ? { 'x-trino-schema': opts.schema } : {}),
    ...(await trinoAuthHeader()),
  };

  const columns: TrinoColumn[] = [];
  const rows: unknown[][] = [];
  const catalogs = new Set<string>();
  let truncated = false;

  // POST the statement, then walk the nextUri chain (bounded: 5000 pages).
  let page = await trinoFetch(`${trinoBase()}/v1/statement`, { method: 'POST', body: sql, headers });
  const MAX_PAGES = 5_000;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    if (page.error) {
      throw new TrinoError(
        page.error.message || 'Trino query failed',
        400,
        page.error.errorName || 'query_failed',
      );
    }
    if (columns.length === 0 && Array.isArray(page.columns)) {
      for (const c of page.columns) columns.push({ name: String(c?.name ?? ''), type: String(c?.type ?? '') });
    }
    if (Array.isArray(page.data)) {
      for (const r of page.data) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(r as unknown[]);
      }
    }
    if (!page.nextUri || (truncated && rows.length >= maxRows)) break;
    // nextUri is an absolute URL the coordinator hands back; follow it verbatim.
    page = await trinoFetch(page.nextUri, { method: 'GET', headers });
  }

  return {
    engine: 'trino',
    columns,
    rows,
    rowCount: rows.length,
    totalMs: Date.now() - started,
    truncated,
    maxRows,
    catalogs: Array.from(catalogs),
    note:
      'Executed on the opt-in Trino federation cluster (AKS, in your VNet). Federated SQL can join Loom '
      + 'Iceberg tables with external sources in one statement.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-source join builder (server-built — identifiers go through the quoting
// helper, never inline). Trino uses ANSI delimited identifiers ("cat"."sch"."t").
// ─────────────────────────────────────────────────────────────────────────────

/** A fully-qualified Trino table in Loom's own coordinates. */
export interface TrinoTableRef {
  /** Trino catalog (e.g. the Iceberg catalog `iceberg`, or an external `postgres`). */
  catalog: string;
  schema: string;
  table: string;
}

/** Validate one identifier level (catalog / schema / table). */
function assertTrinoIdent(value: string, kind: string): string {
  const v = String(value ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(v)) {
    throw new TrinoError(`"${v}" is not a valid Trino ${kind} identifier`, 400, 'invalid_identifier');
  }
  return v;
}

/**
 * Build the `"catalog"."schema"."table"` reference for a Trino table, each level
 * validated and bracketed via the shared `quoteIdent(name, 'trino')` (ANSI
 * double-quote, injection-safe) — never inline-escaped (.claude sql-quoting rule).
 */
export function trinoTableRef(ref: TrinoTableRef): string {
  const catalog = assertTrinoIdent(ref.catalog, 'catalog');
  const schema = assertTrinoIdent(ref.schema, 'schema');
  const table = assertTrinoIdent(ref.table, 'table');
  return [catalog, schema, table].map((p) => quoteIdent(p, 'trino')).join('.');
}

/**
 * Build a well-formed cross-source join statement: the canonical N7e federation
 * example — a Loom Iceberg table joined to an external source (e.g. Postgres) in
 * ONE statement. Identifiers are all resolved through {@link trinoTableRef} /
 * {@link quoteIdent}. `columns` is a whitelist of already-validated projection
 * expressions (caller-controlled, defaulting to `*`).
 */
export function buildFederatedJoinSql(args: {
  left: TrinoTableRef;
  right: TrinoTableRef;
  /** Equi-join key pairs: [leftColumn, rightColumn][]. */
  on: Array<[string, string]>;
  columns?: string[];
  limit?: number;
}): string {
  const left = trinoTableRef(args.left);
  const right = trinoTableRef(args.right);
  if (!Array.isArray(args.on) || args.on.length === 0) {
    throw new TrinoError('A federated join needs at least one ON key pair.', 400, 'invalid_join');
  }
  const onClause = args.on
    .map(([l, r]) => `l.${quoteIdent(assertTrinoIdent(l, 'column'), 'trino')} `
      + `= r.${quoteIdent(assertTrinoIdent(r, 'column'), 'trino')}`)
    .join(' AND ');
  const projection = args.columns && args.columns.length ? args.columns.join(', ') : '*';
  const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 100), 200_000));
  return `SELECT ${projection} FROM ${left} AS l JOIN ${right} AS r ON ${onClause} LIMIT ${limit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

export interface TrinoAccessEvent {
  actorOid: string;
  actorUpn: string;
  tenantId: string;
  /** The statement (truncated in the row) — the "scope" of a federated access. */
  sql: string;
  /** Distinct Trino catalogs the planner touched (federation footprint). */
  catalogs?: string[];
  workspaceId?: string;
  itemId?: string;
  outcome: 'success' | 'failure';
  rowCount?: number;
  elapsedMs?: number;
  detail?: string;
}

/**
 * Write ONE `_auditLog` data-access row for a federated Trino query and fan it
 * out through the SIEM / webhook audit stream. Best-effort by design: an
 * audit-store failure must never turn a successful read into a 500, but it IS
 * logged.
 */
export async function logTrinoAccess(ev: TrinoAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const statement = (ev.sql || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const catalogs = (ev.catalogs || []).filter(Boolean);
  const summary =
    `Federated SQL (Trino) query by ${ev.actorUpn}`
    + (catalogs.length ? ` across ${catalogs.join(', ')}` : '')
    + (ev.rowCount === undefined ? '' : ` (${ev.rowCount} row(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: ev.itemId || 'sql-lab',
      itemType: 'sql-lab',
      action: 'trino.sql.query',
      summary,
      engine: 'trino',
      statement,
      catalogs,
      workspaceId: ev.workspaceId || '',
      outcome: ev.outcome,
      rowCount: ev.rowCount ?? null,
      elapsedMs: ev.elapsedMs ?? null,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[trino] audit row write failed:', (e as Error)?.message || e);
  }

  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: 'trino.sql.query',
      targetType: 'sql-lab',
      targetId: ev.itemId || 'sql-lab',
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        engine: 'trino',
        statement,
        catalogs,
        workspaceId: ev.workspaceId || '',
        rowCount: ev.rowCount ?? null,
        elapsedMs: ev.elapsedMs ?? null,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
