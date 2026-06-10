/**
 * mirror-iceberg — the Azure-native, Fabric-free implementation of the
 * "Include Iceberg tables" option for a Snowflake mirror source.
 *
 * WHY THIS EXISTS
 * ---------------
 * Microsoft Fabric's "Configure mirroring" screen for Snowflake offers, under
 * "Mirror all data", a choice between mirroring **all managed and Iceberg
 * tables** or **only managed tables (skipping Iceberg)** — see
 * https://learn.microsoft.com/fabric/mirroring/snowflake-tutorial#start-mirroring-process.
 *
 * Snowflake **managed** tables are copied/streamed by the engine (Loom's
 * snapshot/ADF-CDC path). Snowflake **Iceberg** tables are different: their data
 * already lives as Parquet + Iceberg metadata in *external* object storage
 * (ADLS Gen2 / S3) that Snowflake points at. Fabric does NOT re-copy them — it
 * creates a OneLake **shortcut** to that storage and uses metadata
 * virtualization to read the Iceberg table as Delta.
 *
 * The Azure-native 1:1 (no Fabric, no OneLake) is the same idea without OneLake:
 * register a **Synapse Serverless `OPENROWSET(... FORMAT='DELTA')`** query
 * accessor directly over the customer's Iceberg storage folder. Synapse
 * Serverless reads Delta/Iceberg-Parquet in place — zero data movement, exactly
 * Fabric's shortcut semantics. We therefore land NO bytes for Iceberg tables;
 * we emit a query accessor + the abfss/https path so the table is immediately
 * queryable from the paired Serverless SQL endpoint, a notebook, or a lakehouse
 * shortcut.
 *
 * This module is intentionally **pure** (no mssql/identity/native chain) so the
 * path math + spec building are unit-testable; the engine imports it and adds
 * the real ADLS probe + persistence.
 */

import { httpsToAbfss } from './cloud-endpoints';

/** A single Snowflake Iceberg table to expose, with its external-storage folder. */
export interface IcebergTableSpec {
  /** Snowflake schema (e.g. PUBLIC). */
  schema: string;
  /** Snowflake table name. */
  table: string;
  /**
   * Folder under the mirror's Iceberg storage root that holds this table's
   * Parquet + Iceberg metadata. When omitted we derive `<schema>/<table>`.
   * (In Snowflake this is the `metadataFileLocation` parent reported by
   * SYSTEM$GET_ICEBERG_TABLE_INFORMATION.)
   */
  folder?: string;
}

/** The result of registering one Iceberg table as an in-place query accessor. */
export interface IcebergTableResult {
  schema: string;
  table: string;
  /** Always 'iceberg' — distinguishes these rows from copied managed tables. */
  kind: 'iceberg';
  /** No data is moved for Iceberg tables — they are read in place. */
  status: 'registered' | 'error';
  /** abfss:// path to the table's Iceberg folder (sovereign-cloud-correct). */
  path?: string;
  /** https:// path to the same folder (for OPENROWSET BULK). */
  httpsPath?: string;
  /** Ready-to-run Synapse Serverless query reading the Iceberg table as Delta. */
  openrowset?: string;
  lastSync: string;
  note?: string;
  error?: string;
}

/**
 * The Snowflake-source mirror options the wizard captures. `includeIceberg`
 * mirrors Fabric's "all managed and Iceberg tables" vs "only managed" choice;
 * `icebergStorageUrl` is the one storage connection Fabric requires when Iceberg
 * is included ("only select Iceberg tables that are reachable via the same
 * storage connection").
 */
export interface SnowflakeMirrorOptions {
  includeIceberg?: boolean;
  /**
   * https:// or abfss:// root of the ADLS Gen2 container/folder that holds the
   * Snowflake Iceberg tables' external data. Required when includeIceberg is on.
   */
  icebergStorageUrl?: string;
  /** Explicit Iceberg table subset; empty = expose every discovered Iceberg table. */
  icebergTables?: IcebergTableSpec[];
}

/** Trim a path of leading/trailing slashes for safe joins. */
function trimSlashes(p: string): string {
  return String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Normalise the user-supplied Iceberg storage root to an abfss:// URL.
 * Accepts either an abfss:// URL (returned as-is, slash-normalised) or an
 * https:// dfs URL (converted via the sovereign-aware httpsToAbfss). Returns
 * null when the input is empty or not a recognisable ADLS Gen2 URL — the caller
 * turns that into an honest gate.
 */
export function normalizeIcebergRoot(url: string | undefined): string | null {
  const u = String(url || '').trim();
  if (!u) return null;
  if (u.startsWith('abfss://')) return u.replace(/\/+$/, '');
  if (/^https:\/\/[^/]+\.dfs\.core\./i.test(u)) {
    const abfss = httpsToAbfss(u.endsWith('/') ? u : `${u}/`);
    return abfss.startsWith('abfss://') ? abfss.replace(/\/+$/, '') : null;
  }
  return null;
}

/**
 * abfss:// → https:// for an ADLS Gen2 path so it can feed OPENROWSET(BULK ...).
 * Pure inverse of httpsToAbfss for the abfss shape this module produces:
 *   abfss://<container>@<host>/<path>  →  https://<host>/<container>/<path>
 * Returns the input unchanged if it isn't an abfss URL.
 */
export function abfssToHttps(abfss: string): string {
  const m = /^abfss:\/\/([^@]+)@([^/]+)\/(.*)$/.exec(String(abfss || ''));
  if (!m) return abfss;
  const [, container, host, rest] = m;
  return `https://${host}/${container}/${trimSlashes(rest)}`;
}

/**
 * Build the abfss + https folder paths for one Iceberg table under the storage
 * root. The folder defaults to `<schema>/<table>` (Snowflake's external-volume
 * convention) when not explicitly supplied.
 */
export function icebergTablePaths(
  root: string,
  spec: IcebergTableSpec,
): { abfss: string; https: string } {
  const folder = trimSlashes(spec.folder || `${spec.schema}/${spec.table}`);
  const abfss = `${root.replace(/\/+$/, '')}/${folder}`;
  return { abfss, https: abfssToHttps(abfss) };
}

/**
 * The Synapse Serverless OPENROWSET that reads an Iceberg table in place as
 * Delta (OneLake-free metadata virtualization equivalent). `FORMAT='DELTA'`
 * works because Synapse Serverless + the Iceberg→Delta-compatible Parquet layout
 * read the same files Fabric's shortcut would surface.
 */
export function icebergOpenrowset(httpsFolder: string): string {
  const folder = httpsFolder.endsWith('/') ? httpsFolder : `${httpsFolder}/`;
  return `SELECT TOP 100 * FROM OPENROWSET(BULK '${folder}', FORMAT = 'DELTA') AS rows`;
}

/**
 * Register the selected Iceberg tables as in-place query accessors. PURE: it
 * computes paths + OPENROWSET; the engine layer adds the real ADLS existence
 * probe and persistence. Returns one result row per table plus the resolved
 * storage root. When the root can't be normalised the caller should gate.
 */
export function buildIcebergResults(
  options: SnowflakeMirrorOptions,
  lastSync: string,
): { root: string | null; tables: IcebergTableResult[] } {
  const root = normalizeIcebergRoot(options.icebergStorageUrl);
  const specs = options.icebergTables || [];
  if (!root) return { root: null, tables: [] };
  const tables: IcebergTableResult[] = specs.map((spec) => {
    const { abfss, https } = icebergTablePaths(root, spec);
    return {
      schema: spec.schema,
      table: spec.table,
      kind: 'iceberg',
      status: 'registered',
      path: abfss,
      httpsPath: https,
      openrowset: icebergOpenrowset(https),
      lastSync,
      note:
        'Iceberg table read in place from external storage (no data copied) — ' +
        'Azure-native equivalent of Fabric\'s OneLake shortcut + Iceberg→Delta virtualization.',
    };
  });
  return { root, tables };
}
