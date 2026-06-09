/**
 * Pure XMLA helpers for the Azure Analysis Services DAX backend — no Azure SDK
 * imports, so this module is unit-testable in a plain Node environment. The
 * credentialed executor lives in `aas-client.ts` (which imports these).
 *
 * Docs:
 *   - XMLA Execute (DAX via the EVALUATE statement):
 *     https://learn.microsoft.com/openspecs/sql_server_protocols/ms-xmla
 *   - AAS connect / XMLA endpoint:
 *     https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-connect
 */

export const AAS_MAX_ROWS = 5_000;

export class AasError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status = 502, body?: unknown) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

export interface AasQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  truncated: boolean;
}

/**
 * Honest config gate. AAS is opt-in (LOOM_SEMANTIC_BACKEND=analysis-services).
 * `LOOM_AAS_SERVER` is the server data-plane address in the form
 * `<region>.asazure.windows.net/<serverName>` (no scheme); `LOOM_AAS_MODEL` is
 * the tabular model (database) name. Returns `{ missing }` when not configured,
 * else `null`.
 */
export function aasConfigGate(): { missing: string; hint: string } | null {
  const server = process.env.LOOM_AAS_SERVER?.trim();
  const model = process.env.LOOM_AAS_MODEL?.trim();
  if (!server) {
    return {
      missing: 'LOOM_AAS_SERVER',
      hint:
        'Set LOOM_AAS_SERVER to the Azure Analysis Services data-plane address ' +
        '(e.g. westus2.asazure.windows.net/myserver) and add the Console UAMI as a ' +
        'server administrator: `az ams server admin add --resource-group <rg> --name <server> ' +
        '--object-id <uami-principal-id>`.',
    };
  }
  if (!model) {
    return {
      missing: 'LOOM_AAS_MODEL',
      hint: 'Set LOOM_AAS_MODEL to the tabular model (database) name on the AAS server.',
    };
  }
  return null;
}

/** Resolve the configured server address + model, throwing the gate as an error. */
export function resolveAasTarget(): { server: string; model: string } {
  const gate = aasConfigGate();
  if (gate) throw new AasError(`AAS not configured: ${gate.missing}. ${gate.hint}`, 503, gate);
  return {
    server: process.env.LOOM_AAS_SERVER!.trim(),
    model: process.env.LOOM_AAS_MODEL!.trim(),
  };
}

/**
 * Build the XMLA-over-HTTP POST URL for an AAS server address.
 *   server = "westus2.asazure.windows.net/myserver"
 *   → https://westus2.asazure.windows.net/servers/myserver
 */
export function buildAasXmlaUrl(server: string): string {
  const cleaned = server.replace(/^https?:\/\//i, '').replace(/^asazure:\/\//i, '').replace(/\/+$/, '');
  const slash = cleaned.indexOf('/');
  if (slash < 0) {
    throw new AasError(
      `LOOM_AAS_SERVER must be "<region>.asazure.windows.net/<serverName>" (got "${server}")`,
      400,
    );
  }
  const host = cleaned.slice(0, slash);
  const serverName = cleaned.slice(slash + 1);
  return `https://${host}/servers/${encodeURIComponent(serverName)}`;
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SOAP 1.1 XMLA Execute envelope carrying a DAX statement (Tabular rowset). */
export function buildExecuteEnvelope(model: string, dax: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>` +
    `<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">` +
    `<Command><Statement>${xmlEscape(dax)}</Statement></Command>` +
    `<Properties><PropertyList>` +
    `<Catalog>${xmlEscape(model)}</Catalog>` +
    `<Format>Tabular</Format>` +
    `<Content>Data</Content>` +
    `</PropertyList></Properties>` +
    `</Execute>` +
    `</soap:Body></soap:Envelope>`
  );
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse the XMLA rowset returned in the SOAP body. The rowset namespace emits
 * one `<row>` element per row whose child element local-names are the column
 * names. Tabular `EVALUATE` results name columns like `Table[Column]` which the
 * server XML-encodes (`Table_x005B_Column_x005D_`); we decode the `_xHHHH_`
 * escapes so the UI shows the human column name.
 */
export function parseRowset(xml: string): { columns: string[]; rows: unknown[][] } {
  // Surface a server-side XMLA fault as a precise error.
  const fault = /<(?:\w+:)?Exception\b[^>]*\bErrorCode="[^"]*"[^>]*\bDescription="([^"]*)"/i.exec(xml)
    || /<faultstring>([\s\S]*?)<\/faultstring>/i.exec(xml)
    || /<Error\b[^>]*\bDescription="([^"]*)"/i.exec(xml);
  if (fault) throw new AasError(`AAS XMLA fault: ${decodeXmlEntities(fault[1])}`, 502, xml.slice(0, 600));

  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>|<row(?:\s[^>]*)?\/>/gi;
  const cellRe = /<((?:\w+:)?[\w.\-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  const columns: string[] = [];
  const colSeen = new Set<string>();
  const rowMaps: Map<string, string>[] = [];

  const decodeCol = (name: string): string =>
    name
      .replace(/^[\w]+:/, '') // strip namespace prefix
      .replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

  let rowMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((rowMatch = rowRe.exec(xml))) {
    const inner = rowMatch[1] || '';
    const cellMap = new Map<string, string>();
    cellRe.lastIndex = 0;
    let cellMatch: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((cellMatch = cellRe.exec(inner))) {
      const col = decodeCol(cellMatch[1]);
      if (col.toLowerCase() === 'row') continue;
      if (!colSeen.has(col)) { colSeen.add(col); columns.push(col); }
      cellMap.set(col, decodeXmlEntities(cellMatch[2]));
    }
    rowMaps.push(cellMap);
  }

  // Second pass: align every row to the union column order; coerce numerics.
  const aligned = rowMaps.map((map) =>
    columns.map((c) => {
      if (!map.has(c)) return null;
      const v = map.get(c)!;
      if (v === '') return '';
      const n = Number(v);
      return Number.isFinite(n) && v.trim() !== '' && /^-?\d/.test(v.trim()) ? n : v;
    }),
  );

  return { columns, rows: aligned };
}
