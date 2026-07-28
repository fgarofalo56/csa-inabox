/**
 * Unity Catalog backend selector — Databricks UC (Commercial default) vs the
 * self-hosted OSS Unity Catalog server (`loom-unity`, the Azure-Government
 * default). Databricks Unity Catalog has no Azure Government endpoint; this
 * switch lets the SAME Loom UC client speak the SAME `/api/2.1/unity-catalog/*`
 * REST surface to an OSS Unity Catalog server deployed by
 * `platform/fiab/bicep/modules/compute/loom-unity-app.bicep`.
 *
 * Selection (see {@link resolveUcBackend}):
 *   - `LOOM_UC_BACKEND=oss`         → OSS Unity Catalog (explicit opt-in).
 *   - `LOOM_UC_BACKEND=databricks`  → Databricks Unity Catalog (explicit).
 *   - unset → **auto**: OSS when running in Azure Government AND no Databricks
 *     workspace is bound AND `LOOM_UNITY_URL` is set; otherwise Databricks.
 *
 * The OSS server and Databricks UC share the catalog / schema / table / volume /
 * function / model / permission REST shapes, so those operations route
 * transparently. OSS UC 0.5 (grounded in the upstream OpenAPI spec,
 * `api/all.yaml@v0.5.0`) additionally implements external locations,
 * credentials (its name for storage credentials — see
 * {@link ossUcRewritePath}), registered models + versions, functions, the
 * grants surface (`GET/PATCH /permissions/{securable_type}/{full_name}`), and
 * temporary credential vending. Genuinely Databricks-only families (Delta
 * Sharing, lineage-tracking / system tables, Lakehouse Federation connections,
 * workspace bindings, effective-permissions, online tables, clean rooms,
 * Marketplace) are gated honestly when the OSS backend is active (see
 * {@link ossUcUnsupportedPath}) rather than silently 404-ing.
 *
 * No Fabric / Power BI is ever reached — OSS Unity Catalog IS the Azure-native
 * backend (`.claude/rules/no-fabric-dependency.md`).
 *
 * LU-2 (AuthN/Z hardening) added the authorization half: {@link ossUcAuthHeader}
 * injects the Console's credential on every Loom Unity call so the BFF is the
 * single audited choke point, and {@link unityAuthorizationPosture} reports —
 * honestly — when nothing is configured and the catalog is therefore reachable
 * anonymously by anything on the VNet.
 */
import { isGovCloud } from '@/lib/azure/cloud-endpoints';

export type UcBackend = 'databricks' | 'oss';

/** True when either Databricks-workspace env is set (single or federated). */
function hasDatabricksWorkspace(): boolean {
  return !!(process.env.LOOM_DATABRICKS_HOSTNAMES || process.env.LOOM_DATABRICKS_HOSTNAME);
}

/**
 * Resolve the active Unity Catalog backend. Explicit `LOOM_UC_BACKEND` always
 * wins; otherwise auto-select OSS in Azure Government when there is no Databricks
 * workspace to talk to and a `loom-unity` URL is configured. Defaults to
 * Databricks (the Commercial behaviour) so existing deployments are unchanged.
 */
export function resolveUcBackend(): UcBackend {
  const explicit = (process.env.LOOM_UC_BACKEND || '').trim().toLowerCase();
  if (explicit === 'oss') return 'oss';
  if (explicit === 'databricks') return 'databricks';
  if (isGovCloud() && !hasDatabricksWorkspace() && !!process.env.LOOM_UNITY_URL) {
    return 'oss';
  }
  return 'databricks';
}

/** Convenience: is the OSS Unity Catalog backend active? */
export function isOssUc(): boolean {
  return resolveUcBackend() === 'oss';
}

export interface OssUcNotConfiguredHint {
  missingEnvVar: string;
  bicepModule: string;
  bicepStatus: string;
  followUp: string;
}

/** Thrown when the OSS backend is selected but `LOOM_UNITY_URL` is not set. */
export class OssUcNotConfiguredError extends Error {
  hint: OssUcNotConfiguredHint;
  constructor(hint: OssUcNotConfiguredHint) {
    super(`OSS Unity Catalog is not configured: missing ${hint.missingEnvVar}`);
    this.name = 'OssUcNotConfiguredError';
    this.hint = hint;
  }
}

/**
 * The OSS Unity Catalog server base URL (no trailing slash). Throws a structured
 * {@link OssUcNotConfiguredError} — naming the exact env var + bicep module — so
 * the BFF can surface an honest MessageBar gate when the backend is selected but
 * the service is not deployed.
 */
export function ossUcBase(): string {
  const url = (process.env.LOOM_UNITY_URL || '').trim().replace(/\/+$/, '');
  if (!url) {
    throw new OssUcNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_URL',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus:
        'Deploy the loom-unity Container App (self-hosted OSS Unity Catalog) and set LOOM_UNITY_URL on the Console app.',
      followUp:
        'See docs/fiab/unity-gov.md for the az acr build + deploy steps. No Databricks or Fabric required.',
    });
  }
  return url;
}

/** Optional pre-shared bearer for the OSS server (a server-minted service token,
 * delivered as a Key Vault secretref — never a plain env literal in bicep). */
export function ossUcAuthToken(): string | undefined {
  const t = (process.env.LOOM_UNITY_TOKEN || '').trim();
  return t || undefined;
}

// ============================================================
// LU-2 — Loom Unity authorization (the BFF is the ONLY caller)
// ============================================================

/**
 * How the Console authenticates to Loom Unity (the self-hosted, Unity-Catalog-
 * compatible OSS server).
 *
 *   'token'     — a pre-shared server-minted bearer (`LOOM_UNITY_TOKEN`, a Key
 *                 Vault secretref). Highest precedence because it is the only
 *                 credential the upstream server mints for itself.
 *   'entra'     — the Console UAMI mints an Entra access token for the Loom Unity
 *                 audience (`LOOM_UNITY_AUDIENCE`, or `api://<client-id>/.default`
 *                 derived from `LOOM_UNITY_CLIENT_ID` / `LOOM_MSAL_CLIENT_ID`).
 *                 The server pins issuer + audience (server.allowed-issuers /
 *                 server.audiences — verified against upstream v0.5.1).
 *   'anonymous' — NOTHING is configured. Calls go out unauthenticated, which only
 *                 works against a server running `server.authorization=disable`:
 *                 the pre-LU-2 posture where anything on the VNet can read AND
 *                 mutate the catalog. This state is never silent — see
 *                 {@link unityAuthorizationPosture}, the `svc-loom-unity-authz`
 *                 gate, and the `probe-loom-unity-authz` live health probe, which
 *                 PROVES the open door by getting a 200 on an unauthenticated read.
 */
export type UnityAuthMode = 'token' | 'entra' | 'anonymous';

/** The Entra scope the Console requests its Loom Unity bearer for (undefined when
 * no app registration is wired at all). Mirrors the Iceberg-REST-catalog BFF
 * pattern: a dedicated `LOOM_UNITY_CLIENT_ID` when the operator registered one,
 * otherwise the Console's own app registration. */
export function unityAudience(): string | undefined {
  const explicit = (process.env.LOOM_UNITY_AUDIENCE || '').trim();
  if (explicit) return explicit;
  const clientId = (process.env.LOOM_UNITY_CLIENT_ID || '').trim();
  if (clientId) return `api://${clientId}/.default`;
  const msal = (process.env.LOOM_MSAL_CLIENT_ID || '').trim();
  return msal ? `api://${msal}/.default` : undefined;
}

/**
 * True when the operator has DECLARED a Loom Unity audience. Deliberately does
 * NOT count the `LOOM_MSAL_CLIENT_ID` fallback: inferring "authorization is on"
 * from a var every deployment sets would make the Console fail closed against
 * catalogs that never enabled authorization (every pre-LU-2 estate). Hardening is
 * therefore always the result of an explicit declaration, and the un-declared
 * state is reported — never guessed at.
 */
function unityAudienceDeclared(): boolean {
  return !!((process.env.LOOM_UNITY_AUDIENCE || '').trim() || (process.env.LOOM_UNITY_CLIENT_ID || '').trim());
}

/** Resolve the active authentication mode. Explicit `LOOM_UNITY_AUTH_MODE` wins. */
export function resolveUnityAuthMode(): UnityAuthMode {
  const explicit = (process.env.LOOM_UNITY_AUTH_MODE || '').trim().toLowerCase();
  if (explicit === 'token' || explicit === 'entra' || explicit === 'anonymous') return explicit;
  if (ossUcAuthToken()) return 'token';
  if (unityAudienceDeclared()) return 'entra';
  return 'anonymous';
}

export interface UnityAuthorizationPosture {
  mode: UnityAuthMode;
  /** True when the Console presents a credential on every Loom Unity call. */
  hardened: boolean;
  /** Entra scope in use (entra mode only). */
  audience?: string;
  /** Honest, operator-facing description of the CURRENT posture. */
  detail: string;
  /** Exact remediation when `hardened` is false. */
  remediation?: string;
}

/**
 * The Console's Loom Unity authorization posture — surfaced on
 * `/api/catalog/unity/capabilities` so the UC panes can render an honest bar
 * instead of pretending an anonymous catalog is secured.
 */
export function unityAuthorizationPosture(): UnityAuthorizationPosture {
  const mode = resolveUnityAuthMode();
  if (mode === 'token') {
    return {
      mode,
      hardened: true,
      detail: 'Loom Unity calls carry a pre-shared server-minted bearer token (LOOM_UNITY_TOKEN, Key Vault secretref). The catalog rejects anonymous callers.',
    };
  }
  if (mode === 'entra') {
    return {
      mode,
      hardened: true,
      audience: unityAudience(),
      detail: `Loom Unity calls carry a Microsoft Entra bearer minted by the Console managed identity for ${unityAudience()}. The server pins the issuer + audience, so a token for any other app or tenant is rejected.`,
    };
  }
  return {
    mode,
    hardened: false,
    detail: 'Loom Unity calls go out UNAUTHENTICATED. That only succeeds against a catalog running with authorization disabled — in which case every workload that can reach the Container Apps environment can read AND modify catalog metadata (and mint ADLS credentials if vending is wired).',
    remediation:
      'Redeploy platform/fiab/bicep/modules/compute/loom-unity-app.bicep with authMode=entra (the default) + entraClientId=<loom-unity app registration>, then set LOOM_UNITY_CLIENT_ID (or LOOM_UNITY_AUDIENCE) on the Console app so it mints a bearer. Alternatively set LOOM_UNITY_TOKEN from Key Vault. See docs/fiab/security/loom-unity-threat-model.md.',
  };
}

/** Thrown when Loom Unity authorization is REQUIRED but no credential can be
 * produced — the Console fails closed instead of silently retrying anonymously. */
export class OssUcAuthNotConfiguredError extends Error {
  hint: OssUcNotConfiguredHint;
  constructor(hint: OssUcNotConfiguredHint) {
    super(`Loom Unity authorization is not configured: ${hint.missingEnvVar}`);
    this.name = 'OssUcAuthNotConfiguredError';
    this.hint = hint;
  }
}

/**
 * The Authorization header for one Loom Unity call. The Console BFF is the single
 * audited choke point: no engine or user talks to `loom-unity` directly (its
 * ingress is internal + IP-pinned), so this is where the credential is injected.
 *
 * Fails CLOSED in `token` / `entra` mode — an unmintable token throws rather than
 * degrading to an anonymous request that would either 401 opaquely or, worse,
 * succeed against an unsecured server.
 */
export async function ossUcAuthHeader(): Promise<Record<string, string>> {
  // A pre-shared server-minted token always wins (the Iceberg-REST BFF pattern).
  const preShared = ossUcAuthToken();
  if (preShared) return { authorization: `Bearer ${preShared}` };

  const mode = resolveUnityAuthMode();
  if (mode === 'anonymous') return {};

  const audience = unityAudience();
  if (!audience) {
    throw new OssUcAuthNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_CLIENT_ID | LOOM_UNITY_AUDIENCE | LOOM_UNITY_TOKEN',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus:
        'LOOM_UNITY_AUTH_MODE requires the Console to authenticate to Loom Unity, but no audience or token is configured.',
      followUp:
        'Set LOOM_UNITY_CLIENT_ID (the Loom Unity Entra app registration) so the Console mints api://<client-id>/.default, or LOOM_UNITY_TOKEN from Key Vault. See docs/fiab/security/loom-unity-threat-model.md.',
    });
  }
  try {
    // Lazy import: this module is imported by the pure capability surface, so the
    // Azure credential chain must never be pulled in eagerly.
    const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
    const token = await uamiArmCredential().getToken(audience);
    if (token?.token) return { authorization: `Bearer ${token.token}` };
  } catch (e) {
    throw new OssUcAuthNotConfiguredError({
      missingEnvVar: 'LOOM_UNITY_AUDIENCE',
      bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
      bicepStatus: `The Console managed identity could not mint an Entra token for ${audience}: ${(e as Error)?.message || String(e)}`,
      followUp:
        'Confirm the Loom Unity app registration exposes that scope and the Console UAMI is permitted on it (or set LOOM_UNITY_TOKEN from Key Vault). See docs/fiab/security/loom-unity-threat-model.md.',
    });
  }
  throw new OssUcAuthNotConfiguredError({
    missingEnvVar: 'LOOM_UNITY_AUDIENCE',
    bicepModule: 'platform/fiab/bicep/modules/compute/loom-unity-app.bicep',
    bicepStatus: `The Console managed identity returned no Entra token for ${audience}.`,
    followUp:
      'Confirm the Loom Unity app registration exposes that scope and the Console UAMI is permitted on it (or set LOOM_UNITY_TOKEN from Key Vault). See docs/fiab/security/loom-unity-threat-model.md.',
  });
}

/**
 * Returns a human feature name when `path` targets a Unity Catalog REST family
 * that the OSS server does not implement, else `null`. The UC client uses this
 * to gate honestly on the OSS backend instead of emitting a confusing upstream
 * 404.
 *
 * Grounded in the upstream OSS Unity Catalog 0.5 OpenAPI spec (`api/all.yaml`):
 * catalogs / schemas / tables / volumes / functions / registered models (+
 * versions) / external locations / credentials / **permissions (grants)** /
 * temporary credentials / metastore_summary are all implemented and return
 * `null`. Delta Sharing, lineage-tracking, effective-permissions, Lakehouse
 * Federation connections, workspace bindings, system schemas, online tables,
 * clean rooms, Databricks Marketplace, and the Jobs API are Databricks-only.
 */
export function ossUcUnsupportedPath(path: string): string | null {
  if (/\/(shares|recipients|providers)(\/|$|\?)/.test(path)) return 'Delta Sharing';
  if (/\/lineage-tracking\//.test(path)) return 'table/column lineage';
  if (/\/effective-permissions\//.test(path)) return 'effective (inherited) permissions';
  if (/\/unity-catalog\/connections(\/|$|\?)/.test(path)) return 'Lakehouse Federation connections';
  if (/\/unity-catalog\/bindings\//.test(path)) return 'workspace-catalog bindings';
  if (/\/systemschemas(\/|$)/.test(path)) return 'system schemas';
  if (/\/online-tables(\/|$)/.test(path)) return 'online tables';
  if (/\/clean-rooms(\/|$)/.test(path)) return 'clean rooms';
  if (/\/marketplace-consumer\//.test(path)) return 'Databricks Marketplace';
  if (/\/api\/2\.\d+\/jobs\//.test(path)) return 'Databricks jobs';
  return null;
}

/**
 * Rewrites a Databricks-flavoured UC REST path to its OSS Unity Catalog
 * equivalent. The two servers share almost the whole surface; the one naming
 * split is storage credentials: Databricks exposes
 * `/api/2.1/unity-catalog/storage-credentials` while OSS UC models the same
 * securable family as `/api/2.1/unity-catalog/credentials` (with
 * `purpose=STORAGE`) — including the permissions securable segment
 * (`storage_credential` → `credential`).
 */
export function ossUcRewritePath(path: string): string {
  return path
    .replace(/\/unity-catalog\/storage-credentials(?=\/|\?|$)/, '/unity-catalog/credentials')
    .replace(/\/unity-catalog\/permissions\/storage_credential\//, '/unity-catalog/permissions/credential/')
    .replace(/\/unity-catalog\/effective-permissions\/storage_credential\//, '/unity-catalog/effective-permissions/credential/');
}

// ============================================================
// Capability matrix — one source of truth for the API + UI + docs
// ============================================================

export type UcCapabilitySupport = 'full' | 'partial' | 'none';

export interface UcCapability {
  /** Stable id — also the row anchor in docs/fiab/unity-catalog-capability-matrix.md. */
  id: string;
  label: string;
  /** Support level on the Databricks Unity Catalog backend (Commercial default). */
  databricks: UcCapabilitySupport;
  /** Support level on the OSS Unity Catalog backend (Azure Government default). */
  oss: UcCapabilitySupport;
  /** Where the capability surfaces in Loom. */
  loomSurface: string;
  /** Honest per-backend note (what `partial`/`none` means + the Loom-native fallback). */
  note?: string;
}

/**
 * The full Unity Catalog capability set and its support level per backend.
 * `/api/catalog/unity/capabilities` serializes this (plus the active backend)
 * so every UC pane can render an honest per-cloud capability note instead of a
 * dead gate. Keep in sync with docs/fiab/unity-catalog-capability-matrix.md.
 */
export const UC_CAPABILITIES: UcCapability[] = [
  { id: 'metastores', label: 'Metastores', databricks: 'full', oss: 'partial', loomSurface: '/catalog/metastores', note: 'OSS UC is a single-metastore server (metastore_summary); Databricks federates metastores across workspaces.' },
  { id: 'catalogs', label: 'Catalogs (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'schemas', label: 'Schemas (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'tables', label: 'Tables (list/get/create/delete)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore', note: 'OSS UC has no PATCH /tables (owner/comment updates are Databricks-only).' },
  { id: 'views', label: 'Views (browse)', databricks: 'full', oss: 'partial', loomSurface: '/catalog/unity — Explore', note: 'Views surface through the tables list (table_type=VIEW). CREATE VIEW is a SQL-warehouse DDL on Databricks; OSS UC registers views created by engines that write to it.' },
  { id: 'volumes', label: 'Volumes (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'functions', label: 'Functions (list/get/create/delete)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore' },
  { id: 'models', label: 'Registered models + versions', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Explore', note: 'Databricks governs models through the FUNCTION permissions path; OSS UC has a first-class registered_model securable.' },
  { id: 'grants', label: 'Grants / privileges (securable ACLs)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Grants', note: 'Both backends implement GET/PATCH /permissions/{securable}/{name}. Effective (inherited) permissions are Databricks-only; on OSS the direct grants are shown.' },
  { id: 'external-locations', label: 'External locations (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage' },
  { id: 'storage-credentials', label: 'Storage credentials (CRUD)', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage', note: 'OSS UC names the same family "credentials" (purpose=STORAGE); Loom rewrites the path transparently.' },
  { id: 'temporary-credentials', label: 'Temporary credential vending', databricks: 'full', oss: 'full', loomSurface: '/catalog/unity — Storage', note: 'On OSS, ADLS vending needs the LOOM_UNITY_ADLS_* service principal on loom-unity; unset, data access stays on Loom managed-identity/ACL paths.' },
  { id: 'connections', label: 'Connections (Lakehouse Federation)', databricks: 'full', oss: 'none', loomSurface: '/catalog/unity — Federation', note: 'OSS UC has no federation. Loom-native fallback: Linked Services / Synapse + ADF connectors cover remote DBMS access in Gov.' },
  { id: 'delta-sharing', label: 'Delta Sharing (shares/recipients/providers)', databricks: 'full', oss: 'none', loomSurface: 'Marketplace — Data shares', note: 'OSS UC 0.5 does not implement the sharing server. Loom-native fallback: Loom Marketplace shares + access grants.' },
  { id: 'lineage', label: 'Lineage (table + column)', databricks: 'full', oss: 'none', loomSurface: '/catalog/lineage', note: 'Databricks system.access table + column lineage (via /lineage-tracking/). On OSS/Gov the equivalent is Loom-native UNIFIED COLUMN lineage: the shared col:<table>::<column> model (L1) that merges Purview column facets, Weave/Thread columnMappings, and OpenLineage ingest (L2/L3) into the same column-grain graph surface — default-ON, no gate. UC is simply one more source that folds onto that identity when a Databricks warehouse is present.' },
  { id: 'tags', label: 'Tags (object + column, governed tags)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — UC dialogs', note: 'Tag DDL runs on a Databricks SQL warehouse. OSS fallback: Purview classifications + Loom catalog annotations.' },
  { id: 'abac', label: 'ABAC / row filters / column masks', databricks: 'full', oss: 'none', loomSurface: 'Governance — UC security panel', note: 'Policy DDL is warehouse-side. OSS fallback: enforce at the serving engine (Synapse/ADX policies).' },
  { id: 'system-tables', label: 'System tables (audit/billing/query/classification)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — audit dialogs', note: 'OSS fallback: Azure Monitor / Log Analytics on the loom-unity Container App.' },
  { id: 'bindings', label: 'Workspace bindings (catalog isolation)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — bindings dialog', note: 'OSS UC is single-server; Loom workspace isolation is enforced by Loom workspace ACLs instead.' },
  { id: 'quality-monitors', label: 'Data quality monitors', databricks: 'full', oss: 'none', loomSurface: 'Catalog — data quality', note: 'OSS fallback: Loom data-quality checks (Great-Expectations-style) on Spark.' },
  { id: 'online-tables', label: 'Online tables', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'OSS fallback: Lakebase/Postgres serving tables.' },
  { id: 'clean-rooms', label: 'Clean rooms', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'Databricks-only collaboration surface.' },
  { id: 'marketplace', label: 'Databricks Marketplace', databricks: 'full', oss: 'none', loomSurface: 'Marketplace', note: 'OSS fallback: Loom Marketplace (API + Data products).' },
];
