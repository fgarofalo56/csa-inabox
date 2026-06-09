/**
 * aas-tmsl — the network-free core of the Azure Analysis Services XMLA client:
 * config readers, SOAP/XMLA envelope construction, fault + tabular-row parsing,
 * and the TMSL measure command builder. This module deliberately imports NO
 * `@azure/identity` (or any credential / fetch surface) so it is fully unit
 * testable and so the editor's pure logic carries no auth dependency.
 *
 * `aas-client.ts` re-exports this surface and adds the credential + the actual
 * XMLA POST. See aas-client.ts for the endpoint / audience documentation.
 */

import { aasServerBase } from './cloud-endpoints';

export class AasError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

/** Canonical HTTPS server base from LOOM_AAS_SERVER (read lazily so env can vary). */
export function serverBase(): string {
  return aasServerBase(process.env.LOOM_AAS_SERVER || '');
}

/** XMLA POST target — `LOOM_AAS_XMLA_URL` override, else the server base URL. */
export function xmlaUrl(): string {
  return (process.env.LOOM_AAS_XMLA_URL || serverBase()).replace(/\/+$/, '');
}

/** Configured AAS model database name (LOOM_AAS_DATABASE), or '' if unset. */
export function aasDefaultDatabase(): string {
  return process.env.LOOM_AAS_DATABASE || '';
}

/** True when LOOM_AAS_SERVER is set and parseable into an XMLA endpoint. */
export function isAasConfigured(): boolean {
  return !!xmlaUrl();
}

/** Return the XMLA endpoint URL or throw the honest 501 infra-gate. */
export function requireXmlaUrl(): string {
  const url = xmlaUrl();
  if (!url) {
    throw new AasError(
      'LOOM_AAS_SERVER is not configured. Set it to the AAS connection string (asazure://<region>.asazure.windows.net/<serverName>).',
      501,
    );
  }
  return url;
}

/** Resolve the effective database (arg → LOOM_AAS_DATABASE) or throw 501. */
export function resolveDatabase(database?: string): string {
  const db = (database || aasDefaultDatabase()).trim();
  if (!db) {
    throw new AasError('LOOM_AAS_DATABASE is not configured. Set it to the AAS model database name.', 501);
  }
  return db;
}

/** Escape XML-special characters so TMSL JSON / DAX text embeds safely. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the SOAP/XMLA Execute envelope wrapping a TMSL or DAX Statement. The
 * Catalog property pins the active database on the XMLA connection; Tabular
 * format yields a row-shaped DAX result.
 */
export function buildSoapEnvelope(database: string, statement: string): string {
  const escaped = xmlEscape(statement);
  const catalog = xmlEscape(database || '');
  return `<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>${escaped}</Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>${catalog}</Catalog>
          <Format>Tabular</Format>
        </PropertyList>
      </Properties>
    </Execute>
  </Body>
</Envelope>`;
}

/** Extract a SOAP/XMLA fault message from response XML, namespace-agnostic. */
export function extractFault(xml: string): string | null {
  const fs = xml.match(/<(?:[^:>]+:)?faultstring[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?faultstring>/i);
  if (fs) return fs[1].trim();
  // AS engine errors arrive as <Error ... Description="..."/> inside the body.
  const err = xml.match(/<(?:[^:>]+:)?Error[^>]*\bDescription="([^"]+)"/i);
  if (err) return err[1].trim();
  return null;
}

/**
 * Parse tabular <row> elements from an XMLA Execute response. Each <row>
 * carries named child elements whose local-name is the column header. A simple
 * regex walk is sufficient for the single-row probe pattern this client uses
 * (`EVALUATE ROW(...)`); complex multi-column rowsets keep their string values.
 */
export function parseXmlaRows(xml: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const rowMatches = xml.matchAll(/<(?:[^:>]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[^:>]+:)?row>/gi);
  for (const rowMatch of rowMatches) {
    const rowContent = rowMatch[1];
    const row: Record<string, unknown> = {};
    const cellMatches = rowContent.matchAll(/<([A-Za-z_][\w.]*)\b[^>]*>([\s\S]*?)<\/\1>/g);
    for (const cell of cellMatches) {
      row[cell[1]] = cell[2].trim();
    }
    rows.push(row);
  }
  return rows;
}

/** Build the TMSL createOrReplace command for a single measure (pure — testable). */
export function buildMeasureUpsertTmsl(opts: {
  database: string;
  tableName: string;
  measureName: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
}): object {
  const measure: Record<string, string> = {
    name: opts.measureName,
    expression: opts.expression,
  };
  if (opts.formatString) measure.formatString = opts.formatString;
  if (opts.displayFolder) measure.displayFolder = opts.displayFolder;
  return {
    createOrReplace: {
      object: { database: opts.database, table: opts.tableName, measure: opts.measureName },
      measure,
    },
  };
}

/** Build `EVALUATE ROW("value", 'Table'[Measure])` for a single-measure probe. */
export function buildMeasureEvalQuery(tableName: string, measureName: string): string {
  const tbl = `'${(tableName || '').replace(/'/g, "''")}'`;
  const meas = `[${(measureName || '').replace(/]/g, '')}]`;
  return `EVALUATE ROW("value", ${tbl}${meas})`;
}
