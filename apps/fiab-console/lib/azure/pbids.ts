/**
 * pbids — pure Power BI Desktop connection-file (.pbids) generator for Loom's
 * Azure-native data sources. NO Microsoft Fabric / Power BI service dependency:
 * the file targets the Loom item's underlying Azure endpoint directly (Synapse
 * SQL / Azure SQL via TDS, Azure Analysis Services via the analysis-services
 * protocol, Azure Data Explorer via the azure-data-explorer protocol). When a
 * user opens the downloaded .pbids, Power BI Desktop launches already pointed at
 * that endpoint and prompts only for credentials (the file carries no secrets).
 *
 * No IO, no process.env reads, no fetch — safe for client components and vitest
 * without mocks. The BFF route resolves the real surfaced endpoint and passes a
 * normalized {@link PbidsSource}; this module shapes the file.
 *
 * PBIDS schema + per-connector protocol strings are grounded in Microsoft Learn,
 * NOT invented:
 *   - File shape ({ version:"0.1", connections:[{ details:{ protocol, address },
 *     options?, mode? }] }) + the `tds` (SQL Server) and `analysis-services`
 *     (Azure AS) protocols + `mode` "DirectQuery"|"Import":
 *       https://learn.microsoft.com/power-bi/connect-data/desktop-data-sources#use-pbids-files-to-get-data
 *   - `azure-data-explorer` protocol with address { cluster, database } — the
 *     DSR the Azure Data Explorer (Kusto) connector exports; its two connection
 *     parameters are Cluster (https://<name>.<region>.kusto.windows.net) and
 *     Database, per the connector reference:
 *       https://learn.microsoft.com/power-query/connectors/azure-data-explorer
 */

/** PBIDS connector protocol strings Loom emits (grounded — see file header). */
export type PbidsProtocol = 'tds' | 'analysis-services' | 'azure-data-explorer';

/** PBIDS connectivity mode. Omitted ⇒ Power BI Desktop prompts the user. */
export type PbidsMode = 'DirectQuery' | 'Import';

export interface PbidsConnectionDetails {
  protocol: PbidsProtocol;
  /** Connector-specific address bag (server/database, server, or cluster/database). */
  address: Record<string, string>;
}

export interface PbidsConnection {
  details: PbidsConnectionDetails;
  /** Always present (per the Learn SQL Server example) even when empty. */
  options?: Record<string, unknown>;
  /** Only set for protocols that honor DirectQuery/Import (tds, azure-data-explorer). */
  mode?: PbidsMode;
}

export interface PbidsFile {
  version: '0.1';
  connections: PbidsConnection[];
}

/**
 * Loom item kinds that map to a PBIDS connection. Grouped by protocol:
 *   tds                → lakehouse / warehouse / sql-database / mirrored-*
 *   analysis-services  → semantic-model
 *   azure-data-explorer→ kql-database / eventhouse
 */
export type PbidsItemKind =
  | 'lakehouse'
  | 'warehouse'
  | 'sql-database'
  | 'mirrored-database'
  | 'mirrored-databricks'
  | 'mirrored-catalog'
  | 'semantic-model'
  | 'kql-database'
  | 'eventhouse';

/** Normalized, already-resolved endpoint descriptor handed to {@link buildPbids}. */
export interface PbidsSource {
  kind: PbidsItemKind;
  /** TDS: SQL server FQDN, e.g. `ws-ondemand.sql.azuresynapse.net`. */
  server?: string;
  /** TDS / analysis-services: database / tabular-model (catalog) name. */
  database?: string;
  /**
   * analysis-services: the AAS server / XMLA address. Accepts a bare
   * `<region>.asazure.windows.net/<server>` (an `asazure://` scheme is added) or
   * an already-schemed `asazure://…` / `powerbi://…` URI.
   */
  xmlaServer?: string;
  /** azure-data-explorer: cluster URI, e.g. `https://cluster.region.kusto.windows.net`. */
  cluster?: string;
  /** Requested connectivity mode (tds + adx). Defaults to DirectQuery. AS ignores it. */
  mode?: PbidsMode;
}

/** Thrown when the surfaced endpoint can't produce a valid .pbids. The route
 *  turns this into an honest 412 gate naming `missing` (per no-vaporware.md). */
export class PbidsError extends Error {
  /** The address field / endpoint that could not be resolved. */
  missing: string;
  constructor(message: string, missing: string) {
    super(message);
    this.name = 'PbidsError';
    this.missing = missing;
  }
}

const TDS_KINDS: ReadonlySet<PbidsItemKind> = new Set([
  'lakehouse', 'warehouse', 'sql-database',
  'mirrored-database', 'mirrored-databricks', 'mirrored-catalog',
]);

/** Resolve the PBIDS protocol for a Loom item kind. */
export function protocolForKind(kind: PbidsItemKind): PbidsProtocol {
  if (kind === 'semantic-model') return 'analysis-services';
  if (kind === 'kql-database' || kind === 'eventhouse') return 'azure-data-explorer';
  if (TDS_KINDS.has(kind)) return 'tds';
  throw new PbidsError(`Unsupported PBIDS item kind: ${kind}`, 'kind');
}

/** Coerce a caller-supplied mode string (?mode=import|directQuery) to PbidsMode. */
export function normalizeMode(raw: string | null | undefined): PbidsMode | undefined {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'import') return 'Import';
  if (v === 'directquery' || v === 'direct-query') return 'DirectQuery';
  return undefined;
}

/**
 * Normalize an AAS server address into the `asazure://…` form Power BI Desktop's
 * analysis-services connector expects. A `powerbi://…` URI (opt-in Premium XMLA)
 * is passed through unchanged.
 *   `westus2.asazure.windows.net/myserver` → `asazure://westus2.asazure.windows.net/myserver`
 *   `asazure://westus2.asazure.windows.net/myserver` → unchanged
 *   `https://westus2.asazure.windows.net/servers/myserver` → `asazure://westus2.asazure.windows.net/myserver`
 */
export function normalizeAnalysisServicesServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (/^(asazure|powerbi|localhost):\/\//i.test(s)) return s;
  // XMLA-over-HTTP form → asazure form.
  const httpsForm = /^https?:\/\/([^/]+)\/servers\/(.+)$/i.exec(s);
  if (httpsForm) return `asazure://${httpsForm[1]}/${httpsForm[2]}`;
  const bare = s.replace(/^https?:\/\//i, '');
  return `asazure://${bare}`;
}

/**
 * Build a single-connection PBIDS file for a resolved Loom Azure endpoint.
 * Pure + deterministic. Throws {@link PbidsError} (with `missing`) when a
 * required address part is absent so the route can render an honest gate rather
 * than hand the user a broken download.
 */
export function buildPbids(source: PbidsSource): PbidsFile {
  const protocol = protocolForKind(source.kind);

  let connection: PbidsConnection;
  if (protocol === 'tds') {
    const server = (source.server || '').trim();
    if (!server) {
      throw new PbidsError(
        `No SQL endpoint resolved for ${source.kind}. The data source has no surfaced SQL server FQDN.`,
        'server',
      );
    }
    const address: Record<string, string> = { server };
    const database = (source.database || '').trim();
    if (database) address.database = database;
    connection = {
      details: { protocol: 'tds', address },
      options: {},
      mode: source.mode || 'DirectQuery',
    };
  } else if (protocol === 'analysis-services') {
    const xmla = (source.xmlaServer || '').trim();
    if (!xmla) {
      throw new PbidsError(
        'No Analysis Services (XMLA) server resolved for the semantic model.',
        'xmlaServer',
      );
    }
    const address: Record<string, string> = { server: normalizeAnalysisServicesServer(xmla) };
    const database = (source.database || '').trim();
    if (database) address.database = database;
    // analysis-services connections are a model "connect" (Navigator picks the
    // model/tables) — the Learn Azure AS example omits `mode`, so we do too.
    connection = { details: { protocol: 'analysis-services', address } };
  } else {
    // azure-data-explorer
    const cluster = (source.cluster || '').trim();
    if (!cluster) {
      throw new PbidsError(
        `No Azure Data Explorer cluster resolved for ${source.kind}.`,
        'cluster',
      );
    }
    const address: Record<string, string> = { cluster };
    const database = (source.database || '').trim();
    if (database) address.database = database;
    connection = {
      details: { protocol: 'azure-data-explorer', address },
      options: {},
      mode: source.mode || 'DirectQuery',
    };
  }

  return { version: '0.1', connections: [connection] };
}

/** Serialize a PBIDS file as the JSON text written to the `.pbids` download. */
export function serializePbids(file: PbidsFile): string {
  return JSON.stringify(file, null, 2);
}
