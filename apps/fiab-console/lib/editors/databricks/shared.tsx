'use client';

/**
 * Databricks editors — SHARED module.
 *
 * Styles, common types/helpers, the results panel, DBU/DWU pricing
 * estimators, and the cluster/notebook/job helper functions used by 2+ of
 * the Databricks editors. Extracted verbatim from databricks-editors.tsx
 * (behavior-preserving split — zero logic change).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { shorthands,
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
  Combobox,
  Input, Field, Switch, Textarea, Tooltip, Divider,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Stop20Regular,
  ArrowSync20Regular, Folder20Regular, Document20Regular,
  Save20Regular, Delete20Regular, Add20Regular, Key20Regular, Sparkle20Regular,
  Flowchart20Regular,
  DataBarVertical20Regular,
  TableAdd20Regular, Copy20Regular,
  Eye20Regular, MathFormula20Regular,
  ArrowDownload20Regular,
  Organization20Regular,
  Tag20Regular,
  CloudLink20Regular, PlugConnected20Regular,
  History20Regular, ShieldTask20Regular, Link20Regular,
  ArrowUpload20Regular, CloudArrowUp24Regular, Dismiss16Regular,
  BuildingShop20Regular, ShieldLock20Regular, People20Regular, Star20Regular,
} from '@fluentui/react-icons';
import { ModelViewPanel } from '../components/model-view-canvas';
import { ItemEditorChrome } from '../item-editor-chrome';
import { StatsMaintenanceDialog } from '../components/stats-maintenance-dialog';
import { WarehouseMonitoringTab } from '../components/warehouse-monitoring';
import { ConnectionDetailsPanel } from '../components/connection-details';
import { AiFunctionsHelper } from '../components/ai-functions-helper';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { DatabricksWorkspaceTree } from '@/lib/components/databricks/databricks-workspace-tree';
import { UcLineagePanel } from '@/lib/components/databricks/uc-lineage-panel';
import { UcSecurityPanel } from '@/lib/panes/uc-security-panel';
import { PipelineDagView, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from '../components/warehouse-alerts';
import { SqlCopilotEditor } from '@/lib/components/editor/sql-copilot-editor';
import { VisualQueryCanvas, type VqSourceTable } from '../components/visual-query-canvas';
import { downloadResultsCsv, downloadResultsJson } from '../components/result-export';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { emptyCell } from '@/lib/types/notebook-cell';
import {
  parseSource, serializeCells, cellLangToCommandLanguage,
  type DbxBaseLanguage,
} from '../databricks-notebook-source';
import { QueryParamsBar, substituteDbx, type QueryParam } from '../components/query-params';
import { ResultVisualize } from '../components/result-visualize';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: '200px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '200px' },
  resultMeta: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  treePad: { padding: tokens.spacingHorizontalS },
  treeRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, padding: `3px ${tokens.spacingHorizontalXS}`, borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  treeDelete: { opacity: 0, ':hover': { opacity: 1 } },
  cellList: { display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 },
  cellOutput: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderTop: 'none',
    borderRadius: `0 0 ${tokens.borderRadiusMedium} ${tokens.borderRadiusMedium}`, padding: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalXS,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cellPre: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', wordBreak: 'break-word',
    margin: 0, maxHeight: '320px', overflow: 'auto', color: tokens.colorNeutralForeground1,
  },
  // ---- Unity Catalog write-path dialog layout (tokenized, no raw inline styles) ----
  dlgCol: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalM },
  dlgRow: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'flex-start' },
  dlgRowEnd: { display: 'flex', columnGap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  flex1: { flex: 1, minWidth: 0 },
  flex2: { flex: 2, minWidth: 0 },
  colRow: { display: 'flex', columnGap: tokens.spacingHorizontalS, alignItems: 'center' },
  privWrap: { display: 'flex', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  privBadge: {
    cursor: 'pointer',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  badgeWrap: { display: 'flex', columnGap: tokens.spacingHorizontalXS, rowGap: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  actionRow: { display: 'flex', columnGap: tokens.spacingHorizontalS },
  hintCaption: { display: 'block', color: tokens.colorNeutralForeground3 },
  // ---- Fluent-themed file picker (replaces the bare <input type=file>) ----
  fileDrop: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    rowGap: tokens.spacingVerticalXS, textAlign: 'center', cursor: 'pointer',
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground3,
    transitionProperty: 'background-color, border-color', transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, ...shorthands.borderColor(tokens.colorBrandStroke1), color: tokens.colorNeutralForeground2 },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '1px' },
  },
  fileDropActive: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorNeutralBackground2Hover, color: tokens.colorNeutralForeground2 },
  fileDropIcon: { color: tokens.colorBrandForeground1 },
  filePicked: {
    display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  filePickedName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  visuallyHidden: {
    position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px',
    overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
  },
});

interface QueryResponse {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  state?: string;
  code?: string;
  canceled?: boolean;
}

interface Warehouse {
  id: string;
  name: string;
  state: string;
  cluster_size?: string;
  warehouse_type?: string;
  enable_serverless_compute?: boolean;
}

interface WarehouseState {
  ok?: boolean;
  state?: string;
  name?: string;
  cluster_size?: string;
  warehouse_type?: string;
  serverless?: boolean;
  min_num_clusters?: number;
  max_num_clusters?: number;
  auto_stop_mins?: number;
  error?: string;
}

interface SchemaResponse {
  ok: boolean;
  state?: string;
  catalogs?: string[];
  schemas?: string[];
  tables?: string[];
  columns?: string[];
  views?: string[];
  functions?: string[];
  message?: string;
  error?: string;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function stateColor(state?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (state === 'RUNNING') return 'success';
  if (state === 'STARTING' || state === 'STOPPING') return 'warning';
  if (state === 'STOPPED') return 'informative';
  return 'severe';
}

function ResultsPanel({
  result, loading, onOpenExcel,
}: {
  result: QueryResponse | null;
  loading: boolean;
  onOpenExcel?: () => void | Promise<void>;
}) {
  const s = useStyles();
  if (loading) {
    return (
      <div className={s.resultBox}>
        <Spinner size="small" label="Executing SQL on warehouse…" labelPosition="after" />
      </div>
    );
  }
  if (!result) {
    return (
      <div className={s.resultBox}>
        <Caption1>Click <strong>Run</strong> to execute. Results appear here.</Caption1>
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent={result.canceled ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.canceled ? 'Query canceled' : 'Query failed'}</MessageBarTitle>
            {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  const rows = result.rows || [];
  const columns = result.columns || [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
        {rows.length > 0 && (
          <div className={s.resultActions}>
            <Tooltip content="Download results as CSV" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadResultsCsv(`query-results-${stamp}`, columns, rows)}>CSV</Button>
            </Tooltip>
            <Tooltip content="Download results as JSON" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadResultsJson(`query-results-${stamp}`, columns, rows)}>JSON</Button>
            </Tooltip>
            {onOpenExcel && (
              <Tooltip content="Open in Excel (web query — refresh re-runs against the live warehouse)" relationship="label">
                <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                  onClick={() => void onOpenExcel()}>Excel</Button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <Caption1>Query returned no rows.</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Query results" size="small">
            <TableHeader>
              <TableRow>
                {columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- $/hr estimate (client-side, no extra backend call) --------------------
// DBU consumption per cluster by warehouse size (Databricks SQL Warehouse sizing
// table, Microsoft Learn). The autoscaler runs `min_num_clusters` of these.
const DBU_PER_CLUSTER: Record<string, number> = {
  '2X-Small': 2, 'X-Small': 4, 'Small': 8, 'Medium': 16, 'Large': 32,
  'X-Large': 64, '2X-Large': 128, '3X-Large': 256, '4X-Large': 512,
};
// Azure list-price DBU/hr rate by warehouse type (USD; serverless is demand-billed
// at a premium). Static — actual cost varies by region, Photon, and discount.
const DBU_RATE_USD: Record<string, number> = {
  SERVERLESS: 0.70,
  PRO: 0.55,
  CLASSIC: 0.22,
};
function dbuPerHr(size: string): number {
  return DBU_PER_CLUSTER[size] ?? 4;
}
function estimateDbxCostPerHr(size: string, type: string, serverless: boolean, minClusters: number): number {
  const dbu = dbuPerHr(size);
  const rate = serverless ? DBU_RATE_USD.SERVERLESS : (DBU_RATE_USD[type] ?? DBU_RATE_USD.PRO);
  return dbu * rate * Math.max(1, minClusters);
}
// Synapse Dedicated SQL pool DWU → $/hr (Azure list price, ~East US 2; linear in
// DWU: DW100c ≈ $1.51/hr). Static estimate; varies by region and reservation.
const DWU_COST_USD: Record<string, number> = {
  'DW100c': 1.51, 'DW200c': 3.02, 'DW300c': 4.53, 'DW400c': 6.04,
  'DW500c': 7.55, 'DW1000c': 15.10, 'DW1500c': 22.65, 'DW2000c': 30.20,
  'DW2500c': 37.75, 'DW3000c': 45.30, 'DW5000c': 75.50,
};
function estimateDwuCostPerHr(sku: string): number {
  return DWU_COST_USD[sku] ?? 1.51;
}

interface Cluster {
  cluster_id: string;
  cluster_name?: string;
  state?: string;
  spark_version?: string;
  node_type_id?: string;
  num_workers?: number;
  autoscale?: { min_workers?: number; max_workers?: number };
  autotermination_minutes?: number;
  state_message?: string;
  // v3.4 — Libraries + Init Scripts tabs surface these from the GET response.
  // Databricks GET /api/2.0/clusters/get returns init_scripts + spark_conf
  // inline on the cluster object; libraries are a separate REST call
  // (/api/2.0/libraries/cluster-status?cluster_id=...).
  spark_conf?: Record<string, string>;
  init_scripts?: Array<{
    workspace?: { destination?: string };
    volumes?: { destination?: string };
    dbfs?: { destination?: string };
    s3?: { destination?: string };
    abfss?: { destination?: string };
    gcs?: { destination?: string };
    file?: { destination?: string };
  }>;
  custom_tags?: Record<string, string>;
  data_security_mode?: string;
  driver_node_type_id?: string;
  runtime_engine?: string;
  spark_env_vars?: Record<string, string>;
  azure_attributes?: { availability?: string; first_on_demand?: number };
}

// Library object returned by /api/2.0/libraries/cluster-status — slim shape,
// just the fields the tab renders. Real response includes per-library
// install status (INSTALLED / PENDING / FAILED) and messages.
interface ClusterLibrary {
  status?: string;
  messages?: string[];
  library?: {
    pypi?: { package?: string; repo?: string };
    maven?: { coordinates?: string; repo?: string };
    cran?: { package?: string };
    jar?: string;
    egg?: string;
    whl?: string;
    requirements?: string;
  };
}

function clusterStateColor(s?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (s === 'RUNNING') return 'success';
  if (s === 'PENDING' || s === 'RESTARTING' || s === 'RESIZING') return 'warning';
  if (s === 'TERMINATED') return 'informative';
  return 'severe';
}

function runStateColor(s?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (s === 'SUCCESS') return 'success';
  if (s === 'FAILED' || s === 'TIMEDOUT' || s === 'CANCELED') return 'severe';
  if (s === 'RUNNING' || s === 'PENDING') return 'warning';
  return 'informative';
}

function fmtTime(ms?: number): string {
  if (!ms) return '—';
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z'; }
  catch { return String(ms); }
}

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtBytes(b?: number): string {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${(b / 1_073_741_824).toFixed(2)} GB`;
}

// ============================================================
// Databricks Notebook editor — cell-based, Databricks-parity
//
// One-for-one with the real Databricks notebook surface:
//   - Workspace tree (browse / open / new / delete notebooks)
//   - Cluster picker + live cluster status badge
//   - Cell-based authoring: add code/markdown cells, reorder, delete,
//     duplicate, per-cell language (Python/SQL/Scala/R via %-magics),
//     Monaco editor per code cell, markdown render per md cell
//   - Run cell / Run all against a real cluster via the Databricks
//     Command Execution API (api/1.2). Real stdout / table / error per cell.
//   - Save -> serialises cells to Databricks SOURCE format and imports
//     them to the workspace (api/2.0/workspace/import).
//   - Open -> exports SOURCE (api/2.0/workspace/export) and parses to cells.
//
// Honest gates: if no cluster is RUNNING, the Run controls explain the exact
// action (start a cluster); if the workspace REST is not reachable the tree
// surfaces the precise error from the BFF.
// ============================================================

interface WorkspaceObject {
  object_type: string;
  path: string;
  language?: string;
}

interface RunRow {
  run_id: number;
  run_name?: string;
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string };
  start_time?: number;
  execution_duration?: number;
  creator_user_name?: string;
}

interface CellResult {
  status: 'idle' | 'running' | 'ok' | 'error';
  resultType?: 'text' | 'table' | 'image' | 'error';
  text?: string;
  columns?: string[];
  rows?: unknown[][];
  image?: string;
  error?: string;
  cause?: string;
  truncated?: boolean;
  ms?: number;
}

// Map Databricks workspace object language -> notebook base language.
function detectBase(lang?: string): DbxBaseLanguage {
  const u = (lang || 'PYTHON').toUpperCase();
  if (u === 'SQL') return 'SQL';
  if (u === 'SCALA') return 'SCALA';
  if (u === 'R') return 'R';
  return 'PYTHON';
}


export {
  useStyles, ResultsPanel, formatCell, stateColor, fmtBytes, fmtTime, fmtDuration,
  clusterStateColor, runStateColor, detectBase, dbuPerHr, estimateDbxCostPerHr,
  estimateDwuCostPerHr, DBU_PER_CLUSTER, DBU_RATE_USD, DWU_COST_USD,
};
export type {
  QueryResponse, Warehouse, WarehouseState, SchemaResponse, Cluster, ClusterLibrary,
  WorkspaceObject, RunRow, CellResult,
};
