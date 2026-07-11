/**
 * pbi-binding — pure, client-safe (no React / no fetch / no Node) shared types +
 * mappers for the Weave → Power BI "Pick a Loom item" source flow (W2).
 *
 * The `LoomItemSourcePicker` (a `'use client'` component) resolves a Loom item to
 * a `PbiBindingLite` via the BFF, then hands it to its host surfaces. The report
 * designer consumes the ready `ReportDataSource` directly; the paginated-report
 * editor maps the connector → an RDL data-source type; the semantic-model ingest
 * step turns the binding into a real Power Query M `Source =` expression. Those
 * two mappers are PURE, so they live here and are unit-tested without a DOM (the
 * repo's render tests are env-broken; pure logic tests run clean).
 *
 * W3 adds two more PURE mappers that let the paginated-report + semantic-model
 * editors reuse the shared `GetDataGallery` (connector catalog) — NOT just the
 * loom-item picker — while keeping their own persistence contracts intact:
 *   • `rdlFillFromReportSource` — a gallery-chosen `ReportDataSource` (+ the
 *     bound connection's real host/database) → the RDL `{type,server,database}`
 *     fields, or an honest gate for a source that isn't a paginated data source.
 *   • `mExprFromReportSource`   — the same chosen source → a REAL, ready-to-run
 *     Power Query M `Source =` step (no `<server>` / `<account>` placeholder),
 *     or an honest gate for a connector Loom can't yet turn into ingest M.
 */
import type { ReportDataSource, ReportConnType } from './report-data-source';

/** The Azure-native backend family a resolved Loom item sits on. */
export type PbiConnectorLite = 'synapse-sql' | 'adx' | 'adls' | 'azure-sql';

/** The normalized coordinates the BFF resolves for a Loom item (client mirror
 *  of the server `PbiSourceBinding`, minus the loom-native seed). */
export interface PbiBindingLite {
  connector: PbiConnectorLite;
  server?: string;
  clusterUri?: string;
  database: string;
  defaultTable?: string;
  behindPrivateEndpoint: boolean;
  sourceItemId: string;
  sourceType: string;
  sourceLabel: string;
}

/** One resolved column (name + best-effort type) shown in the preview grid. */
export interface PbiPreviewColumn { name: string; dataType: string }

/** RDL data-source types (mirror of `RdlDataSourceType` in paginated-report-client). */
export type RdlSourceType = 'AzureSQL' | 'Synapse' | 'Cosmos' | 'ADLS';

/**
 * Map a resolved Loom-item connector → the paginated-report RDL data-source type.
 * ADX has no RDL analog (its picker surfaces an honest gate), so it maps to
 * nothing — the caller leaves the type unchanged.
 */
export const CONNECTOR_TO_RDL: Partial<Record<PbiConnectorLite, RdlSourceType>> = {
  'synapse-sql': 'Synapse',
  'azure-sql': 'AzureSQL',
  'adls': 'ADLS',
};

/** Split a (possibly `schema.table`) default table into `{schema, table}`. */
function splitTable(defaultTable: string): { schema: string; table: string } {
  const parts = defaultTable.includes('.') ? defaultTable.split('.') : ['dbo', defaultTable];
  const table = parts.pop() as string;
  const schema = parts.pop() || 'dbo';
  return { schema, table };
}

/**
 * Build a REAL Power Query M `Source =` expression from a resolved binding — no
 * `<server>` placeholder to hand-edit. Covers the Synapse SQL (lakehouse /
 * warehouse / mirror / serverless / dedicated) and ADX (eventhouse / KQL
 * database) connectors. Returns null for connectors with no account-complete M
 * (dataset / ADLS) — the picker still shows the resolution, and the user picks a
 * file connector card instead.
 *
 * String literals are double-quoted with `"` → `""` escaping. This emits Power
 * Query M (double-quoted strings), NOT SQL — there is no SQL identifier quoting
 * here (no bracket-quoting), so it is outside the `@/lib/sql/quoting` surface.
 */
export function mExprFromBinding(b: PbiBindingLite): string | null {
  const q = (v: string) => v.replace(/"/g, '""');
  if (b.connector === 'synapse-sql' && b.server) {
    if (b.defaultTable) {
      const { schema, table } = splitTable(b.defaultTable);
      return `Sql.Database("${q(b.server)}", "${q(b.database)}"){[Schema="${q(schema)}", Item="${q(table)}"]}[Data]`;
    }
    return `Sql.Database("${q(b.server)}", "${q(b.database)}")`;
  }
  if (b.connector === 'adx' && b.clusterUri) {
    const table = b.defaultTable ? (b.defaultTable.split('.').pop() as string) : '';
    return `AzureDataExplorer.Contents("${q(b.clusterUri)}", "${q(b.database)}", "${q(table)}")`;
  }
  return null;
}

// ===========================================================================
// W3 — shared GetDataGallery reuse in the paginated-report + semantic-model
// editors. Both take a gallery-chosen `ReportDataSource` and the bound
// connection's non-secret coordinates and turn it into their own contract.
// ===========================================================================

/** The bound connection's non-secret coordinates (from `LoomConnectionView`). */
export interface ConnCoords { host?: string; database?: string; name?: string }

/**
 * Map a report `ConnType` → the paginated-report RDL data-source type. Only the
 * SQL-family + Cosmos types have an RDL analog; storage / file / Databricks /
 * PostgreSQL / ADX / MySQL do not (the caller surfaces an honest gate).
 */
export const REPORT_CONN_TO_RDL: Partial<Record<ReportConnType, RdlSourceType>> = {
  'azure-sql': 'AzureSQL',
  'generic-sql': 'AzureSQL',
  'synapse-dedicated': 'Synapse',
  'synapse-serverless': 'Synapse',
  'cosmos': 'Cosmos',
};

/** The RDL fields a gallery pick fills, or an honest gate string. */
export type RdlFill =
  | { ok: true; type: RdlSourceType; server?: string; database?: string; name?: string }
  | { ok: false; gate: string };

const RDL_UNSUPPORTED_GATE =
  'This source type isn’t a paginated-report data source yet. Pick a SQL connection ' +
  '(Azure SQL, Synapse, or Cosmos), or use “Pick a Loom item” to source from a ' +
  'lakehouse / warehouse / dataset.';

/**
 * Turn a GetDataGallery-chosen `ReportDataSource` (+ the bound connection's real
 * host/database) into the RDL `{type,server,database}` a paginated data source
 * persists. Only `kind:'connection'` on an RDL-mappable connType fills; every
 * other pick (file / ADLS / Databricks / PostgreSQL / ADX / MySQL) returns an
 * honest gate — the RDL contract is never filled with fabricated coordinates.
 */
export function rdlFillFromReportSource(ds: ReportDataSource, coords?: ConnCoords): RdlFill {
  if (ds.kind !== 'connection') return { ok: false, gate: RDL_UNSUPPORTED_GATE };
  const type = REPORT_CONN_TO_RDL[ds.connType];
  if (!type) return { ok: false, gate: RDL_UNSUPPORTED_GATE };
  // SQL-family + Synapse need a real server FQDN; Cosmos needs its account host.
  if (!coords?.host) {
    return {
      ok: false,
      gate:
        'This connection has no server / host recorded. Re-import it with its host ' +
        '(and database), or use “Pick a Loom item”.',
    };
  }
  return {
    ok: true,
    type,
    server: coords.host,
    database: coords.database,
    name: coords.name,
  };
}

/** A real Power Query M step, or an honest gate string. */
export type MFill = { ok: true; m: string } | { ok: false; gate: string };

/** Build a file `Document()` M over a full DataLake URL for a tabular format. */
function fileDocM(format: string, url: string): MFill {
  const q = (v: string) => v.replace(/"/g, '""');
  const f = (format || '').toLowerCase();
  const contents = `AzureStorage.DataLakeContents("${q(url)}")`;
  if (f === 'csv') {
    return { ok: true, m: `Csv.Document(${contents}, [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv])` };
  }
  if (f === 'parquet') return { ok: true, m: `Parquet.Document(${contents})` };
  if (f === 'json') return { ok: true, m: `Json.Document(${contents})` };
  return {
    ok: false,
    gate:
      `Delta folders aren’t a direct Power Query ingest source. Source the Delta ` +
      `table via a Synapse / lakehouse SQL connection (or “Pick a Loom item”), or ` +
      `upload a CSV / Parquet / JSON file.`,
  };
}

/** Build a SQL-family `Source =` M step from a bound object ref. */
function sqlM(fn: 'Sql.Database' | 'PostgreSQL.Database', host: string, database: string, ds: ReportDataSource & { kind: 'connection' }): MFill {
  const q = (v: string) => v.replace(/"/g, '""');
  const ref = ds.objectRef;
  if (ref.mode === 'query') {
    return { ok: true, m: `${fn}("${q(host)}", "${q(database)}", [Query="${q(ref.sql)}"])` };
  }
  if (ref.mode === 'table') {
    const schema = (ref.schema && ref.schema.trim()) || 'dbo';
    return { ok: true, m: `${fn}("${q(host)}", "${q(database)}"){[Schema="${q(schema)}", Item="${q(ref.table)}"]}[Data]` };
  }
  return { ok: false, gate: 'This connection object type isn’t supported for ingest — pick a table/view or a custom SQL query.' };
}

const M_UNSUPPORTED_GATE =
  'This connector isn’t a supported Power Query ingest source yet. Supported: Azure ' +
  'SQL, Synapse, PostgreSQL, and uploaded CSV / Parquet / JSON files. Land this data ' +
  'in the lake (e.g. via Copy / mirror) and ingest from ADLS, or use “Pick a Loom item”.';

/**
 * Turn a GetDataGallery-chosen `ReportDataSource` (+ the bound connection's real
 * host/database) into a REAL Power Query M `Source =` expression for the
 * semantic-model ingest wizard — NO `<server>` / `<account>` placeholder to
 * hand-edit. Supports SQL-family + PostgreSQL connections, storage-connection
 * files (host = account), and uploaded files (real abfss/https path). Every
 * other pick returns an honest gate.
 */
export function mExprFromReportSource(ds: ReportDataSource, coords?: ConnCoords): MFill {
  if (ds.kind === 'file-upload') {
    return ds.containerPath
      ? fileDocM(ds.format, ds.containerPath)
      : { ok: false, gate: 'The uploaded file has no path yet — re-upload it.' };
  }
  if (ds.kind === 'adls-file') {
    return {
      ok: false,
      gate:
        'A bare container/path has no storage account to build a Power Query source ' +
        'from. Pick the file via a storage Connection (Loom resolves the account) or ' +
        'upload it, and Loom inserts a real Source step.',
    };
  }
  if (ds.kind !== 'connection') return { ok: false, gate: M_UNSUPPORTED_GATE };

  const host = coords?.host;
  const database = coords?.database;
  const missing = (): MFill => ({
    ok: false,
    gate: 'This connection has no host / database recorded. Re-import it with its host and database.',
  });
  switch (ds.connType) {
    case 'azure-sql':
    case 'generic-sql':
    case 'synapse-dedicated':
    case 'synapse-serverless':
      return host && database ? sqlM('Sql.Database', host, database, ds) : missing();
    case 'postgres':
      return host && database ? sqlM('PostgreSQL.Database', host, database, ds) : missing();
    case 'storage-adls':
      if (ds.objectRef.mode === 'file' && host) {
        const path = ds.objectRef.containerPath.replace(/^\/+/, '');
        const url = /^https?:\/\/|^abfss:\/\//i.test(ds.objectRef.containerPath)
          ? ds.objectRef.containerPath
          : `https://${host}/${path}`;
        return fileDocM(ds.objectRef.format, url);
      }
      return { ok: false, gate: M_UNSUPPORTED_GATE };
    default:
      return { ok: false, gate: M_UNSUPPORTED_GATE };
  }
}
