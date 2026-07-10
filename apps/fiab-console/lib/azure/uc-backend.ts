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
 * function REST shapes, so those operations route transparently. Databricks-only
 * families (grants via the REST permission graph, Delta Sharing, and the
 * lineage-tracking / system-table surfaces) are NOT part of the OSS server; the
 * UC client gates them honestly when the OSS backend is active (see
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
 * 404. Grants (the Databricks REST permission graph), Delta Sharing, and the
 * lineage-tracking surfaces are Databricks-only; catalogs / schemas / tables /
 * volumes / functions are supported and return `null`.
 */
export function ossUcUnsupportedPath(path: string): string | null {
  if (/\/permissions\//.test(path)) return 'grants (REST permission graph)';
  if (/\/(shares|recipients|providers)(\/|$|\?)/.test(path)) return 'Delta Sharing';
  if (/\/lineage-tracking\//.test(path)) return 'table/column lineage';
  return null;
}
