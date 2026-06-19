/**
 * aas-tmsl — PURE TMSL (Tabular Model Scripting Language) builders for the Loom
 * semantic-model "Model view" (relationships + drill hierarchies).
 *
 * Zero runtime imports: these functions are pure JSON serializers so they are
 * trivially unit-testable and carry no @azure/identity / network weight. The
 * I/O write surfaces (XMLA / Fabric REST) live in aas-client.ts, which
 * re-exports everything here.
 *
 * TMSL refs:
 *   relationship object  — https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl
 *   hierarchy object     — https://learn.microsoft.com/analysis-services/tmsl/hierarchies-object-tmsl
 *   createOrReplace      — https://learn.microsoft.com/analysis-services/tmsl/createorreplace-command-tmsl
 *   alter command        — https://learn.microsoft.com/analysis-services/tmsl/alter-command-tmsl
 */

// ---------------------------------------------------------------------------
// Shared error class (network-free — aas-client.ts re-exports this so existing
// importers keep working without any import path change).
// ---------------------------------------------------------------------------

/**
 * Structured error for Azure Analysis Services operations. `status` mirrors the
 * HTTP status code (e.g. 501 = infra gate, 401 = auth, 422 = TMSL fault). All
 * AAS client functions throw this rather than a generic Error so BFF routes can
 * distinguish infra gates (501) from transient errors (502) without string
 * matching.
 */
export class AasError extends Error {
  status: number;
  body?: unknown;
  endpoint?: string;
  /** Stable machine code for callers (e.g. 'aas_xmla_not_supported'). */
  code?: string;
  /** Operator-actionable remediation surfaced in the MessageBar. */
  remediation?: string;
  constructor(message: string, status: number, body?: unknown, endpoint?: string, code?: string, remediation?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.code = code;
    this.remediation = remediation;
  }
}

// ---------------------------------------------------------------------------
// Network-free AAS configuration helpers (readable from env only, no Azure SDK)
//
// These are extracted here so they can be unit-tested without the heavy
// @azure/identity chain that aas-client.ts imports. aas-client.ts re-exports
// them for back-compat with existing call sites.
// ---------------------------------------------------------------------------

/**
 * True when the AAS server is configured via env (`LOOM_AAS_SERVER` is set and
 * non-empty). Does not validate the URI format — use `requireXmlaUrl()` for
 * that (it also checks connectivity configuration).
 */
export function isAasConfigured(): boolean {
  return Boolean((process.env.LOOM_AAS_SERVER || '').trim());
}

/**
 * Return the default AAS database name from `LOOM_AAS_DATABASE`, or `''` when
 * unset. Callers that need a definite name should use `resolveDatabase()` which
 * throws an honest 501 when neither env nor arg is set.
 */
export function aasDefaultDatabase(): string {
  return (process.env.LOOM_AAS_DATABASE || '').trim();
}

/**
 * Derive the canonical XMLA POST URL for the configured server. Resolves to:
 *   - `LOOM_AAS_XMLA_URL` (with trailing slash stripped) when set, OR
 *   - `https://<host>/servers/<serverName>` from parsing `LOOM_AAS_SERVER`.
 * Returns `''` when `LOOM_AAS_SERVER` is unset. Call `requireXmlaUrl()` to
 * throw an honest 501 instead of returning empty.
 */
export function xmlaUrl(): string {
  const override = (process.env.LOOM_AAS_XMLA_URL || '').trim();
  if (override) return override.replace(/\/+$/, '');
  const raw = (process.env.LOOM_AAS_SERVER || '').trim();
  if (!raw) return '';
  const m = raw.match(/^(?:asazure|https?):\/\/([^/]+)\/([^/?#]+)/i);
  if (!m) return '';
  return `https://${m[1]}/servers/${m[2]}`;
}

/**
 * Return the XMLA POST URL for the configured server, or throw `AasError(501)`
 * with an operator-actionable message when the server is not configured. Used
 * as the first check in every XMLA write route.
 */
export function requireXmlaUrl(): string {
  const url = xmlaUrl();
  if (!url) {
    throw new AasError(
      'Azure Analysis Services is not configured. Set LOOM_AAS_SERVER to the AAS connection string ' +
        '(asazure://<region>.asazure.windows.net/<serverName>) to enable XMLA write.',
      501,
      undefined,
      undefined,
      'aas_not_configured',
      'Set LOOM_AAS_SERVER (bicep param loomAasServer) and redeploy, or use the Loom-native backend.',
    );
  }
  return url;
}

/**
 * Resolve the target database name: prefer `db` arg, fall back to
 * `LOOM_AAS_DATABASE`, throw `AasError(501)` when neither is set.
 */
export function resolveDatabase(db?: string): string {
  const resolved = (db || '').trim() || aasDefaultDatabase();
  if (!resolved) {
    throw new AasError(
      'No AAS database specified and LOOM_AAS_DATABASE is not set. ' +
        'Pass the database name explicitly or set LOOM_AAS_DATABASE.',
      501,
      undefined,
      undefined,
      'aas_no_database',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Network-free XMLA SOAP envelope builder + response parsers
// ---------------------------------------------------------------------------

/** XML-escape a string for embedding in a SOAP envelope or XML attribute. */
function xmlEscapeInternal(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the SOAP `Execute` envelope for a DAX query against an AAS database.
 * The DAX statement is XML-escaped so special characters (`>`, `&`, `<`) in
 * measure expressions do not break the XML. `<Format>Tabular</Format>` is
 * included so the response contains named `<row>` elements (parsed by
 * `parseXmlaRows`).
 *
 * This is the real implementation moved from aas-client.ts's private
 * `soapEnvelope` function — same logic, same output, now exported and testable.
 */
export function buildSoapEnvelope(database: string, daxStatement: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<Body>' +
    '<Execute xmlns="urn:schemas-microsoft-com:xml-analysis">' +
    '<Command><Statement>' + xmlEscapeInternal(daxStatement) + '</Statement></Command>' +
    '<Properties><PropertyList>' +
    '<Catalog>' + xmlEscapeInternal(database) + '</Catalog>' +
    '<Format>Tabular</Format>' +
    '</PropertyList></Properties>' +
    '</Execute>' +
    '</Body>' +
    '</Envelope>'
  );
}

/**
 * Extract an XMLA fault / exception message from a SOAP response body. XMLA
 * returns HTTP 200 even for command errors, embedding the error as one of:
 *   - `<soap:faultstring>` (prefixed) or `<faultstring>` (un-prefixed)
 *   - `<Error Description="…"/>` from the AS engine
 *   - `<Exception message="…"/>` element
 * Returns null when the response carries no error indicator. This is the real
 * implementation moved from aas-client.ts — namespace prefix–aware.
 */
export function extractFault(xml: string): string | null {
  // Match both <faultstring> and <soap:faultstring> (or any prefix).
  const fault = xml.match(/<(?:\w+:)?faultstring[^>]*>([\s\S]*?)<\/(?:\w+:)?faultstring>/i);
  if (fault) return fault[1].trim();
  const exc = xml.match(/<(?:\w+:)?Exception[^>]*\bmessage="([^"]*)"/i);
  if (exc) return exc[1].trim();
  const err = xml.match(/<(?:\w+:)?Error[^>]*\bDescription="([^"]*)"/i);
  if (err) return err[1].trim();
  return null;
}

/**
 * Extract `<row>…</row>` rowsets from an XMLA Execute response, returning an
 * array of `{ columnName: value }` records. Column names come from the child
 * element names inside each `<row>`. Namespace prefixes on row cells are
 * stripped. This is the real implementation reused from tabular-model.ts's
 * `parseRowset` — same logic, exported under the name the tests expect.
 */
export function parseXmlaRows(xml: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const rowRe = /<row[ >]([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const row: Record<string, string> = {};
    const cellRe = /<(?:\w+:)?([A-Za-z_][\w.]*)>([^<]*)<\/(?:\w+:)?\1>/g;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(rowMatch[1])) !== null) {
      row[cell[1]] = cell[2];
    }
    rows.push(row);
  }
  return rows;
}

export type TmslCardinality = 'none' | 'one' | 'many';
export type TmslCrossFilter = 'oneDirection' | 'bothDirections' | 'automatic';

export interface TmslRelationship {
  name: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  fromCardinality: TmslCardinality;
  toCardinality: TmslCardinality;
  crossFilteringBehavior: TmslCrossFilter;
  isActive: boolean;
}

export interface TmslHierarchyLevel {
  ordinal: number;
  /** Display name — can differ from the source column. */
  name: string;
  /** Must reference a column that exists in the parent table. */
  column: string;
}

export interface TmslHierarchy {
  name: string;
  /** Parent table — not part of the TMSL hierarchy body but needed for Alter routing. */
  table: string;
  levels: TmslHierarchyLevel[];
}

export interface TmslColumn {
  name: string;
  /** TMSL dataType — string | int64 | double | decimal | dateTime | boolean. */
  dataType: string;
}

export interface TmslTable {
  name: string;
  columns: TmslColumn[];
  hierarchies?: TmslHierarchy[];
}

function relationshipBody(rel: TmslRelationship): Record<string, unknown> {
  return {
    name: rel.name,
    fromTable: rel.fromTable,
    fromColumn: rel.fromColumn,
    toTable: rel.toTable,
    toColumn: rel.toColumn,
    fromCardinality: rel.fromCardinality,
    toCardinality: rel.toCardinality,
    crossFilteringBehavior: rel.crossFilteringBehavior,
    // TMSL `isActive` defaults to true — emit only when false so an inactive
    // (USERELATIONSHIP) role-playing relationship is honored.
    ...(rel.isActive === false ? { isActive: false } : {}),
  };
}

/**
 * createOrReplace command that upserts a single relationship on the model. Used
 * for both create and the active/inactive toggle (re-emit with isActive flipped).
 */
export function buildCreateOrReplaceRelationshipTmsl(database: string, rel: TmslRelationship): string {
  return JSON.stringify(
    {
      createOrReplace: {
        object: { database, relationship: rel.name },
        relationship: relationshipBody(rel),
      },
    },
    null,
    2,
  );
}

/** delete command that drops a relationship by name. */
export function buildDeleteRelationshipTmsl(database: string, relationshipName: string): string {
  return JSON.stringify(
    {
      delete: {
        object: { database, relationship: relationshipName },
      },
    },
    null,
    2,
  );
}

function hierarchyBody(h: Omit<TmslHierarchy, 'table'>): Record<string, unknown> {
  return {
    name: h.name,
    levels: [...h.levels]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((l) => ({ ordinal: l.ordinal, name: l.name, column: l.column })),
  };
}

/**
 * Alter command that sets a table's `hierarchies` array. Alter (not
 * createOrReplace) is used so only the hierarchies property changes — the
 * table's columns/partitions are left intact.
 */
export function buildAlterTableHierarchyTmsl(
  database: string,
  tableName: string,
  hierarchy: Omit<TmslHierarchy, 'table'>,
): string {
  return JSON.stringify(
    {
      alter: {
        object: { database, table: tableName },
        table: {
          name: tableName,
          hierarchies: [hierarchyBody(hierarchy)],
        },
      },
    },
    null,
    2,
  );
}

/**
 * Build a full `model.bim` TMSL document from the current model state. This is
 * the read-only preview shown in the editor AND the payload the Fabric
 * updateDefinition write overwrites with (it replaces the whole model.bim).
 */
export function buildModelBimTmsl(
  modelName: string,
  tables: TmslTable[],
  relationships: TmslRelationship[],
  hierarchies: TmslHierarchy[],
): string {
  const hierByTable = new Map<string, Omit<TmslHierarchy, 'table'>[]>();
  for (const h of hierarchies) {
    const list = hierByTable.get(h.table) || [];
    list.push({ name: h.name, levels: h.levels });
    hierByTable.set(h.table, list);
  }
  return JSON.stringify(
    {
      name: modelName,
      compatibilityLevel: 1567,
      model: {
        culture: 'en-US',
        tables: tables.map((t) => {
          const hs = hierByTable.get(t.name) || [];
          return {
            name: t.name,
            columns: t.columns.map((c) => ({
              name: c.name,
              dataType: c.dataType,
              sourceColumn: c.name,
            })),
            ...(hs.length ? { hierarchies: hs.map(hierarchyBody) } : {}),
          };
        }),
        relationships: relationships.map(relationshipBody),
      },
    },
    null,
    2,
  );
}

/**
 * Build the TMSL createOrReplace command for a single measure (pure — testable).
 * Used by the Monaco DAX editor's "Save to model (XMLA)" path. Optional format
 * string + display folder are included only when supplied.
 */
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

/** Build EVALUATE ROW("value", 'Table'[Measure]) for a single-measure probe. */
export function buildMeasureEvalQuery(tableName: string, measureName: string): string {
  const tbl = "'" + (tableName || '').replace(/'/g, "''") + "'";
  const meas = '[' + (measureName || '').replace(/]/g, '') + ']';
  return 'EVALUATE ROW("value", ' + tbl + meas + ')';
}
