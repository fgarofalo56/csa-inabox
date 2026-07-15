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

/** Optional bearer token for the OSS server (only when OIDC/token auth is enabled). */
export function ossUcAuthToken(): string | undefined {
  const t = (process.env.LOOM_UNITY_TOKEN || '').trim();
  return t || undefined;
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
  { id: 'lineage', label: 'Lineage (table + column)', databricks: 'full', oss: 'none', loomSurface: '/catalog/lineage', note: 'Databricks system.access lineage + REST preview. On OSS, Loom unified lineage (Purview + ADX + item edges) is the equivalent — same graph surface.' },
  { id: 'tags', label: 'Tags (object + column, governed tags)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — UC dialogs', note: 'Tag DDL runs on a Databricks SQL warehouse. OSS fallback: Purview classifications + Loom catalog annotations.' },
  { id: 'abac', label: 'ABAC / row filters / column masks', databricks: 'full', oss: 'none', loomSurface: 'Governance — UC security panel', note: 'Policy DDL is warehouse-side. OSS fallback: enforce at the serving engine (Synapse/ADX policies).' },
  { id: 'system-tables', label: 'System tables (audit/billing/query/classification)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — audit dialogs', note: 'OSS fallback: Azure Monitor / Log Analytics on the loom-unity Container App.' },
  { id: 'bindings', label: 'Workspace bindings (catalog isolation)', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor — bindings dialog', note: 'OSS UC is single-server; Loom workspace isolation is enforced by Loom workspace ACLs instead.' },
  { id: 'quality-monitors', label: 'Data quality monitors', databricks: 'full', oss: 'none', loomSurface: 'Catalog — data quality', note: 'OSS fallback: Loom data-quality checks (Great-Expectations-style) on Spark.' },
  { id: 'online-tables', label: 'Online tables', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'OSS fallback: Lakebase/Postgres serving tables.' },
  { id: 'clean-rooms', label: 'Clean rooms', databricks: 'full', oss: 'none', loomSurface: 'SQL warehouse editor', note: 'Databricks-only collaboration surface.' },
  { id: 'marketplace', label: 'Databricks Marketplace', databricks: 'full', oss: 'none', loomSurface: 'Marketplace', note: 'OSS fallback: Loom Marketplace (API + Data products).' },
];
