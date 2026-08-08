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
import { recordDatabricksUnityAccess } from '@/lib/azure/unity-audit';
import { isUnreachableServiceUrl } from '@/lib/azure/unreachable-url';
import { trimSlashes } from '@/lib/util/trim';

/** Registry gate id — mirrors the ENV_CHECKS spec in env-checks/data-plane.ts. */
export const ICEBERG_CATALOG_GATE_ID = 'svc-iceberg-catalog';

/** Default IRC prefix on a Unity Catalog OSS server. */
export const DEFAULT_IRC_PREFIX = '/api/2.1/unity-catalog/iceberg';

/** Iceberg REST spec multi-level-namespace separator (unit separator U+001F). */
export const NAMESPACE_SEPARATOR = '\u001f';

/** Honest config gate — the missing env var, or null when the catalog is wired. */
export function icebergCatalogConfigGate(): { missing: string } | null {
  const url = (process.env.LOOM_ICEBERG_CATALOG_URL || '').trim();
  // Empty OR a value that can't be a real remote catalog (a bind address / a
  // circular self-reference) → gated. A placeholder like 0.0.0.0:3000 must show
  // the honest "not configured" gate, not pass through to an "unreachable" fetch.
  return url && !isUnreachableCatalogUrl(url) ? null : { missing: 'LOOM_ICEBERG_CATALOG_URL' };
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
  if (!url || isUnreachableCatalogUrl(url)) {
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

/**
 * A `LOOM_ICEBERG_CATALOG_URL` value that CANNOT be a real remote catalog and
 * should be treated as unconfigured (→ the honest 503 gate) instead of being
 * fetched into an ugly "unreachable at …" error.
 *
 * Observed live (Commercial console): the placeholder
 * `https://0.0.0.0:3000/api/catalog/iceberg` was sitting in the env — a dev
 * BIND address (0.0.0.0 / :: are listen-on-all, never a connect target) that
 * also circularly points back at Loom's OWN BFF proxy path. Fetching it fails,
 * so the surface showed "Iceberg REST Catalog unreachable at https://0.0.0.0…"
 * instead of the designed "not configured — dual metadata still works" gate.
 * A stale/placeholder value must degrade to the same honest state as unset.
 */
export function isUnreachableCatalogUrl(raw: string): boolean {
  // ONE implementation, shared with lib/admin/env-checks (which cannot import
  // this server-only module). The health gate used to disagree with the runtime
  // about this exact value and reported the estate green while every request
  // 503'd — see lib/azure/unreachable-url.ts for the full account.
  //
  // The second argument is the iceberg-specific circular case: a value pointing
  // back at this app's OWN BFF proxy is not a catalog.
  return isUnreachableServiceUrl(raw, /\/api\/catalog\/iceberg(\/|$)/);
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

/**
 * Insert the Iceberg REST Catalog **`prefix`** into a `/v1/...` sub-path.
 *
 * PURE, so the routing decision is assertable offline — the alternative is a
 * decision only exercisable against a live catalog, i.e. one nobody notices has
 * gone wrong. It went wrong for the entire life of this client.
 *
 * The Iceberg REST spec defines `prefix` as a path element between `/v1/` and
 * the resource: `GET /v1/{prefix}/namespaces`. A server returns it from the
 * `/v1/config` handshake in `overrides.prefix`, and a conforming client MUST
 * apply it to every subsequent request.
 *
 * MEASURED (upstream `IcebergRestCatalogService`, read at BOTH tags this image
 * ships — v0.5.0 base + the v0.5.1 server overlay, see apps/loom-unity/Dockerfile):
 *
 *   PREFIX_BASE = "catalogs/"
 *   config()  -> ConfigResponse.withOverride("prefix", PREFIX_BASE + catalog)
 *   @Get("/v1/catalogs/{catalog}/namespaces")
 *   @Get("/v1/catalogs/{catalog}/namespaces/{namespace}/tables")
 *   @Get("/v1/catalogs/{catalog}/namespaces/{namespace}/tables/{table}")
 *
 * There is **no `/v1/namespaces` route on this server at all** — which is what
 * this client called until now. And the miss does not surface as a 404: the
 * `UnityAccessDecorator` is bound as a ROUTE DECORATOR over the whole
 * `/api/2.1/unity-catalog/` prefix (`UnityCatalogServer`), so an unmatched path
 * under it still enters the decorator, `findServiceMethod` returns null, and the
 * request dies on `RuntimeException("Couldn't unwrap service.")` — an opaque
 * **HTTP 500**. That is exactly the 500 the live Commercial console measured on
 * `GET /api/catalog/iceberg/namespaces`, and it is why it looked like a server
 * fault rather than a client one.
 */
export function ircPathWithPrefix(subPath: string, prefix: string): string {
  const sub = subPath.startsWith('/') ? subPath : `/${subPath}`;
  // `trimSlashes`, not `.replace(/^\/+|\/+$/g, '')` — the regex form is the
  // quadratic trailing-run shape the repo's `quadratic-trims` guard rejects,
  // and this value arrives from an upstream HTTP response body.
  const p = trimSlashes(String(prefix ?? ''));
  // Only `/v1/*` resources are prefixed. `/v1/config` is the handshake that
  // PRODUCES the prefix, so it is never itself prefixed (see icebergFetchRaw).
  if (!p || !sub.startsWith('/v1/')) return sub;
  return `/v1/${p}${sub.slice('/v1'.length)}`;
}

/**
 * Resolved IRC prefix, cached per (base, mount-prefix, warehouse).
 *
 * The handshake is one extra round trip on a cold path, not per call. The cache
 * is cleared whenever a prefixed call comes back 404/500 so a catalog that was
 * re-provisioned, renamed, or restarted onto a different warehouse RE-HANDSHAKES
 * rather than repeating a stale path — `.claude/rules/auto-bind-by-default.md` §3
 * (a stale binding is repaired automatically, never shown to the user).
 */
const ircPrefixCache = new Map<string, string>();

/** Test seam + self-heal hook — drop every memoized IRC prefix. */
export function resetIcebergPrefixCache(): void {
  ircPrefixCache.clear();
}

function ircPrefixCacheKey(warehouse: string): string {
  return `${icebergCatalogBase()}|${icebergCatalogPrefix()}|${warehouse}`;
}

/**
 * Perform the `/v1/config?warehouse=<wh>` handshake and return the server's
 * `prefix` override (`''` when the server declares none — a plain Polaris-shaped
 * catalog, which is legal).
 *
 * FAILS LOUD, never guesses. If the handshake cannot be completed the error
 * propagates with its real status, so the caller reports "the catalog refused
 * the handshake (HTTP 403)" instead of fabricating a path and reporting the
 * unrelated 500 that path produces. Inventing `catalogs/<warehouse>` here would
 * be a message asserting something the code never established
 * (`.claude/rules/deploy-integrity.md` R7).
 */
export async function resolveIrcPrefix(warehouse = icebergWarehouse()): Promise<string> {
  const key = ircPrefixCacheKey(warehouse);
  const hit = ircPrefixCache.get(key);
  if (hit !== undefined) return hit;
  const cfg = await ircFetchRaw<IrcConfig>('/v1/config', { query: { warehouse } });
  const prefix = String(cfg?.overrides?.prefix ?? cfg?.defaults?.prefix ?? '');
  ircPrefixCache.set(key, prefix);
  return prefix;
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
 * The bearer injected on the upstream hop.
 *
 * A pre-shared bearer (`LOOM_ICEBERG_CATALOG_TOKEN`, injected via Key Vault
 * secretRef) takes precedence for a UC OSS server configured with static-token
 * auth.
 *
 * Otherwise: mint an Entra token through the shared ACA-first UAMI credential
 * chain (`uamiArmCredential`), scoped to the catalog's audience —
 *
 *   LOOM_ICEBERG_CATALOG_AUDIENCE (explicit), else
 *   api://<LOOM_MSAL_CLIENT_ID>/.default (the deployment's own app registration)
 *
 * — and then **exchange it** for a server-minted internal token, which is what
 * actually goes on the wire.
 *
 * That exchange is not optional (F1). The Iceberg REST Catalog is the loom-unity
 * image, whose AuthDecorator rejects any bearer whose `iss` is not its own
 * `internal` issuer — so presenting the raw Entra token is answered **403 even
 * with a byte-exact audience**. That is exactly what the live Commercial console
 * did: `GET /api/catalog/iceberg/namespaces` returned
 * `{"error":"Iceberg REST Catalog returned HTTP 403"}` in ~307ms, warm and
 * reproducible, while the sibling Unity path — which has done the exchange since
 * #2679 — worked. The helper existed; this caller had never adopted it.
 *
 * The exchange is performed against THIS catalog's base, not `LOOM_UNITY_URL`:
 * `iceberg-catalog` and `loom-unity` are separate Container Apps with separate
 * databases and separate minted-token state, so a token minted by one is not
 * honoured by the other.
 *
 * When no audience is resolvable the hop still proceeds unauthenticated — the
 * catalog has internal ingress and the VNet is the perimeter (identical posture
 * to the sibling loom-unity / loom-onelake internal services) — but the failure
 * is logged so it is never silent. A FAILED EXCHANGE, by contrast, throws: the
 * fallback of retrying with the raw Entra token would either 403 opaquely or —
 * far worse — succeed against a server running with authorization disabled, and
 * so hide the very misconfiguration it should surface.
 */
export async function icebergAuthHeader(): Promise<Record<string, string>> {
  const preShared = (process.env.LOOM_ICEBERG_CATALOG_TOKEN || '').trim();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const audience = (process.env.LOOM_ICEBERG_CATALOG_AUDIENCE || '').trim()
    || (process.env.LOOM_MSAL_CLIENT_ID ? `api://${process.env.LOOM_MSAL_CLIENT_ID}/.default` : '');
  if (!audience) return {};

  let entraToken: string | undefined;
  try {
    entraToken = (await uamiArmCredential().getToken(audience))?.token;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[iceberg-catalog] Entra token for %s unavailable: %s', audience, (e as Error)?.message || e);
    return {};
  }
  if (!entraToken) return {};

  const { exchangeForInternalUcToken } = await import('@/lib/azure/uc-token-exchange');
  const internal = await exchangeForInternalUcToken(entraToken, icebergCatalogBase());
  return { authorization: `Bearer ${internal}` };
}

/**
 * Perform one IRC call with Entra auth injected, at the LITERAL sub-path — no
 * `prefix` resolution. Used for the `/v1/config` handshake itself (which is what
 * produces the prefix) and as the transport under {@link ircFetch}.
 *
 * Throws {@link IcebergCatalogError} (503 when the catalog is unwired, 502 when
 * unreachable, upstream status otherwise) so BFF routes map it to a structured
 * envelope. Never returns a fabricated body.
 */
export async function ircFetchRaw<T = unknown>(
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

/**
 * Perform one IRC **resource** call: handshake for the server's `prefix`, apply
 * it per the Iceberg REST spec, then call. Every `/v1/*` operation other than
 * the handshake itself goes through here.
 *
 * On a 404/500 the memoized prefix is dropped so the NEXT call re-handshakes —
 * the self-healing half of `auto-bind-by-default.md` §3. Those two statuses are
 * precisely the ones a stale prefix produces on this server (a renamed/absent
 * warehouse, or a path that no longer matches a route).
 */
export async function ircFetch<T = unknown>(
  subPath: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const prefix = await resolveIrcPrefix();
  try {
    return await ircFetchRaw<T>(ircPathWithPrefix(subPath, prefix), init);
  } catch (e) {
    const status = e instanceof IcebergCatalogError ? e.status : 0;
    if (status === 404 || status === 500) resetIcebergPrefixCache();
    throw e;
  }
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

/**
 * `GET /v1/config?warehouse=<wh>` — the catalog handshake every engine makes.
 *
 * Deliberately on {@link ircFetchRaw}: this call is what PRODUCES the `prefix`,
 * so prefixing it would ask for `/v1/<prefix>/config`, a route no IRC server has.
 */
export function getCatalogConfig(warehouse = icebergWarehouse()): Promise<IrcConfig> {
  return ircFetchRaw<IrcConfig>('/v1/config', { query: { warehouse } });
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

/**
 * The exact upstream failure the LIST-namespaces workaround below is keyed to.
 *
 * Deliberately an EXACT signature, not "any 500". A broad catch would silently
 * mask an unrelated server fault behind a fallback that appeared to work —
 * which is the failure mode this program keeps paying for. Anything that is not
 * this defect propagates untouched.
 */
const LIST_NS_DEFECT = 'Authorization filter not initialized';

/** True when an error is the measured upstream LIST-namespaces defect. */
export function isListNamespacesDefect(e: unknown): boolean {
  return e instanceof IcebergCatalogError
    && e.status === 500
    && String(e.message || '').includes(LIST_NS_DEFECT);
}

/**
 * `GET /v1/{prefix}/namespaces` — with a disclosed fallback to the Unity
 * Catalog schemas API on the SAME server when the shipped image cannot serve it.
 *
 * MEASURED, in Docker against the real `apps/loom-unity` image (authorization
 * enabled, warehouse provisioned, namespace present, every principal tried
 * INCLUDING the server's own metastore-OWNER service token):
 *
 *   GET <irc>/v1/catalogs/loom/namespaces
 *     -> 500 {"error":{"message":"Authorization filter not initialized —
 *             ensure the request goes through UnityAccessDecorator.", ... }}
 *
 * and the CONTROL, the identical call against the BARE upstream
 * `unitycatalog/unitycatalog:v0.5.0` image with no Loom overlay:
 *
 *   -> 200 {"namespaces":[["default"]],"next-page-token":null}
 *
 * So the 500 is a regression Loom imports with the v0.5.1 `unitycatalog-server`
 * overlay its Dockerfile applies (to fix upstream #1603): v0.5.1 added
 * `@ResponseAuthorizeFilter` + `AuthorizedService.applyResponseFilter`, and
 * `IcebergRestCatalogService.listNamespaces` calls `SchemaService.listSchemas`
 * IN-PROCESS, so it runs under the Iceberg route's request context — which
 * carries no `RESULT_FILTER` attribute — and `applyResponseFilter` throws
 * INTERNAL. Every OTHER Iceberg route was measured working on the same image
 * (namespace GET, table list, table load, register: 200).
 *
 * An Iceberg namespace on this server IS a Unity Catalog schema — upstream's own
 * implementation of this route is literally `listSchemas(catalog)` mapped to
 * `Namespace.of(...)`. So the fallback reads the SAME rows from the SAME server
 * with the SAME credential; it is not an approximation and it is not mock data.
 * It is reported through `via` so a caller can never mistake it for the native
 * path (`.claude/rules/deploy-integrity.md` R7 — never assert what you did not do).
 */
export async function listNamespacesResolved(
  parent?: string,
): Promise<IrcNamespaceList & { via: 'irc' | 'unity-schemas' }> {
  try {
    const r = await listNamespaces(parent);
    return { ...r, via: 'irc' };
  } catch (e) {
    if (!isListNamespacesDefect(e)) throw e;
    // Nested namespaces do not exist on this server (upstream returns an empty
    // list for any `parent`), so the fallback matches that behaviour exactly
    // rather than inventing children.
    if (parent) return { namespaces: [], via: 'unity-schemas' };
    return { ...(await listNamespacesViaUnitySchemas()), via: 'unity-schemas' };
  }
}

/**
 * Read the warehouse's namespaces from the Unity Catalog schemas API on the same
 * catalog server, in the IRC response shape. Same base, same injected bearer,
 * same audit chokepoint as every other call here.
 */
async function listNamespacesViaUnitySchemas(): Promise<IrcNamespaceList> {
  const warehouse = icebergWarehouse();
  const ucPath = `/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(warehouse)}`;
  const url = `${icebergCatalogBase()}${ucPath}`;

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(await icebergAuthHeader()) },
    });
  } catch (e) {
    recordDatabricksUnityAccess({ path: ucPath, method: 'GET', status: 0, durationMs: Date.now() - t0, error: e });
    throw new IcebergCatalogError(
      `Iceberg REST Catalog unreachable at ${icebergCatalogBase()}: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  recordDatabricksUnityAccess({ path: ucPath, method: 'GET', status: res.status, durationMs: Date.now() - t0 });

  const text = await res.text();
  let body: { schemas?: Array<{ name?: string }> } = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = {}; }
  }
  if (!res.ok) {
    throw new IcebergCatalogError(
      `Listing namespaces for warehouse "${warehouse}" failed (HTTP ${res.status}). The Iceberg `
      + 'LIST-namespaces route is unavailable on this catalog image and the Unity Catalog schemas '
      + 'API refused as well, so no namespace list could be obtained.',
      res.status,
      'namespace_list_failed',
    );
  }
  return {
    namespaces: (body.schemas || [])
      .map((s) => String(s?.name ?? ''))
      .filter(Boolean)
      .map((n) => [n]),
  };
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
  const ucPath = `/api/2.1/unity-catalog/permissions/schema/${encodeURIComponent(full)}`;
  const url = `${icebergCatalogBase()}${ucPath}`;

  // LU-3 — this is a REAL Unity Catalog grant read issued outside ucFetch (it
  // goes to the IRC's catalog base with the Iceberg auth header), so it records
  // its own audit row. Allowlisted + asserted in
  // scripts/ci/check-unity-audit-chokepoint.mjs.
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...(await icebergAuthHeader()) },
    });
  } catch (e) {
    recordDatabricksUnityAccess({ path: ucPath, method: 'GET', status: 0, durationMs: Date.now() - t0, error: e });
    throw new IcebergCatalogError(
      `Iceberg REST Catalog unreachable at ${icebergCatalogBase()}: ${(e as Error)?.message || String(e)}`,
      502,
      'unreachable',
    );
  }
  recordDatabricksUnityAccess({ path: ucPath, method: 'GET', status: res.status, durationMs: Date.now() - t0 });

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
