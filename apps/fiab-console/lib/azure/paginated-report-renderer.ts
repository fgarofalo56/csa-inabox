/**
 * paginated-report-renderer.ts — Loom-native RDL (paginated report) renderer.
 *
 * This is the Azure-native DEFAULT backend for the `paginated-report` item (per
 * no-fabric-dependency.md: "Loom-native report renderer over the semantic
 * layer"). It needs NO Microsoft Fabric / Power BI workspace to function.
 *
 * The pure RDL parsing / section-building / pagination logic lives in
 * `rdl-parse.ts` (re-exported here); this module adds the data-plane execution
 * that turns each RDL DataSet query into rows:
 *   - DataSource ConnectionString `asazure://…`        → AAS XMLA (DAX)
 *   - DataSource Extension 'DataModel'/'PBIDS' + opt-in → Power BI executeQueries
 *   - otherwise (T-SQL)                                 → Synapse Serverless SQL
 *
 * No mocks — every section is bound to a real query result.
 */

import { textOf, type XmlObject, type XmlValue } from './rdl-xml';
import { executeQuery, serverlessTarget, type SynapseQueryParam } from './synapse-sql-client';
import { parseAasConnectionString } from './aas-xmla';
import { executeDaxQuery } from './aas-client';
import { downloadReportDefinition, executeDatasetQueries } from './powerbi-client';
import {
  parseRdlMetadata, extractDataSources, extractDataSets, resolveParamValues,
  buildSections, paginateSections, RdlRenderError,
  type RdlParamSpec, type RdlPage, type DataSourceDef, type DataSetDef, type DataSetResult,
} from './rdl-parse';

// Re-export the pure surface so routes/tests can import from one module.
export {
  RdlRenderError, parseRdlMetadata, extractParams, extractDataSources, extractDataSets,
  resolveParamValues, buildSections, paginateSections,
  type RdlParamSpec, type RdlSection, type RdlColumn, type RdlRow, type RdlCellValue,
  type RdlPage, type RdlDataType, type RdlSectionKind,
} from './rdl-parse';

export interface RdlRenderResult {
  ok: true;
  reportName: string;
  source: 'item' | 'import' | 'powerbi';
  params: RdlParamSpec[];
  pageCount: number;
  currentPage: number;
  /** Only the requested page is materialised (server-side pagination). */
  page: RdlPage;
  datasetCount: number;
}

async function executeOneDataset(
  def: DataSetDef,
  source: DataSourceDef | undefined,
  binds: SynapseQueryParam[],
  opts: { backend: string; pbiWorkspaceId?: string; pbiDatasetId?: string },
): Promise<DataSetResult> {
  const command = def.commandText;
  if (!command.trim()) return { columns: [], rows: [] };

  // 1) AAS XMLA (asazure://) — DAX execution against an Azure Analysis Services model.
  const aasTarget = parseAasConnectionString(source?.connectionString ?? '', def.dataSourceName);
  if (aasTarget) {
    const r = await executeDaxQuery(aasTarget, command);
    return { columns: r.columns, rows: r.rows };
  }

  // 2) Opt-in Power BI semantic model (DAX via executeQueries) — only when the
  //    Power BI backend is selected and a dataset id is bound.
  const isDataModel = source?.extension === 'DataModel' || source?.extension === 'PBIDS';
  if ((opts.backend === 'powerbi' || opts.backend === 'fabric') && isDataModel && opts.pbiWorkspaceId && opts.pbiDatasetId) {
    const r = await executeDatasetQueries(opts.pbiWorkspaceId, opts.pbiDatasetId, command);
    const rows = r?.results?.[0]?.tables?.[0]?.rows ?? [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows: rows.map((row) => columns.map((c) => row[c] ?? null)) };
  }

  // 3) DEFAULT — T-SQL against Synapse Serverless SQL. Parameters bind as @Name
  //    (injection-safe). Throws an honest "Missing env var: LOOM_SYNAPSE_WORKSPACE"
  //    when Synapse is not provisioned — surfaced by the route as an infra gate.
  const target = serverlessTarget();
  const r = await executeQuery(target, command, 60_000, binds);
  return { columns: r.columns, rows: r.rows };
}

export interface RenderOpts {
  /** Explicit RDL XML (import preview or stored item definition). */
  rdlXml?: string;
  reportName?: string;
  source?: 'item' | 'import' | 'powerbi';
  userParams?: Record<string, string[]>;
  page?: number;
  rowsPerPage?: number;
  /** When true (default), execute datasets + paginate. When false, params only. */
  run?: boolean;
  // Opt-in Power BI backend (no-fabric-dependency.md: strictly opt-in).
  backend?: string;
  pbiWorkspaceId?: string;
  pbiReportId?: string;
  pbiDatasetId?: string;
}

/**
 * Render a paginated report. Returns the parameter schema always, plus the
 * requested rendered page when `run` is true.
 */
export async function renderPaginatedReport(opts: RenderOpts): Promise<RdlRenderResult> {
  const backend = (opts.backend || process.env.LOOM_PAGINATED_REPORT_BACKEND || 'azure').toLowerCase();
  let rdlXml = opts.rdlXml;
  let source: 'item' | 'import' | 'powerbi' = opts.source ?? 'item';

  // OPT-IN: pull the RDL from Power BI REST when no local definition is present
  // and the Power BI backend is explicitly selected with a bound workspace.
  if (!rdlXml && (backend === 'powerbi' || backend === 'fabric') && opts.pbiWorkspaceId && opts.pbiReportId) {
    rdlXml = await downloadReportDefinition(opts.pbiWorkspaceId, opts.pbiReportId);
    source = 'powerbi';
  }

  if (!rdlXml || !rdlXml.trim()) {
    throw new RdlRenderError(
      'No RDL definition is available for this paginated report.',
      409,
      'Import an .rdl file (Home → Import .rdl) to author this report on the Azure-native renderer, '
      + 'or opt into Power BI by setting LOOM_PAGINATED_REPORT_BACKEND=powerbi and selecting a workspace + report.',
    );
  }

  const { report, params } = parseRdlMetadata(rdlXml);
  const dataSetDefs = extractDataSets(report);
  const datasetCount = dataSetDefs.size;
  const reportName = opts.reportName || textOf(report.Description as XmlValue) || 'Paginated report';
  const rowsPerPage = opts.rowsPerPage
    || parseInt(process.env.LOOM_RDL_ROWS_PER_PAGE || '50', 10) || 50;

  if (opts.run === false) {
    return {
      ok: true, reportName, source, params, datasetCount,
      pageCount: 0, currentPage: 1, page: { pageNumber: 1, sections: [] },
    };
  }

  const binds = resolveParamValues(params, opts.userParams ?? {});
  const dataSources = extractDataSources(report);

  const results = new Map<string, DataSetResult>();
  await Promise.all(Array.from(dataSetDefs.entries()).map(async ([name, def]) => {
    const src = dataSources.get(def.dataSourceName);
    results.set(name, await executeOneDataset(def, src, binds, {
      backend, pbiWorkspaceId: opts.pbiWorkspaceId, pbiDatasetId: opts.pbiDatasetId,
    }));
  }));

  const sections = buildSections(report, results);
  const pages = paginateSections(sections, rowsPerPage);
  const currentPage = Math.max(1, Math.min(opts.page ?? 1, pages.length));

  return {
    ok: true, reportName, source, params, datasetCount,
    pageCount: pages.length, currentPage, page: pages[currentPage - 1],
  };
}
