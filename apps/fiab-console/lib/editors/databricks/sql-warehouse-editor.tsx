'use client';

/**
 * Databricks SQL Warehouse editor — extracted verbatim from
 * databricks-editors.tsx (behavior-preserving split — zero logic change).
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
import {
  useStyles, ResultsPanel, stateColor, fmtBytes,
  dbuPerHr, estimateDbxCostPerHr, estimateDwuCostPerHr,
} from './shared';
import type { QueryResponse, Warehouse, WarehouseState, SchemaResponse, Cluster } from './shared';
import {
  UnityCatalogWriteDialogs, ModelVersionsDialog, UcTagsDialog, GovernedTagsDialog,
  ExternalLocationsDialog, ConnectionsDialog, WorkspaceBindingsDialog, AuditSystemDialog,
  MarketplaceDialog, CleanRoomsDialog,
} from './uc-dialogs';
import type { UcSecurable } from './uc-dialogs';

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
  // UC tag governance (wave c1) — object/column tags + governed tags.
  const [ucTagsOpen, setUcTagsOpen] = useState(false);
  const [ucTagsTarget, setUcTagsTarget] = useState<{ catalog: string; schema: string; table: string } | null>(null);
  const [ucGovTagsOpen, setUcGovTagsOpen] = useState(false);
  // UC storage + Lakehouse Federation (wave c2): external locations / storage
  // credentials, and connections / foreign catalogs.
  const [ucExtLocOpen, setUcExtLocOpen] = useState(false);
  const [ucConnsOpen, setUcConnsOpen] = useState(false);
  // UC governance depth (wave c3): workspace-catalog binding (catalog isolation)
  // + system tables / audit surface + UC-native data classification.
  const [ucBindingsOpen, setUcBindingsOpen] = useState(false);
  const [ucAuditOpen, setUcAuditOpen] = useState(false);
  // Registered models as UC securables: a versions browser + a grant-seed that
  // pre-selects the FUNCTION securable + the model full name in the grant dialog.
  const [ucModelOpen, setUcModelOpen] = useState(false);
  const [ucModelTarget, setUcModelTarget] = useState<string | null>(null);
  const [ucGrantSeed, setUcGrantSeed] = useState<{ securable: UcSecurable; fullName: string } | null>(null);
  // UC feature coverage (wave c4): Databricks Marketplace (consumer browse +
  // installations) and Clean Rooms (list + collaborators + assets).
  const [ucMarketplaceOpen, setUcMarketplaceOpen] = useState(false);
  const [ucCleanRoomsOpen, setUcCleanRoomsOpen] = useState(false);
  // Lazy per-table tag cache for the UC tree chips (full_name → tag pairs).
  const [tagsByTable, setTagsByTable] = useState<Record<string, { key: string; value: string }[]>>({});
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
  // Registered models — a UC securable subtype of FUNCTION (browsed via the UC
  // Models REST, governed via the FUNCTION permissions path).
  const [models, setModels] = useState<string[]>([]);
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
    setModels([]);
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
    setModels([]);
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
    setModels([]);
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
    // Registered models (UC securable subtype of FUNCTION) — best-effort; the
    // models REST is a separate UC surface from the schema browse and is honest-
    // gated on Gov, so a miss never blocks the rest of the tree.
    try {
      const mr = await fetch(
        `/api/databricks/unity-catalog/models?catalog=${encodeURIComponent(cat)}&schema=${encodeURIComponent(sch)}`,
      );
      const mj = await mr.json();
      if (mj.ok && Array.isArray(mj.models)) setModels(mj.models.map((m: any) => String(m.name)).filter(Boolean));
    } catch { /* models are best-effort */ }
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

  // Lazy-load a table's Unity Catalog tags for the tree chips (information_schema).
  const loadTableTags = useCallback(async (cat: string, sch: string, tbl: string) => {
    try {
      const p = new URLSearchParams({ catalog: cat, schema: sch, table: tbl });
      if (warehouseId) p.set('warehouseId', warehouseId);
      const r = await fetch(`/api/databricks/unity-catalog/tags?${p.toString()}`);
      const j = await r.json();
      if (j.ok && Array.isArray(j.tableTags)) {
        const pairs = j.tableTags.map((t: any) => ({ key: String(t.tag_name), value: String(t.tag_value ?? '') }));
        setTagsByTable((prev) => ({ ...prev, [`${cat}.${sch}.${tbl}`]: pairs }));
      }
    } catch { /* tag chips are best-effort */ }
  }, [warehouseId]);

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

  // Registered-model securable actions: open the versions browser, and seed the
  // UC grant dialog with the FUNCTION securable + model full name (registered
  // models are governed through the FUNCTION permissions path).
  const openModelVersions = useCallback((fullName: string) => {
    setUcModelTarget(fullName);
    setUcModelOpen(true);
  }, []);
  const openModelGrants = useCallback((fullName: string) => {
    setUcGrantSeed({ securable: 'FUNCTION', fullName });
    setUcGrantsOpen(true);
  }, []);

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
        { label: 'Manage grants', onClick: () => { setUcGrantSeed(null); setUcGrantsOpen(true); }, title: 'View / grant / revoke UC privileges' },
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
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, marginBottom: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
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
              <Button size="small" appearance="outline" icon={<Key20Regular />} onClick={() => { setUcGrantSeed(null); setUcGrantsOpen(true); }} aria-label="Manage grants" />
            </Tooltip>
            <Tooltip content="Governed tags (account-level tag policies)" relationship="label">
              <Button size="small" appearance="outline" icon={<Tag20Regular />} onClick={() => setUcGovTagsOpen(true)}>Governed tags</Button>
            </Tooltip>
            <Tooltip content="External locations & storage credentials (UC cloud-storage governance)" relationship="label">
              <Button size="small" appearance="outline" icon={<CloudLink20Regular />} onClick={() => setUcExtLocOpen(true)}>Locations</Button>
            </Tooltip>
            <Tooltip content="Connections & foreign catalogs (Lakehouse Federation)" relationship="label">
              <Button size="small" appearance="outline" icon={<PlugConnected20Regular />} onClick={() => setUcConnsOpen(true)}>Connections</Button>
            </Tooltip>
            <Tooltip content="Workspace-catalog binding & catalog isolation (a binding supersedes grants)" relationship="label">
              <Button size="small" appearance="outline" icon={<Link20Regular />} onClick={() => setUcBindingsOpen(true)}>Bindings</Button>
            </Tooltip>
            <Tooltip content="Audit & system tables (access audit · query history · billing · data classification · data quality)" relationship="label">
              <Button size="small" appearance="outline" icon={<ShieldTask20Regular />} onClick={() => setUcAuditOpen(true)}>Audit &amp; system</Button>
            </Tooltip>
            <Tooltip content="Databricks Marketplace (browse listings · installed shared catalogs)" relationship="label">
              <Button size="small" appearance="outline" icon={<BuildingShop20Regular />} onClick={() => setUcMarketplaceOpen(true)}>Marketplace</Button>
            </Tooltip>
            <Tooltip content="Clean rooms (privacy-safe collaboration · collaborators · shared assets)" relationship="label">
              <Button size="small" appearance="outline" icon={<ShieldLock20Regular />} onClick={() => setUcCleanRoomsOpen(true)}>Clean rooms</Button>
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
                                  void loadTableTags(c, sch, t);
                                }}
                              >
                                <TreeItemLayout
                                  iconBefore={<DocumentTable20Regular />}
                                  actions={
                                    <>
                                      <Tooltip content={`Edit tags: ${t}`} relationship="label">
                                        <Button
                                          size="small" appearance="subtle" icon={<Tag20Regular />}
                                          aria-label={`Edit tags ${t}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setUcTagsTarget({ catalog: c, schema: sch, table: t });
                                            setUcTagsOpen(true);
                                          }}
                                        />
                                      </Tooltip>
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
                                  {(tagsByTable[`${c}.${sch}.${t}`] || []).slice(0, 3).map((tg, ti) => (
                                    <Badge key={ti} appearance="tint" color="brand" size="small" icon={<Tag20Regular />}
                                      style={{ marginLeft: tokens.spacingHorizontalXXS }}>
                                      {tg.key}{tg.value ? `=${tg.value}` : ''}
                                    </Badge>
                                  ))}
                                  {(tagsByTable[`${c}.${sch}.${t}`]?.length || 0) > 3 && (
                                    <Badge appearance="ghost" size="small" style={{ marginLeft: tokens.spacingHorizontalXXS }}>
                                      +{(tagsByTable[`${c}.${sch}.${t}`]?.length || 0) - 3}
                                    </Badge>
                                  )}
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
                            {/* Registered models (UC securable subtype of FUNCTION) */}
                            {activeSchema === sch && models.map((m) => (
                              <TreeItem
                                key={`m-${c}.${sch}.${m}`}
                                itemType="leaf"
                                value={`m-${c}.${sch}.${m}`}
                                onClick={(e) => { e.stopPropagation(); openModelVersions(`${c}.${sch}.${m}`); }}
                              >
                                <TreeItemLayout
                                  iconBefore={<Sparkle20Regular />}
                                  actions={
                                    <>
                                      <Tooltip content={`Model versions: ${m}`} relationship="label">
                                        <Button
                                          size="small" appearance="subtle" icon={<History20Regular />}
                                          aria-label={`Model versions ${m}`}
                                          onClick={(e) => { e.stopPropagation(); openModelVersions(`${c}.${sch}.${m}`); }}
                                        />
                                      </Tooltip>
                                      <Tooltip content={`Grants on model: ${m}`} relationship="label">
                                        <Button
                                          size="small" appearance="subtle" icon={<Key20Regular />}
                                          aria-label={`Grants ${m}`}
                                          onClick={(e) => { e.stopPropagation(); openModelGrants(`${c}.${sch}.${m}`); }}
                                        />
                                      </Tooltip>
                                    </>
                                  }
                                >
                                  {m}
                                  <Badge appearance="ghost" color="brand" size="small" style={{ marginLeft: tokens.spacingHorizontalXXS }}>model</Badge>
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
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
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
                  {gov && <Badge appearance="outline" color="brand" style={{ marginLeft: tokens.spacingHorizontalS }}>Gov · Synapse Dedicated Pool</Badge>}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
                        <div style={{ display: 'flex', gap: tokens.spacingHorizontalM }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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
                              <code style={{ fontSize: tokens.fontSizeBase100 }}>{q.query_text?.slice(0, 200) || (q.error_message ? `ERR: ${q.error_message}` : '—')}</code>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                      <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' }}>
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
                          fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, overflow: 'auto',
                          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word',
                          maxHeight: 320, backgroundColor: tokens.colorNeutralBackground3,
                          padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, margin: tokens.spacingVerticalNone,
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
            grantSeed={ucGrantSeed}
          />

          <ModelVersionsDialog
            open={ucModelOpen}
            onOpenChange={setUcModelOpen}
            fullName={ucModelTarget}
            onGrants={openModelGrants}
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

          <UcTagsDialog
            open={ucTagsOpen}
            onOpenChange={setUcTagsOpen}
            target={ucTagsTarget}
            warehouseId={warehouseId}
            onChanged={() => { if (ucTagsTarget) void loadTableTags(ucTagsTarget.catalog, ucTagsTarget.schema, ucTagsTarget.table); }}
          />
          <GovernedTagsDialog
            open={ucGovTagsOpen}
            onOpenChange={setUcGovTagsOpen}
            warehouseId={warehouseId}
          />
          <ExternalLocationsDialog
            open={ucExtLocOpen}
            onOpenChange={setUcExtLocOpen}
          />
          <ConnectionsDialog
            open={ucConnsOpen}
            onOpenChange={setUcConnsOpen}
            warehouseId={warehouseId}
          />
          <WorkspaceBindingsDialog
            open={ucBindingsOpen}
            onOpenChange={setUcBindingsOpen}
            catalog={activeCatalog}
            catalogs={catalogs}
          />
          <AuditSystemDialog
            open={ucAuditOpen}
            onOpenChange={setUcAuditOpen}
            warehouseId={warehouseId}
            catalog={activeCatalog}
            schema={activeSchema}
          />

          <MarketplaceDialog
            open={ucMarketplaceOpen}
            onOpenChange={setUcMarketplaceOpen}
          />
          <CleanRoomsDialog
            open={ucCleanRoomsOpen}
            onOpenChange={setUcCleanRoomsOpen}
          />

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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    {ctasError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                    )}
                    <Caption1>
                      Wraps the editor SELECT as <code>CREATE TABLE `catalog`.`schema`.`name` USING DELTA AS SELECT …</code>{' '}
                      and runs it on the warehouse. Requires <code>CREATE TABLE</code> + <code>USE SCHEMA</code> + <code>USE CATALOG</code> on the target.
                    </Caption1>
                    <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
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

