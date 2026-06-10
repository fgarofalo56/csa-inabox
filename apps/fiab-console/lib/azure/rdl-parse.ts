/**
 * rdl-parse.ts — pure RDL (paginated report) parsing, section materialisation
 * and pagination. ZERO Azure-SDK imports (only the dependency-free `rdl-xml`
 * parser) so it is unit-testable and importable from light BFF routes without
 * pulling in mssql / @azure/identity. The data-plane execution that turns
 * dataset queries into rows lives in `paginated-report-renderer.ts`.
 */

import { parseXml, toArray, textOf, type XmlObject, type XmlValue } from './rdl-xml';

export class RdlRenderError extends Error {
  status: number;
  hint?: string;
  constructor(message: string, status = 400, hint?: string) {
    super(message);
    this.name = 'RdlRenderError';
    this.status = status;
    this.hint = hint;
  }
}

export type RdlDataType = 'String' | 'Integer' | 'Float' | 'Boolean' | 'DateTime';

export interface RdlParamSpec {
  name: string;
  prompt?: string;
  dataType: RdlDataType;
  nullable: boolean;
  multiValue: boolean;
  allowBlank: boolean;
  defaultValue?: string[];
  validValues?: Array<{ label: string; value: string }>;
}

export type RdlCellValue = string | number | boolean | null;
export interface RdlRow { cells: RdlCellValue[]; }
export interface RdlColumn { header: string; }

export type RdlSectionKind = 'tablix' | 'table' | 'list' | 'chart';

export interface RdlSection {
  kind: RdlSectionKind;
  name: string;
  dataSetName: string;
  columns: RdlColumn[];
  rows: RdlRow[];
  totalRows: number;
}

export interface RdlPage { pageNumber: number; sections: RdlSection[]; }

export interface DataSourceDef { connectionString: string; extension: string; }
export interface DataSetDef { dataSourceName: string; commandText: string; }

/** A simple named parameter binding (string value or null). */
export interface RdlParamBind { name: string; value: string | null; }

/** A resolved dataset result (column headers + row grid). */
export interface DataSetResult { columns: string[]; rows: unknown[][]; }

const RDL_DATA_TYPES: RdlDataType[] = ['String', 'Integer', 'Float', 'Boolean', 'DateTime'];

function asDataType(v: string): RdlDataType {
  return (RDL_DATA_TYPES as string[]).includes(v) ? (v as RdlDataType) : 'String';
}

export function extractParams(report: XmlObject): RdlParamSpec[] {
  const list = toArray<XmlObject | string>(
    (report?.ReportParameters as XmlObject | undefined)?.ReportParameter,
  ).filter((p): p is XmlObject => typeof p === 'object');
  return list.map((p) => {
    const defaults = toArray<string | XmlObject>((p.DefaultValue as XmlObject | undefined)?.Values
      ? (((p.DefaultValue as XmlObject).Values as XmlObject).Value as XmlValue)
      : undefined).map(textOf).filter((s) => s !== '');
    const valid = toArray<XmlObject | string>((p.ValidValues as XmlObject | undefined)?.ParameterValues
      ? ((((p.ValidValues as XmlObject).ParameterValues as XmlObject).ParameterValue) as XmlValue)
      : (p.ValidValues as XmlObject | undefined)?.ParameterValue)
      .filter((v): v is XmlObject => typeof v === 'object')
      .map((v) => ({ label: textOf(v.Label) || textOf(v.Value), value: textOf(v.Value) }));
    return {
      name: String(p['@_Name'] ?? p.Name ?? ''),
      prompt: textOf(p.Prompt) || undefined,
      dataType: asDataType(textOf(p.DataType) || 'String'),
      nullable: textOf(p.Nullable) === 'true',
      multiValue: textOf(p.MultiValue) === 'true',
      allowBlank: textOf(p.AllowBlank) === 'true',
      defaultValue: defaults.length ? defaults : undefined,
      validValues: valid.length ? valid : undefined,
    };
  });
}

export function extractDataSources(report: XmlObject): Map<string, DataSourceDef> {
  const map = new Map<string, DataSourceDef>();
  toArray<XmlObject | string>((report?.DataSources as XmlObject | undefined)?.DataSource)
    .filter((d): d is XmlObject => typeof d === 'object')
    .forEach((ds) => {
      const name = String(ds['@_Name'] ?? '');
      const cp = ds.ConnectionProperties as XmlObject | undefined;
      map.set(name, {
        connectionString: textOf(cp?.ConnectString),
        extension: textOf(cp?.DataProvider) || String(ds['@_Extension'] ?? ''),
      });
    });
  return map;
}

export function extractDataSets(report: XmlObject): Map<string, DataSetDef> {
  const map = new Map<string, DataSetDef>();
  toArray<XmlObject | string>((report?.DataSets as XmlObject | undefined)?.DataSet)
    .filter((d): d is XmlObject => typeof d === 'object')
    .forEach((ds) => {
      const name = String(ds['@_Name'] ?? '');
      const q = ds.Query as XmlObject | undefined;
      map.set(name, {
        dataSourceName: textOf(q?.DataSourceName),
        commandText: textOf(q?.CommandText),
      });
    });
  return map;
}

/** Resolve effective parameter values: user input wins, else the RDL default. */
export function resolveParamValues(
  specs: RdlParamSpec[],
  userParams: Record<string, string[]>,
): RdlParamBind[] {
  return specs.map((s) => {
    const supplied = userParams[s.name];
    const values = supplied && supplied.length ? supplied : (s.defaultValue ?? []);
    return { name: s.name, value: values.length ? values[0] : null };
  });
}

function headerForTablix(t: XmlObject, fallback: string[]): RdlColumn[] {
  const members = toArray<XmlObject | string>(
    ((t.TablixColumnHierarchy as XmlObject | undefined)?.TablixMembers as XmlObject | undefined)?.TablixMember
    ?? (t.TablixColumnHierarchy as XmlObject | undefined)?.TablixMember,
  ).filter((m): m is XmlObject => typeof m === 'object');
  if (!members.length) return fallback.map((h) => ({ header: h }));
  return members.map((_, i) => ({ header: fallback[i] ?? `Column ${i + 1}` }));
}

export function buildSections(report: XmlObject, datasets: Map<string, DataSetResult>): RdlSection[] {
  const body = report?.Body as XmlObject | undefined;
  const items = (body?.ReportItems as XmlObject | undefined) ?? {};
  const sections: RdlSection[] = [];

  const dataFor = (name: string): DataSetResult => datasets.get(name) ?? { columns: [], rows: [] };
  const rowsToSection = (raw: unknown[][]): RdlRow[] => raw.map((r) => ({ cells: r.map((v) => (v as RdlCellValue)) }));

  toArray<XmlObject | string>(items.Tablix).filter((t): t is XmlObject => typeof t === 'object').forEach((t, i) => {
    const dsName = textOf(t.DataSetName);
    const d = dataFor(dsName);
    sections.push({
      kind: 'tablix', name: String(t['@_Name'] ?? `Tablix${i + 1}`), dataSetName: dsName,
      columns: headerForTablix(t, d.columns), rows: rowsToSection(d.rows), totalRows: d.rows.length,
    });
  });

  toArray<XmlObject | string>(items.Table).filter((t): t is XmlObject => typeof t === 'object').forEach((t, i) => {
    const dsName = textOf(t.DataSetName);
    const d = dataFor(dsName);
    sections.push({
      kind: 'table', name: String(t['@_Name'] ?? `Table${i + 1}`), dataSetName: dsName,
      columns: d.columns.map((h) => ({ header: h })), rows: rowsToSection(d.rows), totalRows: d.rows.length,
    });
  });

  toArray<XmlObject | string>(items.List).filter((t): t is XmlObject => typeof t === 'object').forEach((t, i) => {
    const dsName = textOf(t.DataSetName);
    const d = dataFor(dsName);
    sections.push({
      kind: 'list', name: String(t['@_Name'] ?? `List${i + 1}`), dataSetName: dsName,
      columns: d.columns.map((h) => ({ header: h })), rows: rowsToSection(d.rows), totalRows: d.rows.length,
    });
  });

  toArray<XmlObject | string>(items.Chart).filter((t): t is XmlObject => typeof t === 'object').forEach((t, i) => {
    const dsName = textOf(t.DataSetName);
    const d = dataFor(dsName);
    sections.push({
      kind: 'chart', name: String(t['@_Name'] ?? `Chart${i + 1}`), dataSetName: dsName,
      columns: d.columns.map((h) => ({ header: h })), rows: rowsToSection(d.rows), totalRows: d.rows.length,
    });
  });

  return sections;
}

/** Break sections into pages at `rowsPerPage` data rows per page. */
export function paginateSections(sections: RdlSection[], rowsPerPage: number): RdlPage[] {
  const perPage = Math.max(1, rowsPerPage);
  const pages: RdlPage[] = [];
  let current: RdlSection[] = [];
  let rowsThisPage = 0;
  const flush = () => {
    if (current.length) { pages.push({ pageNumber: pages.length + 1, sections: current }); current = []; rowsThisPage = 0; }
  };

  for (const sec of sections) {
    if (sec.rows.length === 0) { current.push(sec); continue; }
    let offset = 0;
    while (offset < sec.rows.length) {
      const available = perPage - rowsThisPage;
      const chunk = sec.rows.slice(offset, offset + available);
      current.push({ ...sec, rows: chunk });
      rowsThisPage += chunk.length;
      offset += chunk.length;
      if (rowsThisPage >= perPage && offset < sec.rows.length) flush();
    }
    if (rowsThisPage >= perPage) flush();
  }
  flush();
  if (!pages.length) pages.push({ pageNumber: 1, sections: [] });
  return pages;
}

/** Parse the RDL and return just the metadata (params + counts) — no execution. */
export function parseRdlMetadata(rdlXml: string): { report: XmlObject; params: RdlParamSpec[]; datasetCount: number; reportName: string } {
  const doc = parseXml(rdlXml);
  const report = (doc.Report as XmlObject) ?? doc;
  if (!report || typeof report !== 'object' || !('Body' in report || 'DataSets' in report || 'ReportParameters' in report)) {
    throw new RdlRenderError('The supplied definition is not a valid RDL (<Report> root not found).', 422);
  }
  return {
    report,
    params: extractParams(report),
    datasetCount: extractDataSets(report).size,
    reportName: textOf(report.Description as XmlValue) || '',
  };
}
