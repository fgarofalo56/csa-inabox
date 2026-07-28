/**
 * LU-8 — CANONICAL OpenLineage dataset naming for Loom's Azure-native estate.
 *
 * Dataset naming is where lineage graphs silently fail to join. The SAME ADLS
 * Gen2 folder is spelled at least four different ways across the producers
 * Loom already runs:
 *
 *   openlineage-spark listener   abfss://bronze@stloom.dfs.core.windows.net + /sales
 *   Synapse/ADF dataset          linkedService url https://stloom.dfs.core.windows.net
 *                                + fileSystem 'bronze' + folderPath 'sales'
 *   Lakehouse provisioner state  abfss://bronze@stloom.dfs.core.windows.net/sales
 *   Databricks UC storage_loc.   abfss://bronze@stloom.dfs.core.windows.net/sales/
 *
 * Emitted verbatim these produce FOUR disconnected nodes on the lineage canvas
 * that each look perfectly fine. This module is the ONE place that reduces every
 * spelling to a single canonical dataset identity, so a Spark-emitted edge and a
 * pipeline-emitted edge over the same folder land on ONE node.
 *
 * ## Canonical form (grounded in the OpenLineage naming spec)
 *
 * OpenLineage "Naming" spec (openlineage.io/docs/spec/naming, docs release
 * 1.52.0; RunEvent pinned to schema 1-0-5 — see `OL_RUNEVENT_SCHEMA_URL`):
 *
 *   Azure Data Lake Gen2   namespace `abfss://{container}@{account}.dfs.{suffix}`
 *                          name      `{path}`
 *   Azure Blob (wasbs)     namespace `wasbs://{container}@{account}.blob.{suffix}`
 *                          name      `{object key}`
 *   Azure Synapse          namespace `sqlserver://{host}:{port}`
 *                          name      `{schema}.{table}`
 *
 * Two deliberate, documented choices on top of the spec:
 *
 *  1. **wasbs/https/abfs all normalize to the `abfss://` namespace.** The spec
 *     gives blob its own scheme, but ADLS Gen2 (hierarchical namespace) exposes
 *     the SAME bytes over both the `blob` and `dfs` endpoints — Spark reads
 *     `abfss://`, ADF writes through the blob/dfs REST endpoint, and a graph
 *     that splits them is wrong about physical reality. One storage account +
 *     container + path ⇒ one dataset.
 *  2. **Synapse/SQL names are `{database}.{schema}.{table}`**, not the spec's
 *     bare `{schema}.{table}`. The 3-part form is what `normalizeIdentity()`
 *     maps to the `uc:` join key, so a pipeline's SQL sink collapses onto the
 *     same node the Unity Catalog overlay and the dbt manifest parser (L6,
 *     which also emits `catalog.schema.table`) contribute. A 2-part name would
 *     be ambiguous across databases on the same server anyway.
 *
 * The canonical URI (`canonicalStorageUri`) is exactly what
 * `unified-lineage.normalizeIdentity()` turns into a `path:` key, which is the
 * key the Purview/ADLS and Unity-Catalog `storage_location` overlays already
 * collapse on. That is the whole join.
 *
 * PURE — no I/O, no SDK, no env reads. Sovereign-cloud-safe: the storage suffix
 * (`core.windows.net` / `core.usgovcloudapi.net` / any future sovereign suffix)
 * is carried through from the input, never assumed.
 */

import type { OpenLineageDatasetRef } from '@/lib/azure/openlineage-ingest';

// ---------------------------------------------------------------------------
// Storage URIs
// ---------------------------------------------------------------------------

/** The parts of an Azure storage location, however it was originally spelled. */
export interface StorageUriParts {
  /** Storage account name (lowercased), e.g. `stloom`. */
  account: string;
  /** Container / filesystem name (lowercased), e.g. `bronze`. */
  container: string;
  /** Endpoint suffix, e.g. `core.windows.net` / `core.usgovcloudapi.net`. */
  suffix: string;
  /** Path within the container, no leading/trailing slash. May be ''. */
  path: string;
}

/**
 * Delta/Parquet writers name the LOG and the PART FILES, not the table folder.
 * Folding them to the owning folder is what makes a Spark `COMPLETE` event over
 * `…/sales/_delta_log` join the pipeline's `…/sales` sink. Ordered longest-first
 * is irrelevant here — each rule strips from the first match onward.
 */
const TABLE_FOLDER_MARKERS = ['_delta_log', '_symlink_format_manifest', '_spark_metadata'];

/** File leaf names an engine writes INSIDE a table folder (never the dataset). */
const PART_FILE_RE = /^(part-|_committed_|_started_|_SUCCESS$|\.part-)/i;

/**
 * Fold a container-relative path onto the DATASET folder: drop a `_delta_log`
 * (or equivalent) segment and everything under it, and drop a trailing engine
 * part-file leaf. Idempotent.
 */
export function foldToTableFolder(rawPath: string): string {
  let p = String(rawPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return '';
  const segs = p.split('/');
  const markerAt = segs.findIndex((s) => TABLE_FOLDER_MARKERS.includes(s.toLowerCase()));
  if (markerAt >= 0) segs.length = markerAt;
  // A trailing part-file leaf belongs to the folder above it.
  const last = segs[segs.length - 1];
  if (last && PART_FILE_RE.test(last)) segs.pop();
  p = segs.filter(Boolean).join('/');
  return p;
}

/**
 * Parse ANY spelling of an Azure storage location into its parts, or null when
 * the string is not an Azure storage location (a REST url, a Cosmos container,
 * an S3 bucket — callers then leave it alone rather than mangling it).
 *
 * Accepted spellings:
 *   abfss://c@acct.dfs.core.windows.net/p     (Spark / UC storage_location)
 *   abfs://c@acct.dfs.core.windows.net/p
 *   wasbs://c@acct.blob.core.windows.net/p    (legacy blob mount)
 *   wasb://c@acct.blob.core.windows.net/p
 *   https://acct.dfs.core.windows.net/c/p     (ADF AzureBlobFS linked service)
 *   https://acct.blob.core.windows.net/c/p    (ADF AzureBlobStorage linked service)
 */
export function parseStorageUri(raw: string | null | undefined): StorageUriParts | null {
  const v = String(raw || '').trim();
  if (!v) return null;

  // scheme://container@account.<dfs|blob>.<suffix>/path
  const at = /^(abfss?|wasbs?):\/\/([^@/]+)@([^./]+)\.(?:dfs|blob)\.([^/]+?)(?:\/(.*))?$/i.exec(v);
  if (at) {
    const [, , container, account, suffix, path] = at;
    return {
      account: account.toLowerCase(),
      container: container.toLowerCase(),
      suffix: suffix.toLowerCase().replace(/\/+$/, ''),
      path: foldToTableFolder(path || ''),
    };
  }

  // https://account.<dfs|blob>.<suffix>/container/path
  const https = /^https?:\/\/([^./]+)\.(?:dfs|blob)\.([^/]+?)(?::\d+)?\/([^/]+)(?:\/(.*))?$/i.exec(v);
  if (https) {
    const [, account, suffix, container, path] = https;
    return {
      account: account.toLowerCase(),
      container: container.toLowerCase(),
      suffix: suffix.toLowerCase().replace(/\/+$/, ''),
      path: foldToTableFolder(path || ''),
    };
  }

  return null;
}

/**
 * The ONE canonical string identity of an Azure storage dataset:
 * `abfss://{container}@{account}.dfs.{suffix}/{path}`, **fully lowercased** and
 * without a trailing slash. Non-Azure-storage inputs are returned
 * lowercased+trimmed unchanged so callers can pass anything through safely.
 *
 * Case: blob names are technically case-sensitive, but every Loom lineage
 * identity has always been case-folded (`normalizeIdentity`, the ingest route's
 * path matcher), and a join that breaks because one producer wrote `/Bronze`
 * and another `/bronze` is exactly the failure this module exists to prevent.
 * The case-faithful form is still available via {@link storagePartsToUri} and
 * is what the emitted OpenLineage dataset `name` carries.
 *
 * This is the string `normalizeIdentity()` turns into the `path:` join key.
 */
export function canonicalStorageUri(raw: string | null | undefined): string {
  const parts = parseStorageUri(raw);
  if (!parts) return String(raw || '').trim().replace(/\/+$/, '').toLowerCase();
  return storagePartsToUri(parts).toLowerCase();
}

/** Assemble canonical parts back into the canonical URI (case-faithful path). */
export function storagePartsToUri(p: StorageUriParts): string {
  const base = `abfss://${p.container}@${p.account}.dfs.${p.suffix}`;
  return p.path ? `${base}/${p.path}` : base;
}

/**
 * The canonical OpenLineage `{namespace, name}` for a storage dataset, split
 * exactly the way the openlineage-spark integration splits it (namespace =
 * scheme + authority, name = `/path`) so a Loom-emitted event and a
 * listener-emitted event over the same folder are byte-identical, and
 * `openlineage-ingest.datasetUri()` rejoins both to the same canonical URI.
 */
export function storageDataset(raw: string): OpenLineageDatasetRef {
  const parts = parseStorageUri(raw);
  if (!parts) {
    // Not Azure storage — emit it whole in `name` (the OL convention for
    // producers that don't split), lowercased for a stable join.
    return { namespace: '', name: String(raw || '').trim().replace(/\/+$/, '').toLowerCase() };
  }
  return {
    namespace: `abfss://${parts.container}@${parts.account}.dfs.${parts.suffix}`,
    name: `/${parts.path}`,
  };
}

// ---------------------------------------------------------------------------
// ADF / Synapse dataset descriptors → the canonical storage dataset
// ---------------------------------------------------------------------------

/** The location fields an ADF/Synapse file dataset carries (see adf-dataset-builder). */
export interface AdfFileLocation {
  /** `AzureBlobFSLocation` | `AzureBlobStorageLocation` | … */
  type?: string;
  /** AzureBlobFSLocation container key. */
  fileSystem?: string;
  /** AzureBlobStorageLocation container key. */
  container?: string;
  folderPath?: string;
  fileName?: string;
}

/**
 * Build the canonical storage URI for an ADF/Synapse file dataset from its
 * `typeProperties.location` plus the account URL of the linked service it
 * references (`AzureBlobFS.url` = `https://acct.dfs.<suffix>`,
 * `AzureBlobStorage.serviceEndpoint` = `https://acct.blob.<suffix>`).
 *
 * Returns null when the account can't be determined or no container is named —
 * an un-anchored path would produce a node that joins to nothing, which is
 * worse than no node at all (no-vaporware: degrade, never fabricate).
 */
export function adfLocationToStorageUri(
  location: AdfFileLocation | undefined,
  linkedServiceUrl: string | undefined,
): string | null {
  if (!location) return null;
  const container = (location.fileSystem || location.container || '').trim();
  if (!container) return null;
  const acct = parseStorageAccountUrl(linkedServiceUrl);
  if (!acct) return null;
  const rel = [location.folderPath, location.fileName]
    .map((s) => String(s || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return storagePartsToUri({
    account: acct.account,
    container: container.toLowerCase(),
    suffix: acct.suffix,
    path: foldToTableFolder(rel),
  });
}

/** `https://acct.dfs.core.windows.net` (or blob) → { account, suffix }. */
export function parseStorageAccountUrl(
  url: string | null | undefined,
): { account: string; suffix: string } | null {
  const m = /^https?:\/\/([^./]+)\.(?:dfs|blob)\.([^/:]+)/i.exec(String(url || '').trim());
  if (!m) return null;
  return { account: m[1].toLowerCase(), suffix: m[2].toLowerCase() };
}

// ---------------------------------------------------------------------------
// SQL (Synapse dedicated / serverless, Azure SQL) datasets
// ---------------------------------------------------------------------------

export interface SqlDatasetParts {
  /** Fully-qualified server host, e.g. `syn-loom.sql.azuresynapse.net`. */
  server?: string;
  port?: number;
  database?: string;
  schema?: string;
  table: string;
}

/** Default TDS port — the OL naming spec wants `{host}:{port}` explicitly. */
export const TDS_PORT = 1433;

/**
 * Canonical OpenLineage dataset for a SQL relation:
 * namespace `sqlserver://{host}:{port}`, name `{database}.{schema}.{table}`
 * (see the header for why the 3-part name, not the spec's 2-part one).
 * When `table` already arrives dotted (e.g. `dbo.orders`) its parts win over
 * the separate `schema` field, matching how ADF `tableName` is authored.
 */
export function sqlDataset(parts: SqlDatasetParts): OpenLineageDatasetRef {
  const dotted = String(parts.table || '').trim().replace(/[[\]"`]/g, '');
  const segs = dotted.split('.').map((s) => s.trim()).filter(Boolean);
  let database = parts.database?.trim() || '';
  let schema = parts.schema?.trim() || '';
  let table = '';
  if (segs.length >= 3) { [database, schema, table] = segs.slice(-3); }
  else if (segs.length === 2) { [schema, table] = segs; }
  else { table = segs[0] || ''; }
  const name = [database, schema, table].filter(Boolean).join('.').toLowerCase();
  const host = (parts.server || '').trim().toLowerCase().replace(/^tcp:/, '').replace(/,\d+$/, '');
  return {
    namespace: host ? `sqlserver://${host}:${parts.port || TDS_PORT}` : '',
    name,
  };
}

/**
 * The string identity Loom stores on a thread edge for a dataset — the value
 * `normalizeIdentity()` must see to produce a `path:` / `uc:` join key.
 *
 *  - storage dataset → the canonical `abfss://…` URI          → `path:…`
 *  - SQL dataset     → the bare `database.schema.table` name   → `uc:…`
 *                      (the SAME convention the dbt manifest parser emits)
 *
 * Keeping this in ONE function is what guarantees the Spark emitter, the
 * pipeline emitter, and the dbt parser agree on the node id.
 */
export function datasetEdgeId(ds: OpenLineageDatasetRef): string {
  const ns = String(ds.namespace || '').trim().replace(/\/+$/, '');
  const name = String(ds.name || '').trim();
  if (/^sqlserver:\/\//i.test(ns)) return name.toLowerCase();
  if (!ns) return name.replace(/\/+$/, '').toLowerCase();
  return `${ns}/${name.replace(/^\/+/, '')}`.replace(/\/+$/, '').toLowerCase();
}
