/**
 * Paginated report (RDL) — Loom-native authoring document + render delegation.
 *
 * Azure-native parity with a Power BI Paginated Report (.rdl). Per
 * .claude/rules/no-fabric-dependency.md this is the DEFAULT path: authoring and
 * export work with ZERO Microsoft Fabric / Power BI workspace bound. The report
 * definition (data sources, datasets, tablixes, parameters) is stored as a
 * structured document in Cosmos (`paginated-report-definitions`, PK
 * /workspaceId) — NOT raw RDL XML, honoring loom-no-freeform-config — and
 * rendering to PDF / Excel / Word is delegated to the
 * `paginated-report-renderer` Azure Function (ReportLab / openpyxl /
 * python-docx).
 *
 * The opt-in Power BI ExportToFile path (Premium P1+/Embedded A4+ capacity)
 * lives in powerbi-client.ts and is reached only when a Power BI workspace is
 * explicitly bound — never the default.
 */

import crypto from 'node:crypto';
import { paginatedReportDefinitionsContainer } from './cosmos-client';
import type { SessionPayload } from '@/lib/auth/session';

// ---------------------------------------------------------------------------
// RDL document model
// ---------------------------------------------------------------------------

export type RdlDataSourceType = 'AzureSQL' | 'Synapse' | 'Cosmos' | 'ADLS';
export type RdlFieldType = 'String' | 'Int' | 'Decimal' | 'DateTime' | 'Boolean';
export type RdlParameterType = 'String' | 'Int' | 'Boolean' | 'DateTime';
export type RdlExportFormat = 'pdf' | 'xlsx' | 'docx';

export interface RdlDataSource {
  id: string;
  name: string;
  type: RdlDataSourceType;
  /** Reference to a saved Loom Connection id (preferred) OR a non-secret server/db hint. */
  connectionRef?: string;
  server?: string;
  database?: string;
}

export interface RdlField {
  name: string;
  type: RdlFieldType;
}

export interface RdlDataset {
  id: string;
  name: string;
  dataSourceId: string;
  /** T-SQL / KQL authored in Monaco. */
  query: string;
  fields: RdlField[];
  /**
   * Rows captured at save-time (from the editor's "Run preview"). The renderer
   * paginates these. Live SQL execution from the renderer is a follow-up that
   * requires granting the Function MI Database Reader on each source.
   */
  sampleRows?: Array<Record<string, unknown>>;
}

export interface RdlTableCell {
  /** Field name (Fields!X.Value) or an aggregate expression token (=Sum(Field)). */
  expression: string;
  bold?: boolean;
}

export interface RdlTablix {
  id: string;
  name: string;
  datasetId: string;
  /** Field names (from the dataset) shown as detail columns, in order. */
  columns: string[];
  /** Field names used as row groups (optional). */
  rowGroups: string[];
  /** Display labels for the header row (parallel to columns). */
  headerRow: string[];
  /** Detail-row cell expressions (one row template; renderer expands per data row). */
  cells: RdlTableCell[][];
  showColumnHeaders: boolean;
  pageBreak: boolean;
}

export interface RdlParameter {
  name: string;
  type: RdlParameterType;
  prompt: string;
  defaultValue?: string;
}

export interface RdlReportDefinition {
  /** Cosmos id = reportId. */
  id: string;
  /** Partition key. */
  workspaceId: string;
  name: string;
  description?: string;
  pageOrientation: 'Portrait' | 'Landscape';
  pageSize: 'A4' | 'Letter' | 'Legal';
  dataSources: RdlDataSource[];
  datasets: RdlDataset[];
  tablixes: RdlTablix[];
  parameters: RdlParameter[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** A blank, valid definition the editor seeds for a brand-new report. */
export function emptyRdlDefinition(workspaceId: string, reportId: string, name: string): RdlReportDefinition {
  const now = new Date().toISOString();
  return {
    id: reportId,
    workspaceId,
    name: name || 'Untitled paginated report',
    pageOrientation: 'Portrait',
    pageSize: 'Letter',
    dataSources: [],
    datasets: [],
    tablixes: [],
    parameters: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// CRUD (Cosmos)
// ---------------------------------------------------------------------------

export async function getRdlDefinition(workspaceId: string, reportId: string): Promise<RdlReportDefinition | null> {
  const c = await paginatedReportDefinitionsContainer();
  try {
    const { resource } = await c.item(reportId, workspaceId).read<RdlReportDefinition>();
    if (!resource) return null;
    return resource.workspaceId === workspaceId ? resource : null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function upsertRdlDefinition(def: RdlReportDefinition): Promise<RdlReportDefinition> {
  if (!def.id) throw new Error('report id required');
  if (!def.workspaceId) throw new Error('workspaceId required');
  const c = await paginatedReportDefinitionsContainer();
  const doc: RdlReportDefinition = { ...def, updatedAt: new Date().toISOString() };
  const { resource } = await c.items.upsert<RdlReportDefinition>(doc);
  return (resource as RdlReportDefinition) ?? doc;
}

export async function deleteRdlDefinition(workspaceId: string, reportId: string): Promise<void> {
  const c = await paginatedReportDefinitionsContainer();
  try {
    await c.item(reportId, workspaceId).delete();
  } catch (e: any) {
    if (e?.code === 404) return;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Render delegation (Azure Function — Azure-native, no Fabric)
// ---------------------------------------------------------------------------

export interface RenderGate {
  /** Human-readable detail for the honest MessageBar. */
  detail: string;
  missingEnvVar: string;
}

/**
 * Honest-gate: the export renderer Function is optional infra. When
 * `LOOM_PAGINATED_RENDER_URL` is unset, authoring still works fully — only
 * export-to-file is gated. Returns null when configured.
 */
export function paginatedRenderGate(): RenderGate | null {
  if (process.env.LOOM_PAGINATED_RENDER_URL) return null;
  return {
    missingEnvVar: 'LOOM_PAGINATED_RENDER_URL',
    detail:
      'Paginated report export renderer is not deployed in this environment. ' +
      'Authoring works without it; deploy azure-functions/paginated-report-renderer ' +
      'and set LOOM_PAGINATED_RENDER_URL to enable PDF / Excel / Word export.',
  };
}

const MIME: Record<RdlExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function exportMimeType(fmt: RdlExportFormat): string {
  return MIME[fmt] || 'application/octet-stream';
}

export interface RenderResult {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * POST the report definition to the renderer Function and return the binary.
 * The Function key (LOOM_PAGINATED_RENDER_KEY) is appended as ?code=… per the
 * Function-level auth convention. Throws (with .status) on a non-2xx.
 */
export async function renderReport(
  def: RdlReportDefinition,
  format: RdlExportFormat,
  parameterValues: Array<{ name: string; value: string }> = [],
): Promise<RenderResult> {
  const base = process.env.LOOM_PAGINATED_RENDER_URL;
  if (!base) {
    const e: any = new Error('LOOM_PAGINATED_RENDER_URL not set');
    e.status = 503;
    throw e;
  }
  const key = process.env.LOOM_PAGINATED_RENDER_KEY;
  const url = new URL('/api/render', base.replace(/\/$/, ''));
  if (key) url.searchParams.set('code', key);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definition: def, format, parameterValues }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e: any = new Error(`renderer returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    e.status = res.status;
    throw e;
  }

  const ab = await res.arrayBuffer();
  const safeName = (def.name || 'report').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'report';
  return {
    bytes: Buffer.from(ab),
    mimeType: exportMimeType(format),
    fileName: `${safeName}.${format}`,
  };
}

/** Stable id helper used by the editor when adding sub-objects. */
export function newRdlId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}
