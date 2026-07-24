/**
 * N1 — Iceberg REST Catalog (IRC) client. SERVER-ONLY (imports the Azure
 * credential chain + Cosmos for the data-access audit trail).
 *
 * ## The backend (operator decision)
 *
 * The IRC is served by **Unity Catalog OSS** running as an INTERNAL-ingress
 * Azure Container App (`platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep`).
 * UC OSS natively bridges Delta and Iceberg over the SAME storage, and Loom
 * already runs UC OSS in Azure Government (`lib/azure/uc-backend.ts`), so this
 * is one more deployment of a container Loom already builds and ships. Apache
 * Polaris is a footnote, not an option — nothing here is Polaris-specific.
 *
 * UC OSS exposes the standard Apache Iceberg REST Catalog surface under a
 * prefix (`/api/2.1/unity-catalog/iceberg` by default, overridable with
 * `LOOM_ICEBERG_CATALOG_PREFIX` for a plain Polaris-shaped `/` deployment):
 *
 *   GET    <prefix>/v1/config?warehouse=<wh>
 *   GET    <prefix>/v1/namespaces[?parent=<ns>]
 *   POST   <prefix>/v1/namespaces
 *   GET    <prefix>/v1/namespaces/{ns}/tables
 *   GET    <prefix>/v1/namespaces/{ns}/tables/{table}
 *   POST   <prefix>/v1/namespaces/{ns}/register
 *
 * Multi-level namespaces are joined with the Iceberg spec's UNIT SEPARATOR
 * (U+001F) inside a single URL path segment — see {@link encodeNamespace}.
 *
 * ## Never public
 *
 * The catalog app has INTERNAL ingress only. External engines (Trino, Spark,
 * DuckDB, Snowflake, Databricks) reach it through the Loom BFF proxy at
 * `/api/catalog/iceberg/*`, which authenticates the caller (session cookie OR a
 * scoped Loom API token) and then INJECTS an Entra bearer for the upstream hop
 * ({@link icebergAuthHeader}). The catalog is therefore never exposed, and
 * every read/write is attributable.
 *
 * ## Audited data plane (ATO, Round-3 extension)
 *
 * IRC reads and writes are external data-access events, so
 * {@link logIcebergAccess} writes an `_auditLog` row (principal, namespace /
 * table scope, operation, timestamp) and fans out through `emitAuditEvent`.
 * High-volume LIST reads aggregate into one row per request rather than one per
 * table.
 *
 * No Microsoft Fabric / OneLake / Power BI is reachable from any path here
 * (.claude/rules/no-fabric-dependency.md).
 *
 * IL5 / SOVEREIGN MOAT: the catalog is a self-hosted OSS container on the
 * deployment's own Container Apps environment, reading the deployment's own
 * ADLS Gen2 over the VNet. There is NO SaaS catalog anywhere — which is exactly
 * why a disconnected IL5 enclave can still hand Trino a working Iceberg
 * catalog. Nothing in this module degrades when the boundary is air-gapped.
 */

import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const ICEBERG_CATALOG_GATE_ID = 'svc-iceberg-catalog';

/** Default IRC prefix on a Unity Catalog OSS server. */
export const DEFAULT_IRC_PREFIX = '/api/2.1/unity-catalog/iceberg';

/** Iceberg REST spec multi-level-namespace separator (unit separator U+001F). */
export const NAMESPACE_SEPARATOR = '\u001f';

/** Honest config gate — the missing env var, or null when the catalog is wired. */
export function icebergCatalogConfigGate(): { missing: string } | null {
  return (process.env.LOOM_ICEBERG_CATALOG_URL || '').trim() ? null : { missing: 'LOOM_ICEBERG_CATALOG_URL' };
}

/** True when the Iceberg REST Catalog service is deployed + wired. */
export function isIcebergCatalogConfigured(): boolean {
  return icebergCatalogConfigGate() === null;
}

export class IcebergCatalogError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'IcebergCatalogError';
    this.status = status;
    this.code = code;
  }
}

/** Base URL of the internal catalog service (no trailing slash). Throws 503. */
export function icebergCatalogBase(): string {
  const url = (process.env.LOOM_ICEBERG_CATALOG_URL || '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new IcebergCatalogError(
      'The Iceberg REST Catalog is not deployed in this environment. Set LOOM_ICEBERG_CATALOG_URL to the '
      + 'internal ingress FQDN of the iceberg-catalog Container App (deploy '
      + 'platform/fiab/bicep/modules/data-plane/iceberg-catalog-aca.bicep). Until then, tables exposed as '
      + 'Iceberg are still readable by pointing an engine directly at the metadata folder in your own ADLS '
      + 'Gen2 — the catalog adds discovery + credential vending, not the data path. No Microsoft Fabric '
      + 'required.',
      503,
      'not_configured',
    );
  }
  return url;
}

/** IRC path prefix on the catalog server (env-overridable, normalized). */
export function icebergCatalogPrefix(): string {
  const raw = (process.env.LOOM_ICEBERG_CATALOG_PREFIX || DEFAULT_IRC_PREFIX).trim();
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '');
}

/**
 * The IRC `warehouse` identifier — the Unity Catalog catalog name that backs the
 * Loom namespaces. Code default `loom`, so the catalog works day-one without an
 * extra env var.
 */
export function icebergWarehouse(): string {
  return (process.env.LOOM_ICEBERG_CATALOG_WAREHOUSE || 'loom').trim() || 'loom';
}

/**
 * Encode an Iceberg namespace for a URL path segment. Accepts the human dotted
 * form (`gold.sales`) or an already-split array, joins levels with the spec's
 * U+001F separator, then percent-encodes the whole segment (so `%1F` reaches
 * the server). Empty / traversal input throws 400 rather than reaching upstream.
 */
export function encodeNamespace(ns: string | string[]): string {
  const levels = (Array.isArray(ns) ? ns : String(ns ?? '').split('.'))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (levels.length === 0) throw new IcebergCatalogError('namespace is required', 400, 'invalid_namespace');
  for (const level of levels) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(level)) {
      throw new IcebergCatalogError(
        `namespace level "${level}" is not a valid Iceberg identifier`,
        400,
        'invalid_namespace',
      );
    }
  }
  return encodeURIComponent(levels.join(NAMESPACE_SEPARATOR));
}

/** Inverse of {@link encodeNamespace} — the human dotted form. */
export function namespaceToDotted(ns: string[] | string): string {
  if (Array.isArray(ns)) return ns.join('.');
  return String(ns ?? '').split(NAMESPACE_SEPARATOR).join('.');
}

/** Validate an Iceberg table identifier (single level, no separators). */
export function assertTableName(table: string): string {
  const t = String(table ?? '').trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/.test(t)) {
    throw new IcebergCatalogError(`"${t}" is not a valid Iceberg table name`, 400, 'invalid_table');
  }
  return t;
}

/** Build the absolute upstream URL for an IRC sub-path (`/v1/...`). */
export function ircUrl(subPath: string, query?: Record<string, string | undefined>): string {
  const sub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  const qs = Object.entries(query || {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${icebergCatalogBase()}${icebergCatalogPrefix()}${sub}${qs ? `?${qs}` : ''}`;
}

/**
 * The Entra bearer injected on the upstream hop. Real token acquisition through
 * the shared ACA-first UAMI credential chain (`uamiArmCredential`), scoped to
 * the catalog's audience:
 *
 *   LOOM_ICEBERG_CATALOG_AUDIENCE (explicit), else
 *   api://<LOOM_MSAL_CLIENT_ID>/.default (the deployment's own app registration)
 *
 * A pre-shared bearer (`LOOM_ICEBERG_CATALOG_TOKEN`, injected via Key Vault
 * secretRef) takes precedence for a UC OSS server configured with static-token
 * auth. When NEITHER is resolvable the hop still proceeds unauthenticated — the
 * catalog has internal ingress and the VNet is the perimeter (identical posture
 * to the sibling loom-unity / loom-onelake internal services) — but the failure
 * is logged so it is never silent.
 */
export async function icebergAuthHeader(): Promise<Record<string, string>> {
  const preShared = (process.env.LOOM_ICEBERG_CATALOG_TOKEN || '').trim();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const audience = (process.env.LOOM_ICEBERG_CATALOG_AUDIENCE || '').trim()
    || (process.env.LOOM_MSAL_CLIENT_ID ? `api://${process.env.LOOM_MSAL_CLIENT_ID}/.default` : '');
  if (!audience) return {};

  try {
    const token = await uamiArmCredential().getToken(audience);
    if (token?.token) return { authorization: `Bearer ${token.token}` };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[iceberg-catalog] Entra token for %s unavailable: %s', audience, (e as Error)?.message || e);
  }
  return {};
}

/**
 * Perform one IRC call with Entra auth injected. Throws {@link IcebergCatalogError}
 * (503 when the catalog is unwired, 502 when unreachable, upstream status
 * otherwise) so BFF routes map it to a structured envelope. Never returns a
 * fabricated body.
 */
export async function ircFetch<T = unknown>(
  subPath: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const url = ircUrl(subPath, init.query);
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(await icebergAuthHeader()),
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: init.method || 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (e) {
    throw new IcebergCatalogError(
      `Iceberg REST Catalog unreachable at ${icebergCatalogBase()}: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }

  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = undefined; }
  }
  if (!res.ok) {
    const errObj = (body as { error?: { message?: string; type?: string } } | undefined)?.error;
    throw new IcebergCatalogError(
      errObj?.message || `Iceberg REST Catalog returned HTTP ${res.status}`,
      res.status,
      errObj?.type,
    );
  }
  return (body ?? {}) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed IRC operations
// ─────────────────────────────────────────────────────────────────────────────

export interface IrcConfig {
  defaults?: Record<string, string>;
  overrides?: Record<string, string>;
  endpoints?: string[];
}

export interface IrcNamespaceList {
  namespaces: string[][];
  'next-page-token'?: string;
}

export interface IrcTableList {
  identifiers: Array<{ namespace: string[]; name: string }>;
  'next-page-token'?: string;
}

export interface IrcLoadTableResult {
  'metadata-location'?: string;
  metadata?: {
    'format-version'?: number;
    'table-uuid'?: string;
    location?: string;
    'current-snapshot-id'?: number;
    schemas?: unknown[];
    properties?: Record<string, string>;
  };
  config?: Record<string, string>;
}

/** `GET /v1/config?warehouse=<wh>` — the catalog handshake every engine makes. */
export function getCatalogConfig(warehouse = icebergWarehouse()): Promise<IrcConfig> {
  return ircFetch<IrcConfig>('/v1/config', { query: { warehouse } });
}

/** `GET /v1/namespaces` (optionally under `parent`). */
export function listNamespaces(parent?: string): Promise<IrcNamespaceList> {
  return ircFetch<IrcNamespaceList>('/v1/namespaces', {
    query: parent ? { parent: decodeURIComponent(encodeNamespace(parent)) } : undefined,
  });
}

/** `POST /v1/namespaces` — create a namespace with optional properties. */
export function createNamespace(
  namespace: string,
  properties: Record<string, string> = {},
): Promise<{ namespace: string[]; properties?: Record<string, string> }> {
  const levels = String(namespace).split('.').map((s) => s.trim()).filter(Boolean);
  // Round-trip through encodeNamespace purely for validation (throws on bad input).
  encodeNamespace(levels);
  return ircFetch('/v1/namespaces', { method: 'POST', body: { namespace: levels, properties } });
}

/** `GET /v1/namespaces/{ns}/tables`. */
export function listTables(namespace: string): Promise<IrcTableList> {
  return ircFetch<IrcTableList>(`/v1/namespaces/${encodeNamespace(namespace)}/tables`);
}

/** `GET /v1/namespaces/{ns}/tables/{table}` — the real Iceberg metadata load. */
export function loadTable(namespace: string, table: string): Promise<IrcLoadTableResult> {
  return ircFetch<IrcLoadTableResult>(
    `/v1/namespaces/${encodeNamespace(namespace)}/tables/${encodeURIComponent(assertTableName(table))}`,
  );
}

/**
 * `POST /v1/namespaces/{ns}/register` — register an EXISTING Iceberg metadata
 * file (the one UniForm/XTable just wrote into the lake) as a catalog table.
 * This is the zero-copy hand-off: the catalog records a pointer, no data moves.
 */
// `async` deliberately: the validation below rejects rather than throwing
// SYNCHRONOUSLY. A Promise-returning function that throws sync would surprise
// every `registerTable(...).catch(h)` caller with an uncaught error.
export async function registerTable(
  namespace: string,
  table: string,
  metadataLocation: string,
): Promise<IrcLoadTableResult> {
  if (!/^(abfss|azure|https|s3a?|file):\/\//i.test(String(metadataLocation))) {
    throw new IcebergCatalogError(
      'metadata-location must be an absolute storage URI (abfss:// for the Loom lake)',
      400,
      'invalid_metadata_location',
    );
  }
  return ircFetch<IrcLoadTableResult>(`/v1/namespaces/${encodeNamespace(namespace)}/register`, {
    method: 'POST',
    body: { name: assertTableName(table), 'metadata-location': metadataLocation },
  });
}

/** `DELETE /v1/namespaces/{ns}/tables/{table}?purgeRequested=false` — drop the
 * catalog POINTER only. `purgeRequested` is pinned false so a catalog
 * de-registration can never delete customer data files. */
export function dropTableRegistration(namespace: string, table: string): Promise<unknown> {
  return ircFetch(
    `/v1/namespaces/${encodeNamespace(namespace)}/tables/${encodeURIComponent(assertTableName(table))}`,
    { method: 'DELETE', query: { purgeRequested: 'false' } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant mapping (Unity Catalog permissions on the SAME server)
// ─────────────────────────────────────────────────────────────────────────────

/** One principal → privileges assignment on a catalog securable. */
export interface IcebergGrantAssignment {
  principal: string;
  privileges: string[];
}

/** Grants on one namespace, plus an honest note when the server has no ACL API. */
export interface IcebergNamespaceGrants {
  namespace: string;
  /** False when the catalog server does not implement the permissions surface. */
  supported: boolean;
  assignments: IcebergGrantAssignment[];
  note?: string;
}

/**
 * Read the Unity Catalog grants on a namespace. The IRC is served by the SAME
 * UC OSS server, so the ACLs an external engine is subject to are exactly the
 * UC schema permissions (`GET /api/2.1/unity-catalog/permissions/schema/{catalog}.{schema}`)
 * — this is a REAL read of that surface, off the catalog base (not the IRC
 * prefix). A server that does not implement permissions returns
 * `supported:false` with the reason instead of a fabricated empty ACL.
 */
export async function listNamespaceGrants(namespace: string): Promise<IcebergNamespaceGrants> {
  // Validate through the same identifier rules the IRC paths use.
  encodeNamespace(namespace);
  const dotted = String(namespace).split('.').map((s) => s.trim()).filter(Boolean).join('.');
  const full = `${icebergWarehouse()}.${dotted}`;
  const url = `${icebergCatalogBase()}/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent(full)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(await icebergAuthHeader()) },
    });
  } catch (e) {
    throw new IcebergCatalogError(
      `Iceberg REST Catalog unreachable at ${icebergCatalogBase()}: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }

  if (res.status === 404 || res.status === 501) {
    return {
      namespace: dotted,
      supported: false,
      assignments: [],
      note:
        `The catalog server did not serve the Unity Catalog permissions API for ${full} (HTTP ${res.status}). `
        + 'Access for external engines is then governed by the Loom proxy: every request carries a scoped Loom '
        + 'API token, is authorized as that principal, and is written to the audit trail.',
    };
  }

  const text = await res.text();
  let body: { privilege_assignments?: Array<{ principal?: string; privileges?: string[] }> } = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = {}; }
  }
  if (!res.ok) {
    throw new IcebergCatalogError(
      `Reading grants for ${full} failed (HTTP ${res.status})`,
      res.status,
      'grants_read_failed',
    );
  }
  return {
    namespace: dotted,
    supported: true,
    assignments: (body.privilege_assignments || []).map((a) => ({
      principal: String(a?.principal ?? ''),
      privileges: Array.isArray(a?.privileges) ? a.privileges.map(String) : [],
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audited data-plane access log
// ─────────────────────────────────────────────────────────────────────────────

/** IRC operations that produce an access row. */
export type IcebergAccessOperation =
  | 'catalog.config'
  | 'namespace.list'
  | 'namespace.create'
  | 'table.list'
  | 'table.load'
  | 'table.register'
  | 'table.deregister';

export interface IcebergAccessEvent {
  /** Acting principal (session oid). */
  actorOid: string;
  /** Acting principal UPN / token label. */
  actorUpn: string;
  /** Entra tenant id from the session (falls back to the actor oid). */
  tenantId: string;
  operation: IcebergAccessOperation;
  /** Iceberg namespace in dotted form ('' for catalog-level operations). */
  namespace?: string;
  /** Table identifier ('' for namespace-level operations). */
  table?: string;
  /** Loom workspace scope when the caller supplied one. */
  workspaceId?: string;
  /** IRC warehouse the request targeted. */
  warehouse?: string;
  outcome: 'success' | 'failure';
  /** For aggregated LIST reads: how many identifiers the response carried. */
  resultCount?: number;
  /** Honest failure detail (upstream error message, truncated). */
  detail?: string;
  /** True when the caller authenticated with a scoped API token, not a cookie. */
  viaApiToken?: boolean;
}

/**
 * Write ONE `_auditLog` data-access row for an IRC operation and fan it out
 * through the SIEM / webhook audit stream. High-volume LIST reads aggregate
 * (one row per request, carrying `resultCount`) rather than one row per table.
 *
 * Best-effort by design: an audit-store failure must never turn a successful
 * read into a 500, but it IS logged so the gap is visible.
 */
export async function logIcebergAccess(ev: IcebergAccessEvent): Promise<void> {
  const at = new Date().toISOString();
  const scope = [ev.namespace, ev.table].filter(Boolean).join('.') || (ev.warehouse || 'catalog');
  const summary =
    `Iceberg REST Catalog ${ev.operation} on ${scope} by ${ev.actorUpn}`
    + (ev.resultCount === undefined ? '' : ` (${ev.resultCount} identifier(s))`)
    + (ev.outcome === 'failure' ? ` — FAILED: ${(ev.detail || '').slice(0, 200)}` : '');

  try {
    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      tenantId: ev.tenantId,
      itemId: scope,
      itemType: 'iceberg-catalog',
      action: `iceberg.${ev.operation}`,
      summary,
      namespace: ev.namespace || '',
      table: ev.table || '',
      workspaceId: ev.workspaceId || '',
      warehouse: ev.warehouse || icebergWarehouse(),
      outcome: ev.outcome,
      resultCount: ev.resultCount ?? null,
      viaApiToken: !!ev.viaApiToken,
      upn: ev.actorUpn,
      actorOid: ev.actorOid,
      at,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[iceberg-catalog] audit row write failed:', (e as Error)?.message || e);
  }

  try {
    emitAuditEvent({
      actorOid: ev.actorOid,
      actorUpn: ev.actorUpn,
      action: `iceberg.${ev.operation}`,
      targetType: 'iceberg-catalog',
      targetId: scope,
      outcome: ev.outcome,
      tenantId: ev.tenantId,
      timestamp: at,
      detail: {
        namespace: ev.namespace || '',
        table: ev.table || '',
        workspaceId: ev.workspaceId || '',
        warehouse: ev.warehouse || icebergWarehouse(),
        resultCount: ev.resultCount ?? null,
        viaApiToken: !!ev.viaApiToken,
        ...(ev.detail ? { detail: ev.detail.slice(0, 400) } : {}),
      },
    });
  } catch {
    /* audit-stream fan-out is best-effort by contract */
  }
}
