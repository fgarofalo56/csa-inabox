/**
 * Azure Analysis Services / Power BI Premium XMLA client.
 *
 * Executes TMSL commands (Alter, Create, CreateOrReplace, Delete) and runs
 * Discover (TMSCHEMA_* rowsets) against a Tabular model via the XMLA protocol
 * over HTTP — a SOAP envelope with `Content-Type: text/xml` and a Bearer
 * token. No mocks: every public function calls the real XMLA endpoint or
 * builds the exact TMSL JSON the engine accepts (per no-vaporware.md).
 *
 * Backend selection (priority order):
 *   1. LOOM_AAS_SERVER_URL  — `asazure://<region>.asazure.windows.net/<name>`
 *      Token scope: https://<region>.asazure.windows.net/.default
 *      XMLA HTTP  : https://<region>.asazure.windows.net/servers/<name>/models/<db>/xmla
 *   2. LOOM_POWERBI_XMLA_ENDPOINT — the Power BI Premium XMLA endpoint URL
 *      (operators supply it with the `/xmla` path, or a dataset XMLA URL).
 *      Token scope: pbiXmlaScope() (cloud-aware).
 *
 * This is the Azure-native DEFAULT path for editing semantic-model column
 * metadata (data category, format string, summarize-by, display folder,
 * sort-by, hidden, calculated columns / tables). It requires NO Microsoft
 * Fabric or Power BI *workspace* — Azure Analysis Services is a standalone
 * Azure resource (per no-fabric-dependency.md: semantic-model → "Azure
 * Analysis Services optional"). Power BI Premium XMLA is the opt-in
 * alternative when a tenant licenses it.
 *
 * Availability:
 *   Commercial + GCC : both backends available (AAS runs on Commercial Azure).
 *   GCC-High / IL5 / DoD : AAS is NOT offered in Azure Government. The Power
 *     BI Premium XMLA endpoint may still be used if licensed. When neither is
 *     configured, `aasConfigGate()` returns a precise reason so the BFF route
 *     renders an honest MessageBar rather than attempting an impossible call.
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { aasScope, pbiXmlaScope, isGovCloud, cloudBoundaryLabel } from './cloud-endpoints';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class AasError extends Error {
  status: number;
  body?: string;
  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = 'AasError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TmslSummarizeBy =
  | 'default' | 'none' | 'sum' | 'min' | 'max' | 'count' | 'average' | 'distinctCount';
export type TmslDataType =
  | 'string' | 'int64' | 'double' | 'dateTime' | 'decimal' | 'boolean' | 'binary' | 'unknown' | 'variant';
export type TmslColumnType = 'data' | 'calculated' | 'rowNumber' | 'calculatedTableColumn';

/** Complete column definition (Alter requires ALL read-write props, not a partial patch). */
export interface TmslColumnDef {
  name: string;
  dataType: TmslDataType;
  type?: TmslColumnType;
  dataCategory?: string;
  isHidden?: boolean;
  summarizeBy?: TmslSummarizeBy;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string; // calculated columns only
}

export interface TmslCalcColumnDef extends Omit<TmslColumnDef, 'type'> {
  expression: string; // required for a calculated column
}

/** Parsed model column row (from a TMSCHEMA Discover, enums resolved). */
export interface ModelColumn {
  name: string;
  type: TmslColumnType;
  dataType: TmslDataType | string;
  dataCategory?: string;
  isHidden: boolean;
  summarizeBy?: TmslSummarizeBy | string;
  formatString?: string;
  displayFolder?: string;
  sortByColumn?: string;
  expression?: string;
}

export interface ModelMeasure {
  name: string;
  expression?: string;
  formatString?: string;
  displayFolder?: string;
  isHidden?: boolean;
}

export interface ModelTable {
  name: string;
  isCalculatedTable: boolean;
  calculatedExpression?: string;
  columns: ModelColumn[];
  measures: ModelMeasure[];
}

// TMSL command shapes (also the exact JSON sent to the engine).
export interface TmslAlterCommand {
  alter: {
    object: { database: string; table: string; column: string };
    column: Record<string, unknown>;
  };
}
export interface TmslCreateColumnCommand {
  create: {
    parentObject: { database: string; table: string };
    column: Record<string, unknown>;
  };
}
export interface TmslCreateTableCommand {
  create: {
    parentObject: { database: string };
    table: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Backend config
// ---------------------------------------------------------------------------

export interface AasXmlaConfig {
  xmlaUrl: string;
  scope: string;
  database: string;
  backend: 'analysis-services' | 'powerbi';
}

/**
 * Derive the XMLA HTTP URL + AAD token scope from the configured backend.
 * Returns null when neither LOOM_AAS_SERVER_URL nor LOOM_POWERBI_XMLA_ENDPOINT
 * is set.
 */
export function aasXmlaConfig(): AasXmlaConfig | null {
  const raw = (process.env.LOOM_AAS_SERVER_URL || '').trim();
  const database = (process.env.LOOM_AAS_DATABASE || 'loomdb').trim();
  if (raw.startsWith('asazure://')) {
    // asazure://eastus2.asazure.windows.net/myserver
    const stripped = raw.replace('asazure://', '');
    const slash = stripped.indexOf('/');
    const host = slash >= 0 ? stripped.slice(0, slash) : stripped;
    const serverName = slash >= 0 ? stripped.slice(slash + 1).replace(/\/+$/, '') : '';
    if (host && serverName) {
      return {
        xmlaUrl: `https://${host}/servers/${serverName}/models/${database}/xmla`,
        scope: aasScope(host),
        database,
        backend: 'analysis-services',
      };
    }
  }
  const pbiXmla = (process.env.LOOM_POWERBI_XMLA_ENDPOINT || '').trim();
  if (pbiXmla) {
    // Operators provide the HTTP XMLA endpoint URL directly. The Power BI
    // database is the dataset name; when the URL is the workspace XMLA root
    // the caller passes the dataset name as `database`.
    const xmlaUrl = pbiXmla.replace(/^powerbi:\/\//, 'https://').replace(/\/+$/, '');
    return {
      xmlaUrl,
      scope: pbiXmlaScope(),
      database: (process.env.LOOM_AAS_DATABASE || '').trim(),
      backend: 'powerbi',
    };
  }
  return null;
}

/**
 * Honest config / availability gate. Returns `{ missing, detail }` when the
 * column-metadata editor cannot operate, or null when an XMLA backend is
 * ready. The BFF route surfaces `detail` in a Fluent MessageBar.
 */
export function aasConfigGate(): { missing: string; detail: string } | null {
  const cfg = aasXmlaConfig();
  if (cfg) return null;
  if (isGovCloud()) {
    return {
      missing: 'LOOM_POWERBI_XMLA_ENDPOINT',
      detail:
        `Azure Analysis Services is not available in the current cloud boundary (${cloudBoundaryLabel()}). ` +
        'Column metadata editing (data category, format string, summarize-by, display folder, sort-by, hidden, ' +
        'calculated columns/tables) requires an XMLA endpoint. In Azure Government, set LOOM_POWERBI_XMLA_ENDPOINT ' +
        'to a licensed Power BI Premium XMLA endpoint, or edit the model with Power BI Desktop / Tabular Editor ' +
        'against a Commercial Azure Analysis Services instance reachable from your network.',
    };
  }
  return {
    missing: 'LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT',
    detail:
      'Neither LOOM_AAS_SERVER_URL (Azure Analysis Services) nor LOOM_POWERBI_XMLA_ENDPOINT (Power BI Premium) ' +
      'is configured. Set one to enable column metadata editing — data category, format string, summarize-by, ' +
      'display folder, sort-by, hidden toggle, and calculated columns / tables. Deploy AAS with ' +
      'platform/fiab/bicep/modules/admin-plane/analysis-services.bicep (loomSemanticBackend=analysis-services).',
  };
}

// ---------------------------------------------------------------------------
// Credential (Console UAMI, chained with DefaultAzureCredential for local dev)
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

async function getToken(scope: string): Promise<string> {
  const t = await credential.getToken(scope);
  if (!t?.token) throw new AasError(`Failed to acquire AAD token for ${scope}`, 401);
  return t.token;
}

// ---------------------------------------------------------------------------
// TMSL builders (pure — unit-testable without HTTP)
// ---------------------------------------------------------------------------

/** Trim undefined keys so the emitted TMSL only carries set properties. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** TMSL column body shared by Alter + Create (no `name` for Create's column? — Create needs name). */
function tmslColumnBody(col: TmslColumnDef, includeName: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = compact({
    name: includeName ? col.name : undefined,
    dataType: col.dataType,
    dataCategory: col.dataCategory,
    summarizeBy: col.summarizeBy,
    formatString: col.formatString,
    displayFolder: col.displayFolder,
    sortByColumn: col.sortByColumn,
    expression: col.expression,
    type: col.type,
  });
  // isHidden is a boolean — include it explicitly (compact() would drop false).
  if (col.isHidden !== undefined) body.isHidden = col.isHidden;
  return body;
}

/**
 * TMSL to alter an existing column. Per the Alter command contract, the
 * `column` object MUST be the COMPLETE definition (all read-write props), not
 * a partial patch — callers merge current values with edits before building.
 */
export function buildAlterColumnTmsl(
  database: string,
  tableName: string,
  column: TmslColumnDef,
): TmslAlterCommand {
  return {
    alter: {
      object: { database, table: tableName, column: column.name },
      // The altered column carries its name plus every read-write property.
      column: tmslColumnBody(column, true),
    },
  };
}

/** TMSL to create a calculated column (type=calculated, requires `expression`). */
export function buildCreateCalcColumnTmsl(
  database: string,
  tableName: string,
  column: TmslCalcColumnDef,
): TmslCreateColumnCommand {
  const body = tmslColumnBody({ ...column, type: 'calculated' }, true);
  body.type = 'calculated';
  body.expression = column.expression;
  return {
    create: {
      parentObject: { database, table: tableName },
      column: body,
    },
  };
}

/**
 * TMSL to create a calculated table from a DAX expression. A calculated table
 * is a table whose single partition has a `calculated` source carrying the DAX.
 */
export function buildCreateCalcTableTmsl(
  database: string,
  tableName: string,
  daxExpression: string,
): TmslCreateTableCommand {
  return {
    create: {
      parentObject: { database },
      table: {
        name: tableName,
        partitions: [
          {
            name: tableName,
            mode: 'import',
            source: {
              type: 'calculated',
              expression: daxExpression,
            },
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// XMLA SOAP transport
// ---------------------------------------------------------------------------

const XMLA_NS = 'urn:schemas-microsoft-com:xml-analysis';
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';

/** XML-escape element text (the TMSL JSON or DMV restriction values). */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Build the SOAP envelope for an Execute (TMSL command) request. */
export function buildExecuteEnvelope(tmslJson: string, catalog: string): string {
  return (
    `<Envelope xmlns="${SOAP_NS}"><Body>` +
    `<Execute xmlns="${XMLA_NS}">` +
    `<Command><Statement>${xmlEscape(tmslJson)}</Statement></Command>` +
    `<Properties><PropertyList>${catalog ? `<Catalog>${xmlEscape(catalog)}</Catalog>` : ''}</PropertyList></Properties>` +
    `</Execute></Body></Envelope>`
  );
}

/** Build the SOAP envelope for a Discover (TMSCHEMA rowset) request. */
export function buildDiscoverEnvelope(
  requestType: string,
  restrictions: Record<string, string>,
  catalog: string,
): string {
  const restr = Object.entries(restrictions)
    .map(([k, v]) => `<${k}>${xmlEscape(String(v))}</${k}>`)
    .join('');
  return (
    `<Envelope xmlns="${SOAP_NS}"><Body>` +
    `<Discover xmlns="${XMLA_NS}">` +
    `<RequestType>${xmlEscape(requestType)}</RequestType>` +
    `<Restrictions><RestrictionList>${restr}</RestrictionList></Restrictions>` +
    `<Properties><PropertyList>${catalog ? `<Catalog>${xmlEscape(catalog)}</Catalog>` : ''}<Format>Tabular</Format></PropertyList></Properties>` +
    `</Discover></Body></Envelope>`
  );
}

/** Extract a SOAP/XMLA fault message, if present. */
function extractFault(xml: string): string | null {
  // SOAP <faultstring> or XMLA <Error Description="..."> / <Exception>.
  const fs = xml.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  if (fs) return xmlUnescape(fs[1].trim());
  const err = xml.match(/<Error[^>]*\bDescription="([^"]*)"/i);
  if (err) return xmlUnescape(err[1].trim());
  const ex = xml.match(/<Exception[^>]*\bMessage="([^"]*)"/i);
  if (ex) return xmlUnescape(ex[1].trim());
  return null;
}

/** Throw on a SOAP/XMLA fault; otherwise return void (Execute success). */
export function parseExecuteResponse(xml: string): void {
  const fault = extractFault(xml);
  if (fault) throw new AasError(fault, 502, xml.slice(0, 2000));
}

/** Parse an XMLA rowset (`<row>` blocks) into plain string-keyed objects. */
export function parseRowset(xml: string): Record<string, string>[] {
  const fault = extractFault(xml);
  if (fault) throw new AasError(fault, 502, xml.slice(0, 2000));
  const rows: Record<string, string>[] = [];
  const rowRe = /<row[\s>]([\s\S]*?)<\/row>/gi;
  let m: RegExpExecArray | null;
  // Also handle <row> with no attributes: <row>...</row>
  const normalized = xml.replace(/<row>/gi, '<row >');
  while ((m = rowRe.exec(normalized)) !== null) {
    const inner = m[1];
    const fields: Record<string, string> = {};
    const fieldRe = /<([A-Za-z_][\w.:-]*)[^>]*>([\s\S]*?)<\/\1>/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(inner)) !== null) {
      // Strip any namespace prefix from the tag.
      const tag = f[1].includes(':') ? f[1].split(':').pop()! : f[1];
      fields[tag] = xmlUnescape(f[2].trim());
    }
    rows.push(fields);
  }
  return rows;
}

async function postXmla(envelope: string, scope: string, xmlaUrl: string): Promise<string> {
  const token = await getToken(scope);
  let res: Response;
  try {
    res = await fetch(xmlaUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${XMLA_NS}:Execute"`,
      },
      body: envelope,
    });
  } catch (e: any) {
    throw new AasError(`XMLA request failed: ${e?.message || String(e)}`, 502);
  }
  const text = await res.text();
  if (!res.ok) {
    const fault = extractFault(text) || `XMLA HTTP ${res.status}`;
    throw new AasError(fault, res.status, text.slice(0, 2000));
  }
  return text;
}

/**
 * Execute a TMSL command (Alter / Create / CreateOrReplace / Delete) via XMLA.
 * `statement` is the complete TMSL object (this function serializes it).
 * Returns the serialized TMSL that was sent (for receipts).
 */
export async function command(statement: object, database?: string): Promise<{ tmsl: string }> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured (set LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT)', 412);
  const db = database || cfg.database;
  const tmsl = JSON.stringify(statement);
  const envelope = buildExecuteEnvelope(tmsl, db);
  const xml = await postXmla(envelope, cfg.scope, cfg.xmlaUrl);
  parseExecuteResponse(xml);
  return { tmsl };
}

/**
 * Run an XMLA Discover and return the rowset rows as plain objects.
 * requestType e.g. "TMSCHEMA_COLUMNS"; restrictions e.g. { TableID: "5" }.
 */
export async function discover(
  requestType: string,
  restrictions: Record<string, string> = {},
  database?: string,
): Promise<Record<string, string>[]> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured (set LOOM_AAS_SERVER_URL or LOOM_POWERBI_XMLA_ENDPOINT)', 412);
  const db = database || cfg.database;
  const envelope = buildDiscoverEnvelope(requestType, restrictions, db);
  const xml = await postXmla(envelope, cfg.scope, cfg.xmlaUrl);
  return parseRowset(xml);
}

// ---------------------------------------------------------------------------
// TMSCHEMA enum decoders (TOM enum integer → TMSL string)
// ---------------------------------------------------------------------------
// Verified against Microsoft Learn: ColumnType (Data=1, Calculated=2,
// RowNumber=3, CalculatedTableColumn=4), AggregateFunction (the column
// SummarizeBy enum) and the TOM DataType enum.

const COLUMN_TYPE: Record<string, TmslColumnType> = {
  '1': 'data', '2': 'calculated', '3': 'rowNumber', '4': 'calculatedTableColumn',
};
const DATA_TYPE: Record<string, TmslDataType> = {
  '1': 'unknown', '2': 'string', '6': 'int64', '8': 'double', '9': 'dateTime',
  '10': 'decimal', '11': 'boolean', '17': 'binary', '19': 'unknown', '20': 'variant',
};
const SUMMARIZE_BY: Record<string, TmslSummarizeBy> = {
  '1': 'default', '2': 'none', '3': 'sum', '4': 'min', '5': 'max',
  '6': 'count', '7': 'average', '8': 'distinctCount',
};
// TMSCHEMA_PARTITIONS Type / SourceType enum: 1=Query, 2=Calculated, 3=None,
// 4=M, 6=Entity, 7=PolicyRange, 8=CalculationGroup. We only need Calculated.
const PARTITION_CALCULATED = '2';

function decode<T>(map: Record<string, T>, raw: string | undefined, fallback?: T): T | string | undefined {
  if (raw === undefined || raw === '') return fallback;
  return map[raw] ?? raw;
}

/**
 * Read the full tabular model (tables + columns + measures) via TMSCHEMA
 * Discover rowsets, resolving the integer enums + ID joins into friendly
 * names. This is the real backend read for the editor's Tables tab.
 */
export async function readModel(database?: string): Promise<ModelTable[]> {
  const cfg = aasXmlaConfig();
  if (!cfg) throw new AasError('No XMLA backend configured', 412);
  const db = database || cfg.database;

  const [tablesRows, colsRows, measuresRows, partRows] = await Promise.all([
    discover('TMSCHEMA_TABLES', {}, db),
    discover('TMSCHEMA_COLUMNS', {}, db),
    discover('TMSCHEMA_MEASURES', {}, db).catch(() => [] as Record<string, string>[]),
    discover('TMSCHEMA_PARTITIONS', {}, db).catch(() => [] as Record<string, string>[]),
  ]);

  // Build ID → table-name map.
  const tableById = new Map<string, string>();
  for (const t of tablesRows) {
    const id = t.ID || t.TableID;
    const name = t.Name || t.ExplicitName || t.InferredName;
    if (id && name) tableById.set(id, name);
  }

  // Column ID → name (for SortByColumnID resolution).
  const colNameById = new Map<string, string>();
  for (const c of colsRows) {
    const id = c.ID || c.ColumnID;
    const name = c.ExplicitName || c.InferredName || c.Name;
    if (id && name) colNameById.set(id, name);
  }

  // Which tables have a calculated partition?
  const calcTableExpr = new Map<string, string>();
  for (const p of partRows) {
    const tid = p.TableID;
    const type = p.Type || p.SourceType;
    if (tid && type === PARTITION_CALCULATED) {
      calcTableExpr.set(tid, p.QueryDefinition || p.Expression || '');
    }
  }

  // Group columns + measures by table id.
  const colsByTable = new Map<string, ModelColumn[]>();
  for (const c of colsRows) {
    const tid = c.TableID;
    if (!tid) continue;
    const name = c.ExplicitName || c.InferredName || c.Name || '';
    if (!name || name.startsWith('RowNumber-')) continue; // skip the engine RowNumber column
    const typeRaw = c.Type;
    if (typeRaw === '3') continue; // RowNumber
    const col: ModelColumn = {
      name,
      type: (decode(COLUMN_TYPE, typeRaw, 'data') as TmslColumnType),
      dataType: (decode(DATA_TYPE, c.ExplicitDataType || c.InferredDataType, 'string') as string),
      dataCategory: c.DataCategory || undefined,
      isHidden: c.IsHidden === 'true' || c.IsHidden === '1',
      summarizeBy: (decode(SUMMARIZE_BY, c.SummarizeBy, 'default') as string),
      formatString: c.FormatString || undefined,
      displayFolder: c.DisplayFolder || undefined,
      sortByColumn: c.SortByColumnID ? colNameById.get(c.SortByColumnID) : undefined,
      expression: c.Expression || undefined,
    };
    const arr = colsByTable.get(tid) || [];
    arr.push(col);
    colsByTable.set(tid, arr);
  }

  const measuresByTable = new Map<string, ModelMeasure[]>();
  for (const m of measuresRows) {
    const tid = m.TableID;
    if (!tid) continue;
    const measure: ModelMeasure = {
      name: m.Name || m.ExplicitName || '',
      expression: m.Expression || undefined,
      formatString: m.FormatString || undefined,
      displayFolder: m.DisplayFolder || undefined,
      isHidden: m.IsHidden === 'true' || m.IsHidden === '1',
    };
    const arr = measuresByTable.get(tid) || [];
    arr.push(measure);
    measuresByTable.set(tid, arr);
  }

  const out: ModelTable[] = [];
  for (const [id, name] of tableById) {
    out.push({
      name,
      isCalculatedTable: calcTableExpr.has(id),
      calculatedExpression: calcTableExpr.get(id) || undefined,
      columns: colsByTable.get(id) || [],
      measures: measuresByTable.get(id) || [],
    });
  }
  // Stable order by table name.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
