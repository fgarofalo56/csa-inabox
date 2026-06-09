/**
 * tabular-model.ts — pure (dependency-free) core of the Loom tabular layer.
 *
 * This module holds the parts of the Semantic-Link-read backend that need NO
 * Azure SDK / Cosmos / mssql imports: backend selection, model-metadata
 * extraction from a Cosmos item's state.content, the constrained DAX→T-SQL
 * translator, and the XMLA SOAP envelope builders / row-set parser. Keeping
 * them here (importing only the pure cloud-endpoints helpers) means they are
 * unit-testable in isolation and the heavy `tabular-eval-client.ts` (which adds
 * the credential + Synapse + Cosmos calls) re-exports them.
 *
 * No Power BI / Fabric host appears anywhere in this file.
 */

import { isGovCloud } from './cloud-endpoints';
import type { WorkspaceItem } from '@/lib/types/workspace';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TableMeta {
  name: string;
  columns: Array<{ name: string; dataType: string }>;
  /** Measure names attached to this table in the model definition. */
  measureNames: string[];
}

export interface MeasureMeta {
  name: string;
  table: string;
  expression: string;
  formatString?: string;
}

export interface ModelSummary {
  id: string;
  displayName: string;
  workspaceId: string;
  description?: string;
}

export type Backend = 'loom-native' | 'analysis-services';

/** Result row-set shape — maps 1:1 onto LoomDataTable (T7) in the UI. */
export interface TabularQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Which backend produced the rows. */
  backend: Backend;
  /** Translated SQL (loom-native) for transparency in the step trace. */
  sql?: string;
}

// ---------------------------------------------------------------------------
// Error class — mirrors PowerBiError / FabricError shape
// ---------------------------------------------------------------------------

export class TabularError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly backend?: Backend,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'TabularError';
  }
}

// ---------------------------------------------------------------------------
// Backend selector
// ---------------------------------------------------------------------------

export function resolveBackend(): Backend {
  // AAS is unavailable in Azure Government — loom-native is forced there.
  if (isGovCloud()) return 'loom-native';
  const b = (process.env.LOOM_SEMANTIC_BACKEND ?? 'loom-native').trim().toLowerCase();
  if (b === 'analysis-services') {
    const server = (process.env.LOOM_AAS_SERVER ?? '').trim();
    if (!server) {
      throw new TabularError(
        'LOOM_SEMANTIC_BACKEND=analysis-services but LOOM_AAS_SERVER is not set. ' +
          'Set LOOM_AAS_SERVER to the AAS server URI (asazure://<region>.asazure.windows.net/<server>) ' +
          'or switch to loom-native (the default).',
        undefined,
        'analysis-services',
        'Set LOOM_AAS_SERVER (param loomAasServer) in admin-plane/main.bicep and redeploy.',
      );
    }
    return 'analysis-services';
  }
  return 'loom-native';
}

// ---------------------------------------------------------------------------
// loom-native: extract metadata from state.content (SemanticModelContent)
// ---------------------------------------------------------------------------

export interface ExtractedContent {
  tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>;
  /** Top-level measures keyed by their target table (canonical bundle shape). */
  measures: Array<{ name: string; table: string; expression: string; formatString?: string }>;
}

/**
 * Read tables + measures from a semantic-model item's `state.content`.
 * The canonical SemanticModelContent holds measures TOP-LEVEL (keyed by
 * `table`); we also fold in any per-table `t.measures` for robustness.
 */
export function extractContent(item: WorkspaceItem): ExtractedContent {
  const content = (item.state as any)?.content ?? (item.state as any) ?? {};
  const rawTables: any[] = Array.isArray(content.tables) ? content.tables : [];
  const tables = rawTables.map((t) => ({
    name: String(t?.name ?? ''),
    columns: (Array.isArray(t?.columns) ? t.columns : []).map((c: any) => ({
      name: String(c?.name ?? ''),
      dataType: String(c?.dataType ?? 'string'),
    })),
  }));
  const measures: ExtractedContent['measures'] = [];
  for (const m of (Array.isArray(content.measures) ? content.measures : [])) {
    if (m?.name) {
      measures.push({
        name: String(m.name),
        table: String(m.table ?? ''),
        expression: String(m.expression ?? ''),
        formatString: m.formatString ? String(m.formatString) : undefined,
      });
    }
  }
  for (const t of rawTables) {
    for (const m of (Array.isArray(t?.measures) ? t.measures : [])) {
      if (m?.name && !measures.some((x) => x.name === m.name && x.table === (t?.name ?? ''))) {
        measures.push({
          name: String(m.name),
          table: String(t?.name ?? ''),
          expression: String(m.expression ?? ''),
          formatString: m.formatString ? String(m.formatString) : undefined,
        });
      }
    }
  }
  return { tables, measures };
}

/** Resolve the Synapse database the model's tables live in (for DAX eval). */
export function modelBackingDatabase(item: WorkspaceItem): string | undefined {
  const state = (item.state as any) ?? {};
  const content = state.content ?? {};
  return (
    state.warehouseDatabase ||
    state.backingDatabase ||
    content.warehouseDatabase ||
    content.database ||
    undefined
  );
}

// ---------------------------------------------------------------------------
// loom-native: DAX → T-SQL translation (constrained, no vaporware)
//
// Supported patterns (everything else returns null → an honest error pointing
// the user at the AAS backend for full DAX):
//   EVALUATE <Table>                                   → SELECT TOP 1000 * FROM [Table]
//   EVALUATE TOPN(N, <Table>)                          → SELECT TOP N    * FROM [Table]
//   EVALUATE ROW("Label", CALCULATE(AGG(Table[Col])))  → SELECT AGG([Col]) AS [Label] FROM [Table]
//     where AGG ∈ {SUM, COUNT, AVERAGE→AVG, MIN, MAX}
// ---------------------------------------------------------------------------

export function translateDaxToSql(dax: string): string | null {
  const d = String(dax ?? '').trim().replace(/\s+/g, ' ');

  const tableOnly = /^EVALUATE\s+'?([A-Za-z_][\w ]*?)'?$/i.exec(d);
  if (tableOnly) return `SELECT TOP 1000 * FROM [${tableOnly[1].trim()}]`;

  const topn = /^EVALUATE\s+TOPN\s*\(\s*(\d+)\s*,\s*'?([A-Za-z_][\w ]*?)'?\s*\)$/i.exec(d);
  if (topn) return `SELECT TOP ${topn[1]} * FROM [${topn[2].trim()}]`;

  const row =
    /^EVALUATE\s+ROW\s*\(\s*"([^"]+)"\s*,\s*CALCULATE\s*\(\s*(SUM|COUNT|AVERAGE|MIN|MAX)\s*\(\s*'?([A-Za-z_][\w ]*?)'?\s*\[\s*([\w ]+?)\s*\]\s*\)\s*\)\s*\)$/i.exec(
      d,
    );
  if (row) {
    const [, label, agg, table, col] = row;
    const sqlAgg = agg.toUpperCase() === 'AVERAGE' ? 'AVG' : agg.toUpperCase();
    return `SELECT ${sqlAgg}([${col.trim()}]) AS [${label}] FROM [${table.trim()}]`;
  }

  return null;
}

/** Error thrown for an unsupported loom-native DAX pattern (shared message). */
export function unsupportedDaxError(): TabularError {
  return new TabularError(
    'The loom-native tabular backend supports these DAX patterns: ' +
      'EVALUATE <Table>; EVALUATE TOPN(N, <Table>); ' +
      'EVALUATE ROW("Label", CALCULATE(SUM|COUNT|AVERAGE|MIN|MAX(Table[Col]))). ' +
      'Full DAX (FILTER, RELATED, measure references) needs the Analysis Services backend. ' +
      'Use tabular_list_measures to read a measure expression, then run its SQL via synapse_serverless_query.',
    400,
    'loom-native',
    'For full DAX, set LOOM_SEMANTIC_BACKEND=analysis-services + LOOM_AAS_SERVER (Commercial/GCC only).',
  );
}

// ---------------------------------------------------------------------------
// AAS XMLA envelope builders + row-set parser (pure strings)
// ---------------------------------------------------------------------------

export const AAS_XML_NS = 'urn:schemas-microsoft-com:xml-analysis';

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildDiscoverEnvelope(
  requestType: 'TMSCHEMA_TABLES' | 'TMSCHEMA_MEASURES',
  database: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Discover xmlns="${AAS_XML_NS}">
      <RequestType>${requestType}</RequestType>
      <Restrictions><RestrictionList><DatabaseName>${escapeXml(database)}</DatabaseName></RestrictionList></Restrictions>
      <Properties><PropertyList><Catalog>${escapeXml(database)}</Catalog><Content>SchemaData</Content></PropertyList></Properties>
    </Discover>
  </Body>
</Envelope>`;
}

export function buildExecuteEnvelope(database: string, daxStatement: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="${AAS_XML_NS}">
      <Command><Statement>${escapeXml(daxStatement)}</Statement></Command>
      <Properties><PropertyList><Catalog>${escapeXml(database)}</Catalog><Format>Tabular</Format><Content>Data</Content></PropertyList></Properties>
    </Execute>
  </Body>
</Envelope>`;
}

/** Extract `<row>…</row>` rowsets from an XMLA response. */
export function parseRowset(xml: string): Record<string, string>[] {
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

/** Parse the tabular column names from an XMLA Execute rowset schema. */
export function parseXmlaColumns(xml: string): string[] {
  const columns: string[] = [];
  const colRe = /<xsd:element\s[^>]*\bname="([^"]+)"/g;
  let cm: RegExpExecArray | null;
  while ((cm = colRe.exec(xml)) !== null) {
    if (cm[1] !== 'row' && !columns.includes(cm[1])) columns.push(cm[1]);
  }
  return columns;
}
