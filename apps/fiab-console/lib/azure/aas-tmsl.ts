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
  /**
   * Wave-3 RI flag. When true the tabular engine assumes referential integrity
   * on this relationship (no blank "(Unknown)" member, INNER-join pushdown for
   * DirectQuery). TMSL property `relyOnReferentialIntegrity`; emitted only when
   * true so a relationship without the flag is byte-for-byte identical to the
   * pre-Wave-3 output. Mirrors the optional `assumeReferentialIntegrity` flag on
   * StoredRelationship / SmStoredRelationship (the canvas RI switch).
   */
  relyOnReferentialIntegrity?: boolean;
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
  /**
   * Wave-3 date-table wiring. When true this column is emitted as the table's
   * key column (`isKey: true`) — required on the date column of a table marked
   * `dataCategory: 'Time'` so time-intelligence DAX (DATESYTD, SAMEPERIODLASTYEAR…)
   * resolves. Emitted only when true (back-compat).
   */
  isKey?: boolean;
}

export interface TmslTable {
  name: string;
  columns: TmslColumn[];
  hierarchies?: TmslHierarchy[];
  /**
   * Wave-3 date-table mark. When set to 'Time' the table is emitted with
   * `dataCategory: 'Time'` (mark-as-date-table). Optional + emitted only when
   * present so a normal table is unchanged.
   */
  dataCategory?: string;
  /**
   * Wave-3 — the date/key column of a marked date table. When set, the matching
   * column in `columns` is emitted with `isKey: true`. Alternative to setting
   * `isKey` directly on the column; honored by `buildModelBimTmsl`.
   */
  dateColumn?: string;
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
    // Wave-3 RI: `relyOnReferentialIntegrity` defaults to false — emit only when
    // true so output is byte-identical to pre-Wave-3 for normal relationships.
    ...(rel.relyOnReferentialIntegrity ? { relyOnReferentialIntegrity: true } : {}),
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
 * A table marked as the model's date table (mark-as-date-table). The matching
 * table is emitted with `dataCategory: 'Time'` and its `dateColumn` becomes the
 * table key column (`isKey: true`). Mirrors `DateTableMark` in model-store.ts;
 * a `DateTableMark[]` (with an extra `updatedAt`) is structurally assignable.
 */
export interface DateTableMarkInput {
  table: string;
  dateColumn: string;
}

/**
 * Build a full `model.bim` TMSL document from the current model state. This is
 * the read-only preview shown in the editor AND the payload the Fabric
 * updateDefinition write overwrites with (it replaces the whole model.bim).
 *
 * Wave-3: pass `dateTables` (or set `dataCategory`/`dateColumn` on a TmslTable)
 * to mark a date table — the table gets `dataCategory: 'Time'` and its date
 * column gets `isKey: true`. Both inputs are optional and additive, so omitting
 * them yields the exact pre-Wave-3 document.
 */
export function buildModelBimTmsl(
  modelName: string,
  tables: TmslTable[],
  relationships: TmslRelationship[],
  hierarchies: TmslHierarchy[],
  dateTables: DateTableMarkInput[] = [],
): string {
  const hierByTable = new Map<string, Omit<TmslHierarchy, 'table'>[]>();
  for (const h of hierarchies) {
    const list = hierByTable.get(h.table) || [];
    list.push({ name: h.name, levels: h.levels });
    hierByTable.set(h.table, list);
  }
  // table name → date/key column (from the dateTables arg, last write wins).
  const dateColByTable = new Map<string, string>();
  for (const d of dateTables) {
    if (d && d.table && d.dateColumn) dateColByTable.set(d.table, d.dateColumn);
  }
  return JSON.stringify(
    {
      name: modelName,
      compatibilityLevel: 1567,
      model: {
        culture: 'en-US',
        tables: tables.map((t) => {
          const hs = hierByTable.get(t.name) || [];
          // Effective date column: explicit dateTables arg wins, else the
          // per-table `dateColumn` hint. Presence implies a Time data category.
          const dateCol = dateColByTable.get(t.name) || t.dateColumn || '';
          const dataCategory = dateCol ? 'Time' : t.dataCategory;
          return {
            name: t.name,
            columns: t.columns.map((c) => {
              const isKey = c.isKey === true || (!!dateCol && c.name === dateCol);
              return {
                name: c.name,
                dataType: c.dataType,
                sourceColumn: c.name,
                ...(isKey ? { isKey: true } : {}),
              };
            }),
            ...(hs.length ? { hierarchies: hs.map(hierarchyBody) } : {}),
            ...(dataCategory ? { dataCategory } : {}),
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
 *
 * Wave-3: `formatStringDefinition` carries a DAX expression that RETURNS the
 * format string (dynamic format strings, e.g. a measure whose format flips
 * between currency and percent). It is emitted as
 * `formatStringDefinition: { expression: '<dax>' }`; when absent the output is
 * identical to the pre-Wave-3 command. A static `formatString` and a dynamic
 * `formatStringDefinition` can both be supplied (the engine prefers the
 * dynamic definition); supply only one when in doubt.
 */
export function buildMeasureUpsertTmsl(opts: {
  database: string;
  tableName: string;
  measureName: string;
  expression: string;
  formatString?: string;
  displayFolder?: string;
  /** DAX expression returning the format string (dynamic format strings). */
  formatStringDefinition?: string;
}): object {
  const measure: Record<string, unknown> = {
    name: opts.measureName,
    expression: opts.expression,
  };
  if (opts.formatString) measure.formatString = opts.formatString;
  if (opts.displayFolder) measure.displayFolder = opts.displayFolder;
  if (opts.formatStringDefinition) {
    measure.formatStringDefinition = { expression: opts.formatStringDefinition };
  }
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

// ---------------------------------------------------------------------------
// Wave-3 — What-If parameter (OPT-IN provision-time emit only)
//
// A what-if parameter in a tabular model is a single-column CALCULATED TABLE
// (partition source type 'calculated', expression GENERATESERIES(min,max,inc))
// plus a SELECTEDVALUE "<name> Value" measure that reads the slicer selection.
// This is the same shape Power BI Desktop generates for "New parameter", so the
// model behaves identically when provisioned to a tabular engine. It is NOT on
// the default Loom render/query path — the structured what-if dialog persists to
// `state.model.whatIfParameters` and drives the real /query DAX directly; this
// builder is only used when provisioning to an AAS/tabular engine (opt-in).
//
// TMSL refs:
//   calculated table column — https://learn.microsoft.com/analysis-services/tmsl/tables-object-tmsl
//   GENERATESERIES          — https://learn.microsoft.com/dax/generateseries-function-dax
//   SELECTEDVALUE           — https://learn.microsoft.com/dax/selectedvalue-function-dax
// ---------------------------------------------------------------------------

/**
 * Structural input for {@link buildWhatIfParameterTmsl}. A `WhatIfParameter`
 * from model-store.ts is assignable to this (it carries every field plus extra
 * metadata), so the model route can pass its persisted object directly.
 */
export interface WhatIfParameterTmslInput {
  /** Identifier-safe table + column name (e.g. 'Discount %'). */
  name: string;
  /** The single-column table expression: `GENERATESERIES(min, max, increment)`. */
  seriesExpression: string;
  /** The bound value measure body: `SELECTEDVALUE('<name>'[<name>], <default>)`. */
  valueMeasure: string;
  /** TMSL data type of the generated column; defaults to 'double'. */
  dataType?: 'int64' | 'decimal' | 'double';
}

/**
 * createOrReplace command that upserts a what-if parameter as a calculated
 * single-column table + its SELECTEDVALUE value measure. Pure JSON (no network).
 * Returns the command object (mirrors {@link buildMeasureUpsertTmsl}); the route
 * passes it to the TMSL executor when provisioning to a tabular engine.
 *
 * Output shape (Power-BI-parity for a what-if parameter):
 *   createOrReplace → table { columns:[calculatedTableColumn over [Value]],
 *   partitions:[{ mode:'import', source:{ type:'calculated', expression } }],
 *   measures:[{ name:'<name> Value', expression:<SELECTEDVALUE> }] }.
 */
export function buildWhatIfParameterTmsl(database: string, param: WhatIfParameterTmslInput): object {
  const name = param.name;
  const dataType = param.dataType || 'double';
  return {
    createOrReplace: {
      object: { database, table: name },
      table: {
        name,
        columns: [
          {
            // GENERATESERIES returns a single column named [Value]; bind to it.
            type: 'calculatedTableColumn',
            name,
            dataType,
            isNameInferred: true,
            isDataTypeInferred: true,
            sourceColumn: '[Value]',
            sortByColumn: name,
            summarizeBy: 'none',
          },
        ],
        partitions: [
          {
            name,
            mode: 'import',
            source: { type: 'calculated', expression: param.seriesExpression },
          },
        ],
        measures: [
          // Power BI convention: the value measure is named "<name> Value".
          { name: `${name} Value`, expression: param.valueMeasure },
        ],
      },
    },
  };
}
