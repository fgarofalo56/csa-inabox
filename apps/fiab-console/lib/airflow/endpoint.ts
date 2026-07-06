/**
 * Shared Airflow webserver resolver + auth for the airflow-job item routes.
 *
 * Azure-native, NO-FABRIC (per .claude/rules/no-fabric-dependency.md): the
 * airflow-job item drives a real Apache Airflow REST API. By DEFAULT that is
 * the day-one managed host Loom deploys on Azure Container Apps
 * (platform/fiab/bicep/modules/admin-plane/airflow.bicep → LOOM_AIRFLOW_ENDPOINT),
 * the Azure-native 1:1 for Fabric's "Apache Airflow job" / ADF's "Workflow
 * Orchestration Manager". A per-item BYO webserver URL is an OPT-IN override.
 *
 * Precedence (resolveAirflowConn):
 *   1. per-item stored `webserverUrl` (BYO opt-in)  → wins
 *   2. else LOOM_AIRFLOW_ENDPOINT (managed day-one host) → the default
 *   3. else null → the caller surfaces the honest NO_WEBSERVER gate
 *
 * Auth (airflowAuthHeaders):
 *   - managed host → HTTP Basic (LOOM_AIRFLOW_USERNAME / LOOM_AIRFLOW_PASSWORD)
 *     — WOM's "Basic authentication" mode.
 *   - BYO → Bearer (LOOM_AIRFLOW_BEARER) when set, else Basic when creds exist.
 */

export interface AirflowConn {
  /** Effective Airflow webserver base URL (managed host or BYO). */
  webserverUrl: string;
  /** true when resolved from the managed LOOM_AIRFLOW_ENDPOINT host. */
  managed: boolean;
}

/** Honest gate copy shown when neither a managed host nor a BYO URL is available. */
export const AIRFLOW_NO_WEBSERVER_HINT =
  'No Airflow webserver is available. Deploy the day-one managed host ' +
  '(platform/fiab/bicep/modules/admin-plane/airflow.bicep sets LOOM_AIRFLOW_ENDPOINT), ' +
  'or paste a BYO Airflow webserver URL in the Settings tab. ' +
  'See docs/fiab/v3-tenant-bootstrap.md for the auth/bootstrap steps.';

/** Is a managed day-one Airflow host wired into this deployment? */
export function managedAirflowConfigured(): boolean {
  return Boolean((process.env.LOOM_AIRFLOW_ENDPOINT || '').trim());
}

/**
 * Resolve the effective Airflow webserver for an item's stored state.
 * Returns null when neither a per-item BYO URL nor the managed host is set.
 */
export function resolveAirflowConn(
  itemState: Record<string, unknown> | undefined | null,
): AirflowConn | null {
  const byo = String((itemState as { webserverUrl?: unknown } | null)?.webserverUrl || '').trim();
  if (byo) return { webserverUrl: byo, managed: false };
  const managed = (process.env.LOOM_AIRFLOW_ENDPOINT || '').trim();
  if (managed) return { webserverUrl: managed, managed: true };
  return null;
}

/** Build the auth + accept headers for a resolved Airflow connection. */
export function airflowAuthHeaders(
  conn: AirflowConn,
  base: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...base };
  const user = (process.env.LOOM_AIRFLOW_USERNAME || '').trim();
  const pass = process.env.LOOM_AIRFLOW_PASSWORD || '';
  const bearer = (process.env.LOOM_AIRFLOW_BEARER || '').trim();
  if (conn.managed && user && pass) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  } else if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  } else if (user && pass) {
    headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return headers;
}
