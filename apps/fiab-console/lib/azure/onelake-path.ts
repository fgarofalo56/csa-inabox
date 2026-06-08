/**
 * onelake-path — translation helper that maps a Loom item's
 * {account, container, itemPath} tuple to all four OneLake-compatible URI
 * forms (DFS HTTPS, Blob HTTPS, ABFS, GUID DFS).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Microsoft Fabric's OneLake exposes every item at a stable address in four
 * shapes (see https://learn.microsoft.com/fabric/onelake/onelake-access-api):
 *
 *   | Form     | Fabric template                                                            |
 *   |----------|----------------------------------------------------------------------------|
 *   | DFS      | https://onelake.dfs.fabric.microsoft.com/<ws>/<item>.<type>/<path>         |
 *   | Blob     | https://onelake.blob.fabric.microsoft.com/<ws>/<item>.<type>/<path>       |
 *   | ABFS     | abfss://<ws>@onelake.dfs.fabric.microsoft.com/<item>.<type>/<path>        |
 *   | GUID DFS | https://onelake.dfs.fabric.microsoft.com/<wsGuid>/<itemGuid>/<path>       |
 *
 * Loom is Azure-native (per no-fabric-dependency.md): the Console UAMI talks
 * to the ADLS Gen2 backing store in the DLZ, NOT the Fabric SaaS endpoint.
 * So we generate the same four shapes against the ADLS data plane, using the
 * SAME cloud-suffix resolver `adls-client` uses (`dfsSuffix()` /
 * `getBlobSuffix()` from cloud-endpoints) — never hard-coding a hostname:
 *
 *   | Form     | Loom / ADLS template                                                       |
 *   |----------|----------------------------------------------------------------------------|
 *   | DFS      | https://{account}.{dfsSuffix()}/{container}/{itemPath}                     |
 *   | Blob     | https://{account}.{getBlobSuffix()}/{container}/{itemPath}                 |
 *   | ABFS     | abfss://{container}@{account}.{dfsSuffix()}/{itemPath}                     |
 *   | GUID     | https://{account}.{dfsSuffix()}/{workspaceGuid}/{itemGuid}/{itemPath}      |
 *
 * Commercial / GCC → *.core.windows.net; GCC-High / IL5 / DoD →
 * *.core.usgovcloudapi.net. Because the suffix comes from `isGovCloud()` the
 * exact same code is correct in every sovereign boundary. No Fabric / Power BI
 * host is ever produced here.
 */

import { dfsSuffix, getBlobSuffix } from './cloud-endpoints';

export interface OneLakePathParams {
  /** ADLS Gen2 storage account name (e.g. "stloomdlz"). */
  account: string;
  /** Container — the OneLake "workspace" equivalent (e.g. "bronze"). */
  container: string;
  /** Path within the container, no leading slash (e.g. "sales.lakehouse/Tables/orders"). */
  itemPath: string;
  /** Optional workspace GUID — enables the GUID-based URI form. */
  workspaceGuid?: string;
  /** Optional item GUID — enables the GUID-based URI form. */
  itemGuid?: string;
}

export interface OneLakePaths {
  /** HTTPS DFS endpoint (ADLS Gen2 data plane — what Spark/azcopy/Storage SDK use). */
  dfs: string;
  /** HTTPS Blob endpoint (same bytes, Blob API surface — BlobFuse2 / Blob SDK). */
  blob: string;
  /**
   * ABFS driver URI — the canonical "OneLake path" the Fabric Properties pane
   * surfaces and what Spark / Databricks / Synapse accept as a `location`.
   * Scheme is always `abfss` (TLS-only against real storage).
   */
  abfs: string;
  /**
   * GUID-based DFS URL (workspace GUID + item GUID instead of names).
   * `null` when either GUID is absent from the Loom item record.
   */
  guid: string | null;
}

/** Strip leading/trailing slashes from a path segment so joins never double up. */
function clean(p: string): string {
  return (p ?? '').replace(/^\/+|\/+$/g, '');
}

/**
 * Build all four ADLS-layer URI forms for a Loom item. Pure string
 * construction over the env-resolved cloud suffixes — no network call, no
 * Fabric dependency.
 */
export function onelakePaths(params: OneLakePathParams): OneLakePaths {
  const { account, container, itemPath, workspaceGuid, itemGuid } = params;
  const dfs = dfsSuffix();
  const blob = getBlobSuffix();
  const cp = clean(itemPath);
  const tail = cp ? `/${cp}` : '';

  return {
    dfs: `https://${account}.${dfs}/${container}${tail}`,
    blob: `https://${account}.${blob}/${container}${tail}`,
    abfs: `abfss://${container}@${account}.${dfs}${tail}`,
    guid:
      workspaceGuid && itemGuid
        ? `https://${account}.${dfs}/${workspaceGuid}/${itemGuid}${tail}`
        : null,
  };
}

/** Convenience: just the ABFS string (the most common clipboard target). */
export function onelakeAbfs(params: OneLakePathParams): string {
  return onelakePaths(params).abfs;
}
