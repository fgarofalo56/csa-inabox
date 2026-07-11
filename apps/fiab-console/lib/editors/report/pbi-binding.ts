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
 */

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
