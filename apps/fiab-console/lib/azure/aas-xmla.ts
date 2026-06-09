/**
 * aas-xmla.ts — pure helpers for the Azure Analysis Services XMLA data plane:
 * connection-string parsing, endpoint/scope URL building, the XMLA Execute SOAP
 * envelope, and the tabular-rowset response parser. ZERO Azure-SDK imports
 * (only cloud-endpoints + the dependency-free rdl-xml parser) so it is
 * unit-testable without the @azure/identity credential chain. The authenticated
 * `executeDaxQuery` lives in `aas-client.ts`.
 */

import { aasSuffix } from './cloud-endpoints';
import { parseXml, findFirst, toArray, type XmlObject } from './rdl-xml';

export interface AasTarget {
  /** AAS deployment region, e.g. 'eastus2' / 'usgovvirginia'. */
  region: string;
  /** Bare AAS server name (no region, no suffix). */
  server: string;
  /** Tabular model / database name on the server. */
  database: string;
}

/**
 * Parse an RDL DataSource ConnectionString of the form
 *   Data Source=asazure://eastus2.asazure.windows.net/myserver;Initial Catalog=AdventureWorks
 * into an {region, server, database}. `Initial Catalog=` (when present) sets the
 * database; otherwise the caller supplies it. Returns null when the string is
 * not an `asazure://` URI (→ route to Synapse SQL instead).
 */
export function parseAasConnectionString(connectionString: string, fallbackDatabase = ''): AasTarget | null {
  if (!connectionString || !/asazure:\/\//i.test(connectionString)) return null;
  const m = connectionString.match(/asazure:\/\/([^.]+)\.[^/]+\/([^;/\s]+)/i);
  if (!m) return null;
  const catalog = connectionString.match(/Initial Catalog\s*=\s*([^;]+)/i);
  return {
    region: m[1],
    server: m[2],
    database: (catalog ? catalog[1].trim() : '') || fallbackDatabase,
  };
}

/** Build the XMLA-over-HTTPS endpoint URL for an AAS model. */
export function aasEndpointUrl(t: AasTarget): string {
  return `https://${t.region}.${aasSuffix()}/servers/${t.server}/models/${encodeURIComponent(t.database)}`;
}

/** AAD `.default` token scope for an AAS endpoint (region-specific resource). */
export function aasTokenScope(t: AasTarget): string {
  return `https://${t.region}.${aasSuffix()}/.default`;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build an XMLA Execute SOAP envelope that runs `statement` against `database`. */
export function buildXmlaExecute(database: string, statement: string): string {
  return [
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">',
    '<Body>',
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">',
    '<Command><Statement>' + escXml(statement) + '</Statement></Command>',
    '<Properties><PropertyList>',
    '<Catalog>' + escXml(database) + '</Catalog>',
    '<Format>Tabular</Format><Content>Data</Content>',
    '</PropertyList></Properties>',
    '</Execute>',
    '</Body>',
    '</Envelope>',
  ].join('');
}

/**
 * Parse an XMLA Tabular Execute response into columns + rows. The rowset lives
 * at `…/return/root/row[]`; each `<row>` has one child element per column whose
 * tag name is the column name. We locate the `row` collection by name (robust
 * to the SOAP namespace prefix) and project it into a column/row grid.
 */
export function parseXmlaRowset(xmlText: string): { columns: string[]; rows: unknown[][] } {
  const doc = parseXml(xmlText);
  const rowsVal = findFirst(doc, 'row');
  const rows = toArray<XmlObject | string>(rowsVal).filter((r): r is XmlObject => typeof r === 'object');
  if (!rows.length) return { columns: [], rows: [] };
  const cols: string[] = [];
  for (const r of rows.slice(0, 50)) {
    for (const k of Object.keys(r)) {
      if (k.startsWith('@_') || k === '#text') continue;
      if (!cols.includes(k)) cols.push(k);
    }
  }
  const grid = rows.map((r) => cols.map((c) => {
    const v = r[c];
    if (v === undefined || v === null) return null;
    return typeof v === 'string' ? v : (typeof (v as XmlObject)['#text'] === 'string' ? (v as XmlObject)['#text'] : null);
  }));
  return { columns: cols, rows: grid };
}
