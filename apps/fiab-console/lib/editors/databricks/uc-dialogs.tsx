'use client';

/**
 * Databricks editors — Unity Catalog governance dialogs.
 *
 * The cohesive group of UC write-path / governance dialogs rendered by the
 * SQL Warehouse editor. Extracted verbatim from databricks-editors.tsx
 * (behavior-preserving split — zero logic change).
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
import { useStyles, fmtTime } from './shared';


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
  /** When set as the grant dialog opens, pre-selects this securable type + full
   *  name (e.g. FUNCTION + a registered-model full name) instead of the tree
   *  context default. */
  grantSeed?: { securable: UcSecurable; fullName: string } | null;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
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
    grantSeed,
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
  const tblFileInputRef = useRef<HTMLInputElement | null>(null);
  const [tblFileDragOver, setTblFileDragOver] = useState(false);
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

  const clearPickedFile = useCallback(() => {
    setTblFileName(''); setTblFileContent('');
    if (tblFileInputRef.current) tblFileInputRef.current.value = '';
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
    // An explicit grant-seed (e.g. a registered model → FUNCTION securable) wins
    // over the tree-context default.
    if (grantSeed && grantSeed.fullName) { setGrSecurable(grantSeed.securable); setGrFullName(grantSeed.fullName); return; }
    if (activeSchema && activeCatalog) { setGrSecurable('SCHEMA'); setGrFullName(`${activeCatalog}.${activeSchema}`); }
    else if (activeCatalog) { setGrSecurable('CATALOG'); setGrFullName(activeCatalog); }
  }, [grantsOpen, activeCatalog, activeSchema, grantSeed]);

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
                        ref={tblFileInputRef}
                        type="file"
                        className={s.visuallyHidden}
                        accept=".csv,.json,.parquet,.orc,.avro,.txt,text/csv,application/json"
                        aria-label="Choose a data file"
                        onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                      />
                      {tblFileName ? (
                        <div className={s.filePicked}>
                          <Document20Regular className={s.fileDropIcon} />
                          <Body1 className={s.filePickedName} title={tblFileName}>{tblFileName}</Body1>
                          <Caption1>{tblFileContent.length.toLocaleString()} chars</Caption1>
                          <Button size="small" appearance="subtle" icon={<ArrowUpload20Regular />} onClick={() => tblFileInputRef.current?.click()}>Replace</Button>
                          <Tooltip content="Remove file" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove file" onClick={clearPickedFile} />
                          </Tooltip>
                        </div>
                      ) : (
                        <div
                          role="button"
                          tabIndex={0}
                          aria-label="Choose or drop a data file"
                          className={tblFileDragOver ? `${s.fileDrop} ${s.fileDropActive}` : s.fileDrop}
                          onClick={() => tblFileInputRef.current?.click()}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tblFileInputRef.current?.click(); } }}
                          onDragOver={(e) => { e.preventDefault(); setTblFileDragOver(true); }}
                          onDragLeave={() => setTblFileDragOver(false)}
                          onDrop={(e) => { e.preventDefault(); setTblFileDragOver(false); onPickFile(e.dataTransfer.files?.[0] || null); }}
                        >
                          <CloudArrowUp24Regular className={s.fileDropIcon} />
                          <Body1>Drop a file here, or <strong>browse</strong></Body1>
                          <Caption1>CSV · JSON · Parquet · ORC · Avro · text</Caption1>
                        </div>
                      )}
                    </Field>
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
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' }}>
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

// ============================================================
// UC tag governance dialogs (wave c1) — object/column tags + governed tags.
// Real Databricks SQL DDL via /api/databricks/unity-catalog/{tags,governed-tags}.
// ============================================================

interface TagPair { key: string; value: string }

function TagChips({ tags, onRemove, busy }: { tags: TagPair[]; onRemove: (key: string) => void; busy: boolean }) {
  if (!tags.length) return <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No tags.</Caption1>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS }}>
      {tags.map((t) => (
        <span key={t.key} style={{
          display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
          padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
          borderRadius: tokens.borderRadiusMedium,
          backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground2,
          border: `1px solid ${tokens.colorBrandStroke2}`,
        }}>
          <Tag20Regular style={{ fontSize: '14px' }} />
          <Caption1>{t.key}{t.value ? `=${t.value}` : ''}</Caption1>
          <Button size="small" appearance="transparent" icon={<Dismiss16Regular />} aria-label={`Remove tag ${t.key}`} disabled={busy} onClick={() => onRemove(t.key)} />
        </span>
      ))}
    </div>
  );
}

function UcTagsDialog({ open, onOpenChange, target, warehouseId, onChanged }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  target: { catalog: string; schema: string; table: string } | null;
  warehouseId: string; onChanged: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tableTags, setTableTags] = useState<TagPair[]>([]);
  const [colTags, setColTags] = useState<Record<string, TagPair[]>>({});
  const [columns, setColumns] = useState<string[]>([]);
  const [col, setCol] = useState('');
  const [newTbl, setNewTbl] = useState<KvRow[]>([{ key: '', value: '' }]);
  const [newCol, setNewCol] = useState<KvRow[]>([{ key: '', value: '' }]);

  const base = '/api/databricks/unity-catalog/tags';

  const reload = useCallback(async () => {
    if (!target) return;
    setLoading(true); setErr(null); setGate(null);
    try {
      const p = new URLSearchParams({ catalog: target.catalog, schema: target.schema, table: target.table });
      if (warehouseId) p.set('warehouseId', warehouseId);
      const r = await fetch(`${base}?${p.toString()}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'failed to read tags'); return; }
      setTableTags((j.tableTags || []).map((t: any) => ({ key: String(t.tag_name), value: String(t.tag_value ?? '') })));
      const byCol: Record<string, TagPair[]> = {};
      for (const t of (j.columnTags || [])) {
        const cn = String(t.column_name);
        (byCol[cn] ||= []).push({ key: String(t.tag_name), value: String(t.tag_value ?? '') });
      }
      setColTags(byCol);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [target, warehouseId]);

  const loadColumns = useCallback(async () => {
    if (!target) return;
    try {
      const r = await fetch(`/api/databricks/unity-catalog/tables?full_name=${encodeURIComponent(`${target.catalog}.${target.schema}.${target.table}`)}`);
      const j = await r.json();
      if (j.ok && j.table?.columns) setColumns(j.table.columns.map((c: any) => String(c.name)));
    } catch { /* best-effort */ }
  }, [target]);

  useEffect(() => {
    if (open && target) {
      void reload(); void loadColumns();
      setNewTbl([{ key: '', value: '' }]); setNewCol([{ key: '', value: '' }]); setCol('');
    }
  }, [open, target, reload, loadColumns]);

  const run = async (payload: any): Promise<boolean> => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, warehouseId }) });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return false; }
      if (!j.ok) { setErr(j.error || 'tag operation failed'); return false; }
      await reload(); onChanged(); return true;
    } catch (e: any) { setErr(e?.message || String(e)); return false; }
    finally { setBusy(false); }
  };

  const applyTableTags = async () => {
    if (!target) return;
    const tags = newTbl.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value }));
    if (!tags.length) return;
    if (await run({ action: 'set', catalog: target.catalog, schema: target.schema, name: target.table, kind: 'TABLE', tags })) setNewTbl([{ key: '', value: '' }]);
  };
  const removeTableTag = (key: string) => { if (target) void run({ action: 'unset', catalog: target.catalog, schema: target.schema, name: target.table, kind: 'TABLE', keys: [key] }); };

  const applyColTags = async () => {
    if (!target || !col) return;
    const tags = newCol.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value }));
    if (!tags.length) return;
    if (await run({ action: 'set', catalog: target.catalog, schema: target.schema, name: target.table, column: col, tags })) setNewCol([{ key: '', value: '' }]);
  };
  const removeColTag = (key: string) => { if (target && col) void run({ action: 'unset', catalog: target.catalog, schema: target.schema, name: target.table, column: col, keys: [key] }); };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '760px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>Tags — {target ? `${target.catalog}.${target.schema}.${target.table}` : ''}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              {loading && <Spinner size="tiny" label="Reading information_schema…" labelPosition="after" />}
              {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Tag operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Subtitle2>Table tags</Subtitle2>
                <TagChips tags={tableTags} onRemove={removeTableTag} busy={busy} />
                <KvTagEditor rows={newTbl} setRows={setNewTbl} />
                <div><Button appearance="primary" icon={<Add20Regular />} disabled={busy || !newTbl.some((r) => r.key.trim())} onClick={applyTableTags}>Apply table tags</Button></div>
              </div>

              <Divider />

              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                <Subtitle2>Column tags</Subtitle2>
                <Field label="Column">
                  <Dropdown placeholder="Pick a column" value={col} selectedOptions={col ? [col] : []} onOptionSelect={(_, d) => setCol(d.optionValue || '')}>
                    {columns.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                  </Dropdown>
                </Field>
                {col && <TagChips tags={colTags[col] || []} onRemove={removeColTag} busy={busy} />}
                {col && <KvTagEditor rows={newCol} setRows={setNewCol} />}
                {col && <div><Button appearance="primary" icon={<Add20Regular />} disabled={busy || !newCol.some((r) => r.key.trim())} onClick={applyColTags}>Apply column tags</Button></div>}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function GovernedTagsDialog({ open, onOpenChange, warehouseId }: {
  open: boolean; onOpenChange: (v: boolean) => void; warehouseId: string;
}) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cols, setCols] = useState<string[]>(['Tag Key', 'Description', 'Values', 'Id']);
  const [key, setKey] = useState('');
  const [desc, setDesc] = useState('');
  const [valsCsv, setValsCsv] = useState('');

  const base = '/api/databricks/unity-catalog/governed-tags';

  const reload = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const p = new URLSearchParams();
      if (warehouseId) p.set('warehouseId', warehouseId);
      const r = await fetch(`${base}?${p.toString()}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setRows([]); return; }
      if (!j.ok) { setErr(j.error || 'failed to list governed tags'); setRows([]); return; }
      const gt: Record<string, unknown>[] = j.governedTags || [];
      setRows(gt);
      if (gt.length) setCols(Object.keys(gt[0]));
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [warehouseId]);

  useEffect(() => { if (open) void reload(); }, [open, reload]);

  const csvVals = () => valsCsv.split(',').map((x) => x.trim()).filter(Boolean);
  const run = async (payload: any): Promise<boolean> => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, warehouseId }) });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return false; }
      if (!j.ok) { setErr(j.error || 'governed-tag operation failed'); return false; }
      await reload(); return true;
    } catch (e: any) { setErr(e?.message || String(e)); return false; }
    finally { setBusy(false); }
  };

  const create = async () => { if (key.trim() && await run({ action: 'create', key: key.trim(), description: desc.trim() || undefined, values: csvVals() })) { setKey(''); setDesc(''); setValsCsv(''); } };
  const setValues = () => { if (key.trim()) void run({ action: 'alter-values', key: key.trim(), values: csvVals() }); };
  const setDescription = () => { if (key.trim()) void run({ action: 'alter-description', key: key.trim(), description: desc }); };
  const drop = (k: string) => { if (k) void run({ action: 'drop', key: k }); };
  const loadRow = (r: Record<string, unknown>) => {
    setKey(String(r['Tag Key'] ?? r['tag_key'] ?? ''));
    setDesc(String(r['Description'] ?? ''));
    const v = String(r['Values'] ?? '');
    setValsCsv(v.replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean).join(', '));
  };
  const keyCol = cols.includes('Tag Key') ? 'Tag Key' : cols[0];

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '860px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>Governed tags</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Account-level governed tags enforce an allowed key + value set (the tag policy): members with
                ASSIGN can apply them, and only from the allowed list. Backed by CREATE / ALTER / DROP GOVERNED TAG
                · SHOW GOVERNED TAGS on the SQL warehouse.
              </Caption1>
              {loading && <Spinner size="tiny" label="SHOW GOVERNED TAGS…" labelPosition="after" />}
              {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              <div style={{ overflow: 'auto', maxHeight: '300px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                <Table size="small" aria-label="Governed tags">
                  <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}<TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {rows.length === 0 && <TableRow><TableCell colSpan={cols.length + 1}><Caption1>No governed tags in this account.</Caption1></TableCell></TableRow>}
                    {rows.map((r, i) => (
                      <TableRow key={i}>
                        {cols.map((c) => <TableCell key={c}>{String(r[c] ?? '')}</TableCell>)}
                        <TableCell>
                          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
                            <Button size="small" appearance="subtle" onClick={() => loadRow(r)} disabled={busy}>Load</Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Drop governed tag" disabled={busy} onClick={() => drop(String(r[keyCol] ?? ''))} />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <Subtitle2>Create / edit governed tag</Subtitle2>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Tag key" required style={{ minWidth: 160 }}><Input value={key} onChange={(_, d) => setKey(d.value)} placeholder="pii" /></Field>
                <Field label="Description" style={{ flex: 1, minWidth: 200 }}><Input value={desc} onChange={(_, d) => setDesc(d.value)} placeholder="Personally identifiable information" /></Field>
                <Field label="Allowed values (comma-separated; empty = key-only)" style={{ flex: 1, minWidth: 200 }}><Input value={valsCsv} onChange={(_, d) => setValsCsv(d.value)} placeholder="ssn, ccn, dob" /></Field>
              </div>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                <Button appearance="primary" icon={<Add20Regular />} disabled={busy || !key.trim()} onClick={create}>Create governed tag</Button>
                <Button appearance="outline" disabled={busy || !key.trim()} onClick={setValues}>Set values</Button>
                <Button appearance="outline" disabled={busy || !key.trim()} onClick={setDescription}>Set description</Button>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}



// ============================================================
// External locations + storage credentials (wave c2) — UC governs WHERE it
// reads/writes external data. REST /api/databricks/unity-catalog/{external-
// locations,storage-credentials}. Azure-native, secret-free credential path
// (Databricks Access Connector managed identity).
// ============================================================
function ExternalLocationsDialog({ open, onOpenChange }: {
  open: boolean; onOpenChange: (v: boolean) => void;
}) {
  const [tab, setTab] = useState<'locations' | 'credentials'>('locations');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [locs, setLocs] = useState<any[]>([]);
  const [creds, setCreds] = useState<any[]>([]);

  // External-location create / edit form.
  const [locName, setLocName] = useState('');
  const [locUrl, setLocUrl] = useState('');
  const [locCred, setLocCred] = useState('');
  const [locComment, setLocComment] = useState('');
  const [locRO, setLocRO] = useState(false);
  const [editingLoc, setEditingLoc] = useState<string | null>(null);

  // Storage-credential create form (Azure Access Connector managed identity).
  const [credName, setCredName] = useState('');
  const [credConnector, setCredConnector] = useState('');
  const [credMi, setCredMi] = useState('');
  const [credComment, setCredComment] = useState('');
  const [credRO, setCredRO] = useState(false);

  const LOC = '/api/databricks/unity-catalog/external-locations';
  const CRED = '/api/databricks/unity-catalog/storage-credentials';

  const reload = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const [lr, cr] = await Promise.all([fetch(LOC), fetch(CRED)]);
      const lj = await lr.json(); const cj = await cr.json();
      if (lj.gated) { setGate(lj.error); setLocs([]); }
      else if (lj.ok) setLocs(lj.externalLocations || []);
      else setErr(lj.error || 'failed to list external locations');
      if (cj.gated) { if (!lj.gated) setGate(cj.error); setCreds([]); }
      else if (cj.ok) setCreds(cj.storageCredentials || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);

  const resetLoc = () => { setLocName(''); setLocUrl(''); setLocCred(''); setLocComment(''); setLocRO(false); setEditingLoc(null); };
  const resetCred = () => { setCredName(''); setCredConnector(''); setCredMi(''); setCredComment(''); setCredRO(false); };

  const saveLoc = async () => {
    setBusy(true); setErr(null);
    try {
      const editing = !!editingLoc;
      const r = await fetch(LOC, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editing
          ? { name: editingLoc, comment: locComment, read_only: locRO, url: locUrl || undefined, credential_name: locCred || undefined }
          : { name: locName.trim(), url: locUrl.trim(), credential_name: locCred, comment: locComment || undefined, read_only: locRO }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'external-location operation failed'); return; }
      resetLoc(); await reload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const deleteLoc = async (name: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${LOC}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok && !j.gated) { setErr(j.error || 'delete failed'); return; }
      if (j.gated) { setGate(j.error); return; }
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const editLoc = (l: any) => { setTab('locations'); setEditingLoc(l.name); setLocName(l.name); setLocUrl(l.url || ''); setLocCred(l.credential_name || ''); setLocComment(l.comment || ''); setLocRO(!!l.read_only); };

  const createCred = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(CRED, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: credName.trim(), access_connector_id: credConnector.trim(), managed_identity_id: credMi.trim() || undefined, comment: credComment || undefined, read_only: credRO }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'storage-credential create failed'); return; }
      resetCred(); await reload();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const deleteCred = async (name: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${CRED}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'delete failed'); return; }
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '960px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>External locations &amp; storage credentials</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Unity Catalog governs access to cloud storage with two objects: a <b>storage credential</b> (an Azure
                Databricks Access Connector managed identity — no secret) and an <b>external location</b> (a storage path +
                the credential it authorizes through). Backed by real UC REST; the Console UAMI needs CREATE STORAGE
                CREDENTIAL / CREATE EXTERNAL LOCATION on the metastore.
              </Caption1>
              {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
              {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)} size="small">
                <Tab value="locations" icon={<CloudLink20Regular />}>External locations ({locs.length})</Tab>
                <Tab value="credentials" icon={<Key20Regular />}>Storage credentials ({creds.length})</Tab>
              </TabList>

              {tab === 'locations' && (
                <>
                  <div style={{ overflow: 'auto', maxHeight: '260px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                    <Table size="small" aria-label="External locations">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>URL</TableHeaderCell><TableHeaderCell>Credential</TableHeaderCell><TableHeaderCell>Read-only</TableHeaderCell><TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {locs.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No external locations.</Caption1></TableCell></TableRow>}
                        {locs.map((l) => (
                          <TableRow key={l.name}>
                            <TableCell>{l.name}</TableCell>
                            <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{l.url}</span></TableCell>
                            <TableCell>{l.credential_name || '—'}</TableCell>
                            <TableCell>{l.read_only ? <Badge appearance="tint" color="warning">read-only</Badge> : '—'}</TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXXS }}>
                                <Button size="small" appearance="subtle" disabled={busy} onClick={() => editLoc(l)}>Edit</Button>
                                <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete external location" disabled={busy} onClick={() => deleteLoc(l.name)} />
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Subtitle2>{editingLoc ? `Edit external location · ${editingLoc}` : 'Create external location'}</Subtitle2>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Name" required style={{ minWidth: 160 }}><Input value={locName} disabled={!!editingLoc} onChange={(_, d) => setLocName(d.value)} placeholder="bronze_ext" /></Field>
                    <Field label="Storage URL" required style={{ flex: 1, minWidth: 260 }}><Input value={locUrl} onChange={(_, d) => setLocUrl(d.value)} placeholder="abfss://container@account.dfs.core.windows.net/path" /></Field>
                    <Field label="Storage credential" required style={{ minWidth: 180 }}>
                      <Dropdown selectedOptions={locCred ? [locCred] : []} value={locCred} placeholder="Select credential" onOptionSelect={(_, d) => setLocCred(d.optionValue || '')}>
                        {creds.map((c) => <Option key={c.name} value={c.name}>{c.name}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Comment" style={{ flex: 1, minWidth: 240 }}><Input value={locComment} onChange={(_, d) => setLocComment(d.value)} placeholder="Bronze landing zone" /></Field>
                    <Switch label="Read-only" checked={locRO} onChange={(_, d) => setLocRO(d.checked)} />
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                    <Button appearance="primary" icon={<Add20Regular />} disabled={busy || !locName.trim() || (!editingLoc && (!locUrl.trim() || !locCred))} onClick={saveLoc}>{editingLoc ? 'Save changes' : 'Create external location'}</Button>
                    {editingLoc && <Button appearance="outline" disabled={busy} onClick={resetLoc}>Cancel edit</Button>}
                  </div>
                </>
              )}

              {tab === 'credentials' && (
                <>
                  <div style={{ overflow: 'auto', maxHeight: '260px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                    <Table size="small" aria-label="Storage credentials">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Access connector</TableHeaderCell><TableHeaderCell>Comment</TableHeaderCell><TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {creds.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No storage credentials.</Caption1></TableCell></TableRow>}
                        {creds.map((c) => (
                          <TableRow key={c.name}>
                            <TableCell>{c.name}</TableCell>
                            <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{c.azure_managed_identity?.access_connector_id?.split('/').pop() || '—'}</span></TableCell>
                            <TableCell>{c.comment || '—'}</TableCell>
                            <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete storage credential" disabled={busy} onClick={() => deleteCred(c.name)} /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Subtitle2>Create storage credential (Azure Access Connector)</Subtitle2>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Azure-native, secret-free: paste the ARM resource id of your Azure Databricks <b>Access Connector</b>.
                    For a user-assigned managed identity, also set the Managed identity id; leave it blank for system-assigned.
                  </Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Name" required style={{ minWidth: 160 }}><Input value={credName} onChange={(_, d) => setCredName(d.value)} placeholder="lake_access" /></Field>
                    <Field label="Access connector ARM id" required style={{ flex: 1, minWidth: 320 }}><Input value={credConnector} onChange={(_, d) => setCredConnector(d.value)} placeholder="/subscriptions/…/providers/Microsoft.Databricks/accessConnectors/…" /></Field>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Managed identity id (optional, user-assigned)" style={{ flex: 1, minWidth: 280 }}><Input value={credMi} onChange={(_, d) => setCredMi(d.value)} placeholder="/subscriptions/…/userAssignedIdentities/…" /></Field>
                    <Field label="Comment" style={{ minWidth: 180 }}><Input value={credComment} onChange={(_, d) => setCredComment(d.value)} /></Field>
                    <Switch label="Read-only" checked={credRO} onChange={(_, d) => setCredRO(d.checked)} />
                  </div>
                  <div><Button appearance="primary" icon={<Add20Regular />} disabled={busy || !credName.trim() || !credConnector.trim()} onClick={createCred}>Create storage credential</Button></div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void reload()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Connections + foreign catalogs (Lakehouse Federation, wave c2). list/delete
// via REST; CREATE CONNECTION / CREATE FOREIGN CATALOG via SQL on the warehouse
// (credential options use secret('scope','key')). Prefill from cross-sub ARG
// connectables (/api/azure/connectables). REST /api/databricks/unity-catalog/connections.
// ============================================================
type UcConnTypeUI = 'SQLSERVER' | 'SQLDW' | 'POSTGRESQL' | 'MYSQL' | 'SNOWFLAKE' | 'REDSHIFT';
const CONN_PRESETS: Record<UcConnTypeUI, { label: string; defaultPort: string; snowflake?: boolean }> = {
  SQLSERVER: { label: 'SQL Server', defaultPort: '1433' },
  SQLDW: { label: 'Azure Synapse (SQLDW)', defaultPort: '1433' },
  POSTGRESQL: { label: 'PostgreSQL', defaultPort: '5432' },
  MYSQL: { label: 'MySQL', defaultPort: '3306' },
  SNOWFLAKE: { label: 'Snowflake', defaultPort: '443', snowflake: true },
  REDSHIFT: { label: 'Amazon Redshift', defaultPort: '5439' },
};
// Map the ARG connectable connType → a federation connection type (only the
// federatable DBMS sources; storage/cosmos/eventing aren't CREATE CONNECTION targets).
const CONNECTABLE_TO_FED: Record<string, UcConnTypeUI> = {
  'azure-sql': 'SQLSERVER',
  'synapse-serverless': 'SQLDW',
  'synapse-dedicated': 'SQLDW',
  'postgres': 'POSTGRESQL',
};

function ConnectionsDialog({ open, onOpenChange, warehouseId }: {
  open: boolean; onOpenChange: (v: boolean) => void; warehouseId: string;
}) {
  const [tab, setTab] = useState<'connections' | 'foreign'>('connections');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [conns, setConns] = useState<any[]>([]);

  // Create-connection wizard.
  const [cName, setCName] = useState('');
  const [cType, setCType] = useState<UcConnTypeUI>('SQLSERVER');
  const [cHost, setCHost] = useState('');
  const [cPort, setCPort] = useState('1433');
  const [cUser, setCUser] = useState('');
  const [cSfWarehouse, setCSfWarehouse] = useState('');
  const [cComment, setCComment] = useState('');
  const [pwMode, setPwMode] = useState<'literal' | 'secret'>('secret');
  const [cPassword, setCPassword] = useState('');
  const [cSecretScope, setCSecretScope] = useState('');
  const [cSecretKey, setCSecretKey] = useState('');

  // Prefill from ARG connectables.
  const [connectables, setConnectables] = useState<any[]>([]);
  const [prefill, setPrefill] = useState('');

  // Create-foreign-catalog form.
  const [fcName, setFcName] = useState('');
  const [fcConn, setFcConn] = useState('');
  const [fcDb, setFcDb] = useState('');
  const [fcComment, setFcComment] = useState('');

  const BASE = '/api/databricks/unity-catalog/connections';

  const reload = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      const r = await fetch(BASE);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setConns([]); return; }
      if (!j.ok) { setErr(j.error || 'failed to list connections'); setConns([]); return; }
      setConns(j.connections || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void reload(); }, [open, reload]);

  // Lazy-load connectables when the user opens the prefill dropdown.
  const loadConnectables = useCallback(async () => {
    if (connectables.length) return;
    try {
      const r = await fetch('/api/azure/connectables');
      const j = await r.json();
      if (j.ok && Array.isArray(j.resources)) {
        setConnectables(j.resources.filter((x: any) => CONNECTABLE_TO_FED[x.connType]));
      }
    } catch { /* prefill is best-effort */ }
  }, [connectables.length]);

  const applyPrefill = (armId: string) => {
    setPrefill(armId);
    const res = connectables.find((x) => x.armResourceId === armId);
    if (!res) return;
    const fed = CONNECTABLE_TO_FED[res.connType];
    if (fed) { setCType(fed); setCPort(CONN_PRESETS[fed].defaultPort); }
    if (res.host) setCHost(res.host);
    if (!cName.trim()) setCName((res.name || '').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase());
    if (res.database && !fcDb.trim()) setFcDb(res.database);
  };

  const onTypeChange = (t: UcConnTypeUI) => { setCType(t); setCPort(CONN_PRESETS[t].defaultPort); };

  const resetConn = () => { setCName(''); setCHost(''); setCUser(''); setCSfWarehouse(''); setCComment(''); setCPassword(''); setCSecretScope(''); setCSecretKey(''); setPrefill(''); };

  const createConn = async () => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const options: any[] = [
        { key: 'host', value: { kind: 'string', value: cHost.trim() } },
        { key: 'port', value: { kind: 'string', value: cPort.trim() } },
        { key: 'user', value: { kind: 'string', value: cUser.trim() } },
      ];
      if (CONN_PRESETS[cType].snowflake && cSfWarehouse.trim()) options.push({ key: 'sfWarehouse', value: { kind: 'string', value: cSfWarehouse.trim() } });
      options.push(pwMode === 'secret'
        ? { key: 'password', value: { kind: 'secret', scope: cSecretScope.trim(), key: cSecretKey.trim() } }
        : { key: 'password', value: { kind: 'string', value: cPassword } });
      const r = await fetch(BASE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-connection', name: cName.trim(), type: cType, options, comment: cComment || undefined, warehouseId: warehouseId || undefined }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'connection create failed'); return; }
      setOk(`Connection ${cName.trim()} created (${j.executionMs ?? 0} ms).`);
      setCPassword(''); resetConn(); await reload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const deleteConn = async (name: string) => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fetch(`${BASE}?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'delete failed'); return; }
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };

  const createForeign = async () => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fetch(BASE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'create-foreign-catalog', name: fcName.trim(), connection: fcConn, database: fcDb.trim(), comment: fcComment || undefined, warehouseId: warehouseId || undefined }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'foreign-catalog create failed'); return; }
      setOk(`Foreign catalog ${fcName.trim()} created — it now appears in the Catalogs tree.`);
      setFcName(''); setFcDb('');
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const pwValid = pwMode === 'secret' ? (cSecretScope.trim() && cSecretKey.trim()) : !!cPassword;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '980px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Connections — Lakehouse Federation</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Register a remote DBMS as a Unity Catalog <b>connection</b>, then mirror one of its databases as a
                read-only <b>foreign catalog</b>. Real CREATE CONNECTION / CREATE FOREIGN CATALOG DDL on the SQL warehouse;
                passwords use a Databricks <b>secret</b> reference (recommended) so the credential never appears in the SQL.
              </Caption1>
              {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
              {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
              {ok && <MessageBar intent="success"><MessageBarBody>{ok}</MessageBarBody></MessageBar>}

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)} size="small">
                <Tab value="connections" icon={<PlugConnected20Regular />}>Connections ({conns.length})</Tab>
                <Tab value="foreign" icon={<Database20Regular />}>Foreign catalog</Tab>
              </TabList>

              {tab === 'connections' && (
                <>
                  <div style={{ overflow: 'auto', maxHeight: '220px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                    <Table size="small" aria-label="Connections">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Host</TableHeaderCell><TableHeaderCell>Comment</TableHeaderCell><TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {conns.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No connections.</Caption1></TableCell></TableRow>}
                        {conns.map((c) => (
                          <TableRow key={c.name}>
                            <TableCell>{c.name}</TableCell>
                            <TableCell><Badge appearance="tint">{c.connection_type}</Badge></TableCell>
                            <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{c.options?.host || '—'}</span></TableCell>
                            <TableCell>{c.comment || '—'}</TableCell>
                            <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Delete connection" disabled={busy} onClick={() => deleteConn(c.name)} /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <Subtitle2>Create connection</Subtitle2>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Name" required style={{ minWidth: 150 }}><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="prod_sqlserver" /></Field>
                    <Field label="Type" required style={{ minWidth: 180 }}>
                      <Dropdown value={CONN_PRESETS[cType].label} selectedOptions={[cType]} onOptionSelect={(_, d) => onTypeChange((d.optionValue as UcConnTypeUI) || 'SQLSERVER')}>
                        {(Object.keys(CONN_PRESETS) as UcConnTypeUI[]).map((t) => <Option key={t} value={t}>{CONN_PRESETS[t].label}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Prefill from my Azure resources" style={{ minWidth: 240 }}>
                      <Dropdown placeholder="(optional) pick a resource" value={prefill ? (connectables.find((x) => x.armResourceId === prefill)?.name || '') : ''} selectedOptions={prefill ? [prefill] : []} onOpenChange={(_, d) => { if (d.open) void loadConnectables(); }} onOptionSelect={(_, d) => applyPrefill(d.optionValue || '')}>
                        {connectables.length === 0 && <Option value="" disabled>No federatable resources found</Option>}
                        {connectables.map((x) => <Option key={x.armResourceId} value={x.armResourceId}>{x.name} ({CONN_PRESETS[CONNECTABLE_TO_FED[x.connType]]?.label})</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Host" required style={{ flex: 1, minWidth: 240 }}><Input value={cHost} onChange={(_, d) => setCHost(d.value)} placeholder="myserver.database.windows.net" /></Field>
                    <Field label="Port" required style={{ minWidth: 90 }}><Input value={cPort} onChange={(_, d) => setCPort(d.value)} /></Field>
                    {CONN_PRESETS[cType].snowflake && <Field label="sfWarehouse" style={{ minWidth: 150 }}><Input value={cSfWarehouse} onChange={(_, d) => setCSfWarehouse(d.value)} placeholder="COMPUTE_WH" /></Field>}
                    <Field label="User" required style={{ minWidth: 160 }}><Input value={cUser} onChange={(_, d) => setCUser(d.value)} placeholder="loom_reader" /></Field>
                  </div>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Password" required style={{ minWidth: 220 }}>
                      <Dropdown value={pwMode === 'secret' ? 'Databricks secret (recommended)' : 'Literal value'} selectedOptions={[pwMode]} onOptionSelect={(_, d) => setPwMode((d.optionValue as 'literal' | 'secret') || 'secret')}>
                        <Option value="secret">Databricks secret (recommended)</Option>
                        <Option value="literal">Literal value</Option>
                      </Dropdown>
                    </Field>
                    {pwMode === 'secret' ? (
                      <>
                        <Field label="Secret scope" required style={{ minWidth: 160 }}><Input value={cSecretScope} onChange={(_, d) => setCSecretScope(d.value)} placeholder="loom" /></Field>
                        <Field label="Secret key" required style={{ minWidth: 160 }}><Input value={cSecretKey} onChange={(_, d) => setCSecretKey(d.value)} placeholder="sqlserver-password" /></Field>
                      </>
                    ) : (
                      <Field label="Password value" required style={{ flex: 1, minWidth: 220 }}><Input type="password" value={cPassword} onChange={(_, d) => setCPassword(d.value)} /></Field>
                    )}
                    <Field label="Comment" style={{ flex: 1, minWidth: 180 }}><Input value={cComment} onChange={(_, d) => setCComment(d.value)} /></Field>
                  </div>
                  <div><Button appearance="primary" icon={<Add20Regular />} disabled={busy || !cName.trim() || !cHost.trim() || !cUser.trim() || !pwValid} onClick={createConn}>Create connection</Button></div>
                </>
              )}

              {tab === 'foreign' && (
                <>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    A foreign catalog mirrors one database from a connection into Unity Catalog; it appears in the Catalogs
                    tree and is governed like any UC catalog. Pick an existing connection and the remote database to mirror.
                  </Caption1>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <Field label="Catalog name" required style={{ minWidth: 180 }}><Input value={fcName} onChange={(_, d) => setFcName(d.value)} placeholder="sqlserver_sales" /></Field>
                    <Field label="Connection" required style={{ minWidth: 200 }}>
                      <Dropdown placeholder="Select connection" value={fcConn} selectedOptions={fcConn ? [fcConn] : []} onOptionSelect={(_, d) => setFcConn(d.optionValue || '')}>
                        {conns.length === 0 && <Option value="" disabled>Create a connection first</Option>}
                        {conns.map((c) => <Option key={c.name} value={c.name}>{c.name} ({c.connection_type})</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Remote database" required style={{ minWidth: 180 }}><Input value={fcDb} onChange={(_, d) => setFcDb(d.value)} placeholder="SalesDB" /></Field>
                    <Field label="Comment" style={{ flex: 1, minWidth: 180 }}><Input value={fcComment} onChange={(_, d) => setFcComment(d.value)} /></Field>
                  </div>
                  <div><Button appearance="primary" icon={<Add20Regular />} disabled={busy || !fcName.trim() || !fcConn || !fcDb.trim()} onClick={createForeign}>Create foreign catalog</Button></div>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void reload()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Workspace-catalog binding (catalog isolation) — wave c3.
// A binding restricts which workspaces can access a catalog and SUPERSEDES
// explicit grants, but only when the catalog is ISOLATED (OPEN ⇒ any workspace).
// Real UC REST via /api/databricks/unity-catalog/bindings.
// ============================================================
function WorkspaceBindingsDialog({ open, onOpenChange, catalog, catalogs }: {
  open: boolean; onOpenChange: (v: boolean) => void; catalog: string | null; catalogs: string[];
}) {
  const [sel, setSel] = useState<string>(catalog || '');
  const [bindings, setBindings] = useState<{ workspace_id: number; binding_type?: string }[]>([]);
  const [isolationMode, setIsolationMode] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [wsId, setWsId] = useState('');
  const [bindType, setBindType] = useState<'BINDING_TYPE_READ_WRITE' | 'BINDING_TYPE_READ_ONLY'>('BINDING_TYPE_READ_WRITE');

  const BASE = '/api/databricks/unity-catalog/bindings';

  useEffect(() => { if (open && catalog && !sel) setSel(catalog); }, [open, catalog, sel]);

  const load = useCallback(async () => {
    if (!sel) { setBindings([]); setIsolationMode(undefined); return; }
    setLoading(true); setErr(null); setGate(null);
    try {
      const r = await fetch(`${BASE}?securable_type=catalog&securable_name=${encodeURIComponent(sel)}`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); setBindings([]); return; }
      if (!j.ok) { setErr(j.error || 'failed to load bindings'); setBindings([]); return; }
      setBindings(j.bindings || []);
      setIsolationMode(j.isolationMode);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [sel]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  const patch = async (change: 'add' | 'remove', workspaceId: number, binding_type?: string) => {
    setBusy(true); setErr(null); setGate(null);
    try {
      const r = await fetch(BASE, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ securable_type: 'catalog', securable_name: sel, [change]: [{ workspace_id: workspaceId, binding_type: binding_type || 'BINDING_TYPE_READ_WRITE' }] }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'binding update failed'); return; }
      setBindings(j.bindings || []);
      if (change === 'add') setWsId('');
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const setIsolation = async (mode: 'OPEN' | 'ISOLATED') => {
    setBusy(true); setErr(null); setGate(null);
    try {
      const r = await fetch(BASE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ securable_name: sel, isolation_mode: mode }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'isolation update failed'); return; }
      setIsolationMode(j.catalog?.isolation_mode || mode);
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };

  const isolated = (isolationMode || '').toUpperCase() === 'ISOLATED';
  const addId = Number(wsId);
  const addValid = Number.isFinite(addId) && addId > 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '860px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>Workspace-catalog binding &amp; isolation</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                A workspace binding restricts which workspaces can access a catalog. A binding <b>supersedes explicit
                grants</b> — a real security boundary — but is only enforced when the catalog is <b>ISOLATED</b>
                (an <b>OPEN</b> catalog is reachable from any workspace). Backed by real UC REST; the Console UAMI must be a
                metastore admin or the catalog owner.
              </Caption1>

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Catalog" required style={{ minWidth: 220 }}>
                  <Dropdown placeholder="Pick a catalog" value={sel} selectedOptions={sel ? [sel] : []} onOptionSelect={(_, d) => setSel(d.optionValue || '')}>
                    {catalogs.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Isolation mode">
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
                    <Badge appearance="filled" color={isolated ? 'danger' : 'subtle'}>{isolationMode || '—'}</Badge>
                    <Button size="small" appearance={isolated ? 'outline' : 'primary'} disabled={!sel || busy || !isolated} onClick={() => setIsolation('OPEN')}>Set OPEN</Button>
                    <Button size="small" appearance={isolated ? 'primary' : 'outline'} disabled={!sel || busy || isolated} onClick={() => setIsolation('ISOLATED')}>Set ISOLATED</Button>
                  </div>
                </Field>
                <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading || !sel} onClick={() => void load()}>Refresh</Button>
                {loading && <Spinner size="tiny" />}
              </div>

              {!isolated && sel && (
                <MessageBar intent="info"><MessageBarBody>
                  <MessageBarTitle>Catalog is OPEN</MessageBarTitle>
                  Bindings below are recorded but NOT enforced until you set the catalog ISOLATED.
                </MessageBarBody></MessageBar>
              )}
              {gate && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Configuration required</MessageBarTitle>{gate}</MessageBarBody></MessageBar>}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              <div style={{ overflow: 'auto', maxHeight: '260px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                <Table size="small" aria-label="Workspace bindings">
                  <TableHeader><TableRow><TableHeaderCell>Workspace id</TableHeaderCell><TableHeaderCell>Binding type</TableHeaderCell><TableHeaderCell> </TableHeaderCell></TableRow></TableHeader>
                  <TableBody>
                    {bindings.length === 0 && <TableRow><TableCell colSpan={3}><Caption1>{sel ? 'No workspaces bound (catalog reachable per its isolation mode).' : 'Pick a catalog.'}</Caption1></TableCell></TableRow>}
                    {bindings.map((b) => (
                      <TableRow key={b.workspace_id}>
                        <TableCell><span style={{ fontFamily: 'monospace' }}>{b.workspace_id}</span></TableCell>
                        <TableCell><Badge appearance="tint" color={(b.binding_type || '').includes('READ_ONLY') ? 'warning' : 'brand'}>{(b.binding_type || 'BINDING_TYPE_READ_WRITE').replace('BINDING_TYPE_', '')}</Badge></TableCell>
                        <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label="Unbind workspace" disabled={busy} onClick={() => patch('remove', b.workspace_id, b.binding_type)} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <Subtitle2>Bind a workspace</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Enter the numeric Databricks workspace id (the workspace deployment id) to grant it access to this catalog.
              </Caption1>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Workspace id" required style={{ minWidth: 200 }}><Input value={wsId} onChange={(_, d) => setWsId(d.value.replace(/[^0-9]/g, ''))} placeholder="1234567890123456" /></Field>
                <Field label="Access" style={{ minWidth: 180 }}>
                  <Dropdown value={bindType.replace('BINDING_TYPE_', '')} selectedOptions={[bindType]} onOptionSelect={(_, d) => setBindType((d.optionValue as any) || 'BINDING_TYPE_READ_WRITE')}>
                    <Option value="BINDING_TYPE_READ_WRITE" text="READ_WRITE">Read &amp; write</Option>
                    <Option value="BINDING_TYPE_READ_ONLY" text="READ_ONLY">Read only</Option>
                  </Dropdown>
                </Field>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!sel || !addValid || busy} onClick={() => patch('add', addId, bindType)}>Bind workspace</Button>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Audit & system tables (wave c3) — read-only reads of system.access.audit,
// system.query.history, system.billing.usage, and UC-native data classification
// (system.data_classification.results). Honest-gated when a system schema isn't
// enabled. Real SQL over /api/databricks/unity-catalog/{system-tables,data-classification}.
// ============================================================
function SysRows({ columns, rows, classify }: { columns: string[]; rows: Record<string, unknown>[]; classify?: boolean }) {
  const cell = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
    const s = String(v);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  };
  return (
    <div style={{ overflow: 'auto', maxHeight: '380px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
      <Table size="small" aria-label="System table results">
        <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 && <TableRow><TableCell colSpan={Math.max(1, columns.length)}><Caption1>No rows.</Caption1></TableCell></TableRow>}
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((c) => {
                if (classify && c === 'class_tag') return <TableCell key={c}><Badge appearance="tint" color="important">{cell(row[c])}</Badge></TableCell>;
                if (classify && c === 'confidence') {
                  const hi = String(row[c] || '').toUpperCase() === 'HIGH';
                  return <TableCell key={c}><Badge appearance="filled" color={hi ? 'danger' : 'warning'}>{cell(row[c])}</Badge></TableCell>;
                }
                return <TableCell key={c}><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{cell(row[c])}</span></TableCell>;
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AuditSystemDialog({ open, onOpenChange, warehouseId, catalog, schema }: {
  open: boolean; onOpenChange: (v: boolean) => void; warehouseId?: string; catalog: string | null; schema: string | null;
}) {
  type AuditTab = 'audit' | 'query' | 'billing' | 'classification' | 'quality';
  const [tab, setTab] = useState<AuditTab>('audit');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [execMs, setExecMs] = useState<number | null>(null);
  // shared filters
  const [days, setDays] = useState('7');
  const [limit, setLimit] = useState('100');
  const [service, setService] = useState('');
  const [action, setAction] = useState('');
  const [status, setStatus] = useState('');
  const [clCatalog, setClCatalog] = useState(catalog || '');
  const [clSchema, setClSchema] = useState(schema || '');
  const [clConfidence, setClConfidence] = useState('');
  // Data-quality monitor status filter (Healthy / Unhealthy / Unknown).
  const [qStatus, setQStatus] = useState('');

  useEffect(() => { if (open) { setClCatalog(catalog || ''); setClSchema(schema || ''); } }, [open, catalog, schema]);

  const wq = warehouseId ? `&warehouseId=${encodeURIComponent(warehouseId)}` : '';

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null); setColumns([]); setRows([]); setExecMs(null);
    try {
      let url: string;
      if (tab === 'classification') {
        const p = new URLSearchParams();
        if (clCatalog.trim()) p.set('catalog', clCatalog.trim());
        if (clSchema.trim()) p.set('schema', clSchema.trim());
        if (clConfidence.trim()) p.set('confidence', clConfidence.trim());
        if (limit.trim()) p.set('limit', limit.trim());
        url = `/api/databricks/unity-catalog/data-classification?${p.toString()}${wq}`;
      } else if (tab === 'quality') {
        const p = new URLSearchParams();
        if (clCatalog.trim()) p.set('catalog', clCatalog.trim());
        if (clSchema.trim()) p.set('schema', clSchema.trim());
        if (qStatus.trim()) p.set('status', qStatus.trim());
        if (limit.trim()) p.set('limit', limit.trim());
        url = `/api/databricks/unity-catalog/quality-monitors?${p.toString()}${wq}`;
      } else {
        const tableParam = tab === 'audit' ? 'audit' : tab === 'query' ? 'query-history' : 'billing';
        const p = new URLSearchParams({ table: tableParam });
        if (days.trim()) p.set('days', days.trim());
        if (limit.trim()) p.set('limit', limit.trim());
        if (tab === 'audit') { if (service.trim()) p.set('service', service.trim()); if (action.trim()) p.set('action', action.trim()); }
        if (tab === 'query' && status.trim()) p.set('status', status.trim());
        url = `/api/databricks/unity-catalog/system-tables?${p.toString()}${wq}`;
      }
      const r = await fetch(url);
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'failed to read system table'); return; }
      setColumns(j.columns || []);
      setRows(j.rows || []);
      setExecMs(typeof j.executionMs === 'number' ? j.executionMs : null);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [tab, days, limit, service, action, status, clCatalog, clSchema, clConfidence, qStatus, wq]);
  useEffect(() => { if (open) void load(); }, [open, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const tryEnable = async (sch: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/system-tables', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'enable-schema', schema: sch }),
      });
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'enable failed'); return; }
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  const enableSchema = tab === 'audit' ? 'access' : tab === 'query' ? 'query' : tab === 'billing' ? 'billing' : tab === 'quality' ? 'data_quality_monitoring' : 'data_classification';

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '1100px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Audit &amp; system tables — Unity Catalog</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Read-only over the Databricks <b>system tables</b> (real SQL on the SQL warehouse). The Console UAMI needs
                USE CATALOG on <code>system</code> + USE SCHEMA + SELECT on each system schema; account/metastore admin to enable a schema.
              </Caption1>

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as AuditTab)} size="small">
                <Tab value="audit" icon={<ShieldTask20Regular />}>Access audit</Tab>
                <Tab value="query" icon={<History20Regular />}>Query history</Tab>
                <Tab value="billing" icon={<DataBarVertical20Regular />}>Billing usage</Tab>
                <Tab value="classification" icon={<Tag20Regular />}>Data classification</Tab>
                <Tab value="quality" icon={<DataBarVertical20Regular />}>Data quality</Tab>
              </TabList>

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {tab !== 'classification' && tab !== 'quality' && (
                  <Field label="Window (days)" style={{ minWidth: 110 }}><Input value={days} onChange={(_, d) => setDays(d.value.replace(/[^0-9]/g, ''))} placeholder="7" /></Field>
                )}
                <Field label="Row limit" style={{ minWidth: 110 }}><Input value={limit} onChange={(_, d) => setLimit(d.value.replace(/[^0-9]/g, ''))} placeholder="100" /></Field>
                {tab === 'audit' && <>
                  <Field label="Service (optional)" style={{ minWidth: 150 }}><Input value={service} onChange={(_, d) => setService(d.value)} placeholder="unityCatalog" /></Field>
                  <Field label="Action (optional)" style={{ minWidth: 150 }}><Input value={action} onChange={(_, d) => setAction(d.value)} placeholder="getTable" /></Field>
                </>}
                {tab === 'query' && (
                  <Field label="Status (optional)" style={{ minWidth: 160 }}>
                    <Dropdown value={status} selectedOptions={status ? [status] : []} placeholder="Any" onOptionSelect={(_, d) => setStatus(d.optionValue || '')}>
                      <Option value="">Any</Option>
                      <Option value="FINISHED">FINISHED</Option>
                      <Option value="FAILED">FAILED</Option>
                      <Option value="CANCELED">CANCELED</Option>
                    </Dropdown>
                  </Field>
                )}
                {tab === 'classification' && <>
                  <Field label="Catalog (optional)" style={{ minWidth: 150 }}><Input value={clCatalog} onChange={(_, d) => setClCatalog(d.value)} placeholder="main" /></Field>
                  <Field label="Schema (optional)" style={{ minWidth: 150 }}><Input value={clSchema} onChange={(_, d) => setClSchema(d.value)} placeholder="public" /></Field>
                  <Field label="Confidence" style={{ minWidth: 130 }}>
                    <Dropdown value={clConfidence} selectedOptions={clConfidence ? [clConfidence] : []} placeholder="Any" onOptionSelect={(_, d) => setClConfidence(d.optionValue || '')}>
                      <Option value="">Any</Option>
                      <Option value="HIGH">HIGH</Option>
                      <Option value="LOW">LOW</Option>
                    </Dropdown>
                  </Field>
                </>}
                {tab === 'quality' && <>
                  <Field label="Catalog (optional)" style={{ minWidth: 150 }}><Input value={clCatalog} onChange={(_, d) => setClCatalog(d.value)} placeholder="main" /></Field>
                  <Field label="Schema (optional)" style={{ minWidth: 150 }}><Input value={clSchema} onChange={(_, d) => setClSchema(d.value)} placeholder="public" /></Field>
                  <Field label="Status" style={{ minWidth: 140 }}>
                    <Dropdown value={qStatus} selectedOptions={qStatus ? [qStatus] : []} placeholder="Any" onOptionSelect={(_, d) => setQStatus(d.optionValue || '')}>
                      <Option value="">Any</Option>
                      <Option value="Unhealthy">Unhealthy</Option>
                      <Option value="Healthy">Healthy</Option>
                      <Option value="Unknown">Unknown</Option>
                    </Dropdown>
                  </Field>
                </>}
                <Button appearance="primary" icon={<Eye20Regular />} disabled={loading} onClick={() => void load()}>Run</Button>
                {loading && <Spinner size="tiny" />}
                {execMs != null && <Badge appearance="outline">{rows.length} row(s) · {execMs} ms</Badge>}
              </div>

              {gate && (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>System schema not available</MessageBarTitle>
                  {gate}
                  <div style={{ marginTop: tokens.spacingVerticalS }}>
                    <Button size="small" appearance="outline" disabled={busy} onClick={() => void tryEnable(enableSchema)}>
                      Attempt to enable system.{enableSchema}
                    </Button>
                  </div>
                </MessageBarBody></MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Read failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              {tab === 'classification' && !gate && !err && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Column-level sensitive-class detections from <code>system.data_classification.results</code> — complements the
                  Microsoft Purview scan path. <code>class_tag</code> is the detected sensitive class; <code>confidence</code> is HIGH or LOW.
                </Caption1>
              )}

              {tab === 'quality' && !gate && !err && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Latest data-quality status per monitored table from <code>system.data_quality_monitoring.table_results</code> —
                  <code>status</code> is the consolidated health (Healthy / Unhealthy / Unknown), with freshness &amp; completeness sub-status.
                  Creating / refreshing a Lakehouse Monitor is a notebook or Catalog-Explorer "Quality" flow; Loom surfaces the results read-only.
                </Caption1>
              )}

              <SysRows columns={columns} rows={rows} classify={tab === 'classification'} />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void load()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Registered models as UC securables (wave c3 finish) — read-only versions
// browser. Registered models are a SUBTYPE of the FUNCTION securable; they are
// governed via the FUNCTION permissions path, so "Manage grants" seeds the UC
// grant dialog with FUNCTION + the model full name. CREATE / registration is an
// MLflow-side flow (honest note). Real UC REST via /api/databricks/unity-catalog/models.
// ============================================================
function ModelVersionsDialog({ open, onOpenChange, fullName, onGrants }: {
  open: boolean; onOpenChange: (v: boolean) => void; fullName: string | null;
  onGrants: (fullName: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [model, setModel] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!fullName) return;
    setLoading(true); setErr(null); setGate(null); setModel(null); setVersions([]);
    try {
      const r = await fetch(`/api/databricks/unity-catalog/models?full_name=${encodeURIComponent(fullName)}&versions=true`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'failed to load model'); return; }
      setModel(j.model || null);
      setVersions(Array.isArray(j.versions) ? j.versions : []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [fullName]);
  useEffect(() => { if (open && fullName) void load(); }, [open, fullName]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtTime = (v: unknown): string => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    try { return new Date(n).toLocaleString(); } catch { return ''; }
  };
  const statusColor = (st: string): 'success' | 'warning' | 'danger' | 'informative' => {
    const s = (st || '').toUpperCase();
    if (s === 'READY') return 'success';
    if (s.includes('FAILED')) return 'danger';
    if (s.includes('PENDING')) return 'warning';
    return 'informative';
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '900px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>Registered model — {fullName || ''}</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                A registered model is a Unity Catalog securable (a subtype of <b>FUNCTION</b>). Versions are read-only here;
                governance uses the FUNCTION permissions path — use <b>Manage grants</b> for <code>EXECUTE</code> / <code>APPLY TAG</code> / <code>MANAGE</code>.
              </Caption1>

              {gate && (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>Registered models unavailable</MessageBarTitle>{gate}
                </MessageBarBody></MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              {model && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'center' }}>
                  {model.owner && <Badge appearance="outline">owner: {String(model.owner)}</Badge>}
                  {model.comment && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{String(model.comment)}</Caption1>}
                  {model.updated_at && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>updated {fmtTime(model.updated_at)}</Caption1>}
                </div>
              )}

              {loading && <Spinner size="tiny" label="Loading versions…" />}
              {!loading && (
                <div style={{ overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table size="small" aria-label="Model versions">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Version</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Source / run</TableHeaderCell>
                      <TableHeaderCell>Created by</TableHeaderCell>
                      <TableHeaderCell>Created</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {versions.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No versions registered.</Caption1></TableCell></TableRow>}
                      {versions.map((v) => (
                        <TableRow key={String(v.version)}>
                          <TableCell><Badge appearance="tint" color="brand">v{String(v.version)}</Badge></TableCell>
                          <TableCell>{v.status ? <Badge appearance="filled" color={statusColor(String(v.status))}>{String(v.status)}</Badge> : ''}</TableCell>
                          <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{String(v.source || v.run_id || '')}</span></TableCell>
                          <TableCell>{String(v.created_by || '')}</TableCell>
                          <TableCell>{fmtTime(v.created_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <MessageBar intent="info"><MessageBarBody>
                Registering a new model or version is an MLflow-side flow
                (<code>POST /api/2.0/mlflow/registered-models/create</code> · <code>mlflow.register_model</code> from a notebook or job).
                Loom surfaces models read-only as governed securables.
              </MessageBarBody></MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" icon={<Key20Regular />} disabled={!fullName} onClick={() => { if (fullName) { onGrants(fullName); onOpenChange(false); } }}>
              Manage grants (FUNCTION)
            </Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void load()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Databricks Marketplace (consumer) — wave c4 (completes UC feature coverage).
// Read-mostly browse of listings + this consumer's installations over the
// documented consumer REST (/api/databricks/unity-catalog/marketplace). An
// installed listing materializes as a read-only shared catalog (Delta Sharing).
// Installing is the consumer "Get instant access" acceptance flow — surfaced as
// an honest note, not a half-working button (per no-vaporware.md).
// ============================================================
function fmtEpoch(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n).toLocaleString(); } catch { return ''; }
}

function MarketplaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  type MpTab = 'browse' | 'installed';
  const [tab, setTab] = useState<MpTab>('browse');
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [listings, setListings] = useState<any[]>([]);
  const [installations, setInstallations] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const [onlyStaffPick, setOnlyStaffPick] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null);
    try {
      if (tab === 'installed') {
        const r = await fetch('/api/databricks/unity-catalog/marketplace?installations=true');
        const j = await r.json();
        if (j.gated) { setGate(j.error); return; }
        if (!j.ok) { setErr(j.error || 'failed to list installations'); return; }
        setInstallations(Array.isArray(j.installations) ? j.installations : []);
      } else {
        const p = new URLSearchParams();
        if (q.trim()) p.set('q', q.trim());
        if (onlyFree) p.set('is_free', 'true');
        if (onlyStaffPick) p.set('is_staff_pick', 'true');
        const r = await fetch(`/api/databricks/unity-catalog/marketplace?${p.toString()}`);
        const j = await r.json();
        if (j.gated) { setGate(j.error); return; }
        if (!j.ok) { setErr(j.error || 'failed to list listings'); return; }
        setListings(Array.isArray(j.listings) ? j.listings : []);
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [tab, q, onlyFree, onlyStaffPick]);
  useEffect(() => { if (open) void load(); }, [open, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '1100px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Databricks Marketplace</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Browse open Marketplace data products (real consumer REST). Installing a listing materializes it as a
                read-only <b>shared catalog</b> via Delta Sharing. Browsing &amp; installing needs the
                {' '}<code>USE MARKETPLACE ASSETS</code> privilege.
              </Caption1>

              <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as MpTab)} size="small">
                <Tab value="browse" icon={<BuildingShop20Regular />}>Browse listings</Tab>
                <Tab value="installed" icon={<ArrowDownload20Regular />}>Installed</Tab>
              </TabList>

              {tab === 'browse' && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="Search listings" style={{ minWidth: 260, flex: 1 }}>
                    <Input value={q} onChange={(_, d) => setQ(d.value)} placeholder="weather, retail, demographics…"
                      onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} contentBefore={<Eye20Regular />} />
                  </Field>
                  <Switch label="Free only" checked={onlyFree} onChange={(_, d) => setOnlyFree(d.checked)} />
                  <Switch label="Staff picks" checked={onlyStaffPick} onChange={(_, d) => setOnlyStaffPick(d.checked)} />
                  <Button appearance="primary" icon={<Eye20Regular />} disabled={loading} onClick={() => void load()}>Search</Button>
                  {loading && <Spinner size="tiny" />}
                  <Badge appearance="outline">{listings.length} listing(s)</Badge>
                </div>
              )}
              {tab === 'installed' && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' }}>
                  {loading && <Spinner size="tiny" />}
                  <Badge appearance="outline">{installations.length} installation(s)</Badge>
                </div>
              )}

              {gate && (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>Marketplace unavailable</MessageBarTitle>{gate}
                </MessageBarBody></MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              {tab === 'browse' && !gate && (
                <div style={{ overflow: 'auto', maxHeight: '420px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table size="small" aria-label="Marketplace listings">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Listing</TableHeaderCell>
                      <TableHeaderCell>Provider</TableHeaderCell>
                      <TableHeaderCell>Categories</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {listings.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No listings visible to this consumer.</Caption1></TableCell></TableRow>}
                      {listings.map((l, i) => (
                        <TableRow key={l.id || i}>
                          <TableCell>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center' }}>
                                <b>{String(l.name || l.id || 'listing')}</b>
                                {l.is_free && <Badge appearance="tint" color="success">Free</Badge>}
                                {l.is_staff_pick && <Badge appearance="tint" color="brand" icon={<Star20Regular />}>Staff pick</Badge>}
                              </span>
                              {l.subtitle && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{String(l.subtitle)}</Caption1>}
                            </div>
                          </TableCell>
                          <TableCell>{String(l.provider_name || '')}{l.provider_region ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}> · {String(l.provider_region)}</Caption1> : null}</TableCell>
                          <TableCell>
                            <span style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' }}>
                              {(Array.isArray(l.categories) ? l.categories : []).slice(0, 3).map((c: string) => <Badge key={c} appearance="outline">{c}</Badge>)}
                            </span>
                          </TableCell>
                          <TableCell>{l.listing_type ? <Badge appearance="tint" color={String(l.listing_type).toUpperCase() === 'PERSONALIZED' ? 'warning' : 'informative'}>{String(l.listing_type)}</Badge> : ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {tab === 'installed' && !gate && (
                <div style={{ overflow: 'auto', maxHeight: '420px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table size="small" aria-label="Marketplace installations">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Listing</TableHeaderCell>
                      <TableHeaderCell>Shared catalog</TableHeaderCell>
                      <TableHeaderCell>Share</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Installed</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {installations.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No installed data products.</Caption1></TableCell></TableRow>}
                      {installations.map((ins, i) => (
                        <TableRow key={ins.id || i}>
                          <TableCell><b>{String(ins.listing_name || ins.listing_id || '')}</b></TableCell>
                          <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{String(ins.catalog_name || '')}</span></TableCell>
                          <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{String(ins.share_name || '')}</span></TableCell>
                          <TableCell>{ins.status ? <Badge appearance="filled" color={String(ins.status).toUpperCase().includes('INSTALL') ? 'success' : 'informative'}>{String(ins.status)}</Badge> : ''}</TableCell>
                          <TableCell>{fmtEpoch(ins.installed_on)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <MessageBar intent="info"><MessageBarBody>
                Installing a listing is the consumer <b>“Get instant access”</b> acceptance flow
                (<code>POST /api/2.1/marketplace-consumer/listings/&#123;id&#125;/installations</code> with the listing's accepted-terms
                version). Once installed, the data product appears above as a read-only <b>shared catalog</b> and as a provider in the
                Delta Sharing surface — query it like any other Unity Catalog catalog.
              </MessageBarBody></MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void load()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

// ============================================================
// Clean Rooms — wave c4 (completes UC feature coverage). Read surface: list
// clean rooms + a detail view (collaborators + assets) over the documented
// stable REST (/api/databricks/unity-catalog/clean-rooms). Create + CLEAN ROOM
// TASK DDL are honest notes (Public-Preview / cross-org handshake flows).
// ============================================================
function CleanRoomsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [loading, setLoading] = useState(false);
  const [gate, setGate] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rooms, setRooms] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true); setErr(null); setGate(null); setDetail(null); setAssets([]); setSelected(null);
    try {
      const r = await fetch('/api/databricks/unity-catalog/clean-rooms');
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'failed to list clean rooms'); return; }
      setRooms(Array.isArray(j.cleanRooms) ? j.cleanRooms : []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { if (open) void loadList(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const openRoom = useCallback(async (name: string) => {
    setSelected(name); setDetailLoading(true); setDetail(null); setAssets([]); setErr(null);
    try {
      const r = await fetch(`/api/databricks/unity-catalog/clean-rooms?name=${encodeURIComponent(name)}&assets=true`);
      const j = await r.json();
      if (j.gated) { setGate(j.error); return; }
      if (!j.ok) { setErr(j.error || 'failed to load clean room'); return; }
      setDetail(j.cleanRoom || null);
      setAssets(Array.isArray(j.assets) ? j.assets : []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setDetailLoading(false); }
  }, []);

  const statusColor = (st: string): 'success' | 'warning' | 'danger' | 'informative' => {
    const s = (st || '').toUpperCase();
    if (s === 'ACTIVE') return 'success';
    if (s.includes('FAIL') || s === 'DELETED') return 'danger';
    if (s.includes('PROVISION') || s.includes('PENDING')) return 'warning';
    return 'informative';
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '1120px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>Clean rooms — Unity Catalog</DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                A clean room is a secure, privacy-safe environment where collaborators run approved workloads on each other's data
                without exposing the underlying rows. Real Clean Rooms REST — list + collaborators + shared assets.
              </Caption1>

              {gate && (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>Clean rooms unavailable</MessageBarTitle>{gate}
                </MessageBarBody></MessageBar>
              )}
              {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

              {!gate && (
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-start' }}>
                  {/* Left: room list */}
                  <div style={{ width: 320, flexShrink: 0, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'auto', maxHeight: '440px' }}>
                    <div style={{ padding: tokens.spacingVerticalS, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Clean rooms ({rooms.length})</Caption1>
                      {loading && <Spinner size="tiny" />}
                    </div>
                    <Divider />
                    {rooms.length === 0 && !loading && (
                      <div style={{ padding: tokens.spacingVerticalM }}><Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No clean rooms in this metastore.</Caption1></div>
                    )}
                    {rooms.map((r) => (
                      <div key={r.name} role="button" tabIndex={0}
                        onClick={() => void openRoom(r.name)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void openRoom(r.name); }}
                        style={{
                          padding: tokens.spacingVerticalS, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
                          backgroundColor: selected === r.name ? tokens.colorNeutralBackground1Selected : 'transparent',
                          borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
                        }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                          <ShieldLock20Regular />
                          <b style={{ fontSize: tokens.fontSizeBase200 }}>{String(r.name)}</b>
                        </span>
                        <span style={{ display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' }}>
                          {r.status && <Badge size="small" appearance="filled" color={statusColor(String(r.status))}>{String(r.status)}</Badge>}
                          {Array.isArray(r.collaborators) && r.collaborators.length > 0 && (
                            <Badge size="small" appearance="outline" icon={<People20Regular />}>{r.collaborators.length}</Badge>
                          )}
                          {r.region && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{String(r.region)}</Caption1>}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Right: detail */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {!selected && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Select a clean room to view its collaborators and shared assets.</Caption1>}
                    {detailLoading && <Spinner size="tiny" label="Loading clean room…" />}
                    {detail && !detailLoading && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' }}>
                          <Subtitle2>{String(detail.name)}</Subtitle2>
                          {detail.status && <Badge appearance="filled" color={statusColor(String(detail.status))}>{String(detail.status)}</Badge>}
                          {detail.owner && <Badge appearance="outline">owner: {String(detail.owner)}</Badge>}
                          {detail.cloud_vendor && <Badge appearance="outline">{String(detail.cloud_vendor)}{detail.region ? ` · ${String(detail.region)}` : ''}</Badge>}
                        </div>
                        {detail.comment && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{String(detail.comment)}</Caption1>}
                        {detail.created_at && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>created {fmtEpoch(detail.created_at)}{detail.creator ? ` by ${String(detail.creator)}` : ''}</Caption1>}

                        <Subtitle2 style={{ fontSize: tokens.fontSizeBase300 }}>Collaborators</Subtitle2>
                        <div style={{ overflow: 'auto', maxHeight: '180px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                          <Table size="small" aria-label="Clean room collaborators">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Alias</TableHeaderCell>
                              <TableHeaderCell>Organization</TableHeaderCell>
                              <TableHeaderCell>Metastore / invite</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {(detail.collaborators || []).length === 0 && <TableRow><TableCell colSpan={3}><Caption1>No collaborators listed.</Caption1></TableCell></TableRow>}
                              {(detail.collaborators || []).map((c: any, i: number) => (
                                <TableRow key={c.collaborator_alias || c.global_metastore_id || i}>
                                  <TableCell><b>{String(c.collaborator_alias || c.display_name || '')}</b></TableCell>
                                  <TableCell>{String(c.organization_name || c.display_name || '')}</TableCell>
                                  <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase100 }}>{String(c.global_metastore_id || c.invite_recipient_email || '')}</span></TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>

                        <Subtitle2 style={{ fontSize: tokens.fontSizeBase300 }}>Shared assets ({assets.length})</Subtitle2>
                        <div style={{ overflow: 'auto', maxHeight: '200px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                          <Table size="small" aria-label="Clean room assets">
                            <TableHeader><TableRow>
                              <TableHeaderCell>Asset</TableHeaderCell>
                              <TableHeaderCell>Type</TableHeaderCell>
                              <TableHeaderCell>Owner</TableHeaderCell>
                              <TableHeaderCell>Status</TableHeaderCell>
                            </TableRow></TableHeader>
                            <TableBody>
                              {assets.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>No assets shared into this room (or not visible to this collaborator).</Caption1></TableCell></TableRow>}
                              {assets.map((a, i) => (
                                <TableRow key={a.name || i}>
                                  <TableCell><span style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200 }}>{String(a.name || '')}</span></TableCell>
                                  <TableCell>{a.asset_type ? <Badge appearance="tint" color="brand">{String(a.asset_type)}</Badge> : ''}</TableCell>
                                  <TableCell>{String(a.owner_collaborator_alias || '')}</TableCell>
                                  <TableCell>{a.status ? <Badge appearance="outline">{String(a.status)}</Badge> : ''}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <MessageBar intent="info"><MessageBarBody>
                Creating a clean room (<code>POST /api/2.0/clean-rooms</code>) needs each collaborator's
                {' '}<code>global_metastore_id</code> (a cross-organization handshake), and running workloads uses
                {' '}<b>clean-room tasks</b> (<code>CREATE / MODIFY / EXECUTE CLEAN ROOM TASK</code> — SQL DDL run as notebook jobs on
                clean-room-scoped compute). Both are Public-Preview flows; Loom surfaces clean rooms, collaborators &amp; assets read-only.
              </MessageBarBody></MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={() => void loadList()}>Refresh</Button>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}


export {
  UnityCatalogWriteDialogs, ModelVersionsDialog, UcTagsDialog, GovernedTagsDialog,
  ExternalLocationsDialog, ConnectionsDialog, WorkspaceBindingsDialog, AuditSystemDialog,
  MarketplaceDialog, CleanRoomsDialog,
};
export type { UcSecurable };
