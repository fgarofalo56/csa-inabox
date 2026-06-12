'use client';

/**
 * Databricks SQL Warehouse editor — fully wired against the Loom-deployed
 * Databricks workspace via Container App MI + AAD bearer tokens.
 *
 * - Lists real warehouses via /api/2.0/sql/warehouses
 * - Real Start/Stop via /start, /stop
 * - Real Unity Catalog browse (SHOW CATALOGS / SCHEMAS / TABLES)
 * - Real statement execution via /api/2.0/sql/statements with polling
 *
 * Modelled directly on synapse-sql-editors.tsx (Dedicated). No mocks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
} from '@fluentui/react-icons';
import { ModelViewPanel } from './components/model-view-canvas';
import { ItemEditorChrome } from './item-editor-chrome';
import { StatsMaintenanceDialog } from './components/stats-maintenance-dialog';
import { WarehouseMonitoringTab } from './components/warehouse-monitoring';
import { ConnectionDetailsPanel } from './components/connection-details';
import { AiFunctionsHelper } from './components/ai-functions-helper';
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
import { WarehouseAlerts } from './components/warehouse-alerts';
import { SqlCopilotEditor } from '@/lib/components/editor/sql-copilot-editor';
import { VisualQueryCanvas, type VqSourceTable } from './components/visual-query-canvas';
import { downloadResultsCsv, downloadResultsJson } from './components/result-export';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { emptyCell } from '@/lib/types/notebook-cell';
import {
  parseSource, serializeCells, cellLangToCommandLanguage,
  type DbxBaseLanguage,
} from './databricks-notebook-source';
import { QueryParamsBar, substituteDbx, type QueryParam } from './components/query-params';
import { ResultVisualize } from './components/result-visualize';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 200,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 200 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: 4 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8 },
  treeRow: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 4,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  treeDelete: { opacity: 0, ':hover': { opacity: 1 } },
  cellList: { display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 },
  cellOutput: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderTop: 'none',
    borderRadius: '0 0 4px 4px', padding: 8, marginBottom: 4,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cellPre: {
    fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap',
    margin: 0, maxHeight: 320, overflow: 'auto', color: tokens.colorNeutralForeground1,
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

// ============================================================
// Unity Catalog WRITE dialogs — create catalog / schema / table +
// manage grants. All on the real UC REST surface under
// /api/databricks/unity-catalog/*. Drives the same UC tree the editor browses.
// ============================================================

// Privileges the UC grant editor offers per securable type. Grounded in the
// Unity Catalog privileges reference (Learn). Catalog/Schema are container
// objects (CREATE…/USE…); Table/Volume/Function are leaf securables.
const UC_PRIVILEGES: Record<string, string[]> = {
  CATALOG: [
    'ALL PRIVILEGES', 'USE CATALOG', 'USE SCHEMA', 'CREATE SCHEMA', 'CREATE TABLE',
    'CREATE FUNCTION', 'CREATE VOLUME', 'CREATE MATERIALIZED VIEW', 'CREATE MODEL',
    'SELECT', 'MODIFY', 'EXECUTE', 'READ VOLUME', 'WRITE VOLUME', 'REFRESH',
    'BROWSE', 'APPLY TAG', 'MANAGE',
  ],
  SCHEMA: [
    'ALL PRIVILEGES', 'USE SCHEMA', 'CREATE TABLE', 'CREATE FUNCTION', 'CREATE VOLUME',
    'CREATE MATERIALIZED VIEW', 'CREATE MODEL', 'SELECT', 'MODIFY', 'EXECUTE',
    'READ VOLUME', 'WRITE VOLUME', 'REFRESH', 'APPLY TAG', 'MANAGE',
  ],
  TABLE: ['ALL PRIVILEGES', 'SELECT', 'MODIFY', 'APPLY TAG', 'MANAGE'],
  VOLUME: ['ALL PRIVILEGES', 'READ VOLUME', 'WRITE VOLUME', 'APPLY TAG', 'MANAGE'],
  FUNCTION: ['ALL PRIVILEGES', 'EXECUTE', 'APPLY TAG', 'MANAGE'],
  // Storage / metastore securables — the BFF grants route already accepts these
  // securable_types; expose them with their valid privilege matrices (E8).
  EXTERNAL_LOCATION: ['ALL PRIVILEGES', 'CREATE EXTERNAL TABLE', 'CREATE EXTERNAL VOLUME', 'READ FILES', 'WRITE FILES', 'CREATE MANAGED STORAGE', 'BROWSE', 'MANAGE'],
  STORAGE_CREDENTIAL: ['ALL PRIVILEGES', 'CREATE EXTERNAL LOCATION', 'CREATE EXTERNAL TABLE', 'READ FILES', 'WRITE FILES', 'MANAGE'],
  METASTORE: ['CREATE CATALOG', 'CREATE CONNECTION', 'CREATE EXTERNAL LOCATION', 'CREATE STORAGE CREDENTIAL', 'CREATE CLEAN ROOM', 'CREATE PROVIDER', 'CREATE RECIPIENT', 'CREATE SHARE', 'USE MARKETPLACE ASSETS', 'SET SHARE PERMISSION', 'USE CONNECTION', 'MANAGE ALLOWLIST'],
};

const UC_COLUMN_TYPES = [
  'STRING', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DOUBLE', 'FLOAT',
  'DECIMAL', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'TIMESTAMP_NTZ', 'BINARY',
];

interface UcGrant { principal: string; privileges: string[] }
type UcSecurable = 'CATALOG' | 'SCHEMA' | 'TABLE' | 'VOLUME' | 'FUNCTION'
  | 'EXTERNAL_LOCATION' | 'STORAGE_CREDENTIAL' | 'METASTORE';

interface UcWriteDialogsProps {
  catalogs: string[];
  activeCatalog: string | null;
  schemas: string[];
  activeSchema: string | null;
  tables: string[];
  /** SQL Warehouse the editor is bound to — used to run schema inference for
   *  "Create table from file" (read_files CTAS). */
  warehouseId: string;
  onChanged: () => void;            // re-list the tree after a mutation
  // controlled open state per dialog
  createCatalogOpen: boolean; setCreateCatalogOpen: (v: boolean) => void;
  createSchemaOpen: boolean; setCreateSchemaOpen: (v: boolean) => void;
  createTableOpen: boolean; setCreateTableOpen: (v: boolean) => void;
  grantsOpen: boolean; setGrantsOpen: (v: boolean) => void;
  createVolumeOpen: boolean; setCreateVolumeOpen: (v: boolean) => void;
  dropOpen: boolean; setDropOpen: (v: boolean) => void;
}

interface NewColumn { name: string; type_name: string; nullable: boolean; comment: string }

// A key-value tag/property row (UC `properties` map on catalogs/schemas).
interface KvRow { key: string; value: string }
function kvToMap(rows: KvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) { const k = r.key.trim(); if (k) out[k] = r.value; }
  return Object.keys(out).length ? out : undefined;
}

// Inline key-value editor for UC tags/properties (used by create catalog/schema).
// Each row has a key + value input and a remove button; "Add tag" appends a row.
function KvTagEditor({ rows, setRows }: { rows: KvRow[]; setRows: (r: KvRow[]) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Input
            style={{ flex: 1 }} value={r.key} placeholder="key (e.g. team)"
            aria-label={`Tag ${i + 1} key`}
            onChange={(_, d) => setRows(rows.map((x, j) => (j === i ? { ...x, key: d.value } : x)))}
          />
          <Input
            style={{ flex: 1 }} value={r.value} placeholder="value (e.g. analytics)"
            aria-label={`Tag ${i + 1} value`}
            onChange={(_, d) => setRows(rows.map((x, j) => (j === i ? { ...x, value: d.value } : x)))}
          />
          <Button
            size="small" appearance="subtle" icon={<Delete20Regular />}
            aria-label={`Remove tag ${i + 1}`}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setRows([...rows, { key: '', value: '' }])}>
        Add tag
      </Button>
    </div>
  );
}

function UnityCatalogWriteDialogs(props: UcWriteDialogsProps) {
  const s = useStyles();
  const {
    catalogs, activeCatalog, schemas, activeSchema, tables, warehouseId, onChanged,
    createCatalogOpen, setCreateCatalogOpen,
    createSchemaOpen, setCreateSchemaOpen,
    createTableOpen, setCreateTableOpen,
    grantsOpen, setGrantsOpen,
    createVolumeOpen, setCreateVolumeOpen,
    dropOpen, setDropOpen,
  } = props;

  // ---- Create catalog ----
  const [catName, setCatName] = useState('');
  const [catComment, setCatComment] = useState('');
  const [catStorage, setCatStorage] = useState('');
  // Catalog type — Standard (managed) is the default; Foreign wraps a UC
  // connection; Delta-Sharing mounts a share from a provider.
  const [catType, setCatType] = useState<'STANDARD' | 'FOREIGN_CATALOG' | 'DELTASHARING_CATALOG'>('STANDARD');
  const [catConnection, setCatConnection] = useState('');     // FOREIGN: connection_name
  const [catForeignDb, setCatForeignDb] = useState('');       // FOREIGN: options.database
  const [catProvider, setCatProvider] = useState('');         // DELTASHARING: provider_name
  const [catShare, setCatShare] = useState('');               // DELTASHARING: share_name
  const [catTags, setCatTags] = useState<KvRow[]>([]);        // key-value properties (tags)
  const [catBusy, setCatBusy] = useState(false);
  const [catErr, setCatErr] = useState<string | null>(null);

  const createCatalog = useCallback(async () => {
    if (!catName.trim()) return;
    if (catType === 'FOREIGN_CATALOG' && !catConnection.trim()) { setCatErr('Foreign catalogs require a connection.'); return; }
    if (catType === 'DELTASHARING_CATALOG' && (!catProvider.trim() || !catShare.trim())) { setCatErr('Delta-Sharing catalogs require a provider and a share.'); return; }
    setCatBusy(true); setCatErr(null);
    try {
      const payload: Record<string, unknown> = {
        name: catName.trim(),
        comment: catComment.trim() || undefined,
        properties: kvToMap(catTags),
      };
      if (catType === 'FOREIGN_CATALOG') {
        payload.catalog_type = 'FOREIGN_CATALOG';
        payload.connection_name = catConnection.trim();
        if (catForeignDb.trim()) payload.options = { database: catForeignDb.trim() };
      } else if (catType === 'DELTASHARING_CATALOG') {
        payload.catalog_type = 'DELTASHARING_CATALOG';
        payload.provider_name = catProvider.trim();
        payload.share_name = catShare.trim();
      } else {
        // Standard managed catalog — storage root applies here only.
        payload.storage_root = catStorage.trim() || undefined;
      }
      const r = await fetch('/api/databricks/unity-catalog/catalogs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setCatErr(j.error || `HTTP ${r.status}`); return; }
      setCreateCatalogOpen(false);
      setCatName(''); setCatComment(''); setCatStorage('');
      setCatType('STANDARD'); setCatConnection(''); setCatForeignDb(''); setCatProvider(''); setCatShare(''); setCatTags([]);
      onChanged();
    } catch (e: any) { setCatErr(e?.message || String(e)); }
    finally { setCatBusy(false); }
  }, [catName, catComment, catStorage, catType, catConnection, catForeignDb, catProvider, catShare, catTags, onChanged, setCreateCatalogOpen]);

  // ---- Create schema ----
  const [schCatalog, setSchCatalog] = useState(activeCatalog || '');
  const [schName, setSchName] = useState('');
  const [schComment, setSchComment] = useState('');
  const [schTags, setSchTags] = useState<KvRow[]>([]);
  const [schBusy, setSchBusy] = useState(false);
  const [schErr, setSchErr] = useState<string | null>(null);
  useEffect(() => { if (createSchemaOpen) setSchCatalog(activeCatalog || catalogs[0] || ''); }, [createSchemaOpen, activeCatalog, catalogs]);

  const createSchema = useCallback(async () => {
    if (!schCatalog || !schName.trim()) return;
    setSchBusy(true); setSchErr(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/schemas', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: schName.trim(), catalog_name: schCatalog, comment: schComment.trim() || undefined, properties: kvToMap(schTags) }),
      });
      const j = await r.json();
      if (!j.ok) { setSchErr(j.error || `HTTP ${r.status}`); return; }
      setCreateSchemaOpen(false); setSchName(''); setSchComment(''); setSchTags([]);
      onChanged();
    } catch (e: any) { setSchErr(e?.message || String(e)); }
    finally { setSchBusy(false); }
  }, [schCatalog, schName, schComment, schTags, onChanged, setCreateSchemaOpen]);

  // ---- Create table ----
  const [tblCatalog, setTblCatalog] = useState(activeCatalog || '');
  const [tblSchema, setTblSchema] = useState(activeSchema || '');
  const [tblName, setTblName] = useState('');
  const [tblComment, setTblComment] = useState('');
  const [tblType, setTblType] = useState<'MANAGED' | 'EXTERNAL'>('MANAGED');
  const [tblFormat, setTblFormat] = useState('DELTA');
  const [tblStorage, setTblStorage] = useState('');
  const [tblCols, setTblCols] = useState<NewColumn[]>([{ name: 'id', type_name: 'BIGINT', nullable: false, comment: '' }]);
  const [tblBusy, setTblBusy] = useState(false);
  const [tblErr, setTblErr] = useState<string | null>(null);
  // C10 — "Create table from file". Source mode toggles the dialog between the
  // column designer and an upload→infer flow. File is read client-side, POSTed
  // as text; the BFF uploads it to a UC volume and runs read_files CTAS.
  const [tblSource, setTblSource] = useState<'columns' | 'file'>('columns');
  const [tblVolumes, setTblVolumes] = useState<string[]>([]);
  const [tblVolume, setTblVolume] = useState('');
  const [tblFileName, setTblFileName] = useState('');
  const [tblFileContent, setTblFileContent] = useState('');
  const [tblFileFmt, setTblFileFmt] = useState<'csv' | 'json' | 'parquet' | 'orc' | 'avro' | 'text'>('csv');
  const [tblFileHeader, setTblFileHeader] = useState(true);
  const [tblFileMsg, setTblFileMsg] = useState<string | null>(null);
  useEffect(() => {
    if (createTableOpen) { setTblCatalog(activeCatalog || catalogs[0] || ''); setTblSchema(activeSchema || ''); }
  }, [createTableOpen, activeCatalog, activeSchema, catalogs]);
  // Load the schema's volumes (staging targets for the upload) when the From-file
  // mode is active and a catalog.schema is chosen.
  useEffect(() => {
    if (!createTableOpen || tblSource !== 'file' || !tblCatalog || !tblSchema) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/databricks/unity-catalog/tables?catalog=${encodeURIComponent(tblCatalog)}&schema=${encodeURIComponent(tblSchema)}`);
        const j = await r.json();
        if (cancelled) return;
        const vols = (j.volumes || []).map((v: any) => `${tblCatalog}.${tblSchema}.${v.name}`);
        setTblVolumes(vols);
        if (vols.length && !tblVolume) setTblVolume(vols[0]);
      } catch { /* honest empty-state below if none */ }
    })();
    return () => { cancelled = true; };
  }, [createTableOpen, tblSource, tblCatalog, tblSchema, tblVolume]);

  const onPickFile = useCallback((file: File | null) => {
    if (!file) return;
    setTblFileName(file.name);
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext === 'json') setTblFileFmt('json');
    else if (ext === 'parquet') setTblFileFmt('parquet');
    else if (ext === 'orc') setTblFileFmt('orc');
    else if (ext === 'avro') setTblFileFmt('avro');
    else if (ext === 'txt') setTblFileFmt('text');
    else setTblFileFmt('csv');
    const reader = new FileReader();
    reader.onload = () => setTblFileContent(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  }, []);

  const createTableFromFile = useCallback(async () => {
    if (!tblCatalog || !tblSchema || !tblName.trim()) { setTblErr('Catalog, schema and table name are required.'); return; }
    if (!tblVolume) { setTblErr('Pick a staging volume (create one first if the schema has none).'); return; }
    if (!tblFileName || !tblFileContent) { setTblErr('Choose a file to upload.'); return; }
    if (!warehouseId) { setTblErr('No SQL Warehouse bound — schema inference needs a running warehouse.'); return; }
    setTblBusy(true); setTblErr(null); setTblFileMsg(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/tables', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'from_file',
          name: tblName.trim(), catalog_name: tblCatalog, schema_name: tblSchema,
          volume: tblVolume, file_name: tblFileName, content: tblFileContent,
          format: tblFileFmt, header: tblFileHeader, warehouse_id: warehouseId,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setTblErr(j.error || `HTTP ${r.status}`); return; }
      const res = j.result || {};
      setTblFileMsg(`Created ${res.full_name} — ${res.columns?.length ?? 0} columns${res.row_count != null ? `, ${res.row_count} rows` : ''}.`);
      setTblName(''); setTblFileName(''); setTblFileContent('');
      onChanged();
    } catch (e: any) { setTblErr(e?.message || String(e)); }
    finally { setTblBusy(false); }
  }, [tblCatalog, tblSchema, tblName, tblVolume, tblFileName, tblFileContent, tblFileFmt, tblFileHeader, warehouseId, onChanged]);

  const addCol = useCallback(() => setTblCols((c) => [...c, { name: '', type_name: 'STRING', nullable: true, comment: '' }]), []);
  const patchCol = useCallback((i: number, p: Partial<NewColumn>) => setTblCols((c) => c.map((col, j) => (j === i ? { ...col, ...p } : col))), []);
  const delCol = useCallback((i: number) => setTblCols((c) => (c.length <= 1 ? c : c.filter((_, j) => j !== i))), []);

  const createTable = useCallback(async () => {
    if (!tblCatalog || !tblSchema || !tblName.trim()) return;
    if (tblCols.some((c) => !c.name.trim())) { setTblErr('Every column needs a name.'); return; }
    if (tblType === 'EXTERNAL' && !tblStorage.trim()) { setTblErr('EXTERNAL tables require a storage location (abfss://…).'); return; }
    setTblBusy(true); setTblErr(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/tables', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: tblName.trim(), catalog_name: tblCatalog, schema_name: tblSchema,
          table_type: tblType, data_source_format: tblFormat,
          storage_location: tblStorage.trim() || undefined,
          comment: tblComment.trim() || undefined,
          columns: tblCols.map((c, i) => ({ name: c.name.trim(), type_name: c.type_name, nullable: c.nullable, position: i, comment: c.comment.trim() || undefined })),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setTblErr(j.error || `HTTP ${r.status}`); return; }
      setCreateTableOpen(false); setTblName(''); setTblComment(''); setTblStorage('');
      setTblCols([{ name: 'id', type_name: 'BIGINT', nullable: false, comment: '' }]);
      onChanged();
    } catch (e: any) { setTblErr(e?.message || String(e)); }
    finally { setTblBusy(false); }
  }, [tblCatalog, tblSchema, tblName, tblComment, tblType, tblFormat, tblStorage, tblCols, onChanged, setCreateTableOpen]);

  // ---- Grants ----
  const [grSecurable, setGrSecurable] = useState<UcSecurable>('SCHEMA');
  const [grFullName, setGrFullName] = useState('');
  const [grGrants, setGrGrants] = useState<UcGrant[] | null>(null);
  const [grEffective, setGrEffective] = useState(false);
  const [grBusy, setGrBusy] = useState(false);
  const [grErr, setGrErr] = useState<string | null>(null);
  const [grPrincipal, setGrPrincipal] = useState('');
  const [grPrivs, setGrPrivs] = useState<Set<string>>(new Set());
  // Principal directory picker (E10) — autocomplete over workspace SCIM
  // users/groups/service principals. Combobox stays freeform so a principal
  // not in the directory (or when SCIM is unavailable) can still be typed.
  const [grPrincOpts, setGrPrincOpts] = useState<Array<{ value: string; label: string }>>([]);
  const [grPrincBusy, setGrPrincBusy] = useState(false);
  const [grPrincNote, setGrPrincNote] = useState<string | null>(null);
  useEffect(() => {
    const q = grPrincipal.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      setGrPrincBusy(true); setGrPrincNote(null);
      try {
        const r = await fetch(`/api/databricks/unity-catalog/principals?q=${encodeURIComponent(q)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) setGrPrincOpts((j.principals || []).map((p: any) => ({ value: p.value, label: p.label || p.value })));
        else { setGrPrincOpts([]); setGrPrincNote(j.error || `HTTP ${r.status}`); }
      } catch (e: any) { if (!cancelled) { setGrPrincOpts([]); setGrPrincNote(e?.message || String(e)); } }
      finally { if (!cancelled) setGrPrincBusy(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [grPrincipal]);
  // Ownership transfer — Catalog Explorer "Change owner" maps to a UC PATCH
  // with { owner } on the catalog/schema/table URL. Only CATALOG/SCHEMA/TABLE
  // support a direct owner PATCH; volumes/functions inherit/own differently.
  const [grOwner, setGrOwner] = useState('');
  const [grOwnerMsg, setGrOwnerMsg] = useState<string | null>(null);
  const ownerSupported = grSecurable === 'CATALOG' || grSecurable === 'SCHEMA' || grSecurable === 'TABLE';

  const transferOwner = useCallback(async () => {
    if (!grOwner.trim() || !grFullName.trim() || !ownerSupported) return;
    setGrBusy(true); setGrErr(null); setGrOwnerMsg(null);
    try {
      const route = grSecurable === 'CATALOG' ? 'catalogs' : grSecurable === 'SCHEMA' ? 'schemas' : 'tables';
      const body: Record<string, unknown> = { owner: grOwner.trim() };
      if (grSecurable === 'CATALOG') body.name = grFullName.trim();
      else body.full_name = grFullName.trim();
      const r = await fetch(`/api/databricks/unity-catalog/${route}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setGrErr(j.error || `HTTP ${r.status}`); return; }
      const newOwner = j.catalog?.owner || j.schema?.owner || j.table?.owner || grOwner.trim();
      setGrOwnerMsg(`Owner of ${grFullName.trim()} is now ${newOwner}.`);
      onChanged();
    } catch (e: any) { setGrErr(e?.message || String(e)); }
    finally { setGrBusy(false); }
  }, [grOwner, grFullName, grSecurable, ownerSupported, onChanged]);

  // Seed full_name from the current tree context when the dialog opens.
  useEffect(() => {
    if (!grantsOpen) return;
    if (activeSchema && activeCatalog) { setGrSecurable('SCHEMA'); setGrFullName(`${activeCatalog}.${activeSchema}`); }
    else if (activeCatalog) { setGrSecurable('CATALOG'); setGrFullName(activeCatalog); }
  }, [grantsOpen, activeCatalog, activeSchema]);

  // A prior "owner is now…" confirmation describes one specific object — drop it
  // (and the new-owner draft) whenever the target securable/full-name changes so
  // the success bar never lingers under an unrelated object.
  useEffect(() => { setGrOwnerMsg(null); setGrOwner(''); }, [grSecurable, grFullName]);

  const loadGrants = useCallback(async () => {
    if (!grFullName.trim() && grSecurable !== 'METASTORE' as any) { setGrErr('Enter the securable full name.'); return; }
    setGrBusy(true); setGrErr(null); setGrGrants(null);
    try {
      const params = new URLSearchParams({ securable_type: grSecurable, full_name: grFullName.trim() });
      if (grEffective) params.set('effective', 'true');
      const r = await fetch(`/api/databricks/unity-catalog/grants?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) { setGrErr(j.error || `HTTP ${r.status}`); return; }
      // effective shape differs (privileges is array of objects) — normalize for display.
      const grants: UcGrant[] = (j.grants || []).map((g: any) => ({
        principal: g.principal,
        privileges: Array.isArray(g.privileges)
          ? g.privileges.map((p: any) => (typeof p === 'string' ? p : `${p.privilege}${p.inherited_from_type ? ` (inherited)` : ''}`))
          : [],
      }));
      setGrGrants(grants);
    } catch (e: any) { setGrErr(e?.message || String(e)); }
    finally { setGrBusy(false); }
  }, [grSecurable, grFullName, grEffective]);

  const applyGrant = useCallback(async (mode: 'add' | 'remove') => {
    if (!grPrincipal.trim() || grPrivs.size === 0) { setGrErr('Pick a principal and at least one privilege.'); return; }
    setGrBusy(true); setGrErr(null);
    try {
      const change = mode === 'add'
        ? { principal: grPrincipal.trim(), add: [...grPrivs] }
        : { principal: grPrincipal.trim(), remove: [...grPrivs] };
      const r = await fetch('/api/databricks/unity-catalog/grants', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ securable_type: grSecurable, full_name: grFullName.trim(), changes: [change] }),
      });
      const j = await r.json();
      if (!j.ok) { setGrErr(j.error || `HTTP ${r.status}`); return; }
      setGrGrants((j.grants || []).map((g: any) => ({ principal: g.principal, privileges: g.privileges || [] })));
      setGrPrivs(new Set());
    } catch (e: any) { setGrErr(e?.message || String(e)); }
    finally { setGrBusy(false); }
  }, [grSecurable, grFullName, grPrincipal, grPrivs]);

  const togglePriv = useCallback((p: string) => setGrPrivs((s) => {
    const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n;
  }), []);

  // ---- Create volume ----
  const [volCatalog, setVolCatalog] = useState(activeCatalog || '');
  const [volSchema, setVolSchema] = useState(activeSchema || '');
  const [volName, setVolName] = useState('');
  const [volType, setVolType] = useState<'MANAGED' | 'EXTERNAL'>('MANAGED');
  const [volStorage, setVolStorage] = useState('');
  const [volComment, setVolComment] = useState('');
  const [volBusy, setVolBusy] = useState(false);
  const [volErr, setVolErr] = useState<string | null>(null);
  useEffect(() => {
    if (createVolumeOpen) { setVolCatalog(activeCatalog || catalogs[0] || ''); setVolSchema(activeSchema || ''); }
  }, [createVolumeOpen, activeCatalog, activeSchema, catalogs]);

  const createVolume = useCallback(async () => {
    if (!volCatalog || !volSchema || !volName.trim()) return;
    if (volType === 'EXTERNAL' && !volStorage.trim()) { setVolErr('EXTERNAL volumes require a storage location (abfss://…).'); return; }
    setVolBusy(true); setVolErr(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/volumes', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: volName.trim(), catalog_name: volCatalog, schema_name: volSchema,
          volume_type: volType, storage_location: volStorage.trim() || undefined,
          comment: volComment.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setVolErr(j.error || `HTTP ${r.status}`); return; }
      setCreateVolumeOpen(false); setVolName(''); setVolStorage(''); setVolComment('');
      onChanged();
    } catch (e: any) { setVolErr(e?.message || String(e)); }
    finally { setVolBusy(false); }
  }, [volCatalog, volSchema, volName, volType, volStorage, volComment, onChanged, setCreateVolumeOpen]);

  // ---- Drop (catalog / schema / table / volume) ----
  type DropKind = 'CATALOG' | 'SCHEMA' | 'TABLE' | 'VOLUME';
  const [dropKind, setDropKind] = useState<DropKind>('TABLE');
  const [dropName, setDropName] = useState('');
  const [dropForce, setDropForce] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  useEffect(() => {
    if (!dropOpen) return;
    // Seed the most specific securable available from the current tree context.
    if (activeSchema && activeCatalog) { setDropKind('SCHEMA'); setDropName(`${activeCatalog}.${activeSchema}`); }
    else if (activeCatalog) { setDropKind('CATALOG'); setDropName(activeCatalog); }
    setDropErr(null);
  }, [dropOpen, activeCatalog, activeSchema]);

  const doDrop = useCallback(async () => {
    const name = dropName.trim();
    if (!name) { setDropErr('Enter the full name of the object to drop.'); return; }
    const segs = name.split('.').length;
    const want = dropKind === 'CATALOG' ? 1 : dropKind === 'SCHEMA' ? 2 : 3;
    if (segs !== want) { setDropErr(`${dropKind} full name must have ${want} part${want > 1 ? 's' : ''} (${dropKind === 'CATALOG' ? 'catalog' : dropKind === 'SCHEMA' ? 'catalog.schema' : 'catalog.schema.object'}).`); return; }
    setDropBusy(true); setDropErr(null);
    try {
      const route = dropKind === 'CATALOG' ? 'catalogs'
        : dropKind === 'SCHEMA' ? 'schemas'
        : dropKind === 'TABLE' ? 'tables' : 'volumes';
      const qs = new URLSearchParams();
      if (dropKind === 'CATALOG') qs.set('name', name); else qs.set('full_name', name);
      if ((dropKind === 'CATALOG' || dropKind === 'SCHEMA') && dropForce) qs.set('force', 'true');
      const r = await fetch(`/api/databricks/unity-catalog/${route}?${qs.toString()}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setDropErr(j.error || `HTTP ${r.status}`); return; }
      setDropOpen(false); setDropName('');
      onChanged();
    } catch (e: any) { setDropErr(e?.message || String(e)); }
    finally { setDropBusy(false); }
  }, [dropKind, dropName, dropForce, onChanged, setDropOpen]);

  return (
    <>
      {/* Create catalog */}
      <Dialog open={createCatalogOpen} onOpenChange={(_, d) => setCreateCatalogOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>Create catalog</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {catErr && <MessageBar intent="error"><MessageBarBody>{catErr}</MessageBarBody></MessageBar>}
                <Field label="Catalog name" required><Input value={catName} onChange={(_, d) => setCatName(d.value)} placeholder="sales" /></Field>
                <Field label="Type" hint="Standard = managed UC catalog · Foreign = wraps an external DB via a UC connection · Delta Sharing = mounts a provider's share">
                  <Dropdown
                    value={catType === 'STANDARD' ? 'Standard' : catType === 'FOREIGN_CATALOG' ? 'Foreign' : 'Delta Sharing'}
                    selectedOptions={[catType]}
                    onOptionSelect={(_, d) => d.optionValue && setCatType(d.optionValue as typeof catType)}
                  >
                    <Option value="STANDARD" text="Standard">Standard</Option>
                    <Option value="FOREIGN_CATALOG" text="Foreign">Foreign</Option>
                    <Option value="DELTASHARING_CATALOG" text="Delta Sharing">Delta Sharing</Option>
                  </Dropdown>
                </Field>
                <Field label="Comment"><Input value={catComment} onChange={(_, d) => setCatComment(d.value)} /></Field>
                {catType === 'STANDARD' && (
                  <Field label="Managed storage root (optional)" hint="abfss://container@account.dfs.core.windows.net/path — omit to use the metastore default">
                    <Input value={catStorage} onChange={(_, d) => setCatStorage(d.value)} placeholder="abfss://…" />
                  </Field>
                )}
                {catType === 'FOREIGN_CATALOG' && (
                  <>
                    <Field label="Connection" required hint="Name of the UC connection to the foreign database">
                      <Input value={catConnection} onChange={(_, d) => setCatConnection(d.value)} placeholder="pg_prod_conn" />
                    </Field>
                    <Field label="Database (optional)" hint="Source database to mirror (options.database)">
                      <Input value={catForeignDb} onChange={(_, d) => setCatForeignDb(d.value)} placeholder="sales_db" />
                    </Field>
                  </>
                )}
                {catType === 'DELTASHARING_CATALOG' && (
                  <>
                    <Field label="Provider" required hint="The Delta Sharing provider you accepted">
                      <Input value={catProvider} onChange={(_, d) => setCatProvider(d.value)} placeholder="contoso_provider" />
                    </Field>
                    <Field label="Share" required hint="The share to mount as this catalog">
                      <Input value={catShare} onChange={(_, d) => setCatShare(d.value)} placeholder="sales_share" />
                    </Field>
                  </>
                )}
                <Field label="Tags (properties)" hint="Key-value metadata stored on the catalog">
                  <KvTagEditor rows={catTags} setRows={setCatTags} />
                </Field>
                <Caption1>POST <code>/api/2.1/unity-catalog/catalogs</code> — requires CREATE CATALOG on the metastore. Foreign needs CREATE FOREIGN CATALOG on the connection; Delta Sharing needs USE PROVIDER on the provider.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateCatalogOpen(false)} disabled={catBusy}>Cancel</Button>
              <Button appearance="primary" onClick={createCatalog} disabled={catBusy || !catName.trim()}>{catBusy ? 'Creating…' : 'Create catalog'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Create schema */}
      <Dialog open={createSchemaOpen} onOpenChange={(_, d) => setCreateSchemaOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>Create schema</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {schErr && <MessageBar intent="error"><MessageBarBody>{schErr}</MessageBarBody></MessageBar>}
                <Field label="Catalog" required>
                  <Dropdown value={schCatalog} selectedOptions={schCatalog ? [schCatalog] : []} onOptionSelect={(_, d) => d.optionValue && setSchCatalog(d.optionValue)} placeholder="Select catalog">
                    {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Schema name" required><Input value={schName} onChange={(_, d) => setSchName(d.value)} placeholder="bronze" /></Field>
                <Field label="Comment"><Input value={schComment} onChange={(_, d) => setSchComment(d.value)} /></Field>
                <Field label="Tags (properties)" hint="Key-value metadata stored on the schema">
                  <KvTagEditor rows={schTags} setRows={setSchTags} />
                </Field>
                <Caption1>POST <code>/api/2.1/unity-catalog/schemas</code> — requires CREATE SCHEMA + USE CATALOG on the parent.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateSchemaOpen(false)} disabled={schBusy}>Cancel</Button>
              <Button appearance="primary" onClick={createSchema} disabled={schBusy || !schCatalog || !schName.trim()}>{schBusy ? 'Creating…' : 'Create schema'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Create table */}
      <Dialog open={createTableOpen} onOpenChange={(_, d) => setCreateTableOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720, width: '95vw' }}>
          <DialogBody>
            <DialogTitle>Create table</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {tblErr && <MessageBar intent="error"><MessageBarBody>{tblErr}</MessageBarBody></MessageBar>}
                <div className={s.dlgRow}>
                  <Field label="Catalog" required className={s.flex1}>
                    <Dropdown value={tblCatalog} selectedOptions={tblCatalog ? [tblCatalog] : []} onOptionSelect={(_, d) => d.optionValue && setTblCatalog(d.optionValue)} placeholder="catalog">
                      {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Schema" required className={s.flex1}>
                    {schemas.length > 0 && tblCatalog === activeCatalog ? (
                      <Dropdown value={tblSchema} selectedOptions={tblSchema ? [tblSchema] : []} onOptionSelect={(_, d) => d.optionValue && setTblSchema(d.optionValue)} placeholder="schema">
                        {schemas.map((sc) => <Option key={sc} value={sc} text={sc}>{sc}</Option>)}
                      </Dropdown>
                    ) : (
                      <Input value={tblSchema} onChange={(_, d) => setTblSchema(d.value)} placeholder="schema" />
                    )}
                  </Field>
                  <Field label="Table name" required className={s.flex1}><Input value={tblName} onChange={(_, d) => setTblName(d.value)} placeholder="orders" /></Field>
                </div>

                <Field label="Source">
                  <TabList selectedValue={tblSource} onTabSelect={(_, d) => setTblSource(d.value as 'columns' | 'file')} size="small">
                    <Tab value="columns">Define columns</Tab>
                    <Tab value="file">From file (upload &amp; infer)</Tab>
                  </TabList>
                </Field>

                {tblSource === 'columns' ? (
                  <>
                    <div className={s.dlgRow}>
                      <Field label="Type" className={s.flex1}>
                        <Dropdown value={tblType} selectedOptions={[tblType]} onOptionSelect={(_, d) => d.optionValue && setTblType(d.optionValue as 'MANAGED' | 'EXTERNAL')}>
                          <Option value="MANAGED" text="MANAGED">MANAGED</Option>
                          <Option value="EXTERNAL" text="EXTERNAL">EXTERNAL</Option>
                        </Dropdown>
                      </Field>
                      <Field label="Format" className={s.flex1}>
                        <Dropdown value={tblFormat} selectedOptions={[tblFormat]} onOptionSelect={(_, d) => d.optionValue && setTblFormat(d.optionValue)}>
                          {['DELTA', 'PARQUET', 'CSV', 'JSON', 'ORC', 'AVRO', 'TEXT'].map((f) => <Option key={f} value={f} text={f}>{f}</Option>)}
                        </Dropdown>
                      </Field>
                      <Field label="Comment" className={s.flex2}><Input value={tblComment} onChange={(_, d) => setTblComment(d.value)} /></Field>
                    </div>
                    {tblType === 'EXTERNAL' && (
                      <Field label="Storage location" required hint="abfss://… — required for EXTERNAL tables">
                        <Input value={tblStorage} onChange={(_, d) => setTblStorage(d.value)} placeholder="abfss://container@account.dfs.core.windows.net/path" />
                      </Field>
                    )}
                    <Divider>Columns</Divider>
                    {tblCols.map((c, i) => (
                      <div key={i} className={s.colRow}>
                        <Input className={s.flex2} value={c.name} onChange={(_, d) => patchCol(i, { name: d.value })} placeholder="column name" aria-label={`Column ${i + 1} name`} />
                        <Dropdown className={s.flex1} value={c.type_name} selectedOptions={[c.type_name]} onOptionSelect={(_, d) => d.optionValue && patchCol(i, { type_name: d.optionValue })} aria-label={`Column ${i + 1} type`}>
                          {UC_COLUMN_TYPES.map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                        </Dropdown>
                        <Switch checked={c.nullable} label="nullable" onChange={(_, d) => patchCol(i, { nullable: !!d.checked })} />
                        <Input className={s.flex2} value={c.comment} onChange={(_, d) => patchCol(i, { comment: d.value })} placeholder="comment" aria-label={`Column ${i + 1} comment`} />
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove column ${i + 1}`} disabled={tblCols.length <= 1} onClick={() => delCol(i)} />
                      </div>
                    ))}
                    <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addCol}>Add column</Button>
                    <Caption1>POST <code>/api/2.1/unity-catalog/tables</code> — requires CREATE TABLE + USE SCHEMA + USE CATALOG.</Caption1>
                  </>
                ) : (
                  <>
                    {tblFileMsg && <MessageBar intent="success"><MessageBarBody>{tblFileMsg}</MessageBarBody></MessageBar>}
                    {!warehouseId && (
                      <MessageBar intent="warning"><MessageBarBody>
                        No SQL Warehouse is bound to this editor. Schema inference runs a
                        <code> read_files</code> CTAS on a warehouse — start/select one first.
                      </MessageBarBody></MessageBar>
                    )}
                    <Field label="Data file" required hint="CSV / JSON / Parquet / ORC / Avro / text. Read in the browser and uploaded to the staging volume.">
                      <input
                        type="file"
                        accept=".csv,.json,.parquet,.orc,.avro,.txt,text/csv,application/json"
                        aria-label="Choose a data file"
                        onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                      />
                    </Field>
                    {tblFileName && <Caption1>Selected: <code>{tblFileName}</code> ({tblFileContent.length.toLocaleString()} chars)</Caption1>}
                    <div className={s.dlgRow}>
                      <Field label="File format" className={s.flex1}>
                        <Dropdown value={tblFileFmt} selectedOptions={[tblFileFmt]} onOptionSelect={(_, d) => d.optionValue && setTblFileFmt(d.optionValue as typeof tblFileFmt)}>
                          {(['csv', 'json', 'parquet', 'orc', 'avro', 'text'] as const).map((f) => <Option key={f} value={f} text={f.toUpperCase()}>{f.toUpperCase()}</Option>)}
                        </Dropdown>
                      </Field>
                      {tblFileFmt === 'csv' && (
                        <Field label="CSV header row" className={s.flex1}>
                          <Switch checked={tblFileHeader} label="first row is a header" onChange={(_, d) => setTblFileHeader(!!d.checked)} />
                        </Field>
                      )}
                    </div>
                    <Field label="Staging volume" required hint="UC volume used to stage the upload before read_files inference">
                      {tblVolumes.length > 0 ? (
                        <Dropdown value={tblVolume} selectedOptions={tblVolume ? [tblVolume] : []} onOptionSelect={(_, d) => d.optionValue && setTblVolume(d.optionValue)} placeholder="catalog.schema.volume">
                          {tblVolumes.map((v) => <Option key={v} value={v} text={v}>{v}</Option>)}
                        </Dropdown>
                      ) : (
                        <MessageBar intent="info"><MessageBarBody>
                          No volume in <code>{tblCatalog || '?'}.{tblSchema || '?'}</code>. Create a volume
                          first (the "Create volume" action) — it is the staging area for the upload.
                        </MessageBarBody></MessageBar>
                      )}
                    </Field>
                    <Caption1>
                      Uploads to <code>/api/2.0/fs/files</code> then runs
                      <code> CREATE TABLE … AS SELECT * FROM read_files(…)</code> on the warehouse —
                      schema is inferred from the file. Requires CREATE TABLE + WRITE VOLUME + USE SCHEMA.
                    </Caption1>
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateTableOpen(false)} disabled={tblBusy}>Cancel</Button>
              {tblSource === 'columns' ? (
                <Button appearance="primary" onClick={createTable} disabled={tblBusy || !tblCatalog || !tblSchema || !tblName.trim()}>{tblBusy ? 'Creating…' : 'Create table'}</Button>
              ) : (
                <Button appearance="primary" onClick={createTableFromFile} disabled={tblBusy || !tblCatalog || !tblSchema || !tblName.trim() || !tblVolume || !tblFileContent || !warehouseId}>{tblBusy ? 'Importing…' : 'Create from file'}</Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Manage grants */}
      <Dialog open={grantsOpen} onOpenChange={(_, d) => setGrantsOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 760, width: '95vw' }}>
          <DialogBody>
            <DialogTitle>Manage grants (Unity Catalog permissions)</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {grErr && <MessageBar intent="error"><MessageBarBody>{grErr}</MessageBarBody></MessageBar>}
                <div className={s.dlgRowEnd}>
                  <Field label="Securable type" style={{ minWidth: 140 }}>
                    <Dropdown value={grSecurable} selectedOptions={[grSecurable]} onOptionSelect={(_, d) => { if (d.optionValue) { setGrSecurable(d.optionValue as UcSecurable); setGrPrivs(new Set()); } }}>
                      {(['CATALOG', 'SCHEMA', 'TABLE', 'VOLUME', 'FUNCTION', 'EXTERNAL_LOCATION', 'STORAGE_CREDENTIAL', 'METASTORE'] as UcSecurable[]).map((t) => <Option key={t} value={t} text={t}>{t.replace(/_/g, ' ')}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Full name" className={s.flex1} hint="catalog · catalog.schema · catalog.schema.object">
                    <Input value={grFullName} onChange={(_, d) => setGrFullName(d.value)} placeholder="main.sales" />
                  </Field>
                  <Switch checked={grEffective} label="effective (incl. inherited)" onChange={(_, d) => setGrEffective(!!d.checked)} />
                  <Button appearance="primary" onClick={loadGrants} disabled={grBusy}>{grBusy ? 'Loading…' : 'Load grants'}</Button>
                </div>

                {grGrants && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Grants" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Principal</TableHeaderCell>
                        <TableHeaderCell>Privileges</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {grGrants.length === 0 && <TableRow><TableCell colSpan={2}><Caption1>No direct grants.</Caption1></TableCell></TableRow>}
                        {grGrants.map((g) => (
                          <TableRow key={g.principal}>
                            <TableCell>{g.principal}</TableCell>
                            <TableCell><div className={s.badgeWrap}>{g.privileges.map((p) => <Badge key={p} appearance="outline">{p}</Badge>)}</div></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {!grEffective && (
                  <>
                    <Divider>Grant / revoke</Divider>
                    <Field
                      label="Principal"
                      hint="Type to search the workspace directory (users / groups / service principals), or enter any principal directly."
                      validationState={grPrincNote ? 'warning' : 'none'}
                      validationMessage={grPrincNote ? `Directory unavailable (${grPrincNote}) — type the principal directly.` : undefined}
                    >
                      <Combobox
                        freeform
                        value={grPrincipal}
                        selectedOptions={grPrincipal ? [grPrincipal] : []}
                        placeholder="data-engineers"
                        onChange={(e) => setGrPrincipal((e.target as HTMLInputElement).value)}
                        onOptionSelect={(_, d) => { if (d.optionValue) setGrPrincipal(d.optionValue); }}
                        expandIcon={grPrincBusy ? <Spinner size="tiny" /> : undefined}
                      >
                        {grPrincOpts.map((p) => <Option key={p.value} value={p.value} text={p.value}>{p.label}</Option>)}
                        {grPrincOpts.length === 0 && !grPrincBusy && (
                          <Option key="__none" value="" disabled text="">No directory matches — type a principal directly</Option>
                        )}
                      </Combobox>
                    </Field>
                    <div className={s.privWrap} role="group" aria-label="Privileges to grant or revoke">
                      {(UC_PRIVILEGES[grSecurable] || []).map((p) => {
                        const selected = grPrivs.has(p);
                        return (
                          <Badge
                            key={p}
                            className={s.privBadge}
                            appearance={selected ? 'filled' : 'outline'}
                            color={selected ? 'brand' : 'informative'}
                            role="checkbox"
                            aria-checked={selected}
                            tabIndex={0}
                            onClick={() => togglePriv(p)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePriv(p); } }}
                          >
                            {p}
                          </Badge>
                        );
                      })}
                    </div>
                    <div className={s.actionRow}>
                      <Button appearance="primary" onClick={() => applyGrant('add')} disabled={grBusy || !grPrincipal.trim() || grPrivs.size === 0}>Grant selected</Button>
                      <Button appearance="outline" onClick={() => applyGrant('remove')} disabled={grBusy || !grPrincipal.trim() || grPrivs.size === 0}>Revoke selected</Button>
                    </div>
                    <Caption1>PATCH <code>/api/2.1/unity-catalog/permissions/&#123;type&#125;/&#123;full_name&#125;</code> — requires object ownership / MANAGE / metastore admin.</Caption1>

                    <Divider>Change owner</Divider>
                    {grOwnerMsg && <MessageBar intent="success"><MessageBarBody>{grOwnerMsg}</MessageBarBody></MessageBar>}
                    {!ownerSupported ? (
                      <MessageBar intent="info">
                        <MessageBarBody>Ownership transfer applies to catalogs, schemas, and tables. Pick one of those securable types above.</MessageBarBody>
                      </MessageBar>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                          <Field label="New owner" style={{ flex: 1 }} hint="user email, group name, or service-principal applicationId">
                            <Input value={grOwner} onChange={(_, d) => setGrOwner(d.value)} placeholder="data-platform-admins" />
                          </Field>
                          <Button appearance="primary" onClick={transferOwner} disabled={grBusy || !grOwner.trim() || !grFullName.trim()}>
                            {grBusy ? 'Working…' : 'Transfer ownership'}
                          </Button>
                        </div>
                        <Caption1>PATCH <code>/api/2.1/unity-catalog/{grSecurable === 'CATALOG' ? 'catalogs' : grSecurable === 'SCHEMA' ? 'schemas' : 'tables'}/&#123;full_name&#125;</code> with <code>&#123; owner &#125;</code> — requires current-owner / MANAGE / metastore admin.</Caption1>
                      </>
                    )}
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setGrantsOpen(false)} disabled={grBusy}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Create volume */}
      <Dialog open={createVolumeOpen} onOpenChange={(_, d) => setCreateVolumeOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Create volume</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {volErr && <MessageBar intent="error"><MessageBarBody>{volErr}</MessageBarBody></MessageBar>}
                <div className={s.dlgRow}>
                  <Field label="Catalog" required className={s.flex1}>
                    <Dropdown value={volCatalog} selectedOptions={volCatalog ? [volCatalog] : []} onOptionSelect={(_, d) => d.optionValue && setVolCatalog(d.optionValue)} placeholder="catalog">
                      {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Schema" required className={s.flex1}>
                    {schemas.length > 0 && volCatalog === activeCatalog ? (
                      <Dropdown value={volSchema} selectedOptions={volSchema ? [volSchema] : []} onOptionSelect={(_, d) => d.optionValue && setVolSchema(d.optionValue)} placeholder="schema">
                        {schemas.map((sc) => <Option key={sc} value={sc} text={sc}>{sc}</Option>)}
                      </Dropdown>
                    ) : (
                      <Input value={volSchema} onChange={(_, d) => setVolSchema(d.value)} placeholder="schema" />
                    )}
                  </Field>
                </div>
                <Field label="Volume name" required><Input value={volName} onChange={(_, d) => setVolName(d.value)} placeholder="landing" /></Field>
                <Field label="Type">
                  <Dropdown value={volType} selectedOptions={[volType]} onOptionSelect={(_, d) => d.optionValue && setVolType(d.optionValue as 'MANAGED' | 'EXTERNAL')}>
                    <Option value="MANAGED" text="MANAGED">MANAGED</Option>
                    <Option value="EXTERNAL" text="EXTERNAL">EXTERNAL</Option>
                  </Dropdown>
                </Field>
                {volType === 'EXTERNAL' && (
                  <Field label="Storage location" required hint="abfss://… — must sit under a UC external location">
                    <Input value={volStorage} onChange={(_, d) => setVolStorage(d.value)} placeholder="abfss://container@account.dfs.core.windows.net/path" />
                  </Field>
                )}
                <Field label="Comment"><Input value={volComment} onChange={(_, d) => setVolComment(d.value)} /></Field>
                <Caption1>POST <code>/api/2.1/unity-catalog/volumes</code> — requires CREATE VOLUME + USE SCHEMA + USE CATALOG.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateVolumeOpen(false)} disabled={volBusy}>Cancel</Button>
              <Button appearance="primary" onClick={createVolume} disabled={volBusy || !volCatalog || !volSchema || !volName.trim() || (volType === 'EXTERNAL' && !volStorage.trim())}>{volBusy ? 'Creating…' : 'Create volume'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Drop catalog / schema / table / volume */}
      <Dialog open={dropOpen} onOpenChange={(_, d) => setDropOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>Drop object</DialogTitle>
            <DialogContent>
              <div className={s.dlgCol}>
                {dropErr && <MessageBar intent="error"><MessageBarBody>{dropErr}</MessageBarBody></MessageBar>}
                <MessageBar intent="warning"><MessageBarBody>Dropping a Unity Catalog object is permanent. For catalogs/schemas, <strong>force</strong> drops non-empty objects (cascades).</MessageBarBody></MessageBar>
                <Field label="Object type">
                  <Dropdown value={dropKind} selectedOptions={[dropKind]} onOptionSelect={(_, d) => { if (d.optionValue) { setDropKind(d.optionValue as DropKind); setDropErr(null); } }}>
                    {(['CATALOG', 'SCHEMA', 'TABLE', 'VOLUME'] as DropKind[]).map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Full name" required hint={dropKind === 'CATALOG' ? 'catalog' : dropKind === 'SCHEMA' ? 'catalog.schema' : 'catalog.schema.object'}>
                  <Input value={dropName} onChange={(_, d) => setDropName(d.value)} placeholder={dropKind === 'CATALOG' ? 'sales' : dropKind === 'SCHEMA' ? 'sales.bronze' : 'sales.bronze.orders'} />
                </Field>
                {(dropKind === 'CATALOG' || dropKind === 'SCHEMA') && (
                  <Switch checked={dropForce} label="force (cascade — drop even if not empty)" onChange={(_, d) => setDropForce(!!d.checked)} />
                )}
                <Caption1>DELETE <code>/api/2.1/unity-catalog/{dropKind === 'CATALOG' ? 'catalogs' : dropKind === 'SCHEMA' ? 'schemas' : dropKind === 'TABLE' ? 'tables' : 'volumes'}/&#123;name&#125;</code> — requires ownership / MANAGE.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDropOpen(false)} disabled={dropBusy}>Cancel</Button>
              <Button appearance="primary" onClick={doDrop} disabled={dropBusy || !dropName.trim()}>{dropBusy ? 'Dropping…' : `Drop ${dropKind.toLowerCase()}`}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
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

export function DatabricksSqlWarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // Unity Catalog WRITE dialog open-state (create catalog/schema/table + grants).
  const [ucCreateCatalogOpen, setUcCreateCatalogOpen] = useState(false);
  const [ucCreateSchemaOpen, setUcCreateSchemaOpen] = useState(false);
  const [ucCreateTableOpen, setUcCreateTableOpen] = useState(false);
  const [ucGrantsOpen, setUcGrantsOpen] = useState(false);
  const [ucCreateVolumeOpen, setUcCreateVolumeOpen] = useState(false);
  const [ucDropOpen, setUcDropOpen] = useState(false);
  // Query-result alerts (Databricks SQL Alerts on Comm/GCC; Azure Monitor on Gov).
  const [alertsOpen, setAlertsOpen] = useState(false);
  // UC column-mask + row-filter wizards (granular security beyond object grants).
  const [ucSecOpen, setUcSecOpen] = useState(false);
  // AI functions helper (sentiment/classify/translate/summarize/extract).
  const [aiFnOpen, setAiFnOpen] = useState(false);
  // Last table the user clicked in the tree — context for the AI functions SQL.
  const [aiTable, setAiTable] = useState<string>('');
  // Visual (no-code) query canvas — Power-Query diagram-view parity (Spark SQL).
  const [vqOpen, setVqOpen] = useState(false);

  // Statistics & maintenance dialog (ANALYZE / OPTIMIZE) for a selected table.
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsTarget, setStatsTarget] = useState<{ catalog: string; schema: string; table: string } | null>(null);

  const [sqlText0] = useState<string>(
    `-- Databricks SQL Warehouse — Unity Catalog.\n-- Click a table on the left to insert a SELECT.\n-- Tip: highlight part of the script and Run to execute only the selection.\nSELECT current_catalog() AS catalog, current_database() AS schema, current_user() AS upn;`,
  );
  // Multi-tab query state (run-selection + cancel are wired per active tab).
  const { tabs, activeTabId, activeTab, setActiveTabId, addTab, closeTab, patchTab, setActiveSql, setActiveResult } =
    useSqlTabs<QueryResponse>(sqlText0);
  const sqlText = activeTab.sql;
  const setSqlText = setActiveSql;
  const result = activeTab.result;
  const loading = activeTab.loading;
  const setResult = setActiveResult;
  // Monaco editor instance (for run-selection) + schema cache (for IntelliSense).
  const editorRef = useRef<any>(null);
  const schemaCacheRef = useRef<SqlSchemaCache>(createEmptyCache());
  const [canceling, setCanceling] = useState(false);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [warehouseState, setWarehouseState] = useState<WarehouseState | null>(null);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [activeCatalog, setActiveCatalog] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [views, setViews] = useState<string[]>([]);
  const [functions, setFunctions] = useState<string[]>([]);
  // Query parameters auto-detected from {{name}} tokens + chart-visualize toggle.
  const [queryParams, setQueryParams] = useState<QueryParam[]>([]);
  const [showViz, setShowViz] = useState(false);
  const [starting, setStarting] = useState(false);
  // Query | Model — Loom-native Model view; relationships become real Unity
  // Catalog FK constraints. No Power BI dependency.
  const [editorTab, setEditorTab] = useState<'query' | 'model' | 'monitoring' | 'lineage'>('query');
  const [warehousesError, setWarehousesError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Capture the Monaco editor + register schema-aware IntelliSense once mounted.
  const handleEditorReady = useCallback((ed: any, mc: any) => {
    editorRef.current = ed;
    registerSqlIntelliSense(mc, 'sql', () => schemaCacheRef.current);
  }, []);

  // ---- Edit / scale dialog (POST /api/2.0/sql/warehouses/{id}/edit) ----
  const [editOpen, setEditOpen] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSize, setEditSize] = useState('X-Small');
  const [editMinClusters, setEditMinClusters] = useState(1);
  const [editMaxClusters, setEditMaxClusters] = useState(1);
  const [editAutoStop, setEditAutoStop] = useState(10);
  const [editType, setEditType] = useState<'PRO' | 'CLASSIC'>('PRO');
  const [editServerless, setEditServerless] = useState(false);

  // ---- Boundary flag (Comm/GCC → Databricks; Gov → Synapse Dedicated pool) ----
  const [gov, setGov] = useState(false);

  // ---- Create dialog (POST .../create) ----
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createSize, setCreateSize] = useState('Small');
  const [createType, setCreateType] = useState<'PRO' | 'CLASSIC'>('PRO');
  const [createServerless, setCreateServerless] = useState(false);
  const [createPhoton, setCreatePhoton] = useState(true);
  const [createChannel, setCreateChannel] = useState<'CHANNEL_NAME_CURRENT' | 'CHANNEL_NAME_PREVIEW'>('CHANNEL_NAME_CURRENT');
  const [createAutoStop, setCreateAutoStop] = useState(10);
  const [createMinClusters, setCreateMinClusters] = useState(1);
  const [createMaxClusters, setCreateMaxClusters] = useState(1);
  const [createTagsText, setCreateTagsText] = useState('');
  const [createSpotPolicy, setCreateSpotPolicy] = useState<'COST_OPTIMIZED' | 'RELIABILITY_OPTIMIZED'>('COST_OPTIMIZED');
  // Gov-only: Synapse Dedicated pool DWU SKU.
  const [createGovSku, setCreateGovSku] = useState('DW100c');

  // ---- Delete confirm dialog (POST .../delete) ----
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---- Save as table (CTAS) dialog — CREATE TABLE … USING DELTA AS SELECT … ----
  const [ctasOpen, setCtasOpen] = useState(false);
  const [ctasCatalog, setCtasCatalog] = useState('');
  const [ctasSchema, setCtasSchema] = useState('');
  const [ctasName, setCtasName] = useState('');
  const [ctasBusy, setCtasBusy] = useState(false);
  const [ctasError, setCtasError] = useState<string | null>(null);
  const [ctasReceipt, setCtasReceipt] = useState<string | null>(null);

  // ---- Clone table dialog — CREATE [OR REPLACE] TABLE … [SHALLOW|DEEP] CLONE … ----
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState('');
  const [cloneTarget, setCloneTarget] = useState('');
  const [cloneKind, setCloneKind] = useState<'SHALLOW' | 'DEEP'>('SHALLOW');
  const [cloneReplace, setCloneReplace] = useState(false);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneReceipt, setCloneReceipt] = useState<string | null>(null);

  // ---- Initial: load warehouses, pick first, fetch state ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/warehouses`);
        const j = await r.json();
        if (cancelled) return;
        if (typeof j.gov === 'boolean') setGov(j.gov);
        if (!j.ok) {
          setWarehousesError(j.error || `HTTP ${r.status}`);
          return;
        }
        const list = (j.warehouses || []) as Warehouse[];
        setWarehouses(list);
        if (list.length > 0 && !warehouseId) setWarehouseId(list[0].id);
      } catch (e: any) {
        if (!cancelled) setWarehousesError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- State + catalogs whenever warehouse changes ----
  const refreshState = useCallback(async (): Promise<WarehouseState | null> => {
    if (!warehouseId) return null;
    const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/state?warehouseId=${encodeURIComponent(warehouseId)}`);
    const j = (await r.json()) as WarehouseState;
    setWarehouseState(j);
    return j;
  }, [id, warehouseId]);

  const refreshCatalogs = useCallback(async () => {
    if (!warehouseId) return;
    const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}`);
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) {
      setCatalogs(j.catalogs || []);
      schemaCacheRef.current.catalogs = j.catalogs || [];
    }
  }, [id, warehouseId]);

  useEffect(() => {
    if (!warehouseId) return;
    setActiveCatalog(null);
    setActiveSchema(null);
    setSchemas([]);
    setTables([]);
    setViews([]);
    setFunctions([]);
    refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
  }, [warehouseId, refreshState, refreshCatalogs]);

  // ---- Schema drill-down ----
  const openCatalog = useCallback(async (cat: string) => {
    if (!warehouseId) return;
    setActiveCatalog(cat);
    setActiveSchema(null);
    setSchemas([]);
    setTables([]);
    setViews([]);
    setFunctions([]);
    const r = await fetch(
      `/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}`,
    );
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) {
      setSchemas(j.schemas || []);
      schemaCacheRef.current.schemas.set(cat, j.schemas || []);
    }
  }, [id, warehouseId]);

  const openSchema = useCallback(async (cat: string, sch: string) => {
    if (!warehouseId) return;
    setActiveSchema(sch);
    setTables([]);
    setViews([]);
    setFunctions([]);
    const r = await fetch(
      `/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}&schema=${encodeURIComponent(sch)}`,
    );
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) {
      setTables(j.tables || []);
      schemaCacheRef.current.tables.set(`${cat}.${sch}`, j.tables || []);
      setViews(j.views || []);
      setFunctions(j.functions || []);
    }
  }, [id, warehouseId]);

  // Fetch a table's columns (DESCRIBE TABLE) into the IntelliSense cache so
  // typing `catalog.schema.table.` suggests real column names.
  const cacheColumns = useCallback(async (cat: string, sch: string, tbl: string) => {
    if (!warehouseId) return;
    try {
      const r = await fetch(
        `/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}&schema=${encodeURIComponent(sch)}&table=${encodeURIComponent(tbl)}`,
      );
      const j = (await r.json()) as SchemaResponse & { columns?: string[] };
      if (j.ok && j.columns) schemaCacheRef.current.columns.set(`${cat}.${sch}.${tbl}`, j.columns);
    } catch { /* completions are best-effort */ }
  }, [id, warehouseId]);

  // Script-out (Databricks): load CREATE (SHOW CREATE …) / DROP into the editor.
  const dbxLoadScript = useCallback(async (
    cat: string, sch: string, name: string, type: 'view' | 'function', mode: 'create' | 'drop',
  ) => {
    if (!warehouseId) { setResult({ ok: false, error: 'No warehouse selected.' }); return; }
    const params = new URLSearchParams({ warehouseId, catalog: cat, schema: sch, name, type, mode });
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/script-out?${params.toString()}`);
      const j = await r.json();
      if (j.ok && typeof j.script === 'string') { setSqlText(j.script); setResult(null); }
      else setResult({ ok: false, error: j.error || `HTTP ${r.status}` });
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, warehouseId]);

  // Lazy row count for a Databricks view via the real /query route.
  const dbxCountRows = useCallback(async (cat: string, sch: string, name: string): Promise<number | null> => {
    if (!warehouseId) return null;
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: `SELECT COUNT(*) AS c FROM \`${cat}\`.\`${sch}\`.\`${name}\``,
          warehouseId, catalog: cat, schema: sch,
        }),
      });
      const j = await r.json();
      const v = j?.ok ? j?.rows?.[0]?.[0] : null;
      return v == null ? null : Number(v);
    } catch { return null; }
  }, [id, warehouseId]);

  // ---- Start / Stop with poll ----
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(async () => {
      const st = await refreshState();
      if (st?.state === 'RUNNING' || st?.state === 'STOPPED') {
        if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
        setStarting(false);
        if (st.state === 'RUNNING') refreshCatalogs();
      }
    }, 5_000);
  }, [refreshState, refreshCatalogs]);

  const start = useCallback(async () => {
    if (!warehouseId) return;
    setStarting(true);
    try {
      await fetch(`/api/items/databricks-sql-warehouse/${id}/start?warehouseId=${encodeURIComponent(warehouseId)}`, { method: 'POST' });
      startPolling();
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
      setStarting(false);
    }
  }, [id, warehouseId, startPolling]);

  const stop = useCallback(async () => {
    if (!warehouseId) return;
    await fetch(`/api/items/databricks-sql-warehouse/${id}/state?warehouseId=${encodeURIComponent(warehouseId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    refreshState();
  }, [id, warehouseId, refreshState]);

  // ---- Edit / scale: pre-fill from the live warehouse, then POST /edit ----
  const openEdit = useCallback(async () => {
    if (!warehouseId) return;
    setEditError(null);
    // Pull current size/scaling/type/serverless so the dialog starts from
    // the real warehouse config (state route surfaces these).
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/state?warehouseId=${encodeURIComponent(warehouseId)}`);
      const j = (await r.json()) as WarehouseState;
      if (j.ok) {
        if (j.cluster_size) setEditSize(j.cluster_size);
        if (typeof j.min_num_clusters === 'number') setEditMinClusters(j.min_num_clusters);
        if (typeof j.max_num_clusters === 'number') setEditMaxClusters(j.max_num_clusters);
        if (typeof j.auto_stop_mins === 'number') setEditAutoStop(j.auto_stop_mins);
        setEditType(j.warehouse_type === 'CLASSIC' ? 'CLASSIC' : 'PRO');
        setEditServerless(!!j.serverless);
      }
    } catch { /* dialog still opens with defaults */ }
    setEditOpen(true);
  }, [id, warehouseId]);

  const saveEdit = useCallback(async () => {
    if (!warehouseId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/edit?warehouseId=${encodeURIComponent(warehouseId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cluster_size: editSize,
          min_num_clusters: editMinClusters,
          max_num_clusters: editMaxClusters,
          auto_stop_mins: editAutoStop,
          warehouse_type: editType,
          enable_serverless_compute: editServerless,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setEditError(j.error || `HTTP ${r.status}`); return; }
      setEditOpen(false);
      await refreshState();
    } catch (e: any) {
      setEditError(e?.message || String(e));
    } finally {
      setEditBusy(false);
    }
  }, [id, warehouseId, editSize, editMinClusters, editMaxClusters, editAutoStop, editType, editServerless, refreshState]);

  // ---- Create warehouse (Comm/GCC → Databricks; Gov → Synapse Dedicated pool) ----
  const saveCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name) { setCreateError('Name is required.'); return; }
    setCreateBusy(true);
    setCreateError(null);
    try {
      const payload: Record<string, unknown> = { name };
      if (gov) {
        payload.gov_sku = createGovSku;
      } else {
        payload.cluster_size = createSize;
        payload.warehouse_type = createServerless ? 'PRO' : createType;
        payload.enable_serverless_compute = createServerless;
        payload.enable_photon = createPhoton;
        payload.channel = createChannel;
        payload.auto_stop_mins = createAutoStop;
        payload.min_num_clusters = createMinClusters;
        payload.max_num_clusters = createMaxClusters;
        payload.spot_instance_policy = createSpotPolicy;
        // "key=value" per line → { key: value }
        const tags: Record<string, string> = {};
        for (const line of createTagsText.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          const eq = t.indexOf('=');
          if (eq <= 0) continue;
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim();
          if (k && v) tags[k] = v;
        }
        if (Object.keys(tags).length > 0) payload.tags = tags;
      }
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) { setCreateError(j.error || `HTTP ${r.status}`); return; }
      const newId = j.id as string;
      setWarehouses((prev) => [
        ...prev,
        { id: newId, name: j.name || name, state: 'STARTING', cluster_size: gov ? createGovSku : createSize } as Warehouse,
      ]);
      setWarehouseId(newId);
      setCreateOpen(false);
      // Poll the new resource to RUNNING/Online so the badge reflects reality.
      startPolling();
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setCreateBusy(false);
    }
  }, [id, gov, createName, createSize, createType, createServerless, createPhoton, createChannel, createAutoStop, createMinClusters, createMaxClusters, createTagsText, createSpotPolicy, createGovSku, startPolling]);

  // ---- Delete warehouse (running-state guard enforced server-side: 409) ----
  const confirmDelete = useCallback(async (force = false) => {
    if (!warehouseId) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouseId, force }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'warehouse_running') {
          setDeleteError(`${j.error} Stop it first, or use "Force delete".`);
        } else {
          setDeleteError(j.error || `HTTP ${r.status}`);
        }
        return;
      }
      setWarehouses((prev) => {
        const next = prev.filter((w) => w.id !== warehouseId);
        setWarehouseId(next[0]?.id || '');
        return next;
      });
      setWarehouseState(null);
      setDeleteOpen(false);
    } catch (e: any) {
      setDeleteError(e?.message || String(e));
    } finally {
      setDeleteBusy(false);
    }
  }, [id, warehouseId]);

  // ---- Run query (run-selection + cancel-aware) ----
  const run = useCallback(async () => {
    if (!warehouseId) {
      setResult({ ok: false, error: 'No warehouse selected.' });
      return;
    }
    // Run-selection: if text is highlighted, execute only that.
    const sqlToRun = getRunSql(editorRef, sqlText);
    if (!sqlToRun.trim()) return;
    const tabId = activeTabId;
    const clientQueryId = `dbx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    patchTab(tabId, { loading: true, result: null, queryId: clientQueryId });
    try {
      // Rewrite {{name}} → :name and pass values out-of-band in parameters[]
      // (Databricks binds them — never concatenated, so injection-safe).
      const statement = substituteDbx(sqlToRun, queryParams);
      const res = await fetch(`/api/items/databricks-sql-warehouse/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: statement,
          warehouseId,
          catalog: activeCatalog || undefined,
          schema: activeSchema || undefined,
          parameters: queryParams,
          clientQueryId,
        }),
      });
      const json = (await res.json()) as QueryResponse;
      if (res.status === 409 && json.state) {
        patchTab(tabId, { result: { ok: false, error: `Warehouse is ${json.state}. Click Start.` } });
        refreshState();
      } else {
        patchTab(tabId, { result: json });
      }
    } catch (e: any) {
      patchTab(tabId, { result: { ok: false, error: e?.message || String(e) } });
    } finally {
      patchTab(tabId, { loading: false, queryId: undefined });
      setCanceling(false);
    }
  }, [id, sqlText, warehouseId, activeCatalog, activeSchema, queryParams, refreshState, activeTabId, patchTab, setResult]);

  // ---- Cancel the active tab's in-flight statement ----
  const cancel = useCallback(async () => {
    const qid = activeTab.queryId;
    if (!qid) return;
    setCanceling(true);
    try {
      await fetch(`/api/items/databricks-sql-warehouse/${id}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientQueryId: qid }),
      });
    } catch { /* the query promise resolves to canceled regardless */ }
  }, [id, activeTab.queryId]);

  // Open-in-Excel — download a .iqy web-query for the current SQL + warehouse
  // (and tree context). Excel refreshes by POSTing back to the warehouse
  // /query route, which re-executes via the Databricks Statement Execution API.
  const openInExcel = useCallback(async () => {
    if (!warehouseId || !sqlText.trim()) return;
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/iqy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: sqlText,
          warehouseId,
          ...(activeCatalog && { catalog: activeCatalog }),
          ...(activeSchema && { schema: activeSchema }),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-databricks-${id}.iqy`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, sqlText, warehouseId, activeCatalog, activeSchema]);

  const state = warehouseState?.state || 'UNKNOWN';
  const isRunning = state === 'RUNNING';
  const selectedWarehouse = useMemo(
    () => warehouses.find((w) => w.id === warehouseId) || null,
    [warehouses, warehouseId],
  );

  const newSql = useCallback(() => {
    setSqlText('-- New SQL.\nSELECT current_catalog() AS catalog, current_database() AS schema;');
    setResult(null);
  }, []);

  // Query history dialog state — paginates /api/2.0/sql/history/queries
  interface QHEntry {
    query_id: string;
    status: string;
    query_text?: string;
    query_start_time_ms?: number;
    duration?: number;
    user_name?: string;
    rows_produced?: number;
    error_message?: string;
  }
  interface QueryProfileMetrics {
    compilation_time_ms?: number;
    execution_time_ms?: number;
    photon_total_time_ms?: number;
    total_time_ms?: number;
    result_fetch_time_ms?: number;
    read_bytes?: number;
    read_remote_bytes?: number;
    read_cache_bytes?: number;
    write_remote_bytes?: number;
    network_sent_bytes?: number;
    spill_to_disk_bytes?: number;
    rows_read_count?: number;
    rows_produced_count?: number;
    read_files_count?: number;
    read_partitions_count?: number;
    pruned_files_count?: number;
  }
  interface QueryProfile {
    query_id: string;
    status: string;
    query_text?: string;
    duration?: number;
    error_message?: string;
    spark_ui_url?: string;
    statement_type?: string;
    metrics?: QueryProfileMetrics;
    photon_coverage_pct?: number | null;
    plans_state?: string;
    plans?: unknown;
  }
  const [qhOpen, setQhOpen] = useState(false);
  const [qhEntries, setQhEntries] = useState<QHEntry[]>([]);
  const [qhBusy, setQhBusy] = useState(false);
  const [qhError, setQhError] = useState<string | null>(null);
  const [qhNext, setQhNext] = useState<string | null>(null);

  // Query-profile drawer — opened from a history row's "Profile" button.
  // Renders the real per-query metrics (IO / Photon) + Spark-plan deep-link
  // from /api/2.0/sql/history/queries/{id}?include_metrics=true.
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileData, setProfileData] = useState<QueryProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const openProfile = useCallback(async (queryId: string) => {
    setProfileOpen(true);
    setProfileBusy(true);
    setProfileError(null);
    setProfileData(null);
    try {
      const r = await fetch(
        `/api/items/databricks-sql-warehouse/${id}/query-profile?queryId=${encodeURIComponent(queryId)}`,
      );
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setProfileData(j as QueryProfile);
    } catch (e: any) { setProfileError(e?.message || String(e)); }
    finally { setProfileBusy(false); }
  }, [id]);

  const loadQueryHistory = useCallback(async (append = false, pageToken?: string) => {
    setQhBusy(true); setQhError(null);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      params.set('maxResults', '50');
      if (pageToken) params.set('pageToken', pageToken);
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/query-history?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setQhEntries((prev) => append ? [...prev, ...(j.entries || [])] : (j.entries || []));
      setQhNext(j.nextPageToken || null);
    } catch (e: any) { setQhError(e?.message || String(e)); }
    finally { setQhBusy(false); }
  }, [id, warehouseId]);

  const openQueryHistory = useCallback(() => {
    setQhOpen(true);
    loadQueryHistory(false);
  }, [loadQueryHistory]);
  const refreshAll = useCallback(() => {
    refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
  }, [refreshState, refreshCatalogs]);
  const canStart = !!warehouseId && !starting && (state === 'STOPPED' || state === 'STOPPING' || state === 'UNKNOWN');
  const canStop = !!warehouseId && isRunning;
  const canRun = !!warehouseId && isRunning && !loading;
  // Re-list the tree level a UC write touched, so created catalogs/schemas/
  // tables appear immediately. Re-runs the deepest active query.
  const ucChanged = useCallback(() => {
    if (activeCatalog && activeSchema) { void openSchema(activeCatalog, activeSchema); }
    else if (activeCatalog) { void openCatalog(activeCatalog); }
    void refreshCatalogs();
  }, [activeCatalog, activeSchema, openCatalog, openSchema, refreshCatalogs]);

  // Tables drilled-down in the UC tree → {schema, table} for the visual-query
  // Add-table picker. (Spark SQL session catalog/schema come from props.)
  const vqSourceTables = useMemo<VqSourceTable[]>(
    () => tables.map((t) => ({ schema: activeSchema || undefined, table: t })),
    [tables, activeSchema],
  );

  // ---- Save as table (CTAS) ----
  const openCtas = useCallback(() => {
    setCtasCatalog(activeCatalog || catalogs[0] || '');
    setCtasSchema(activeSchema || '');
    setCtasName('');
    setCtasError(null);
    setCtasReceipt(null);
    setCtasOpen(true);
  }, [activeCatalog, activeSchema, catalogs]);

  const submitCtas = useCallback(async () => {
    if (!ctasName.trim()) { setCtasError('table name required'); return; }
    if (!ctasCatalog.trim()) { setCtasError('catalog required'); return; }
    if (!ctasSchema.trim()) { setCtasError('schema required'); return; }
    const cleaned = sqlText.trim().replace(/;+\s*$/, '');
    if (!/^select\b/i.test(cleaned)) {
      setCtasError('CTAS requires the editor to contain a SELECT statement.');
      return;
    }
    setCtasBusy(true); setCtasError(null);
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/ctas`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouseId, sql: cleaned, catalog: ctasCatalog.trim(), schema: ctasSchema.trim(), tableName: ctasName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCtasError(j.error || `HTTP ${r.status}`); return; }
      setCtasOpen(false);
      setCtasReceipt(`Delta table created: ${j.table} (${j.executionMs}ms). Queryable in Unity Catalog.`);
      ucChanged();
    } catch (e: any) { setCtasError(e?.message || String(e)); }
    finally { setCtasBusy(false); }
  }, [id, warehouseId, sqlText, ctasCatalog, ctasSchema, ctasName, ucChanged]);

  // ---- Clone table (SHALLOW = zero-copy / DEEP = full copy) ----
  const openCloneForTable = useCallback((fqn: string) => {
    setCloneSource(fqn);
    setCloneTarget('');
    setCloneKind('SHALLOW');
    setCloneReplace(false);
    setCloneError(null);
    setCloneReceipt(null);
    setCloneOpen(true);
  }, []);

  const submitClone = useCallback(async () => {
    if (!cloneSource.trim() || !cloneTarget.trim()) { setCloneError('source and target are required'); return; }
    setCloneBusy(true); setCloneError(null);
    try {
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/clone`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouseId, source: cloneSource.trim(), target: cloneTarget.trim(), cloneType: cloneKind, replace: cloneReplace }),
      });
      const j = await r.json();
      if (!j.ok) { setCloneError(j.error || `HTTP ${r.status}`); return; }
      setCloneOpen(false);
      setCloneReceipt(
        cloneKind === 'SHALLOW'
          ? `Shallow clone created: ${j.target} — zero-copy, ${j.numCopiedFiles} data files duplicated (source has ${j.sourceNumFiles}). (${j.executionMs}ms)`
          : `Deep clone created: ${j.target} — ${j.numCopiedFiles} data files copied, independent of source. (${j.executionMs}ms)`,
      );
      ucChanged();
    } catch (e: any) { setCloneError(e?.message || String(e)); }
    finally { setCloneBusy(false); }
  }, [id, warehouseId, cloneSource, cloneTarget, cloneKind, cloneReplace, ucChanged]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: newSql },
        { label: 'New visual query', onClick: () => setVqOpen(true), title: 'Build a query visually (Power Query diagram view) — compiles to Spark SQL' },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'AI functions', onClick: () => setAiFnOpen(true), title: 'Sentiment / classify / translate / summarize / extract over a text column (Databricks ai_query() or Azure OpenAI)' },
        { label: 'Save as table', onClick: canRun && sqlText.trim() ? openCtas : undefined,
          disabled: !canRun || !sqlText.trim(),
          title: !canRun ? 'Start the warehouse first' : !sqlText.trim() ? 'Enter a SELECT first' : 'CTAS — CREATE TABLE … USING DELTA AS SELECT …' },
        { label: 'Open in Excel', onClick: sqlText.trim() && warehouseId ? openInExcel : undefined, disabled: !sqlText.trim() || !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : 'Download a .iqy web-query — refresh in Excel to re-execute against the warehouse' },
        { label: 'Query history', onClick: warehouseId ? openQueryHistory : undefined, disabled: !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : undefined },
      ]},
      { label: 'Warehouse', actions: [
        { label: 'Create', onClick: () => { setCreateError(null); setCreateOpen(true); }, title: gov ? 'Create a new Synapse Dedicated SQL pool' : 'Create a new SQL Warehouse' },
        { label: 'Delete', onClick: warehouseId ? () => { setDeleteError(null); setDeleteOpen(true); } : undefined, disabled: !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : 'Permanently delete this warehouse' },
        { label: starting ? 'Starting…' : 'Start', onClick: canStart ? start : undefined, disabled: !canStart },
        { label: 'Stop', onClick: canStop ? stop : undefined, disabled: !canStop },
        { label: 'Edit', onClick: warehouseId ? openEdit : undefined, disabled: !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : 'Change size, scaling, auto-stop, type, serverless' },
        { label: 'Connection details', onClick: warehouseId ? () => setConnOpen(true) : undefined, disabled: !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : 'Server hostname, HTTP path, JDBC URL + CLI snippet (copy)' },
        { label: 'Refresh', onClick: warehouseId ? refreshAll : undefined, disabled: !warehouseId },
      ]},
      { label: 'Unity Catalog', actions: [
        { label: 'Create catalog', onClick: () => setUcCreateCatalogOpen(true), title: 'Create a UC catalog (api 2.1 — requires CREATE CATALOG on the metastore)' },
        { label: 'Create schema', onClick: () => setUcCreateSchemaOpen(true), title: 'Create a UC schema under a catalog' },
        { label: 'Create table', onClick: () => setUcCreateTableOpen(true), title: 'Create a managed/external UC table' },
        { label: 'Create volume', onClick: () => setUcCreateVolumeOpen(true), title: 'Create a managed/external UC volume (api 2.1)' },
        { label: 'Drop object', onClick: () => setUcDropOpen(true), title: 'Drop a UC catalog / schema / table / volume (DELETE api 2.1)' },
        { label: 'Clone table', onClick: canRun ? () => openCloneForTable(
            activeCatalog && activeSchema && tables.length > 0
              ? `${activeCatalog}.${activeSchema}.${tables[0]}`
              : '',
          ) : undefined, disabled: !canRun, title: !canRun ? 'Start the warehouse first' : 'SHALLOW (zero-copy) or DEEP CLONE a Delta table' },
        { label: 'Manage grants', onClick: () => setUcGrantsOpen(true), title: 'View / grant / revoke UC privileges' },
        { label: 'Column & row security', onClick: () => setUcSecOpen(true), title: 'Unity Catalog column masks + row filters (Commercial / GCC)' },
      ]},
      { label: 'Modeling', actions: [
        // Loom-native Model view — relationships become real UC FK constraints.
        { label: 'Model view', onClick: () => setEditorTab('model') },
      ]},
      { label: 'Alerts', actions: [
        { label: 'Alerts', onClick: () => setAlertsOpen(true), title: 'Query-result alerts — query + condition + schedule + notification (Databricks SQL Alerts)' },
      ]},
      { label: 'Maintenance', actions: [
        {
          label: 'Statistics & maintenance',
          onClick: statsTarget ? () => setStatsOpen(true) : undefined,
          disabled: !statsTarget,
          title: statsTarget
            ? `ANALYZE / OPTIMIZE ${statsTarget.catalog}.${statsTarget.schema}.${statsTarget.table}`
            : 'Select a table in the catalog tree first',
        },
      ]},
    ]},
  ], [newSql, loading, canRun, run, starting, canStart, start, canStop, stop, refreshAll, warehouseId, openQueryHistory, openEdit, gov, sqlText, openCtas, openCloneForTable, activeCatalog, activeSchema, tables, openInExcel, statsTarget]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
            <Tooltip content="Create catalog (UC REST)" relationship="label">
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setUcCreateCatalogOpen(true)}>Catalog</Button>
            </Tooltip>
            <Tooltip content="Create schema (UC REST)" relationship="label">
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setUcCreateSchemaOpen(true)}>Schema</Button>
            </Tooltip>
            <Tooltip content="Create table (UC REST)" relationship="label">
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setUcCreateTableOpen(true)}>Table</Button>
            </Tooltip>
            <Tooltip content="Create volume (UC REST)" relationship="label">
              <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={() => setUcCreateVolumeOpen(true)}>Volume</Button>
            </Tooltip>
            <Tooltip content="Manage grants (UC permissions)" relationship="label">
              <Button size="small" appearance="outline" icon={<Key20Regular />} onClick={() => setUcGrantsOpen(true)} aria-label="Manage grants" />
            </Tooltip>
            <Tooltip content="Drop object (UC REST)" relationship="label">
              <Button size="small" appearance="outline" icon={<Delete20Regular />} onClick={() => setUcDropOpen(true)} aria-label="Drop object" />
            </Tooltip>
          </div>
          <Tree aria-label="Unity Catalog" defaultOpenItems={['catalogs']}>
            <TreeItem itemType="branch" value="catalogs">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Catalogs ({catalogs.length})
              </TreeItemLayout>
              <Tree>
                {!isRunning && (
                  <TreeItem itemType="leaf" value="stopped">
                    <TreeItemLayout>Warehouse {state.toLowerCase()} — start to browse</TreeItemLayout>
                  </TreeItem>
                )}
                {isRunning && catalogs.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No catalogs visible to this principal.</TreeItemLayout>
                  </TreeItem>
                )}
                {catalogs.map((c) => (
                  <TreeItem
                    key={c}
                    itemType="branch"
                    value={`c-${c}`}
                    onClick={() => openCatalog(c)}
                  >
                    <TreeItemLayout iconBefore={<Folder20Regular />}>
                      {c} {activeCatalog === c && '·'}
                    </TreeItemLayout>
                    <Tree>
                      {activeCatalog === c && schemas.length === 0 && (
                        <TreeItem itemType="leaf" value={`c-${c}-empty`}>
                          <TreeItemLayout>(loading schemas…)</TreeItemLayout>
                        </TreeItem>
                      )}
                      {activeCatalog === c && schemas.map((sch) => (
                        <TreeItem
                          key={`${c}.${sch}`}
                          itemType="branch"
                          value={`s-${c}.${sch}`}
                          onClick={(e) => { e.stopPropagation(); openSchema(c, sch); }}
                        >
                          <TreeItemLayout iconBefore={<Folder20Regular />}>
                            {sch} {activeSchema === sch && '·'}
                          </TreeItemLayout>
                          <Tree>
                            {activeSchema === sch && tables.length === 0 && (
                              <TreeItem itemType="leaf" value={`t-${c}.${sch}-empty`}>
                                <TreeItemLayout>(no tables)</TreeItemLayout>
                              </TreeItem>
                            )}
                            {activeSchema === sch && tables.map((t) => (
                              <TreeItem
                                key={`${c}.${sch}.${t}`}
                                itemType="leaf"
                                value={`t-${c}.${sch}.${t}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setStatsTarget({ catalog: c, schema: sch, table: t });
                                  setAiTable(`\`${c}\`.\`${sch}\`.\`${t}\``);
                                  setSqlText(`SELECT * FROM \`${c}\`.\`${sch}\`.\`${t}\` LIMIT 100;`);
                                  void cacheColumns(c, sch, t);
                                }}
                              >
                                <TreeItemLayout
                                  iconBefore={<DocumentTable20Regular />}
                                  actions={
                                    <>
                                      <Tooltip content={`Lineage: ${t}`} relationship="label">
                                        <Button
                                          size="small" appearance="subtle" icon={<Organization20Regular />}
                                          aria-label={`Lineage ${t}`}
                                          onClick={(e) => { e.stopPropagation(); setStatsTarget({ catalog: c, schema: sch, table: t }); setEditorTab('lineage'); }}
                                        />
                                      </Tooltip>
                                      <Tooltip content={`Clone ${t}`} relationship="label">
                                        <Button
                                          size="small" appearance="subtle" icon={<Copy20Regular />}
                                          aria-label={`Clone ${t}`}
                                          onClick={(e) => { e.stopPropagation(); openCloneForTable(`${c}.${sch}.${t}`); }}
                                        />
                                      </Tooltip>
                                    </>
                                  }
                                >
                                  {t}
                                </TreeItemLayout>
                              </TreeItem>
                            ))}
                            {/* Views */}
                            {activeSchema === sch && views.map((v) => (
                              <TreeItem
                                key={`v-${c}.${sch}.${v}`}
                                itemType="leaf"
                                value={`v-${c}.${sch}.${v}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSqlText(`SELECT * FROM \`${c}\`.\`${sch}\`.\`${v}\` LIMIT 100;`);
                                }}
                              >
                                <TreeItemLayout iconBefore={<Eye20Regular />}
                                  actions={<SqlObjectScriptMenu name={`${sch}.${v}`}
                                    onScriptCreate={() => dbxLoadScript(c, sch, v, 'view', 'create')}
                                    onScriptDrop={() => dbxLoadScript(c, sch, v, 'view', 'drop')} />}>
                                  {v}{' '}
                                  <SqlRowCountBadge cacheKey={`v-${c}.${sch}.${v}`} load={() => dbxCountRows(c, sch, v)} />
                                </TreeItemLayout>
                              </TreeItem>
                            ))}
                            {/* User functions */}
                            {activeSchema === sch && functions.map((f) => (
                              <TreeItem
                                key={`f-${c}.${sch}.${f}`}
                                itemType="leaf"
                                value={`f-${c}.${sch}.${f}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSqlText(`-- Unity Catalog function\nDESCRIBE FUNCTION EXTENDED \`${c}\`.\`${sch}\`.\`${f}\`;`);
                                }}
                              >
                                <TreeItemLayout iconBefore={<MathFormula20Regular />}
                                  actions={<SqlObjectScriptMenu name={`${sch}.${f}`}
                                    onScriptCreate={() => dbxLoadScript(c, sch, f, 'function', 'create')}
                                    onScriptDrop={() => dbxLoadScript(c, sch, f, 'function', 'drop')} />}>
                                  {f}
                                </TreeItemLayout>
                              </TreeItem>
                            ))}
                          </Tree>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={editorTab} onTabSelect={(_, d) => setEditorTab(d.value as 'query' | 'model' | 'monitoring' | 'lineage')}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="model" icon={<Flowchart20Regular />}>Model</Tab>
            <Tab value="lineage" icon={<Organization20Regular />}>Lineage</Tab>
            <Tab value="monitoring" icon={<DataBarVertical20Regular />}>Monitoring</Tab>
          </TabList>
          {editorTab === 'monitoring' && (
            <WarehouseMonitoringTab itemId={id} engine="databricks-sql-warehouse" warehouseId={warehouseId || undefined} />
          )}
          {editorTab === 'lineage' && (
            <UcLineagePanel
              fullName={statsTarget ? `${statsTarget.catalog}.${statsTarget.schema}.${statsTarget.table}` : null}
            />
          )}
          {editorTab === 'model' && (
            <ModelViewPanel
              engine="databricks-sql-warehouse"
              id={id}
              query={{ warehouseId, catalog: activeCatalog || undefined, schema: activeSchema || undefined }}
              ready={isRunning && !!activeCatalog && !!activeSchema}
              measureKind="cosmos"
              notReadyMessage={
                !isRunning ? 'Start the warehouse to load tables.'
                  : (!activeCatalog || !activeSchema) ? 'Open a catalog and schema in the left tree to load its tables into the Model view.'
                  : undefined
              }
              onUseInQuery={(sql) => { setSqlText(sql); setResult(null); setEditorTab('query'); }}
            />
          )}
          {editorTab === 'query' && (
          <>
          {warehousesError && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not list warehouses</MessageBarTitle>
                {warehousesError}
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Dropdown
              aria-label="Warehouse"
              placeholder="Select warehouse"
              value={selectedWarehouse?.name || ''}
              selectedOptions={warehouseId ? [warehouseId] : []}
              onOptionSelect={(_, data) => { if (data.optionValue) setWarehouseId(data.optionValue); }}
              disabled={warehouses.length === 0}
              style={{ minWidth: 240 }}
            >
              {warehouses.map((w) => (
                <Option key={w.id} value={w.id} text={w.name}>
                  {w.name} {w.cluster_size ? `· ${w.cluster_size}` : ''}
                </Option>
              ))}
            </Dropdown>
            <Badge appearance="filled" color={stateColor(state)}>{state}</Badge>
            {warehouseState?.cluster_size && (
              <Badge appearance="outline">{warehouseState.cluster_size}</Badge>
            )}
            {warehouseState?.serverless && (
              <Badge appearance="outline" color="brand">Serverless</Badge>
            )}
            {(state === 'STOPPED' || state === 'STOPPING') && (
              <Button appearance="primary" icon={<Play20Regular />} disabled={starting || !warehouseId} onClick={start}>
                {starting ? 'Starting…' : 'Start'}
              </Button>
            )}
            {isRunning && (
              <Button appearance="outline" icon={<Stop20Regular />} onClick={stop}>Stop</Button>
            )}
            <Button appearance="outline" icon={<ArrowSync20Regular />} aria-label="Refresh warehouse state" onClick={() => {
              refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
            }}>Refresh</Button>
            {/* Catalog picker — drives query context + 3-part / 4-part cross-catalog SQL. */}
            <Dropdown
              aria-label="Catalog"
              placeholder="Catalog"
              value={activeCatalog || ''}
              selectedOptions={activeCatalog ? [activeCatalog] : []}
              onOptionSelect={(_, d) => { if (d.optionValue) openCatalog(d.optionValue); }}
              disabled={catalogs.length === 0 || !isRunning}
              style={{ minWidth: 160 }}
            >
              {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
            </Dropdown>
            <Tooltip content={!warehouseId ? 'Pick a warehouse first' : 'Change size, scaling, auto-stop, type, serverless'} relationship="label">
              <Button appearance="outline" icon={<Save20Regular />} disabled={!warehouseId} onClick={openEdit}>
                Edit
              </Button>
            </Tooltip>
            {loading && (
              <Button appearance="outline" icon={<Stop20Regular />} onClick={cancel} disabled={canceling}>
                {canceling ? 'Canceling…' : 'Cancel'}
              </Button>
            )}
            <Tooltip content={gov ? 'Create a new Synapse Dedicated SQL pool' : 'Create a new SQL Warehouse'} relationship="label">
              <Button appearance="outline" icon={<Add20Regular />} onClick={() => { setCreateError(null); setCreateOpen(true); }}>
                Create
              </Button>
            </Tooltip>
            <Tooltip content={!warehouseId ? 'Pick a warehouse first' : 'Permanently delete this warehouse'} relationship="label">
              <Button appearance="outline" icon={<Delete20Regular />} disabled={!warehouseId} onClick={() => { setDeleteError(null); setDeleteOpen(true); }}>
                Delete
              </Button>
            </Tooltip>
            <Tooltip
              content={
                !warehouseId ? 'Pick a warehouse first'
                  : loading ? 'A query is running…'
                  : !isRunning ? 'Start the warehouse before running SQL'
                  : 'Run the SQL (or just the highlighted selection) on the selected warehouse'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={loading || !isRunning || !warehouseId}
                onClick={run}
                style={{ marginLeft: 'auto' }}
              >
                Run
              </Button>
            </Tooltip>
            <Tooltip content="AI functions — sentiment / classify / translate / summarize / extract over a text column" relationship="label">
              <Button appearance="outline" icon={<Sparkle20Regular />} onClick={() => setAiFnOpen(true)}>
                AI functions
              </Button>
            </Tooltip>
          </div>
          {state === 'STARTING' && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse starting</MessageBarTitle>
                Typically 30–60 seconds on serverless, 2–5 min on classic. Run lights up when state is RUNNING.
              </MessageBarBody>
            </MessageBar>
          )}
          {state === 'STOPPED' && !starting && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse stopped</MessageBarTitle>
                Warehouses auto-stop after their idle window. Click Start to bring it RUNNING; storage is always charged, compute only while RUNNING.
              </MessageBarBody>
            </MessageBar>
          )}
          {activeCatalog && (
            <Caption1>
              Context: <strong>{activeCatalog}</strong>{activeSchema ? <> · <strong>{activeSchema}</strong></> : null}
            </Caption1>
          )}
          <SqlTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onAdd={addTab}
            onClose={closeTab}
          />
          <SqlCopilotEditor
            engine="databricks-sql-warehouse"
            id={id}
            value={sqlText}
            onChange={setSqlText}
            language="sparksql"
            dialectLabel="Spark SQL"
            height={260}
            minHeight={200}
            ariaLabel="Databricks SQL editor"
            onReady={handleEditorReady}
            resultError={result && !result.ok ? result.error || null : null}
            extraBody={{
              warehouseId: warehouseId || undefined,
              catalog: activeCatalog || undefined,
              schema: activeSchema || undefined,
            }}
            onApply={() => setResult(null)}
          />
          <QueryParamsBar sql={sqlText} onChange={setQueryParams} />
          {result?.ok && (result.rows?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button
                size="small"
                appearance={showViz ? 'primary' : 'outline'}
                icon={<DataBarVertical20Regular />}
                onClick={() => setShowViz((v) => !v)}
              >
                {showViz ? 'Hide chart' : 'Visualize'}
              </Button>
            </div>
          )}
          {showViz && result?.ok && (result.rows?.length ?? 0) > 0 && (
            <ResultVisualize columns={result.columns || []} rows={result.rows || []} />
          )}
          <ResultsPanel result={result} loading={loading} onOpenExcel={sqlText.trim() && warehouseId ? openInExcel : undefined} />
          {!warehousesError && warehouses.length === 0 && (
            <div>
              <Subtitle2>No SQL Warehouses found</Subtitle2>
              <Body1>
                The deployed Databricks workspace has no SQL Warehouses yet. Create one in the
                Databricks portal (SQL → Warehouses → Create) — Loom will pick it up automatically.
              </Body1>
            </div>
          )}

          </>
          )}

          {/* Edit / scale dialog — POST /api/2.0/sql/warehouses/{id}/edit */}
          <Dialog open={editOpen} onOpenChange={(_, d) => setEditOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '560px' }}>
              <DialogBody>
                <DialogTitle>Edit warehouse — {selectedWarehouse?.name || warehouseId}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {editError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Edit failed</MessageBarTitle>{editError}</MessageBarBody></MessageBar>
                    )}
                    <MessageBar intent="info">
                      <MessageBarBody>
                        Changes apply via <code>POST /api/2.0/sql/warehouses/&#123;id&#125;/edit</code>. A running
                        warehouse may briefly restart to take a new size; scaling (min/max clusters) and auto-stop
                        apply live.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Cluster size">
                      <Dropdown
                        value={editSize}
                        selectedOptions={[editSize]}
                        onOptionSelect={(_, d) => d.optionValue && setEditSize(d.optionValue)}
                      >
                        {['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large'].map((sz) => (
                          <Option key={sz} value={sz} text={sz}>{sz}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <Field label="Min clusters" style={{ flex: 1 }} hint="Scaling floor (1–30)">
                        <Input type="number" value={String(editMinClusters)}
                          onChange={(_, d) => setEditMinClusters(Math.max(1, Number(d.value) || 1))} />
                      </Field>
                      <Field label="Max clusters" style={{ flex: 1 }} hint="Scaling ceiling (1–30)">
                        <Input type="number" value={String(editMaxClusters)}
                          onChange={(_, d) => setEditMaxClusters(Math.max(1, Number(d.value) || 1))} />
                      </Field>
                    </div>
                    <Field label="Auto-stop (minutes)" hint="0 disables auto-stop">
                      <Input type="number" value={String(editAutoStop)}
                        onChange={(_, d) => setEditAutoStop(Math.max(0, Number(d.value) || 0))} />
                    </Field>
                    <Field label="Warehouse type">
                      <Dropdown
                        value={editType}
                        selectedOptions={[editType]}
                        onOptionSelect={(_, d) => d.optionValue && setEditType(d.optionValue as 'PRO' | 'CLASSIC')}
                      >
                        <Option value="PRO" text="PRO">PRO</Option>
                        <Option value="CLASSIC" text="CLASSIC">CLASSIC</Option>
                      </Dropdown>
                    </Field>
                    <Switch
                      checked={editServerless}
                      label="Serverless compute"
                      onChange={(_, d) => setEditServerless(!!d.checked)}
                    />
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setEditOpen(false)} disabled={editBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={saveEdit} disabled={editBusy}>
                    {editBusy ? 'Saving…' : 'Save changes'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={connOpen} onOpenChange={(_, d) => setConnOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '640px' }}>
              <DialogBody>
                <DialogTitle>Connection details — {selectedWarehouse?.name || warehouseId}</DialogTitle>
                <DialogContent>
                  {warehouseId ? (
                    <ConnectionDetailsPanel
                      engine="databricks-sql-warehouse"
                      id={id}
                      warehouseId={warehouseId}
                    />
                  ) : null}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setConnOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Create dialog — POST .../create (Databricks SQL Warehouse on Comm/GCC; */}
          {/* Synapse Dedicated SQL pool on Gov). Azure-native default, no Fabric. */}
          <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '580px' }}>
              <DialogBody>
                <DialogTitle>
                  {gov ? 'Create dedicated SQL pool' : 'Create SQL warehouse'}
                  {gov && <Badge appearance="outline" color="brand" style={{ marginLeft: 8 }}>Gov · Synapse Dedicated Pool</Badge>}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {createError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>
                    )}
                    <Field label="Name" required hint={gov ? 'Synapse Dedicated SQL pool name (letters, digits, hyphen)' : 'SQL Warehouse display name'}>
                      <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder={gov ? 'loom-warehouse' : 'analytics-wh'} />
                    </Field>

                    {gov ? (
                      <>
                        <Field label="Performance level (DWU)">
                          <Dropdown
                            value={createGovSku}
                            selectedOptions={[createGovSku]}
                            onOptionSelect={(_, d) => d.optionValue && setCreateGovSku(d.optionValue)}
                          >
                            {['DW100c', 'DW200c', 'DW300c', 'DW400c', 'DW500c', 'DW1000c', 'DW1500c', 'DW2000c', 'DW2500c', 'DW3000c', 'DW5000c'].map((sku) => (
                              <Option key={sku} value={sku} text={sku}>{sku}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                        <MessageBar intent="info">
                          <MessageBarBody>
                            <MessageBarTitle>Estimated ~${estimateDwuCostPerHr(createGovSku).toFixed(2)}/hr</MessageBarTitle>
                            Azure list price for {createGovSku} (~East US 2). Provisioned via ARM
                            <code> PUT …/sqlPools/&#123;name&#125;</code>; reaches Online in a few minutes. Compute is
                            billed while Online — pause to stop compute charges. Varies by region and reservation.
                          </MessageBarBody>
                        </MessageBar>
                      </>
                    ) : (
                      <>
                        <Field label="Cluster size">
                          <Dropdown
                            value={createSize}
                            selectedOptions={[createSize]}
                            onOptionSelect={(_, d) => d.optionValue && setCreateSize(d.optionValue)}
                          >
                            {['2X-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large'].map((sz) => (
                              <Option key={sz} value={sz} text={sz}>{sz}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                        <Field label="Type" hint={createServerless ? 'Serverless requires PRO' : undefined}>
                          <Dropdown
                            value={createServerless ? 'PRO' : createType}
                            disabled={createServerless}
                            selectedOptions={[createServerless ? 'PRO' : createType]}
                            onOptionSelect={(_, d) => d.optionValue && setCreateType(d.optionValue as 'PRO' | 'CLASSIC')}
                          >
                            <Option value="PRO" text="PRO">PRO</Option>
                            <Option value="CLASSIC" text="CLASSIC">CLASSIC</Option>
                          </Dropdown>
                        </Field>
                        <Switch
                          checked={createServerless}
                          label="Serverless compute (Databricks-managed; forces PRO)"
                          onChange={(_, d) => { setCreateServerless(!!d.checked); if (d.checked) setCreateType('PRO'); }}
                        />
                        <Switch
                          checked={createPhoton}
                          label="Photon acceleration"
                          onChange={(_, d) => setCreatePhoton(!!d.checked)}
                        />
                        <div style={{ display: 'flex', gap: 12 }}>
                          <Field label="Min clusters" style={{ flex: 1 }} hint="Scaling floor (1–30)">
                            <Input type="number" value={String(createMinClusters)}
                              onChange={(_, d) => setCreateMinClusters(Math.max(1, Number(d.value) || 1))} />
                          </Field>
                          <Field label="Max clusters" style={{ flex: 1 }} hint="Scaling ceiling (1–30)">
                            <Input type="number" value={String(createMaxClusters)}
                              onChange={(_, d) => setCreateMaxClusters(Math.max(1, Number(d.value) || 1))} />
                          </Field>
                        </div>
                        <Field label="Auto-stop (minutes)" hint="0 disables auto-stop">
                          <Input type="number" value={String(createAutoStop)}
                            onChange={(_, d) => setCreateAutoStop(Math.max(0, Number(d.value) || 0))} />
                        </Field>
                        <Field label="Channel">
                          <Dropdown
                            value={createChannel === 'CHANNEL_NAME_PREVIEW' ? 'Preview' : 'Current'}
                            selectedOptions={[createChannel]}
                            onOptionSelect={(_, d) => d.optionValue && setCreateChannel(d.optionValue as 'CHANNEL_NAME_CURRENT' | 'CHANNEL_NAME_PREVIEW')}
                          >
                            <Option value="CHANNEL_NAME_CURRENT" text="Current">Current</Option>
                            <Option value="CHANNEL_NAME_PREVIEW" text="Preview">Preview</Option>
                          </Dropdown>
                        </Field>
                        <Field label="Spot instance policy">
                          <Dropdown
                            value={createSpotPolicy === 'RELIABILITY_OPTIMIZED' ? 'Reliability optimized' : 'Cost optimized'}
                            selectedOptions={[createSpotPolicy]}
                            onOptionSelect={(_, d) => d.optionValue && setCreateSpotPolicy(d.optionValue as 'COST_OPTIMIZED' | 'RELIABILITY_OPTIMIZED')}
                          >
                            <Option value="COST_OPTIMIZED" text="Cost optimized">Cost optimized</Option>
                            <Option value="RELIABILITY_OPTIMIZED" text="Reliability optimized">Reliability optimized</Option>
                          </Dropdown>
                        </Field>
                        <Field label="Tags" hint="key=value, one per line">
                          <Textarea
                            value={createTagsText}
                            onChange={(_, d) => setCreateTagsText(d.value)}
                            placeholder={'team=analytics\nenv=prod'}
                            rows={3}
                          />
                        </Field>
                        <MessageBar intent="info">
                          <MessageBarBody>
                            <MessageBarTitle>
                              Estimated ~${estimateDbxCostPerHr(createSize, createType, createServerless, createMinClusters).toFixed(2)}/hr
                            </MessageBarTitle>
                            {dbuPerHr(createSize)} DBU/hr per cluster × {Math.max(1, createMinClusters)} cluster(s) ·{' '}
                            {createServerless ? 'serverless' : createType.toLowerCase()} list price. Real warehouse via
                            <code> POST /api/2.0/sql/warehouses</code>. Actual cost varies by region, Photon, spot policy, and discount.
                          </MessageBarBody>
                        </MessageBar>
                      </>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={saveCreate} disabled={createBusy || !createName.trim()}>
                    {createBusy ? 'Creating…' : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Delete confirm — POST .../delete. Running-state guard returns 409. */}
          <Dialog open={deleteOpen} onOpenChange={(_, d) => setDeleteOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '520px' }}>
              <DialogBody>
                <DialogTitle>Delete {gov ? 'dedicated pool' : 'warehouse'} — {selectedWarehouse?.name || warehouseId}</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {deleteError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Delete failed</MessageBarTitle>{deleteError}</MessageBarBody></MessageBar>
                    )}
                    {isRunning && !gov && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Warehouse is RUNNING</MessageBarTitle>
                          Stop it first, or use <strong>Force delete</strong> to drop it now — in-flight queries will be cancelled.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <Body1>
                      Permanently deletes <strong>{selectedWarehouse?.name || warehouseId}</strong> and its configuration.
                      {gov ? ' Restorable only from an existing backup.' : ' Data in Unity Catalog is not deleted.'}
                    </Body1>
                    <Caption1>This action cannot be undone.</Caption1>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>Cancel</Button>
                  {isRunning && !gov && (
                    <Button appearance="outline" onClick={() => confirmDelete(true)} disabled={deleteBusy}>
                      {deleteBusy ? 'Deleting…' : 'Force delete'}
                    </Button>
                  )}
                  <Button appearance="primary" onClick={() => confirmDelete(false)} disabled={deleteBusy}>
                    {deleteBusy ? 'Deleting…' : 'Delete'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={qhOpen} onOpenChange={(_, d) => setQhOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Query history — {selectedWarehouse?.name || warehouseId}</DialogTitle>
                <DialogContent>
                  {qhBusy && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
                  {qhError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{qhError}</MessageBarBody></MessageBar>
                  )}
                  <div style={{ overflow: 'auto', maxHeight: '60vh' }}>
                    <Table aria-label="Query history" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>User</TableHeaderCell>
                        <TableHeaderCell>Rows</TableHeaderCell>
                        <TableHeaderCell>Query</TableHeaderCell>
                        <TableHeaderCell>Profile</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {qhEntries.length === 0 && !qhBusy && (
                          <TableRow><TableCell colSpan={7}><Caption1>No queries yet.</Caption1></TableCell></TableRow>
                        )}
                        {qhEntries.map((q) => (
                          <TableRow key={q.query_id}>
                            <TableCell>
                              <Badge appearance="filled" color={q.status === 'FINISHED' ? 'success' : q.status === 'FAILED' ? 'danger' : 'informative'}>
                                {q.status}
                              </Badge>
                            </TableCell>
                            <TableCell>{q.query_start_time_ms ? new Date(q.query_start_time_ms).toLocaleString() : '—'}</TableCell>
                            <TableCell>{q.duration != null ? `${(q.duration / 1000).toFixed(1)}s` : '—'}</TableCell>
                            <TableCell>{q.user_name || '—'}</TableCell>
                            <TableCell>{q.rows_produced ?? '—'}</TableCell>
                            <TableCell style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <code style={{ fontSize: 11 }}>{q.query_text?.slice(0, 200) || (q.error_message ? `ERR: ${q.error_message}` : '—')}</code>
                            </TableCell>
                            <TableCell>
                              <Button
                                size="small"
                                appearance="subtle"
                                disabled={q.status !== 'FINISHED' && q.status !== 'FAILED'}
                                title={q.status !== 'FINISHED' && q.status !== 'FAILED' ? 'Profile available once the query completes' : 'View execution profile (IO, Photon, Spark plan)'}
                                onClick={() => openProfile(q.query_id)}
                              >
                                Profile
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setQhOpen(false)} disabled={qhBusy}>Close</Button>
                  <Button appearance="subtle" onClick={() => loadQueryHistory(false)} disabled={qhBusy}>Refresh</Button>
                  <Button appearance="primary" onClick={() => loadQueryHistory(true, qhNext || undefined)} disabled={qhBusy || !qhNext}>
                    {qhNext ? 'Load more' : 'No more pages'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={profileOpen} onOpenChange={(_, d) => setProfileOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '920px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>
                  Query profile{profileData?.query_id ? ` — ${profileData.query_id}` : ''}
                </DialogTitle>
                <DialogContent>
                  {profileBusy && <Spinner size="small" label="Loading profile…" labelPosition="after" />}
                  {profileError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{profileError}</MessageBarBody>
                    </MessageBar>
                  )}
                  {profileData && !profileBusy && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Badge appearance="filled" color={profileData.status === 'FINISHED' ? 'success' : profileData.status === 'FAILED' ? 'danger' : 'informative'}>
                          {profileData.status}
                        </Badge>
                        {profileData.statement_type && (
                          <Badge appearance="outline">{profileData.statement_type}</Badge>
                        )}
                        {profileData.duration != null && (
                          <Badge appearance="outline">Total: {(profileData.duration / 1000).toFixed(2)}s</Badge>
                        )}
                        {profileData.photon_coverage_pct != null && (
                          <Badge appearance="outline" color="brand">Photon: {profileData.photon_coverage_pct}%</Badge>
                        )}
                        <Caption1>Plans: <strong>{profileData.plans_state ?? '—'}</strong></Caption1>
                      </div>

                      {profileData.error_message && (
                        <MessageBar intent="error">
                          <MessageBarBody>{profileData.error_message}</MessageBarBody>
                        </MessageBar>
                      )}

                      {profileData.metrics && (
                        <>
                          <Divider>IO &amp; timing</Divider>
                          <Table aria-label="Query metrics" size="small">
                            <TableHeader>
                              <TableRow>
                                <TableHeaderCell>Metric</TableHeaderCell>
                                <TableHeaderCell>Value</TableHeaderCell>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {([
                                ['Compilation', `${profileData.metrics.compilation_time_ms ?? '—'} ms`],
                                ['Execution', `${profileData.metrics.execution_time_ms ?? '—'} ms`],
                                ['Photon time', `${profileData.metrics.photon_total_time_ms ?? '—'} ms`],
                                ['Result fetch', `${profileData.metrics.result_fetch_time_ms ?? '—'} ms`],
                                ['Bytes read (total)', fmtBytes(profileData.metrics.read_bytes)],
                                ['Bytes read (remote)', fmtBytes(profileData.metrics.read_remote_bytes)],
                                ['Bytes read (cache)', fmtBytes(profileData.metrics.read_cache_bytes)],
                                ['Bytes written', fmtBytes(profileData.metrics.write_remote_bytes)],
                                ['Spill to disk', fmtBytes(profileData.metrics.spill_to_disk_bytes)],
                                ['Network sent', fmtBytes(profileData.metrics.network_sent_bytes)],
                                ['Rows read', profileData.metrics.rows_read_count != null ? profileData.metrics.rows_read_count.toLocaleString() : '—'],
                                ['Rows produced', profileData.metrics.rows_produced_count != null ? profileData.metrics.rows_produced_count.toLocaleString() : '—'],
                                ['Files scanned', profileData.metrics.read_files_count ?? '—'],
                                ['Files pruned', profileData.metrics.pruned_files_count ?? '—'],
                                ['Partitions scanned', profileData.metrics.read_partitions_count ?? '—'],
                              ] as [string, string | number][]).map(([label, val]) => (
                                <TableRow key={label}>
                                  <TableCell><Caption1>{label}</Caption1></TableCell>
                                  <TableCell className={s.cell}>{val}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </>
                      )}

                      <Divider>Spark plan (physical DAG)</Divider>
                      {profileData.spark_ui_url && (
                        <Body1>
                          Open the full physical plan / DAG in the Spark UI:{' '}
                          <a href={profileData.spark_ui_url} target="_blank" rel="noopener noreferrer">
                            {profileData.spark_ui_url}
                          </a>
                        </Body1>
                      )}
                      {profileData.plans != null && (
                        <pre style={{
                          fontFamily: 'Consolas, monospace', fontSize: 11, overflow: 'auto',
                          maxHeight: 320, backgroundColor: tokens.colorNeutralBackground3,
                          padding: 8, borderRadius: 4, margin: 0,
                        }}>
                          {JSON.stringify(profileData.plans, null, 2)}
                        </pre>
                      )}
                      {profileData.plans == null && !profileData.spark_ui_url && (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            No inline plan returned for this query (likely a result-cache hit or a
                            metadata-only statement). Re-run with a change that bypasses the cache to
                            capture a plan.
                          </MessageBarBody>
                        </MessageBar>
                      )}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setProfileOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <UnityCatalogWriteDialogs
            catalogs={catalogs}
            activeCatalog={activeCatalog}
            schemas={schemas}
            activeSchema={activeSchema}
            tables={tables}
            warehouseId={warehouseId}
            onChanged={ucChanged}
            createVolumeOpen={ucCreateVolumeOpen} setCreateVolumeOpen={setUcCreateVolumeOpen}
            dropOpen={ucDropOpen} setDropOpen={setUcDropOpen}
            createCatalogOpen={ucCreateCatalogOpen} setCreateCatalogOpen={setUcCreateCatalogOpen}
            createSchemaOpen={ucCreateSchemaOpen} setCreateSchemaOpen={setUcCreateSchemaOpen}
            createTableOpen={ucCreateTableOpen} setCreateTableOpen={setUcCreateTableOpen}
            grantsOpen={ucGrantsOpen} setGrantsOpen={setUcGrantsOpen}
          />

          {statsTarget && (
            <StatsMaintenanceDialog
              open={statsOpen}
              onOpenChange={setStatsOpen}
              engine="databricks-sql-warehouse"
              itemId={id}
              catalog={statsTarget.catalog}
              schema={statsTarget.schema}
              tableName={statsTarget.table}
              warehouseId={warehouseId}
            />
          )}
          <WarehouseAlerts
            engine="databricks-sql-warehouse"
            id={id}
            warehouseId={warehouseId}
            open={alertsOpen}
            onOpenChange={setAlertsOpen}
          />
          <Dialog open={ucSecOpen} onOpenChange={(_, d) => setUcSecOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '980px', width: '94vw' }}>
              <DialogBody>
                <DialogTitle>Column &amp; row security — Unity Catalog</DialogTitle>
                <DialogContent>
                  <UcSecurityPanel
                    itemType="databricks-sql-warehouse"
                    itemId={id}
                    warehouseId={warehouseId || undefined}
                    catalog={activeCatalog || undefined}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setUcSecOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <AiFunctionsHelper
            open={aiFnOpen}
            onOpenChange={setAiFnOpen}
            itemType="databricks-sql-warehouse"
            itemId={id}
            warehouseId={warehouseId}
            catalog={activeCatalog}
            schema={activeSchema}
            table={aiTable}
            onInsert={(sql) => setSqlText(sql)}
          />
          <Dialog open={vqOpen} onOpenChange={(_, d) => setVqOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1280px', width: '96vw' }}>
              <DialogBody>
                <DialogTitle>Visual query — Databricks SQL (Spark SQL)</DialogTitle>
                <DialogContent>
                  <VisualQueryCanvas
                    engine="databricks-sql-warehouse"
                    id={id}
                    dialect="sparksql"
                    warehouseId={warehouseId}
                    catalog={activeCatalog || undefined}
                    schema={activeSchema || undefined}
                    sourceTables={vqSourceTables}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setVqOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {ctasReceipt && (
            <MessageBar intent="success">
              <MessageBarBody><MessageBarTitle>Table created</MessageBarTitle>{ctasReceipt}</MessageBarBody>
            </MessageBar>
          )}
          {cloneReceipt && (
            <MessageBar intent="success">
              <MessageBarBody><MessageBarTitle>Clone created</MessageBarTitle>{cloneReceipt}</MessageBarBody>
            </MessageBar>
          )}

          {/* Save as table (CTAS) — CREATE TABLE … USING DELTA AS SELECT … */}
          <Dialog open={ctasOpen} onOpenChange={(_, d) => setCtasOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '600px' }}>
              <DialogBody>
                <DialogTitle>Save as table (CTAS)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {ctasError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                    )}
                    <Caption1>
                      Wraps the editor SELECT as <code>CREATE TABLE `catalog`.`schema`.`name` USING DELTA AS SELECT …</code>{' '}
                      and runs it on the warehouse. Requires <code>CREATE TABLE</code> + <code>USE SCHEMA</code> + <code>USE CATALOG</code> on the target.
                    </Caption1>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Field label="Catalog" required style={{ flex: 1 }}>
                        {catalogs.length > 0 ? (
                          <Dropdown value={ctasCatalog} selectedOptions={ctasCatalog ? [ctasCatalog] : []}
                            onOptionSelect={(_, d) => d.optionValue && setCtasCatalog(d.optionValue)} placeholder="catalog">
                            {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                          </Dropdown>
                        ) : (
                          <Input value={ctasCatalog} onChange={(_, d) => setCtasCatalog(d.value)} placeholder="catalog" />
                        )}
                      </Field>
                      <Field label="Schema" required style={{ flex: 1 }}>
                        {schemas.length > 0 && ctasCatalog === activeCatalog ? (
                          <Dropdown value={ctasSchema} selectedOptions={ctasSchema ? [ctasSchema] : []}
                            onOptionSelect={(_, d) => d.optionValue && setCtasSchema(d.optionValue)} placeholder="schema">
                            {schemas.map((sc) => <Option key={sc} value={sc} text={sc}>{sc}</Option>)}
                          </Dropdown>
                        ) : (
                          <Input value={ctasSchema} onChange={(_, d) => setCtasSchema(d.value)} placeholder="schema" />
                        )}
                      </Field>
                      <Field label="Table name" required style={{ flex: 1 }}>
                        <Input value={ctasName} onChange={(_, d) => setCtasName(d.value)} placeholder="my_table" />
                      </Field>
                    </div>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCtasOpen(false)} disabled={ctasBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitCtas} disabled={ctasBusy || !ctasName.trim() || !ctasCatalog.trim() || !ctasSchema.trim()}>
                    {ctasBusy ? 'Creating…' : 'Create table'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Clone table (Delta SHALLOW = zero-copy / DEEP = full copy) */}
          <Dialog open={cloneOpen} onOpenChange={(_, d) => setCloneOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '620px' }}>
              <DialogBody>
                <DialogTitle>Clone table (Delta)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {cloneError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Clone failed</MessageBarTitle>{cloneError}</MessageBarBody></MessageBar>
                    )}
                    <Field label="Clone type">
                      <Dropdown value={cloneKind} selectedOptions={[cloneKind]}
                        onOptionSelect={(_, d) => d.optionValue && setCloneKind(d.optionValue as 'SHALLOW' | 'DEEP')}>
                        <Option value="SHALLOW" text="SHALLOW">SHALLOW — zero-copy (metadata only; data files remain in source)</Option>
                        <Option value="DEEP" text="DEEP">DEEP — full copy (data files duplicated, independent of source)</Option>
                      </Dropdown>
                    </Field>
                    {cloneKind === 'SHALLOW' && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>Shallow clone dependency</MessageBarTitle>
                          The clone references the source table&apos;s Delta data files. Running VACUUM on the source
                          can break this clone if it removes files the clone still references. Use DEEP clone for
                          long-term archival or any copy that must survive source VACUUM.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <Field label="Source table" hint="catalog.schema.table" required>
                      <Input value={cloneSource} onChange={(_, d) => setCloneSource(d.value)} placeholder="main.sales.orders" />
                    </Field>
                    <Field label="Target table" hint="catalog.schema.table" required>
                      <Input value={cloneTarget} onChange={(_, d) => setCloneTarget(d.value)} placeholder="main.dev.orders_clone" />
                    </Field>
                    <Switch checked={cloneReplace} label="Replace if target already exists (CREATE OR REPLACE TABLE)"
                      onChange={(_, d) => setCloneReplace(!!d.checked)} />
                    <Caption1>
                      Requires <code>SELECT</code> on the source + <code>CREATE TABLE</code> on the target schema.
                      Unity Catalog shallow clone requires Databricks Runtime 13.3 LTS or above.
                    </Caption1>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCloneOpen(false)} disabled={cloneBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitClone} disabled={cloneBusy || !cloneSource.trim() || !cloneTarget.trim()}>
                    {cloneBusy ? 'Cloning…' : 'Clone'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// Shared helpers
// ============================================================

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

export function DatabricksNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // ---- Workspace tree ----
  const [rootPath, setRootPath] = useState('/Workspace');
  const [tree, setTree] = useState<Record<string, WorkspaceObject[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/Workspace']));
  const [treeError, setTreeError] = useState<string | null>(null);

  // ---- Open notebook ----
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [baseLanguage, setBaseLanguage] = useState<DbxBaseLanguage>('PYTHON');
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);

  // ---- Cells (the core of the editor) ----
  const [cells, setCells] = useState<NotebookCell[]>([emptyCell('code', 'python')]);
  const [origSerialized, setOrigSerialized] = useState<string>('');
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [cellResults, setCellResults] = useState<Record<string, CellResult>>({});

  // ---- Cluster + execution context ----
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string>('');
  const [clustersError, setClustersError] = useState<string | null>(null);
  // One execution context per (cluster, command-language) so REPL state
  // persists across cells of the same language. Keyed `${clusterId}:${lang}`.
  const contextsRef = useRef<Record<string, string>>({});
  const [runningAll, setRunningAll] = useState(false);

  const serialized = useMemo(() => serializeCells(cells, baseLanguage), [cells, baseLanguage]);
  const dirty = !!selectedPath && serialized !== origSerialized;

  // ---- Load tree + clusters on mount ----
  const loadDir = useCallback(async (path: string) => {
    try {
      const r = await fetch(`/api/items/databricks-notebook/list?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      setTreeError(null);
      setTree((t) => ({ ...t, [path]: (j.objects || []) as WorkspaceObject[] }));
    } catch (e: any) {
      setTreeError(e?.message || String(e));
    }
  }, []);

  const loadClusters = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setClustersError(j.error || `HTTP ${r.status}`); return; }
      setClustersError(null);
      const list = (j.clusters || []) as Cluster[];
      setClusters(list);
      setClusterId((prev) => {
        if (prev && list.some((c) => c.cluster_id === prev)) return prev;
        const running = list.find((c) => c.state === 'RUNNING');
        return running ? running.cluster_id : (list[0]?.cluster_id || '');
      });
    } catch (e: any) {
      setClustersError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);
  useEffect(() => { void loadClusters(); }, [loadClusters]);

  // ---- Hydrate from the installed item's bundle cells ----
  // A bundle-installed databricks-notebook has its NotebookContent cells
  // stamped into Cosmos (state.cells, or state.content.cells when only the
  // NotebookContent shape was written). The live-workspace tree on the left
  // doesn't surface those, so on mount we open the item populated with every
  // markdown + code cell instead of a single empty cell — the bundle content
  // is no longer stranded. Once the user clicks a real workspace path the
  // openNotebook flow takes over (export from the live Databricks workspace).
  useEffect(() => {
    if (!id || id === 'new') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/databricks-notebook/${encodeURIComponent(id)}`);
        if (!r.ok) return;
        const item = await r.json();
        if (cancelled) return;
        const st = (item?.state as any) || {};
        const raw: any[] = (Array.isArray(st.cells) && st.cells.length > 0)
          ? st.cells
          : (st.content?.kind === 'notebook' && Array.isArray(st.content.cells) ? st.content.cells : []);
        if (raw.length === 0) return;
        const hydrated: NotebookCell[] = raw.map((c, i) => ({
          id: typeof c?.id === 'string' && c.id ? c.id : `bundle-${i}`,
          type: c?.type === 'markdown' ? 'markdown' : 'code',
          lang: (c?.lang || c?.language || st.defaultLang || st.content?.defaultLang || 'python') as NotebookCell['lang'],
          source: typeof c?.source === 'string' ? c.source : Array.isArray(c?.source) ? c.source.join('') : '',
        }));
        setCells(hydrated);
        setBaseLanguage('PYTHON');
        setOrigSerialized(serializeCells(hydrated, 'PYTHON'));
        setActiveCellId(hydrated[0]?.id || null);
        setFileMessage('Loaded notebook cells from the installed app bundle. Click a workspace notebook on the left to open the deployed copy.');
      } catch { /* fall back to the empty starter cell */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!tree[path]) void loadDir(path); }
      return next;
    });
  }, [tree, loadDir]);

  // ---- Open a notebook: export SOURCE, parse to cells ----
  const openNotebook = useCallback(async (path: string, lang?: string) => {
    setSelectedPath(path);
    setFileError(null);
    setFileMessage(null);
    setLoadingFile(true);
    setCellResults({});
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      const base = detectBase(lang || j.language);
      setBaseLanguage(base);
      const parsed = parseSource(j.content || '', base);
      setCells(parsed);
      setOrigSerialized(serializeCells(parsed, base));
      setActiveCellId(parsed[0]?.id || null);
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setLoadingFile(false);
    }
  }, [id]);

  // ---- Save: serialise cells -> SOURCE -> workspace/import ----
  const save = useCallback(async () => {
    if (!selectedPath) return;
    setSavingFile(true);
    setFileError(null);
    setFileMessage(null);
    const snapshot = serializeCells(cells, baseLanguage);
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, language: baseLanguage, content: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) setFileError(j.error || `HTTP ${r.status}`);
      else {
        setOrigSerialized(snapshot);
        setFileMessage(`Saved to ${selectedPath} at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setSavingFile(false);
    }
  }, [id, selectedPath, baseLanguage, cells]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selectedPath && dirty && !savingFile) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPath, dirty, savingFile, save]);

  // ---- New notebook in the workspace ----
  const newNotebook = useCallback(async () => {
    const suggested = `${rootPath.replace(/\/$/, '')}/loom-notebook-${Date.now()}`;
    const path = window.prompt('New notebook path', suggested);
    if (!path) return;
    setFileError(null); setFileMessage(null);
    const starter = [emptyCell('code', 'python')];
    const src = serializeCells(starter, 'PYTHON');
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, language: 'PYTHON', content: src }),
      });
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      setTree({}); void loadDir(rootPath);
      await openNotebook(path, 'PYTHON');
    } catch (e: any) { setFileError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, openNotebook]);

  // ---- Delete a notebook from the tree ----
  const deleteObject = useCallback(async (path: string, isDir: boolean) => {
    if (!window.confirm(`Delete ${path}${isDir ? ' (and contents)' : ''}?`)) return;
    try {
      const qs = `path=${encodeURIComponent(path)}${isDir ? '&recursive=true' : ''}`;
      const r = await fetch(`/api/items/databricks-notebook/${id}?${qs}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      if (selectedPath === path) { setSelectedPath(null); setCells([emptyCell('code', 'python')]); }
      setTree({}); void loadDir(rootPath);
    } catch (e: any) { setTreeError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, selectedPath]);

  // ---- Cell mutations ----
  const updateCell = useCallback((next: NotebookCell) => {
    setCells((cs) => cs.map((c) => (c.id === next.id ? next : c)));
  }, []);
  const addCell = useCallback((type: 'code' | 'markdown', afterId?: string) => {
    const fresh = emptyCell(type, type === 'code' ? 'python' : 'python');
    setCells((cs) => {
      if (!afterId) return [...cs, fresh];
      const idx = cs.findIndex((c) => c.id === afterId);
      if (idx < 0) return [...cs, fresh];
      const copy = cs.slice();
      copy.splice(idx + 1, 0, fresh);
      return copy;
    });
    setActiveCellId(fresh.id);
  }, []);
  const deleteCell = useCallback((cellId: string) => {
    setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== cellId)));
    setCellResults((r) => { const n = { ...r }; delete n[cellId]; return n; });
  }, []);
  const duplicateCell = useCallback((cellId: string) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      if (idx < 0) return cs;
      const src = cs[idx];
      const dup: NotebookCell = { ...src, id: emptyCell('code').id, output: undefined, executionCount: undefined };
      const copy = cs.slice();
      copy.splice(idx + 1, 0, dup);
      return copy;
    });
  }, []);
  const moveCell = useCallback((cellId: string, dir: -1 | 1) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= cs.length) return cs;
      const copy = cs.slice();
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  }, []);

  // ---- Execute a single cell against the cluster ----
  const selectedCluster = useMemo(
    () => clusters.find((c) => c.cluster_id === clusterId) || null,
    [clusters, clusterId],
  );
  const clusterRunning = selectedCluster?.state === 'RUNNING';

  const runCell = useCallback(async (cell: NotebookCell): Promise<void> => {
    if (cell.type === 'markdown') return; // markdown renders client-side
    if (!clusterId) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: 'No cluster selected. Pick a cluster above.' } }));
      return;
    }
    const cmdLang = cellLangToCommandLanguage(cell.lang);
    const ctxKey = `${clusterId}:${cmdLang}`;
    const t0 = Date.now();
    setCellResults((r) => ({ ...r, [cell.id]: { status: 'running' } }));
    try {
      const res = await fetch(`/api/items/databricks-notebook/${id}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clusterId,
          language: cmdLang,
          command: cell.source,
          contextId: contextsRef.current[ctxKey] || undefined,
        }),
      });
      const j = await res.json();
      if (!j.ok) {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: j.error || `HTTP ${res.status}` } }));
        return;
      }
      // Cache the context id for REPL persistence across cells.
      if (j.contextId) contextsRef.current[ctxKey] = j.contextId;
      const ms = Date.now() - t0;
      if (j.resultType === 'error' || j.status === 'Error') {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', resultType: 'error', error: j.error, cause: j.cause, ms } }));
      } else {
        setCellResults((r) => ({
          ...r,
          [cell.id]: {
            status: 'ok',
            resultType: j.resultType,
            text: j.text,
            columns: j.columns,
            rows: j.rows,
            image: j.image,
            truncated: j.truncated,
            ms,
          },
        }));
      }
    } catch (e: any) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: e?.message || String(e) } }));
    }
  }, [id, clusterId]);

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      for (const cell of cells) {
        if (cell.type === 'markdown') continue;
        if (!cell.source.trim()) continue;
        await runCell(cell);
        const res = cellResults[cell.id];
        // stop-on-error parity with Databricks "Run all"
        if (res?.status === 'error') break;
      }
    } finally {
      setRunningAll(false);
    }
  }, [cells, runCell, cellResults]);

  const clearOutputs = useCallback(() => setCellResults({}), []);

  // ---- Runs history (jobs runs/list) ----
  const [runs, setRuns] = useState<RunRow[]>([]);
  const loadRuns = useCallback(async () => {
    const r = await fetch(`/api/items/databricks-notebook/${id}/runs`);
    const j = await r.json();
    if (j.ok) setRuns(j.runs || []);
  }, [id]);
  const [runsOpen, setRunsOpen] = useState(false);
  const openRuns = useCallback(() => { setRunsOpen(true); void loadRuns(); }, [loadRuns]);

  // ---- Tree render ----
  const renderTree = (path: string, depth = 0) => {
    const items = tree[path] || [];
    return items.map((o) => {
      const isDir = o.object_type === 'DIRECTORY' || o.object_type === 'REPO';
      const isNb = o.object_type === 'NOTEBOOK';
      const isOpen = expanded.has(o.path);
      return (
        <div key={o.path} style={{ paddingLeft: depth * 12 }}>
          <div
            className={s.treeRow}
            style={{ background: selectedPath === o.path ? tokens.colorNeutralBackground2Selected : undefined }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-label={`${isDir ? 'Toggle' : 'Open'} ${o.path}`}
              style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer', minWidth: 0 }}
              onClick={() => isDir ? toggle(o.path) : isNb ? openNotebook(o.path, o.language) : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (isDir) toggle(o.path); else if (isNb) openNotebook(o.path, o.language);
                }
              }}
            >
              {isDir ? <Folder20Regular /> : isNb ? <Document20Regular /> : <DocumentTable20Regular />}
              <Caption1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.path.split('/').pop() || o.path}
              </Caption1>
              {o.language && <Caption1 style={{ opacity: 0.6 }}>· {o.language}</Caption1>}
            </div>
            {(isNb || isDir) && (
              <Button
                size="small" appearance="subtle" icon={<Delete20Regular />}
                className={s.treeDelete}
                aria-label={`Delete ${o.path}`}
                onClick={(e) => { e.stopPropagation(); deleteObject(o.path, isDir); }}
              />
            )}
          </div>
          {isDir && isOpen && tree[o.path] !== undefined && renderTree(o.path, depth + 1)}
          {isDir && isOpen && tree[o.path] === undefined && (
            <div style={{ paddingLeft: (depth + 1) * 12 }}><Caption1>(loading…)</Caption1></div>
          )}
        </div>
      );
    });
  };

  const refreshTree = useCallback(() => { setTree({}); void loadDir(rootPath); }, [rootPath, loadDir]);
  const canRunAll = !!clusterId && !runningAll && cells.some((c) => c.type === 'code' && c.source.trim());

  const ribbonNb: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'File', actions: [
        { label: 'New notebook', onClick: newNotebook },
        { label: savingFile ? 'Saving…' : 'Save', onClick: selectedPath && dirty && !savingFile ? save : undefined, disabled: !selectedPath || !dirty || savingFile },
      ]},
      { label: 'Cells', actions: [
        { label: 'Add code cell', onClick: () => addCell('code', activeCellId || undefined) },
        { label: 'Add markdown', onClick: () => addCell('markdown', activeCellId || undefined) },
      ]},
      { label: 'Run', actions: [
        { label: runningAll ? 'Running all…' : 'Run all', onClick: canRunAll ? runAll : undefined, disabled: !canRunAll },
        { label: 'Clear outputs', onClick: clearOutputs },
        { label: 'View runs', onClick: openRuns },
      ]},
      { label: 'Workspace', actions: [
        { label: 'Refresh tree', onClick: refreshTree },
        { label: 'Refresh clusters', onClick: () => void loadClusters() },
      ]},
    ]},
  ], [newNotebook, savingFile, selectedPath, dirty, save, addCell, activeCellId, runningAll, canRunAll, runAll, clearOutputs, openRuns, refreshTree, loadClusters]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonNb}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input
              value={rootPath}
              onChange={(_, d) => setRootPath(d.value || '/Workspace')}
              size="small"
              style={{ flex: 1 }}
            />
            <Button size="small" icon={<ArrowSync20Regular />} aria-label="Refresh tree" onClick={refreshTree} />
            <Button size="small" icon={<Add20Regular />} aria-label="New notebook" onClick={newNotebook} />
          </div>
          {treeError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Workspace error</MessageBarTitle>{treeError}</MessageBarBody>
            </MessageBar>
          )}
          {renderTree(rootPath)}
        </div>
      }
      main={
        <div className={s.pad}>
          {/* Toolbar: notebook id + base language + cluster + run-all */}
          <div className={s.toolbar}>
            <Caption1 style={{ fontWeight: 600 }}>{selectedPath || 'New notebook (unsaved)'}</Caption1>
            <Dropdown
              aria-label="Notebook language"
              value={baseLanguage}
              selectedOptions={[baseLanguage]}
              onOptionSelect={(_, d) => d.optionValue && setBaseLanguage(d.optionValue as DbxBaseLanguage)}
              size="small"
              style={{ width: 120 }}
            >
              <Option value="PYTHON">Python</Option>
              <Option value="SQL">SQL</Option>
              <Option value="SCALA">Scala</Option>
              <Option value="R">R</Option>
            </Dropdown>
            <Dropdown
              placeholder="Attach cluster"
              aria-label="Cluster"
              value={selectedCluster ? `${selectedCluster.cluster_name || selectedCluster.cluster_id} · ${selectedCluster.state}` : ''}
              selectedOptions={clusterId ? [clusterId] : []}
              onOptionSelect={(_, d) => d.optionValue && setClusterId(d.optionValue)}
              size="small"
              style={{ minWidth: 240 }}
              disabled={clusters.length === 0}
            >
              {clusters.map((c) => (
                <Option key={c.cluster_id} value={c.cluster_id} text={`${c.cluster_name || c.cluster_id} · ${c.state}`}>
                  {c.cluster_name || c.cluster_id} · {c.state}
                </Option>
              ))}
            </Dropdown>
            {selectedCluster && (
              <Badge appearance="filled" color={clusterStateColor(selectedCluster.state)}>
                {selectedCluster.state}
              </Badge>
            )}
            <Tooltip
              content={
                runningAll ? 'Running all cells…'
                  : !clusterId ? 'Attach a cluster first'
                  : !cells.some((c) => c.type === 'code' && c.source.trim()) ? 'Add a non-empty code cell'
                  : 'Run every code cell top-to-bottom (stops on first error)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!canRunAll}
                onClick={runAll}
                style={{ marginLeft: 'auto' }}
              >
                {runningAll ? 'Running all…' : 'Run all'}
              </Button>
            </Tooltip>
            <Tooltip
              content={
                !selectedPath ? 'Open or create a notebook first'
                  : savingFile ? 'Saving…'
                  : !dirty ? 'No unsaved changes'
                  : 'Save to the workspace (workspace/import)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Save20Regular />}
                disabled={!selectedPath || !dirty || savingFile}
                onClick={save}
              >
                {savingFile ? 'Saving…' : dirty ? 'Save *' : 'Save'}
              </Button>
            </Tooltip>
          </div>

          {clustersError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Could not list clusters</MessageBarTitle>{clustersError}</MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No clusters in this workspace</MessageBarTitle>
                Create a cluster in the Databricks Cluster editor (or the Databricks portal: Compute → Create compute).
                Cells need an attached cluster to execute via the Command Execution API.
              </MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length > 0 && !clusterRunning && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Cluster is {selectedCluster?.state?.toLowerCase() || 'not running'}</MessageBarTitle>
                Start <strong>{selectedCluster?.cluster_name || clusterId}</strong> in the Databricks Cluster editor
                (Start), then return here. Cells run against a RUNNING cluster; submitting now will start one on demand and may take 2–5 min.
              </MessageBarBody>
            </MessageBar>
          )}
          {fileError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Notebook error</MessageBarTitle>{fileError}
            </MessageBarBody></MessageBar>
          )}
          {fileMessage && (
            <MessageBar intent="success"><MessageBarBody>{fileMessage}</MessageBarBody></MessageBar>
          )}

          {/* Cell list */}
          {loadingFile ? (
            <Spinner size="small" label="Loading notebook source…" labelPosition="after" />
          ) : (
            <div className={s.cellList}>
              <CellAdder
                onAddCode={() => addCell('code', undefined)}
                onAddMarkdown={() => addCell('markdown', undefined)}
              />
              {cells.map((cell, i) => {
                const res = cellResults[cell.id];
                const cellNode = cell.type === 'markdown' ? (
                  <MarkdownCell
                    key={cell.id}
                    cell={cell}
                    active={activeCellId === cell.id}
                    onFocus={() => setActiveCellId(cell.id)}
                    onChange={updateCell}
                    onDelete={() => deleteCell(cell.id)}
                    onMoveUp={() => moveCell(cell.id, -1)}
                    onMoveDown={() => moveCell(cell.id, 1)}
                    onDuplicate={() => duplicateCell(cell.id)}
                    canMoveUp={i > 0}
                    canMoveDown={i < cells.length - 1}
                  />
                ) : (
                  <div key={cell.id}>
                    <CodeCell
                      cell={cell}
                      active={activeCellId === cell.id}
                      onFocus={() => setActiveCellId(cell.id)}
                      onChange={updateCell}
                      onRun={runCell}
                      onDelete={() => deleteCell(cell.id)}
                      onMoveUp={() => moveCell(cell.id, -1)}
                      onMoveDown={() => moveCell(cell.id, 1)}
                      onDuplicate={() => duplicateCell(cell.id)}
                      canMoveUp={i > 0}
                      canMoveDown={i < cells.length - 1}
                      priorCells={cells.slice(0, i).filter((pc) => pc.type === 'code').slice(-3).map((pc) => pc.source)}
                    />
                    <DbxCellOutput res={res} />
                  </div>
                );
                return (
                  <div key={`${cell.id}-wrap`}>
                    {cellNode}
                    <CellAdder
                      onAddCode={() => addCell('code', cell.id)}
                      onAddMarkdown={() => addCell('markdown', cell.id)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Runs history dialog */}
          <Dialog open={runsOpen} onOpenChange={(_, d) => setRunsOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Workspace runs</DialogTitle>
                <DialogContent>
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Recent runs">
                      <TableHeader><TableRow>
                        <TableHeaderCell>run_id</TableHeaderCell>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Exec</TableHeaderCell>
                        <TableHeaderCell>Creator</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {runs.length === 0 && (
                          <TableRow><TableCell colSpan={6}><Caption1>No runs yet.</Caption1></TableCell></TableRow>
                        )}
                        {runs.map((r) => (
                          <TableRow key={r.run_id}>
                            <TableCell>{r.run_id}</TableCell>
                            <TableCell>{r.run_name || '—'}</TableCell>
                            <TableCell>
                              <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                                {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                              </Badge>
                            </TableCell>
                            <TableCell>{fmtTime(r.start_time)}</TableCell>
                            <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                            <TableCell>{r.creator_user_name || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRunsOpen(false)}>Close</Button>
                  <Button appearance="primary" onClick={() => void loadRuns()}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// Renders a single cell's Command Execution result: text / table / image / error.
function DbxCellOutput({ res }: { res?: CellResult }) {
  const s = useStyles();
  if (!res || res.status === 'idle') return null;
  if (res.status === 'running') {
    return (
      <div className={s.cellOutput}>
        <Spinner size="tiny" label="Running on cluster…" labelPosition="after" />
      </div>
    );
  }
  if (res.status === 'error') {
    return (
      <div className={s.cellOutput}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Command failed</MessageBarTitle>
            {res.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
        {res.cause && (
          <pre className={s.cellPre} style={{ color: tokens.colorPaletteRedForeground1 }}>{res.cause}</pre>
        )}
      </div>
    );
  }
  // ok
  return (
    <div className={s.cellOutput}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{res.resultType || 'text'}</Badge>
        {typeof res.ms === 'number' && <Caption1>· {res.ms} ms</Caption1>}
        {res.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
      </div>
      {res.resultType === 'table' ? (
        <div className={s.tableWrap}>
          <Table aria-label="Cell result" size="small">
            <TableHeader>
              <TableRow>
                {(res.columns || []).map((c, i) => <TableHeaderCell key={`${c}-${i}`}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(res.rows || []).map((row, i) => (
                <TableRow key={i}>
                  {(res.columns || []).map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : res.resultType === 'image' && res.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="cell output" src={res.image.startsWith('data:') ? res.image : `data:image/png;base64,${res.image}`} style={{ maxWidth: '100%' }} />
      ) : (
        <pre className={s.cellPre}>{res.text || '(no output)'}</pre>
      )}
    </div>
  );
}


// ============================================================
// Databricks Job editor
// ============================================================

// ------------------------------------------------------------
// Job task model — one-for-one with Databricks Jobs API 2.1/2.2 tasks[].
// Each task carries a task_key, a task-type payload, a compute binding
// (existing cluster or a new job cluster), optional run params, retries,
// timeout, run_if, and depends_on (the multi-task DAG).
// ------------------------------------------------------------
type JobTaskType =
  | 'notebook_task'
  | 'spark_python_task'
  | 'python_wheel_task'
  | 'spark_jar_task'
  | 'spark_submit_task'
  | 'sql_task'
  | 'dbt_task'
  | 'pipeline_task'
  | 'run_job_task';

const TASK_TYPE_LABELS: Record<JobTaskType, string> = {
  notebook_task: 'Notebook',
  spark_python_task: 'Python script',
  python_wheel_task: 'Python wheel',
  spark_jar_task: 'JAR',
  spark_submit_task: 'Spark Submit',
  sql_task: 'SQL',
  dbt_task: 'dbt',
  pipeline_task: 'Pipeline',
  run_job_task: 'Run Job',
};

interface JobTaskForm {
  task_key: string;
  task_type: JobTaskType;
  description: string;
  // Compute
  compute: 'existing' | 'new';
  existing_cluster_id: string;
  // new-job-cluster spec (used when compute === 'new')
  new_spark_version: string;
  new_node_type_id: string;
  new_num_workers: number;
  // depends_on
  depends_on: string[];        // upstream task_keys
  run_if: string;              // ALL_SUCCESS | AT_LEAST_ONE_SUCCESS | NONE_FAILED | ALL_DONE | AT_LEAST_ONE_FAILED | ALL_FAILED
  // reliability
  timeout_seconds: number;
  max_retries: number;
  min_retry_interval_millis: number;
  // type-specific fields
  notebook_path: string;
  notebook_params: string;     // k=v per line
  python_file: string;
  python_params: string;       // one arg per line
  wheel_package: string;
  wheel_entry_point: string;
  jar_main_class: string;
  jar_params: string;          // one arg per line
  spark_submit_params: string; // one arg per line
  sql_warehouse_id: string;
  sql_query_id: string;
  sql_file_path: string;
  dbt_commands: string;        // one command per line
  dbt_project_directory: string;
  pipeline_id: string;
  run_job_id: string;
}

function emptyTask(key: string): JobTaskForm {
  return {
    task_key: key,
    task_type: 'notebook_task',
    description: '',
    compute: 'existing',
    existing_cluster_id: '',
    new_spark_version: '',
    new_node_type_id: '',
    new_num_workers: 1,
    depends_on: [],
    run_if: 'ALL_SUCCESS',
    timeout_seconds: 0,
    max_retries: 0,
    min_retry_interval_millis: 0,
    notebook_path: '',
    notebook_params: '',
    python_file: '',
    python_params: '',
    wheel_package: '',
    wheel_entry_point: '',
    jar_main_class: '',
    jar_params: '',
    spark_submit_params: '',
    sql_warehouse_id: '',
    sql_query_id: '',
    sql_file_path: '',
    dbt_commands: '',
    dbt_project_directory: '',
    pipeline_id: '',
    run_job_id: '',
  };
}

// Parse "k=v" lines into a Record. Blank lines + lines without '=' are skipped.
function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
function serializeKv(rec?: Record<string, string>): string {
  if (!rec) return '';
  return Object.entries(rec).map(([k, v]) => `${k}=${v}`).join('\n');
}
// One-arg-per-(non-blank)-line → string[]
function parseLines(text: string): string[] {
  return (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// Build the Databricks task[] payload entry from a form task.
function taskToSpec(t: JobTaskForm): Record<string, unknown> {
  const spec: Record<string, unknown> = { task_key: t.task_key };
  if (t.description) spec.description = t.description;
  if (t.compute === 'existing') {
    if (t.existing_cluster_id) spec.existing_cluster_id = t.existing_cluster_id;
  } else {
    spec.new_cluster = {
      spark_version: t.new_spark_version,
      node_type_id: t.new_node_type_id,
      num_workers: t.new_num_workers,
    };
  }
  if (t.depends_on.length > 0) {
    spec.depends_on = t.depends_on.map((k) => ({ task_key: k }));
    if (t.run_if && t.run_if !== 'ALL_SUCCESS') spec.run_if = t.run_if;
  }
  if (t.timeout_seconds > 0) spec.timeout_seconds = t.timeout_seconds;
  if (t.max_retries !== 0) {
    spec.max_retries = t.max_retries;
    if (t.min_retry_interval_millis > 0) spec.min_retry_interval_millis = t.min_retry_interval_millis;
  }
  switch (t.task_type) {
    case 'notebook_task':
      spec.notebook_task = {
        notebook_path: t.notebook_path,
        source: 'WORKSPACE',
        ...(t.notebook_params ? { base_parameters: parseKv(t.notebook_params) } : {}),
      };
      break;
    case 'spark_python_task':
      spec.spark_python_task = {
        python_file: t.python_file,
        ...(t.python_params ? { parameters: parseLines(t.python_params) } : {}),
      };
      break;
    case 'python_wheel_task':
      spec.python_wheel_task = {
        package_name: t.wheel_package,
        entry_point: t.wheel_entry_point,
        ...(t.python_params ? { parameters: parseLines(t.python_params) } : {}),
      };
      break;
    case 'spark_jar_task':
      spec.spark_jar_task = {
        main_class_name: t.jar_main_class,
        ...(t.jar_params ? { parameters: parseLines(t.jar_params) } : {}),
      };
      break;
    case 'spark_submit_task':
      spec.spark_submit_task = { parameters: parseLines(t.spark_submit_params) };
      break;
    case 'sql_task':
      spec.sql_task = {
        warehouse_id: t.sql_warehouse_id,
        ...(t.sql_query_id ? { query: { query_id: t.sql_query_id } } : {}),
        ...(t.sql_file_path ? { file: { path: t.sql_file_path, source: 'WORKSPACE' } } : {}),
      };
      break;
    case 'dbt_task':
      spec.dbt_task = {
        commands: parseLines(t.dbt_commands),
        ...(t.dbt_project_directory ? { project_directory: t.dbt_project_directory } : {}),
        ...(t.sql_warehouse_id ? { warehouse_id: t.sql_warehouse_id } : {}),
      };
      break;
    case 'pipeline_task':
      spec.pipeline_task = { pipeline_id: t.pipeline_id };
      break;
    case 'run_job_task':
      spec.run_job_task = { job_id: Number(t.run_job_id) || 0 };
      break;
  }
  return spec;
}

// Hydrate a form task from a Databricks task[] entry returned by jobs/get.
function specToTask(raw: any): JobTaskForm {
  const t = emptyTask(raw.task_key || 'task');
  t.description = raw.description || '';
  if (raw.new_cluster) {
    t.compute = 'new';
    t.new_spark_version = raw.new_cluster.spark_version || '';
    t.new_node_type_id = raw.new_cluster.node_type_id || '';
    t.new_num_workers = raw.new_cluster.num_workers ?? 1;
  } else {
    t.compute = 'existing';
    t.existing_cluster_id = raw.existing_cluster_id || '';
  }
  t.depends_on = (raw.depends_on || []).map((d: any) => d.task_key).filter(Boolean);
  t.run_if = raw.run_if || 'ALL_SUCCESS';
  t.timeout_seconds = raw.timeout_seconds ?? 0;
  t.max_retries = raw.max_retries ?? 0;
  t.min_retry_interval_millis = raw.min_retry_interval_millis ?? 0;
  if (raw.notebook_task) {
    t.task_type = 'notebook_task';
    t.notebook_path = raw.notebook_task.notebook_path || '';
    t.notebook_params = serializeKv(raw.notebook_task.base_parameters);
  } else if (raw.spark_python_task) {
    t.task_type = 'spark_python_task';
    t.python_file = raw.spark_python_task.python_file || '';
    t.python_params = (raw.spark_python_task.parameters || []).join('\n');
  } else if (raw.python_wheel_task) {
    t.task_type = 'python_wheel_task';
    t.wheel_package = raw.python_wheel_task.package_name || '';
    t.wheel_entry_point = raw.python_wheel_task.entry_point || '';
    t.python_params = (raw.python_wheel_task.parameters || []).join('\n');
  } else if (raw.spark_jar_task) {
    t.task_type = 'spark_jar_task';
    t.jar_main_class = raw.spark_jar_task.main_class_name || '';
    t.jar_params = (raw.spark_jar_task.parameters || []).join('\n');
  } else if (raw.spark_submit_task) {
    t.task_type = 'spark_submit_task';
    t.spark_submit_params = (raw.spark_submit_task.parameters || []).join('\n');
  } else if (raw.sql_task) {
    t.task_type = 'sql_task';
    t.sql_warehouse_id = raw.sql_task.warehouse_id || '';
    t.sql_query_id = raw.sql_task.query?.query_id || '';
    t.sql_file_path = raw.sql_task.file?.path || '';
  } else if (raw.dbt_task) {
    t.task_type = 'dbt_task';
    t.dbt_commands = (raw.dbt_task.commands || []).join('\n');
    t.dbt_project_directory = raw.dbt_task.project_directory || '';
    t.sql_warehouse_id = raw.dbt_task.warehouse_id || '';
  } else if (raw.pipeline_task) {
    t.task_type = 'pipeline_task';
    t.pipeline_id = raw.pipeline_task.pipeline_id || '';
  } else if (raw.run_job_task) {
    t.task_type = 'run_job_task';
    t.run_job_id = String(raw.run_job_task.job_id ?? '');
  }
  return t;
}

interface JobRow {
  job_id: number;
  settings?: {
    name?: string;
    schedule?: { quartz_cron_expression?: string; timezone_id?: string; pause_status?: string };
    continuous?: { pause_status?: string };
    trigger?: unknown;
    tasks?: any[];
    tags?: Record<string, string>;
    parameters?: Array<{ name: string; default: string }>;
    max_concurrent_runs?: number;
    timeout_seconds?: number;
    email_notifications?: { on_failure?: string[]; on_success?: string[]; on_start?: string[] };
  };
  creator_user_name?: string;
}

type TriggerType = 'none' | 'cron' | 'continuous' | 'file_arrival';

// Timezone ids the Databricks schedule UI offers (IANA / Joda zone ids).
// Mirrors the portal's timezone dropdown for cron schedules.
const SCHEDULE_TIMEZONES = [
  'UTC',
  'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
  'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

export function DatabricksJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [creatorByJob, setCreatorByJob] = useState<Record<number, string>>({});
  // Bumped after a save/delete so the left Workspace navigator re-lists.
  const [navRefresh, setNavRefresh] = useState(0);

  // ---- Honest infra gate: which workspace will run jobs (LOOM_DATABRICKS_HOSTNAME) ----
  const [workspaceHost, setWorkspaceHost] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<string | null>(null);

  // ---- Job-level settings ----
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState<JobTaskForm[]>([emptyTask('main')]);
  const [activeTaskKey, setActiveTaskKey] = useState<string>('main');
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [jobTimeout, setJobTimeout] = useState(0);
  const [tagsText, setTagsText] = useState('');                 // k=v per line
  const [jobParamsText, setJobParamsText] = useState('');       // k=v per line (job_parameters defaults)
  const [emailOnFailure, setEmailOnFailure] = useState('');     // csv
  const [emailOnSuccess, setEmailOnSuccess] = useState('');     // csv

  // ---- Trigger / schedule ----
  const [triggerType, setTriggerType] = useState<TriggerType>('none');
  const [cron, setCron] = useState('0 0 2 * * ?');
  const [tz, setTz] = useState('UTC');
  const [paused, setPaused] = useState(false);
  const [fileArrivalUrl, setFileArrivalUrl] = useState('');

  // ---- Compute option sources (for new-job-cluster + existing pickers) ----
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [nodeTypes, setNodeTypes] = useState<{ node_type_id: string; description?: string }[]>([]);
  const [sparkVersions, setSparkVersions] = useState<{ key: string; name: string }[]>([]);
  // SQL Warehouses (for sql_task / dbt_task warehouse picker — real REST list).
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  // Notebook workspace browse (for notebook_task path picker)
  const [notebooks, setNotebooks] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState<'tasks' | 'runs' | 'schedule' | 'settings' | 'json'>('tasks');

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // ---- Run output drawer ----
  const [outOpen, setOutOpen] = useState(false);
  const [outBusy, setOutBusy] = useState(false);
  const [outRunId, setOutRunId] = useState<number | null>(null);
  const [outData, setOutData] = useState<any>(null);
  const [outNote, setOutNote] = useState<string | null>(null);
  const [outError, setOutError] = useState<string | null>(null);

  const markDirty = useCallback(() => setDirty(true), []);

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-job');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setListError(null);
      setJobs(j.jobs || []);
      const cmap: Record<number, string> = {};
      for (const job of (j.jobs || []) as JobRow[]) {
        if (job.creator_user_name) cmap[job.job_id] = job.creator_user_name;
      }
      setCreatorByJob(cmap);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadJobs();
    // workspace gate
    void (async () => {
      try {
        const r = await fetch('/api/databricks/workspace');
        const j = await r.json();
        if (j.ok) { setWorkspaceHost(j.workspace?.hostname || null); setGateError(null); }
        else { setGateError(j.error || `HTTP ${r.status}`); setGateHint(j.hint || null); }
      } catch (e: any) { setGateError(e?.message || String(e)); }
    })();
    // clusters
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (j.ok) setClusters(j.clusters || []);
    })();
    // compute options (spark versions + node types) for new job clusters
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster/options');
      const j = await r.json();
      if (j.ok) { setNodeTypes(j.nodeTypes || []); setSparkVersions(j.sparkVersions || []); }
    })();
    // SQL warehouses (for sql_task / dbt_task warehouse picker). Optional —
    // a free-text fallback remains if the workspace has none / list fails.
    void (async () => {
      try {
        const r = await fetch('/api/databricks/warehouses');
        const j = await r.json();
        if (j.ok) {
          setWarehouses((j.warehouses || []).map((w: any) => ({ id: w.id, name: w.name || w.id })));
        }
      } catch { /* picker optional; free-text warehouse id still works */ }
    })();
    // notebooks under /Workspace for the notebook-task path picker
    void (async () => {
      try {
        const r = await fetch('/api/items/databricks-notebook/list?path=/Workspace');
        const j = await r.json();
        if (j.ok) {
          setNotebooks((j.objects || [])
            .filter((o: any) => o.object_type === 'NOTEBOOK')
            .map((o: any) => o.path));
        }
      } catch { /* picker is optional; free-text path still works */ }
    })();
  }, [loadJobs]);

  const resetForNew = useCallback(() => {
    setJobId(null); setName(''); setSaveMessage(null); setSaveError(null); setRunError(null);
    setTasks([emptyTask('main')]); setActiveTaskKey('main'); setRuns([]);
    setMaxConcurrent(1); setJobTimeout(0); setTagsText(''); setJobParamsText('');
    setEmailOnFailure(''); setEmailOnSuccess('');
    setTriggerType('none'); setCron('0 0 2 * * ?'); setTz('UTC'); setPaused(false); setFileArrivalUrl('');
    setActiveTab('tasks'); setDirty(false);
  }, []);

  // Bundle-installed job: seed the form from the item's stamped
  // DatabricksJobContent (tasks + shared cluster) so it opens FULLY BUILT-OUT
  // before any live Databricks job exists. The item GET route returns the
  // editor-shaped { job, source:'bundle' } when no jobId is passed. The user
  // then clicks Create to push it to the real workspace (jobs/create). Only
  // runs once per item id, and never overrides a live-job selection or unsaved
  // edits.
  const [bundleSeeded, setBundleSeeded] = useState(false);
  useEffect(() => {
    if (id === 'new' || !id || bundleSeeded || jobId !== null || dirty) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/items/databricks-job/${encodeURIComponent(id)}`);
        const j = await r.json();
        if (cancelled || !j.ok || j.source !== 'bundle' || !j.job?.settings) return;
        const settings = j.job.settings;
        setName(settings.name || '');
        const ts = (settings.tasks || []).map(specToTask);
        if (ts.length) { setTasks(ts); setActiveTaskKey(ts[0].task_key || 'main'); }
        setMaxConcurrent(settings.max_concurrent_runs ?? 1);
        setActiveTab('tasks');
        setBundleSeeded(true);
      } catch { /* best-effort seed; the live job list still works */ }
    })();
    return () => { cancelled = true; };
  }, [id, bundleSeeded, jobId, dirty]);

  const selectJob = useCallback(async (jid: number) => {
    setJobId(jid);
    setSaveError(null); setSaveMessage(null); setRunError(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jid}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const job = j.job as JobRow;
      setName(job.settings?.name || '');
      const ts = (job.settings?.tasks || []).map(specToTask);
      setTasks(ts.length ? ts : [emptyTask('main')]);
      setActiveTaskKey(ts[0]?.task_key || 'main');
      setMaxConcurrent(job.settings?.max_concurrent_runs ?? 1);
      setJobTimeout(job.settings?.timeout_seconds ?? 0);
      setTagsText(serializeKv(job.settings?.tags));
      setJobParamsText((job.settings?.parameters || []).map((p) => `${p.name}=${p.default}`).join('\n'));
      setEmailOnFailure((job.settings?.email_notifications?.on_failure || []).join(', '));
      setEmailOnSuccess((job.settings?.email_notifications?.on_success || []).join(', '));
      const sch = job.settings?.schedule;
      const cont = job.settings?.continuous;
      const trig = job.settings?.trigger as any;
      if (sch) {
        setTriggerType('cron');
        setCron(sch.quartz_cron_expression || '0 0 2 * * ?');
        setTz(sch.timezone_id || 'UTC');
        setPaused(sch.pause_status === 'PAUSED');
      } else if (cont) {
        setTriggerType('continuous');
        setPaused(cont.pause_status === 'PAUSED');
      } else if (trig?.file_arrival) {
        setTriggerType('file_arrival');
        setFileArrivalUrl(trig.file_arrival.url || '');
        setPaused(trig.pause_status === 'PAUSED');
      } else {
        setTriggerType('none');
      }
      const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jid}`);
      const rj = await rr.json();
      if (rj.ok) setRuns(rj.runs || []);
      setDirty(false);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      name: name || 'untitled-job',
      tasks: tasks.filter((t) => t.task_key).map(taskToSpec),
      max_concurrent_runs: Math.max(1, maxConcurrent || 1),
    };
    if (jobTimeout > 0) spec.timeout_seconds = jobTimeout;
    const tags = parseKv(tagsText);
    if (Object.keys(tags).length) spec.tags = tags;
    const jp = parseKv(jobParamsText);
    if (Object.keys(jp).length) spec.parameters = Object.entries(jp).map(([nm, def]) => ({ name: nm, default: def }));
    const onFail = emailOnFailure.split(',').map((x) => x.trim()).filter(Boolean);
    const onSucc = emailOnSuccess.split(',').map((x) => x.trim()).filter(Boolean);
    if (onFail.length || onSucc.length) {
      spec.email_notifications = {
        ...(onFail.length ? { on_failure: onFail } : {}),
        ...(onSucc.length ? { on_success: onSucc } : {}),
      };
    }
    const pause = paused ? 'PAUSED' : 'UNPAUSED';
    if (triggerType === 'cron') {
      spec.schedule = { quartz_cron_expression: cron, timezone_id: tz, pause_status: pause };
    } else if (triggerType === 'continuous') {
      spec.continuous = { pause_status: pause };
    } else if (triggerType === 'file_arrival') {
      spec.trigger = { file_arrival: { url: fileArrivalUrl }, pause_status: pause };
    }
    return spec;
  }, [name, tasks, maxConcurrent, jobTimeout, tagsText, jobParamsText, emailOnFailure, emailOnSuccess, triggerType, cron, tz, paused, fileArrivalUrl]);

  const specJson = useMemo(() => {
    try { return JSON.stringify(buildSpec(), null, 2); } catch { return '{}'; }
  }, [buildSpec]);

  const save = useCallback(async () => {
    setSaving(true); setSaveError(null); setSaveMessage(null);
    const spec = buildSpec();
    try {
      if (jobId === null) {
        const r = await fetch('/api/items/databricks-job', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setJobId(j.job_id);
        setSaveMessage(`Created job ${j.job_id} at ${new Date().toLocaleTimeString()}`);
        await loadJobs();
        setNavRefresh((n) => n + 1);
        setDirty(false);
      } else {
        const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setSaveMessage(`Saved job ${jobId} at ${new Date().toLocaleTimeString()}`);
        setNavRefresh((n) => n + 1);
        setDirty(false);
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, jobId, buildSpec, loadJobs]);

  const del = useCallback(async () => {
    if (jobId === null) return;
    if (!window.confirm(`Delete job ${jobId}?`)) return;
    await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, { method: 'DELETE' });
    resetForNew();
    await loadJobs();
    setNavRefresh((n) => n + 1);
  }, [id, jobId, loadJobs, resetForNew]);

  const refreshRuns = useCallback(async () => {
    if (jobId === null) return;
    const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jobId}`);
    const rj = await rr.json();
    if (rj.ok) setRuns(rj.runs || []);
  }, [id, jobId]);

  const runNow = useCallback(async () => {
    if (jobId === null) return;
    setRunning(true); setRunError(null);
    try {
      // Pass job-level parameter defaults as job_parameters on run-now (real
      // run-now param shape); the API also honours notebook/python/etc.
      const jp = parseKv(jobParamsText);
      const body = Object.keys(jp).length ? { params: { job_parameters: jp } } : {};
      const r = await fetch(`/api/items/databricks-job/${id}/run?jobId=${jobId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setRunError(j.error || `HTTP ${r.status}`); return; }
      setActiveTab('runs');
      await refreshRuns();
    } catch (e: any) {
      setRunError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [id, jobId, jobParamsText, refreshRuns]);

  const openRunOutput = useCallback(async (runId: number) => {
    setOutOpen(true); setOutBusy(true); setOutRunId(runId);
    setOutData(null); setOutNote(null); setOutError(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}/run-output?runId=${runId}`);
      const j = await r.json();
      if (!j.ok) { setOutError(j.error || `HTTP ${r.status}`); return; }
      setOutData(j); setOutNote(j.outputNote || null);
    } catch (e: any) {
      setOutError(e?.message || String(e));
    } finally {
      setOutBusy(false);
    }
  }, [id]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && (dirty || jobId === null)) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, dirty, jobId, save]);

  // ---- Task mutations ----
  const activeTask = useMemo(
    () => tasks.find((t) => t.task_key === activeTaskKey) || tasks[0] || null,
    [tasks, activeTaskKey],
  );
  const patchTask = useCallback((key: string, patch: Partial<JobTaskForm>) => {
    setTasks((arr) => arr.map((t) => (t.task_key === key ? { ...t, ...patch } : t)));
    markDirty();
  }, [markDirty]);
  const addTask = useCallback(() => {
    setTasks((arr) => {
      let n = arr.length + 1;
      let key = `task_${n}`;
      while (arr.some((t) => t.task_key === key)) { n += 1; key = `task_${n}`; }
      const fresh = emptyTask(key);
      setActiveTaskKey(key);
      return [...arr, fresh];
    });
    markDirty();
  }, [markDirty]);
  const removeTask = useCallback((key: string) => {
    setTasks((arr) => {
      if (arr.length <= 1) return arr;
      const next = arr
        .filter((t) => t.task_key !== key)
        // drop dangling depends_on references to the removed task
        .map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => d !== key) }));
      if (activeTaskKey === key) setActiveTaskKey(next[0]?.task_key || '');
      return next;
    });
    markDirty();
  }, [activeTaskKey, markDirty]);
  const renameTaskKey = useCallback((oldKey: string, newKey: string) => {
    setTasks((arr) => arr.map((t) => ({
      ...t,
      task_key: t.task_key === oldKey ? newKey : t.task_key,
      depends_on: t.depends_on.map((d) => (d === oldKey ? newKey : d)),
    })));
    if (activeTaskKey === oldKey) setActiveTaskKey(newKey);
    markDirty();
  }, [activeTaskKey, markDirty]);

  // DAG activities derived from tasks for the visual canvas.
  const dagActivities: PipelineActivity[] = useMemo(
    () => tasks.map((t) => ({
      name: t.task_key,
      type: TASK_TYPE_LABELS[t.task_type],
      dependsOn: t.depends_on.map((d) => ({ activity: d, dependencyConditions: [] })),
    })),
    [tasks],
  );

  const gated = !!gateError;
  const canSaveJob = !saving && (dirty || jobId === null) && tasks.some((t) => t.task_key);
  const canRunNow = jobId !== null && !running;
  const canDeleteJob = jobId !== null;
  const ribbonJob: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: jobId === null ? 'New job' : 'New job', onClick: resetForNew },
        { label: saving ? 'Saving…' : jobId === null ? 'Create' : 'Save', onClick: canSaveJob ? save : undefined, disabled: !canSaveJob },
        { label: 'Delete', onClick: canDeleteJob ? del : undefined, disabled: !canDeleteJob },
      ]},
      { label: 'Run', actions: [
        { label: running ? 'Submitting…' : 'Run now', onClick: canRunNow ? runNow : undefined, disabled: !canRunNow, title: canRunNow ? undefined : 'Save the job first' },
        { label: 'View runs', onClick: jobId !== null ? () => { setActiveTab('runs'); void refreshRuns(); } : undefined, disabled: jobId === null },
      ]},
      { label: 'Tasks', actions: [
        { label: 'Add task', onClick: addTask },
      ]},
    ]},
  ], [jobId, resetForNew, saving, canSaveJob, save, canDeleteJob, del, running, canRunNow, runNow, refreshRuns, addTask]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonJob}
      leftPanel={
        // Full Databricks Workspace navigator (parity with the ADF Factory
        // Resources / Synapse Workspace Resources panes): typed groups for
        // Jobs / Notebooks / Clusters / SQL Warehouses / Repos / Unity Catalog
        // with live counts, ＋New, filter, inline run/start/stop/delete — all on
        // real Databricks REST. Selecting a Job opens it here; "New job" opens
        // the new-job form (Databricks jobs need ≥1 task, authored below).
        <DatabricksWorkspaceTree
          selectedJobId={jobId}
          onOpenJob={(jid) => void selectJob(jid)}
          onNewJob={resetForNew}
          refreshKey={navRefresh}
        />
      }
      main={
        <div className={s.pad}>
          {/* Honest infra gate — full UI still renders below */}
          {gated && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Databricks workspace not configured</MessageBarTitle>
                {gateError}. {gateHint || 'Set LOOM_DATABRICKS_HOSTNAME on the Console Container App (e.g. adb-XXXXXX.NN.azuredatabricks.net) to enable the Jobs API.'}
                {' '}Provisioned by <code>platform/fiab/bicep/modules/landing-zone/databricks*.bicep</code>.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.toolbar}>
            {dirty && jobId !== null && <Badge appearance="outline" color="warning">unsaved</Badge>}
            {jobId !== null && <Badge appearance="outline">job_id {jobId}</Badge>}
            {workspaceHost && <Caption1>workspace: <code>{workspaceHost}</code></Caption1>}
            <Tooltip
              content={
                saving ? 'Save in progress…'
                  : !tasks.some((t) => t.task_key) ? 'Add at least one task with a task key'
                  : !canSaveJob ? 'No unsaved changes'
                  : jobId === null ? 'Create this job (jobs/create)' : 'Save changes (jobs/reset)'
              }
              relationship="label"
            >
              <Button
                appearance="primary"
                icon={<Save20Regular />}
                disabled={!canSaveJob}
                onClick={save}
                style={{ marginLeft: 'auto' }}
              >
                {saving ? 'Saving…' : jobId === null ? 'Create' : dirty ? 'Save *' : 'Save'}
              </Button>
            </Tooltip>
            {jobId !== null && (
              <Tooltip content={running ? 'A run is being submitted…' : 'Trigger this job now (jobs/run-now)'} relationship="label">
                <Button appearance="outline" icon={<Play20Regular />} disabled={running} onClick={runNow}>
                  {running ? 'Submitting…' : 'Run now'}
                </Button>
              </Tooltip>
            )}
            {jobId !== null && (
              <Button appearance="outline" icon={<Delete20Regular />} aria-label="Delete job" onClick={del}>Delete</Button>
            )}
          </div>
          {saveError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Job save failed</MessageBarTitle>{saveError}
            </MessageBarBody></MessageBar>
          )}
          {runError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Run failed</MessageBarTitle>{runError}
            </MessageBarBody></MessageBar>
          )}
          {saveMessage && (
            <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>
          )}

          <Field label="Job name">
            <Input value={name} onChange={(_, d) => { setName(d.value); markDirty(); }} placeholder="My ETL job" />
          </Field>

          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={activeTab} onTabSelect={(_, d) => setActiveTab(d.value as typeof activeTab)}>
              <Tab value="tasks">Tasks ({tasks.length})</Tab>
              <Tab value="schedule">Schedule &amp; triggers</Tab>
              <Tab value="settings">Settings</Tab>
              <Tab value="runs" disabled={jobId === null}>Runs ({runs.length})</Tab>
              <Tab value="json">JSON</Tab>
            </TabList>
          </div>

          {/* ---------------- TASKS TAB ---------------- */}
          {activeTab === 'tasks' && (
            <>
              <PipelineDagView activities={dagActivities} emptyHint="No tasks yet. Click Add task." />
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                {/* Task list */}
                <div style={{ minWidth: 220 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <Subtitle2 style={{ flex: 1 }}>Tasks</Subtitle2>
                    <Button size="small" icon={<Add20Regular />} appearance="outline" onClick={addTask}>Add</Button>
                  </div>
                  {tasks.map((t) => (
                    <div
                      key={t.task_key}
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit task ${t.task_key}`}
                      onClick={() => setActiveTaskKey(t.task_key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveTaskKey(t.task_key); } }}
                      style={{
                        padding: 6, cursor: 'pointer', borderRadius: 3, marginBottom: 2,
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: activeTaskKey === t.task_key ? tokens.colorNeutralBackground2Selected : undefined,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Body1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.task_key || '(unnamed)'}</Body1>
                        <Caption1>{TASK_TYPE_LABELS[t.task_type]}{t.depends_on.length ? ` · ⤴ ${t.depends_on.length}` : ''}</Caption1>
                      </div>
                      {tasks.length > 1 && (
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                          aria-label={`Remove ${t.task_key}`}
                          onClick={(e) => { e.stopPropagation(); removeTask(t.task_key); }} />
                      )}
                    </div>
                  ))}
                </div>

                <Divider vertical style={{ minHeight: 200 }} />

                {/* Task detail editor */}
                {activeTask && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <Field label="Task key" style={{ flex: 1, minWidth: 160 }}>
                        <Input value={activeTask.task_key}
                          onChange={(_, d) => renameTaskKey(activeTask.task_key, d.value)} />
                      </Field>
                      <Field label="Type" style={{ flex: 1, minWidth: 160 }}>
                        <Dropdown
                          value={TASK_TYPE_LABELS[activeTask.task_type]}
                          selectedOptions={[activeTask.task_type]}
                          onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { task_type: d.optionValue as JobTaskType })}
                        >
                          {(Object.keys(TASK_TYPE_LABELS) as JobTaskType[]).map((tt) => (
                            <Option key={tt} value={tt} text={TASK_TYPE_LABELS[tt]}>{TASK_TYPE_LABELS[tt]}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                    </div>
                    <Field label="Description">
                      <Input value={activeTask.description}
                        onChange={(_, d) => patchTask(activeTask.task_key, { description: d.value })} />
                    </Field>

                    {/* Type-specific fields */}
                    {activeTask.task_type === 'notebook_task' && (
                      <>
                        <Field label="Notebook path" hint="Workspace path, e.g. /Workspace/Users/you/etl">
                          <Dropdown
                            placeholder="/Workspace/…  (or type a path below)"
                            value={activeTask.notebook_path}
                            selectedOptions={activeTask.notebook_path ? [activeTask.notebook_path] : []}
                            onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { notebook_path: d.optionValue })}
                          >
                            {notebooks.map((p) => <Option key={p} value={p} text={p}>{p}</Option>)}
                          </Dropdown>
                        </Field>
                        <Field label="Notebook path (free text)">
                          <Input value={activeTask.notebook_path}
                            onChange={(_, d) => patchTask(activeTask.task_key, { notebook_path: d.value })} />
                        </Field>
                        <Field label="Base parameters (key=value per line)">
                          <Textarea rows={3} value={activeTask.notebook_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { notebook_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_python_task' && (
                      <>
                        <Field label="Python file" hint="Workspace path or dbfs:/… or s3://…">
                          <Input value={activeTask.python_file}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_file: d.value })} />
                        </Field>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.python_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'python_wheel_task' && (
                      <>
                        <div style={{ display: 'flex', gap: 12 }}>
                          <Field label="Package name" style={{ flex: 1 }}>
                            <Input value={activeTask.wheel_package}
                              onChange={(_, d) => patchTask(activeTask.task_key, { wheel_package: d.value })} />
                          </Field>
                          <Field label="Entry point" style={{ flex: 1 }}>
                            <Input value={activeTask.wheel_entry_point}
                              onChange={(_, d) => patchTask(activeTask.task_key, { wheel_entry_point: d.value })} />
                          </Field>
                        </div>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.python_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { python_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_jar_task' && (
                      <>
                        <Field label="Main class">
                          <Input value={activeTask.jar_main_class}
                            onChange={(_, d) => patchTask(activeTask.task_key, { jar_main_class: d.value })} />
                        </Field>
                        <Field label="Parameters (one arg per line)">
                          <Textarea rows={3} value={activeTask.jar_params}
                            onChange={(_, d) => patchTask(activeTask.task_key, { jar_params: d.value })} />
                        </Field>
                      </>
                    )}
                    {activeTask.task_type === 'spark_submit_task' && (
                      <Field label="spark-submit parameters (one arg per line)">
                        <Textarea rows={4} value={activeTask.spark_submit_params}
                          onChange={(_, d) => patchTask(activeTask.task_key, { spark_submit_params: d.value })} />
                      </Field>
                    )}
                    {activeTask.task_type === 'sql_task' && (
                      <>
                        <Field label="SQL Warehouse" hint="Pro/serverless warehouse the SQL runs on">
                          {warehouses.length > 0 ? (
                            <Dropdown
                              aria-label="SQL Warehouse"
                              placeholder="Select warehouse"
                              value={warehouses.find((w) => w.id === activeTask.sql_warehouse_id)?.name || activeTask.sql_warehouse_id}
                              selectedOptions={activeTask.sql_warehouse_id ? [activeTask.sql_warehouse_id] : []}
                              onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { sql_warehouse_id: d.optionValue })}
                            >
                              {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                            </Dropdown>
                          ) : (
                            <Input aria-label="SQL Warehouse id" value={activeTask.sql_warehouse_id} placeholder="warehouse id"
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_warehouse_id: d.value })} />
                          )}
                        </Field>
                        <div style={{ display: 'flex', gap: 12 }}>
                          <Field label="Query id (saved query)" style={{ flex: 1 }}>
                            <Input value={activeTask.sql_query_id}
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_query_id: d.value })} />
                          </Field>
                          <Field label="…or SQL file path" style={{ flex: 1 }}>
                            <Input value={activeTask.sql_file_path}
                              onChange={(_, d) => patchTask(activeTask.task_key, { sql_file_path: d.value })} />
                          </Field>
                        </div>
                      </>
                    )}
                    {activeTask.task_type === 'dbt_task' && (
                      <>
                        <Field label="dbt commands (one per line)" hint="e.g. dbt deps / dbt run / dbt test">
                          <Textarea rows={4} value={activeTask.dbt_commands}
                            onChange={(_, d) => patchTask(activeTask.task_key, { dbt_commands: d.value })} />
                        </Field>
                        <div style={{ display: 'flex', gap: 12 }}>
                          <Field label="Project directory" style={{ flex: 1 }}>
                            <Input value={activeTask.dbt_project_directory}
                              onChange={(_, d) => patchTask(activeTask.task_key, { dbt_project_directory: d.value })} />
                          </Field>
                          <Field label="SQL Warehouse" style={{ flex: 1 }}>
                            {warehouses.length > 0 ? (
                              <Dropdown
                                aria-label="dbt SQL Warehouse"
                                placeholder="Select warehouse"
                                value={warehouses.find((w) => w.id === activeTask.sql_warehouse_id)?.name || activeTask.sql_warehouse_id}
                                selectedOptions={activeTask.sql_warehouse_id ? [activeTask.sql_warehouse_id] : []}
                                onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { sql_warehouse_id: d.optionValue })}
                              >
                                {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>)}
                              </Dropdown>
                            ) : (
                              <Input aria-label="dbt SQL Warehouse id" value={activeTask.sql_warehouse_id} placeholder="warehouse id"
                                onChange={(_, d) => patchTask(activeTask.task_key, { sql_warehouse_id: d.value })} />
                            )}
                          </Field>
                        </div>
                      </>
                    )}
                    {activeTask.task_type === 'pipeline_task' && (
                      <Field label="DLT / Lakeflow pipeline id" hint="Paste the pipeline id from the Databricks Delta Live Tables UI — no Loom DLT editor yet (tracked gap)">
                        <Input aria-label="DLT pipeline id" value={activeTask.pipeline_id} placeholder="e.g. 0123abcd-…"
                          onChange={(_, d) => patchTask(activeTask.task_key, { pipeline_id: d.value })} />
                      </Field>
                    )}
                    {activeTask.task_type === 'run_job_task' && (
                      <Field label="Job to run" hint="Another Databricks job this task triggers">
                        {jobs.filter((jb) => jb.job_id !== jobId).length > 0 ? (
                          <Dropdown
                            aria-label="Job to run"
                            placeholder="Select a job"
                            value={jobs.find((jb) => String(jb.job_id) === activeTask.run_job_id)?.settings?.name || activeTask.run_job_id}
                            selectedOptions={activeTask.run_job_id ? [activeTask.run_job_id] : []}
                            onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { run_job_id: d.optionValue })}
                          >
                            {jobs.filter((jb) => jb.job_id !== jobId).map((jb) => (
                              <Option key={jb.job_id} value={String(jb.job_id)} text={jb.settings?.name || String(jb.job_id)}>
                                {jb.settings?.name || `job ${jb.job_id}`} · {jb.job_id}
                              </Option>
                            ))}
                          </Dropdown>
                        ) : (
                          <Input aria-label="Job id to run" type="number" value={activeTask.run_job_id} placeholder="job_id"
                            onChange={(_, d) => patchTask(activeTask.task_key, { run_job_id: d.value })} />
                        )}
                      </Field>
                    )}

                    {/* Compute (not applicable to SQL / pipeline / run_job task types) */}
                    {!['sql_task', 'pipeline_task', 'run_job_task'].includes(activeTask.task_type) && (
                      <>
                        <Divider />
                        <Subtitle2>Compute</Subtitle2>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <Field label="Cluster">
                            <Dropdown
                              value={activeTask.compute === 'new' ? 'New job cluster' : 'Existing cluster'}
                              selectedOptions={[activeTask.compute]}
                              onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { compute: d.optionValue as 'existing' | 'new' })}
                            >
                              <Option value="existing" text="Existing cluster">Existing cluster</Option>
                              <Option value="new" text="New job cluster">New job cluster</Option>
                            </Dropdown>
                          </Field>
                          {activeTask.compute === 'existing' ? (
                            <Field label="Existing cluster" style={{ minWidth: 240 }}>
                              <Dropdown
                                placeholder="Select cluster"
                                value={clusters.find((c) => c.cluster_id === activeTask.existing_cluster_id)?.cluster_name || activeTask.existing_cluster_id}
                                selectedOptions={activeTask.existing_cluster_id ? [activeTask.existing_cluster_id] : []}
                                onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { existing_cluster_id: d.optionValue })}
                              >
                                {clusters.map((c) => (
                                  <Option key={c.cluster_id} value={c.cluster_id} text={c.cluster_name || c.cluster_id}>
                                    {c.cluster_name || c.cluster_id} · {c.state}
                                  </Option>
                                ))}
                              </Dropdown>
                            </Field>
                          ) : (
                            <>
                              <Field label="Spark version" style={{ minWidth: 220 }}>
                                <Dropdown
                                  placeholder="Runtime"
                                  value={sparkVersions.find((v) => v.key === activeTask.new_spark_version)?.name || activeTask.new_spark_version}
                                  selectedOptions={activeTask.new_spark_version ? [activeTask.new_spark_version] : []}
                                  onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { new_spark_version: d.optionValue })}
                                >
                                  {sparkVersions.slice(0, 80).map((v) => <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>)}
                                </Dropdown>
                              </Field>
                              <Field label="Node type" style={{ minWidth: 200 }}>
                                <Dropdown
                                  placeholder="Node type"
                                  value={activeTask.new_node_type_id}
                                  selectedOptions={activeTask.new_node_type_id ? [activeTask.new_node_type_id] : []}
                                  onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { new_node_type_id: d.optionValue })}
                                >
                                  {nodeTypes.slice(0, 80).map((n) => <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>{n.node_type_id}</Option>)}
                                </Dropdown>
                              </Field>
                              <Field label="Workers">
                                <Input type="number" value={String(activeTask.new_num_workers)}
                                  onChange={(_, d) => patchTask(activeTask.task_key, { new_num_workers: Number(d.value) || 0 })} />
                              </Field>
                            </>
                          )}
                        </div>
                      </>
                    )}

                    {/* Dependencies + reliability */}
                    <Divider />
                    <Subtitle2>Depends on</Subtitle2>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {tasks.filter((t) => t.task_key !== activeTask.task_key).length === 0 && (
                        <Caption1>No other tasks to depend on. Add a task to build a multi-task DAG.</Caption1>
                      )}
                      {tasks.filter((t) => t.task_key !== activeTask.task_key).map((t) => {
                        const on = activeTask.depends_on.includes(t.task_key);
                        return (
                          <Button key={t.task_key} size="small"
                            appearance={on ? 'primary' : 'outline'}
                            onClick={() => {
                              const next = on
                                ? activeTask.depends_on.filter((d) => d !== t.task_key)
                                : [...activeTask.depends_on, t.task_key];
                              patchTask(activeTask.task_key, { depends_on: next });
                            }}>
                            {on ? '✓ ' : '+ '}{t.task_key}
                          </Button>
                        );
                      })}
                    </div>
                    {activeTask.depends_on.length > 0 && (
                      <Field label="Run if (dependency outcome)">
                        <Dropdown
                          value={activeTask.run_if}
                          selectedOptions={[activeTask.run_if]}
                          onOptionSelect={(_, d) => d.optionValue && patchTask(activeTask.task_key, { run_if: d.optionValue })}
                        >
                          {['ALL_SUCCESS', 'AT_LEAST_ONE_SUCCESS', 'NONE_FAILED', 'ALL_DONE', 'AT_LEAST_ONE_FAILED', 'ALL_FAILED'].map((v) => (
                            <Option key={v} value={v} text={v}>{v}</Option>
                          ))}
                        </Dropdown>
                      </Field>
                    )}

                    <Divider />
                    <Subtitle2>Retries &amp; timeout</Subtitle2>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      <Field label="Max retries">
                        <Input type="number" value={String(activeTask.max_retries)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { max_retries: Number(d.value) || 0 })} />
                      </Field>
                      <Field label="Min retry interval (ms)">
                        <Input type="number" value={String(activeTask.min_retry_interval_millis)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { min_retry_interval_millis: Number(d.value) || 0 })} />
                      </Field>
                      <Field label="Task timeout (s)">
                        <Input type="number" value={String(activeTask.timeout_seconds)}
                          onChange={(_, d) => patchTask(activeTask.task_key, { timeout_seconds: Number(d.value) || 0 })} />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---------------- SCHEDULE TAB ---------------- */}
          {activeTab === 'schedule' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Field label="Trigger type">
                <Dropdown
                  value={triggerType === 'none' ? 'None (manual / API only)'
                    : triggerType === 'cron' ? 'Scheduled (cron)'
                    : triggerType === 'continuous' ? 'Continuous'
                    : 'File arrival'}
                  selectedOptions={[triggerType]}
                  onOptionSelect={(_, d) => { if (d.optionValue) { setTriggerType(d.optionValue as TriggerType); markDirty(); } }}
                >
                  <Option value="none" text="None (manual / API only)">None (manual / API only)</Option>
                  <Option value="cron" text="Scheduled (cron)">Scheduled (cron)</Option>
                  <Option value="continuous" text="Continuous">Continuous</Option>
                  <Option value="file_arrival" text="File arrival">File arrival</Option>
                </Dropdown>
              </Field>
              {triggerType === 'cron' && (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Field label="Quartz cron expression" hint="e.g. 0 0 2 * * ?  (daily 02:00)">
                    <Input value={cron} onChange={(_, d) => { setCron(d.value); markDirty(); }} />
                  </Field>
                  <Field label="Timezone" hint="Cron is evaluated in this zone">
                    <Dropdown
                      aria-label="Schedule timezone"
                      value={tz}
                      selectedOptions={[tz]}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setTz(d.optionValue); markDirty(); } }}
                    >
                      {SCHEDULE_TIMEZONES.map((z) => <Option key={z} value={z} text={z}>{z}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              )}
              {triggerType === 'continuous' && (
                <MessageBar intent="info"><MessageBarBody>
                  Continuous jobs keep one run active at all times, restarting automatically. Databricks ignores cron for continuous mode.
                </MessageBarBody></MessageBar>
              )}
              {triggerType === 'file_arrival' && (
                <Field label="File arrival URL" hint="External location / volume path watched for new files">
                  <Input value={fileArrivalUrl} onChange={(_, d) => { setFileArrivalUrl(d.value); markDirty(); }} />
                </Field>
              )}
              {triggerType !== 'none' && (
                <Switch checked={paused} label="Paused"
                  onChange={(_, d) => { setPaused(!!d.checked); markDirty(); }} />
              )}
            </div>
          )}

          {/* ---------------- SETTINGS TAB ---------------- */}
          {activeTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Field label="Max concurrent runs">
                  <Input type="number" value={String(maxConcurrent)}
                    onChange={(_, d) => { setMaxConcurrent(Number(d.value) || 1); markDirty(); }} />
                </Field>
                <Field label="Job timeout (s, 0 = none)">
                  <Input type="number" value={String(jobTimeout)}
                    onChange={(_, d) => { setJobTimeout(Number(d.value) || 0); markDirty(); }} />
                </Field>
              </div>
              <Field label="Tags (key=value per line)">
                <Textarea rows={3} value={tagsText} onChange={(_, d) => { setTagsText(d.value); markDirty(); }} />
              </Field>
              <Field label="Job parameters (key=default per line)" hint="Surfaced as job_parameters on run-now">
                <Textarea rows={3} value={jobParamsText} onChange={(_, d) => { setJobParamsText(d.value); markDirty(); }} />
              </Field>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Field label="Email on failure (comma-separated)" style={{ flex: 1, minWidth: 240 }}>
                  <Input value={emailOnFailure} onChange={(_, d) => { setEmailOnFailure(d.value); markDirty(); }} />
                </Field>
                <Field label="Email on success (comma-separated)" style={{ flex: 1, minWidth: 240 }}>
                  <Input value={emailOnSuccess} onChange={(_, d) => { setEmailOnSuccess(d.value); markDirty(); }} />
                </Field>
              </div>
            </div>
          )}

          {/* ---------------- RUNS TAB ---------------- */}
          {activeTab === 'runs' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2 style={{ flex: 1 }}>Run history</Subtitle2>
                <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={refreshRuns}>Refresh</Button>
                <Button size="small" appearance="primary" icon={<Play20Regular />} disabled={!canRunNow} onClick={runNow}>
                  {running ? 'Submitting…' : 'Run now'}
                </Button>
              </div>
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Run history">
                  <TableHeader><TableRow>
                    <TableHeaderCell>run_id</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Start</TableHeaderCell>
                    <TableHeaderCell>Exec</TableHeaderCell>
                    <TableHeaderCell>Creator</TableHeaderCell>
                    <TableHeaderCell>Output</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {runs.length === 0 && (
                      <TableRow><TableCell colSpan={6}><Caption1>No runs yet. Click Run now.</Caption1></TableCell></TableRow>
                    )}
                    {runs.map((r) => (
                      <TableRow key={r.run_id}>
                        <TableCell>{r.run_id}</TableCell>
                        <TableCell>
                          <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                            {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                          </Badge>
                        </TableCell>
                        <TableCell>{fmtTime(r.start_time)}</TableCell>
                        <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                        <TableCell>{r.creator_user_name || '—'}</TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" onClick={() => openRunOutput(r.run_id)}>View</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {/* ---------------- JSON TAB ---------------- */}
          {activeTab === 'json' && (
            <>
              <Caption1>Live job spec (the exact payload sent to <code>jobs/create</code> / <code>jobs/reset</code>) — parity with Databricks &quot;View JSON&quot;.</Caption1>
              <MonacoTextarea value={specJson} onChange={() => { /* read-only view */ }} language="json" height={420} minHeight={300} ariaLabel="Job spec JSON" readOnly />
            </>
          )}

          {/* Run output drawer */}
          <Dialog open={outOpen} onOpenChange={(_, d) => setOutOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '900px', width: '92vw' }}>
              <DialogBody>
                <DialogTitle>Run output — run_id {outRunId}</DialogTitle>
                <DialogContent>
                  {outBusy && <Spinner size="small" label="Loading run output…" labelPosition="after" />}
                  {outError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{outError}</MessageBarBody></MessageBar>}
                  {outData?.run && (
                    <div style={{ marginBottom: 8 }}>
                      <Badge appearance="outline" color={runStateColor(outData.run.state?.result_state)}>
                        {outData.run.state?.life_cycle_state || '—'}{outData.run.state?.result_state ? ` · ${outData.run.state.result_state}` : ''}
                      </Badge>
                      {outData.run.state?.state_message && <Caption1> · {outData.run.state.state_message}</Caption1>}
                    </div>
                  )}
                  {outNote && <MessageBar intent="info"><MessageBarBody>{outNote}</MessageBarBody></MessageBar>}
                  {outData?.output?.error && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Task error</MessageBarTitle>{outData.output.error}</MessageBarBody></MessageBar>
                  )}
                  {outData?.output?.notebook_output?.result !== undefined && (
                    <>
                      <Caption1>Notebook output</Caption1>
                      <pre className={s.cellPre}>{String(outData.output.notebook_output.result)}</pre>
                    </>
                  )}
                  {outData?.output?.logs && (
                    <>
                      <Caption1>Logs{outData.output.logs_truncated ? ' (truncated)' : ''}</Caption1>
                      <pre className={s.cellPre}>{outData.output.logs}</pre>
                    </>
                  )}
                  {outData?.output?.error_trace && (
                    <>
                      <Caption1>Error trace</Caption1>
                      <pre className={s.cellPre} style={{ color: tokens.colorPaletteRedForeground1 }}>{outData.output.error_trace}</pre>
                    </>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setOutOpen(false)} disabled={outBusy}>Close</Button>
                  <Button appearance="primary" onClick={() => outRunId != null && openRunOutput(outRunId)} disabled={outBusy || outRunId == null}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// Databricks Cluster editor
// ============================================================

interface ClusterEvent {
  timestamp?: number;
  type?: string;
  details?: { reason?: { code?: string }; cause?: string; user?: string; current_num_workers?: number };
}

export function DatabricksClusterEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [sparkVersion, setSparkVersion] = useState('');
  const [autoscale, setAutoscale] = useState(true);
  const [minWorkers, setMinWorkers] = useState(2);
  const [maxWorkers, setMaxWorkers] = useState(8);
  const [numWorkers, setNumWorkers] = useState(2);
  const [autoterm, setAutoterm] = useState(60);

  const [nodeTypes, setNodeTypes] = useState<{ node_type_id: string; description?: string }[]>([]);
  const [sparkVersions, setSparkVersions] = useState<{ key: string; name: string }[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [libraries, setLibraries] = useState<ClusterLibrary[]>([]);
  const [librariesErr, setLibrariesErr] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'config' | 'libraries' | 'init' | 'events'>('config');

  const loadClusters = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setClusters(j.clusters || []);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadClusters();
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster/options');
      const j = await r.json();
      if (j.ok) {
        setNodeTypes(j.nodeTypes || []);
        setSparkVersions(j.sparkVersions || []);
        if (!nodeType && j.nodeTypes?.[0]) setNodeType(j.nodeTypes[0].node_type_id);
        if (!sparkVersion && j.sparkVersions?.[0]) setSparkVersion(j.sparkVersions[0].key);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectCluster = useCallback(async (cid: string) => {
    setClusterId(cid);
    setSaveError(null);
    setStateError(null);
    setSaveMessage(null);
    try {
      const r = await fetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(cid)}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const c = j.cluster as Cluster;
      setCluster(c);
      setName(c.cluster_name || '');
      setNodeType(c.node_type_id || '');
      setSparkVersion(c.spark_version || '');
      if (c.autoscale) {
        setAutoscale(true);
        setMinWorkers(c.autoscale.min_workers || 2);
        setMaxWorkers(c.autoscale.max_workers || 8);
      } else {
        setAutoscale(false);
        setNumWorkers(c.num_workers || 2);
      }
      setAutoterm(c.autotermination_minutes ?? 60);
      // events
      const er = await fetch(`/api/items/databricks-cluster/${id}/events?clusterId=${encodeURIComponent(cid)}&limit=50`);
      const ej = await er.json();
      if (ej.ok) setEvents(ej.events || []);
      // v3.4 — libraries (read-only). Renders in the Libraries tab.
      setLibrariesErr(null);
      try {
        const lr = await fetch(`/api/items/databricks-cluster/${id}/libraries?clusterId=${encodeURIComponent(cid)}`);
        const lj = await lr.json();
        if (lj.ok) setLibraries(lj.libraries || []);
        else { setLibraries([]); setLibrariesErr(lj.error || `HTTP ${lr.status}`); }
      } catch (le: any) { setLibrariesErr(le?.message || String(le)); }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      cluster_name: name || 'untitled-cluster',
      spark_version: sparkVersion,
      node_type_id: nodeType,
      autotermination_minutes: autoterm,
    };
    if (autoscale) spec.autoscale = { min_workers: minWorkers, max_workers: maxWorkers };
    else spec.num_workers = numWorkers;
    return spec;
  }, [name, sparkVersion, nodeType, autoscale, minWorkers, maxWorkers, numWorkers, autoterm]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    // Phase 4.5 — call buildSpec before the await so any in-flight typing
    // during the request lands in the next save, not silently dropped.
    const spec = buildSpec();
    try {
      if (!clusterId) {
        const r = await fetch('/api/items/databricks-cluster', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        // Defensive parse — if the Container App / WAF returns HTML,
        // surface a useful message instead of throwing 'Unexpected
        // token <'.
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!j || !j.ok) {
          const rawErr = j?.error || (await r.text().catch(() => ''))?.slice(0, 240) || `HTTP ${r.status}`;
          // Specifically remediate the SCIM-entitlement gap. The cluster
          // editor's most common 403 is the Console UAMI lacking the
          // allow-cluster-create entitlement (see
          // platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep
          // and docs/fiab/runbooks/databricks-cluster-create-permission.md).
          const looksLikePermDenied =
            /PERMISSION_DENIED/.test(rawErr) ||
            /not authorized to create clusters/i.test(rawErr) ||
            /allow-cluster-create/i.test(rawErr) ||
            r.status === 403;
          if (looksLikePermDenied) {
            setSaveError(
              "Databricks denied the create-cluster call (PERMISSION_DENIED). " +
              "The Loom Console UAMI was registered in the workspace without the " +
              "`allow-cluster-create` entitlement. Fix: re-run the SCIM bootstrap " +
              "deploymentScript via `azd up` (idempotent, takes ~2 min) — it now " +
              "PATCHes existing service principals with the full entitlement set " +
              "(workspace-access, databricks-sql-access, allow-cluster-create, " +
              "allow-instance-pool-create). Runbook: docs/fiab/runbooks/" +
              "databricks-cluster-create-permission.md"
            );
          } else {
            setSaveError(rawErr);
          }
          return;
        }
        setSaveMessage(`Created cluster ${j.cluster_id} at ${new Date().toLocaleTimeString()}`);
        await loadClusters();
        setClusterId(j.cluster_id);
        await selectCluster(j.cluster_id);
      } else {
        // Edit an existing cluster via POST /api/2.0/clusters/edit. Databricks
        // only allows edit while the cluster is RUNNING or TERMINATED; any
        // other state returns 400 INVALID_STATE, which we surface verbatim.
        const r = await fetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(clusterId)}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!j || !j.ok) {
          const rawErr = j?.error || (await r.text().catch(() => ''))?.slice(0, 240) || `HTTP ${r.status}`;
          if (/INVALID_STATE/i.test(rawErr) || /Clusters in state/i.test(rawErr)) {
            setSaveError(
              `Databricks rejected the edit: ${rawErr}. A cluster can only be edited while it is ` +
              `RUNNING or TERMINATED. Stop (terminate) the cluster, edit it, then Start — or edit ` +
              `while it is fully RUNNING.`,
            );
          } else {
            setSaveError(rawErr);
          }
          return;
        }
        setSaveMessage(`Saved cluster ${clusterId} at ${new Date().toLocaleTimeString()}`);
        await loadClusters();
        await selectCluster(clusterId);
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, clusterId, buildSpec, loadClusters, selectCluster]);

  const doState = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!clusterId) return;
    setStateBusy(true);
    setStateError(null);
    try {
      const r = await fetch(`/api/items/databricks-cluster/${id}/state?clusterId=${encodeURIComponent(clusterId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) setStateError(j.error || `HTTP ${r.status}`);
      else {
        // refresh
        await selectCluster(clusterId);
        await loadClusters();
      }
    } catch (e: any) { setStateError(e?.message || String(e)); }
    finally { setStateBusy(false); }
  }, [id, clusterId, selectCluster, loadClusters]);

  const del = useCallback(async () => {
    if (!clusterId) return;
    if (!window.confirm(`Permanently delete cluster ${clusterId}?`)) return;
    await fetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(clusterId)}&permanent=true`, { method: 'DELETE' });
    setClusterId(null);
    setCluster(null);
    await loadClusters();
  }, [id, clusterId, loadClusters]);

  // Ctrl/Cmd+S to save when not already busy — works for both create
  // (clusterId === null → /clusters/create) and edit (existing cluster →
  // /clusters/edit), matching the family-wide muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, save]);

  const state = cluster?.state || (clusterId ? 'UNKNOWN' : 'NEW');

  const canStartCluster = !!clusterId && !stateBusy && state !== 'RUNNING' && state !== 'PENDING';
  const canStopCluster = !!clusterId && !stateBusy && state !== 'TERMINATED' && state !== 'TERMINATING';
  const canRestartCluster = !!clusterId && !stateBusy && state === 'RUNNING';
  const ribbonCluster: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Cluster', actions: [
        { label: saving ? 'Saving…' : clusterId ? 'Save' : 'Create', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Delete', onClick: clusterId ? del : undefined, disabled: !clusterId },
      ]},
      { label: 'State', actions: [
        { label: 'Start', onClick: canStartCluster ? () => doState('start') : undefined, disabled: !canStartCluster },
        { label: 'Stop', onClick: canStopCluster ? () => doState('stop') : undefined, disabled: !canStopCluster },
        { label: 'Restart', onClick: canRestartCluster ? () => doState('restart') : undefined, disabled: !canRestartCluster },
      ]},
    ]},
  ], [saving, clusterId, save, del, canStartCluster, canStopCluster, canRestartCluster, doState]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonCluster}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Subtitle2 style={{ flex: 1 }}>Clusters ({clusters.length})</Subtitle2>
            <Button size="small" icon={<Add20Regular />} aria-label="New cluster" onClick={() => {
              setClusterId(null); setCluster(null); setName(''); setEvents([]);
              setSaveMessage(null); setSaveError(null);
            }} />
            <Button size="small" icon={<ArrowSync20Regular />} aria-label="Refresh cluster list" onClick={loadClusters} />
          </div>
          {listError && (
            <MessageBar intent="error"><MessageBarBody>{listError}</MessageBarBody></MessageBar>
          )}
          {clusters.map((c) => (
            <div
              key={c.cluster_id}
              role="button"
              tabIndex={0}
              aria-label={`Open cluster ${c.cluster_name || c.cluster_id}`}
              onClick={() => selectCluster(c.cluster_id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCluster(c.cluster_id); } }}
              style={{
                padding: 6, cursor: 'pointer', borderRadius: 3,
                background: clusterId === c.cluster_id ? tokens.colorNeutralBackground2Selected : undefined,
              }}
            >
              <Body1>{c.cluster_name || c.cluster_id}</Body1>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge appearance="filled" color={clusterStateColor(c.state)} size="small">{c.state || '?'}</Badge>
                <Caption1>{c.node_type_id || '—'}</Caption1>
              </div>
            </div>
          ))}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={clusterStateColor(state)}>{state}</Badge>
            {cluster?.state_message && <Caption1>{cluster.state_message}</Caption1>}
            <Button appearance="primary" icon={<Save20Regular />} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : clusterId ? 'Save changes' : 'Create'}
            </Button>
            {clusterId && (
              <>
                <Tooltip content={state === 'RUNNING' || state === 'PENDING' ? `Cluster is already ${state.toLowerCase()}` : 'Start the cluster (clusters/start)'} relationship="label">
                  <Button appearance="outline" icon={<Play20Regular />}
                    disabled={stateBusy || state === 'RUNNING' || state === 'PENDING'}
                    onClick={() => doState('start')}>Start</Button>
                </Tooltip>
                <Tooltip content={state === 'TERMINATED' || state === 'TERMINATING' ? `Cluster is already ${state.toLowerCase()}` : 'Terminate the cluster (clusters/delete)'} relationship="label">
                  <Button appearance="outline" icon={<Stop20Regular />}
                    disabled={stateBusy || state === 'TERMINATED' || state === 'TERMINATING'}
                    onClick={() => doState('stop')}>Stop</Button>
                </Tooltip>
                <Tooltip content={state !== 'RUNNING' ? 'Restart is only available while RUNNING' : 'Restart the cluster (clusters/restart)'} relationship="label">
                  <Button appearance="outline" icon={<ArrowSync20Regular />}
                    disabled={stateBusy || state !== 'RUNNING'}
                    onClick={() => doState('restart')}>Restart</Button>
                </Tooltip>
                <Button appearance="outline" icon={<Delete20Regular />} aria-label="Permanently delete cluster" onClick={del}>Delete</Button>
              </>
            )}
          </div>

          {saveError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>{saveError}
          </MessageBarBody></MessageBar>}
          {stateError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>State change failed</MessageBarTitle>{stateError}
          </MessageBarBody></MessageBar>}
          {saveMessage && <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>}

          {clusterId && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Editing an existing cluster</MessageBarTitle>
                Change the name, node type, runtime, autoscale / workers, or autotermination, then click
                <strong> Save</strong> to call <code>POST /api/2.0/clusters/edit</code>. Databricks only allows
                edits while the cluster is <strong>RUNNING</strong> or <strong>TERMINATED</strong>; in any other
                state it returns INVALID_STATE.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Cluster name">
            <Input value={name} onChange={(_, d) => setName(d.value)} />
          </Field>
          <div style={{ display: 'flex', gap: 12 }}>
            <Field label="Node type" style={{ flex: 1 }}>
              <Dropdown
                value={nodeType}
                selectedOptions={nodeType ? [nodeType] : []}
                onOptionSelect={(_, d) => d.optionValue && setNodeType(d.optionValue)}
              >
                {nodeTypes.slice(0, 80).map((n) => (
                  <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>
                    {n.node_type_id}{n.description ? ` · ${n.description}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Spark version" style={{ flex: 1 }}>
              <Dropdown
                value={sparkVersions.find((v) => v.key === sparkVersion)?.name || sparkVersion}
                selectedOptions={sparkVersion ? [sparkVersion] : []}
                onOptionSelect={(_, d) => d.optionValue && setSparkVersion(d.optionValue)}
              >
                {sparkVersions.slice(0, 80).map((v) => (
                  <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>
                ))}
              </Dropdown>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <Switch checked={autoscale} onChange={(_, d) => setAutoscale(!!d.checked)} label="Autoscale" />
            {autoscale ? (
              <>
                <Field label="Min workers">
                  <Input type="number" value={String(minWorkers)}
                    onChange={(_, d) => setMinWorkers(Number(d.value) || 1)} />
                </Field>
                <Field label="Max workers">
                  <Input type="number" value={String(maxWorkers)}
                    onChange={(_, d) => setMaxWorkers(Number(d.value) || 1)} />
                </Field>
              </>
            ) : (
              <Field label="Workers">
                <Input type="number" value={String(numWorkers)}
                  onChange={(_, d) => setNumWorkers(Number(d.value) || 1)} />
              </Field>
            )}
            <Field label="Autotermination (min)">
              <Input type="number" value={String(autoterm)}
                onChange={(_, d) => setAutoterm(Number(d.value) || 0)} />
            </Field>
          </div>

          {clusterId && (
            <>
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginTop: 12 }}>
                <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as 'config' | 'libraries' | 'init' | 'events')}>
                  <Tab value="config">Spark config ({Object.keys(cluster?.spark_conf || {}).length})</Tab>
                  <Tab value="libraries">Libraries ({libraries.length})</Tab>
                  <Tab value="init">Init scripts ({(cluster?.init_scripts || []).length})</Tab>
                  <Tab value="events">Events ({events.length})</Tab>
                </TabList>
              </div>

              {detailTab === 'config' && (
                <>
                  {!cluster?.spark_conf || Object.keys(cluster.spark_conf).length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No custom <code>spark_conf</code> keys on this cluster. Spark uses Databricks defaults.</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Spark config">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Key</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(cluster.spark_conf).map(([k, v]) => (
                            <TableRow key={k}>
                              <TableCell><code style={{ fontSize: 12 }}>{k}</code></TableCell>
                              <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{v}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'libraries' && (
                <>
                  {librariesErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Library list failed</MessageBarTitle>{librariesErr}</MessageBarBody></MessageBar>}
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Read-only library status</MessageBarTitle>
                      Install + uninstall is performed in the Databricks workspace UI — each non-public source
                      (private PyPI, ADO artifact feeds, JARs in protected blob containers) needs its own
                      credential dance. The Loom editor surfaces the per-library install state via
                      <code> /api/2.0/libraries/cluster-status</code>.
                    </MessageBarBody>
                  </MessageBar>
                  {libraries.length === 0 ? (
                    <Caption1>No libraries attached.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Cluster libraries">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Coordinates / package</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Messages</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {libraries.map((lib, i) => {
                            const l = lib.library || {};
                            const t = l.pypi ? 'pypi' : l.maven ? 'maven' : l.cran ? 'cran' : l.jar ? 'jar' : l.whl ? 'whl' : l.egg ? 'egg' : l.requirements ? 'requirements' : '?';
                            const coords = l.pypi?.package || l.maven?.coordinates || l.cran?.package || l.jar || l.whl || l.egg || l.requirements || '—';
                            return (
                              <TableRow key={i}>
                                <TableCell><Badge appearance="outline">{t}</Badge></TableCell>
                                <TableCell><code style={{ fontSize: 12 }}>{coords}</code></TableCell>
                                <TableCell><Badge appearance="filled" color={lib.status === 'INSTALLED' ? 'success' : lib.status === 'FAILED' ? 'danger' : 'warning'}>{lib.status || '—'}</Badge></TableCell>
                                <TableCell style={{ fontSize: 11 }}>{(lib.messages || []).join('; ') || '—'}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'init' && (
                <>
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Read-only init script list</MessageBarTitle>
                      Init scripts run on every node when the cluster starts. Edit + reorder in the Databricks
                      workspace UI (Compute → cluster → Advanced options → Init scripts) — Loom surfaces the
                      configured list from <code>/api/2.0/clusters/get</code>.
                    </MessageBarBody>
                  </MessageBar>
                  {(cluster?.init_scripts || []).length === 0 ? (
                    <Caption1>No init scripts configured.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Init scripts">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Source</TableHeaderCell>
                          <TableHeaderCell>Destination</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {(cluster?.init_scripts || []).map((script, i) => {
                            const src = script.workspace ? 'workspace' : script.volumes ? 'volumes' : script.dbfs ? 'dbfs' : script.abfss ? 'abfss' : script.s3 ? 's3' : script.gcs ? 'gcs' : script.file ? 'file' : '?';
                            const dest = script.workspace?.destination || script.volumes?.destination || script.dbfs?.destination || script.abfss?.destination || script.s3?.destination || script.gcs?.destination || script.file?.destination || '—';
                            return (
                              <TableRow key={i}>
                                <TableCell><Badge appearance="outline">{src}</Badge></TableCell>
                                <TableCell><code style={{ fontSize: 12 }}>{dest}</code></TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'events' && (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Cluster events">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Time</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Reason / cause</TableHeaderCell>
                      <TableHeaderCell>Workers</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {events.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No events.</Caption1></TableCell></TableRow>
                      )}
                      {events.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell>{fmtTime(e.timestamp)}</TableCell>
                          <TableCell><Badge appearance="outline">{e.type || '—'}</Badge></TableCell>
                          <TableCell>{(e.details as any)?.reason?.code || (e.details as any)?.cause || '—'}</TableCell>
                          <TableCell>{(e.details as any)?.current_num_workers ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}
