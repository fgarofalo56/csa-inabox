'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * WarehouseEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Real-REST Fabric Warehouse over a Synapse Dedicated SQL pool. The editor's
 * exclusive helpers (WHQueryResult, WHSchemaResp, SAMPLE_SQL, formatCell) move
 * with it; the only shared dependency is the module's `useStyles`, now imported
 * from ./styles. phase3-editors.tsx re-exports this symbol from a barrel line,
 * so the registry resolves WarehouseEditor unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { WarehouseContent } from '@/lib/apps/content-bundles/types';
import {
  Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Stop20Regular, MathFormula20Regular, Flowchart20Regular,
  DataBarVertical20Regular, ArrowImport20Regular, Eye20Regular, Form20Regular,
} from '@fluentui/react-icons';
import { ModelViewPanel } from '../components/model-view-canvas';
import { ItemEditorChrome } from '../item-editor-chrome';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import { EmptyState } from '@/lib/components/empty-state';
import { WarehouseMonitoringTab } from '../components/warehouse-monitoring';
import { StatsMaintenanceDialog } from '../components/stats-maintenance-dialog';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { sqlRowCount, loadSqlScript } from '../sql-explorer-helpers';
import type { ScriptObjectType, ScriptMode } from '@/lib/azure/sql-object-scripting';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from '../components/warehouse-alerts';
import { WarehouseAcceleration } from '../components/warehouse-acceleration';
import {
  useWarehouseCopilot,
  WarehouseCopilotActions,
  WarehouseCopilotPanels,
} from '../warehouse-editor';
import { VisualQueryCanvas } from '../components/visual-query-canvas';
import { ComputePicker } from '@/lib/components/compute-picker';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { QueryParamsBar, substituteSynapse, type QueryParam } from '../components/query-params';
import { ResultVisualize } from '../components/result-visualize';
import { SqlMigrationWizard } from '../sql-migration-wizard';
import { useStyles } from './styles';

interface WHQueryResult {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  state?: string;
  code?: string;
  sqlNumber?: number;
  warehouse?: string;
  canceled?: boolean;
}
interface WHSchemaResp {
  ok: boolean;
  state?: string;
  sku?: string;
  warehouse?: string;
  message?: string;
  schemas?: Record<string, { table: string; rows: number }[]>;
  databases?: string[];
  columns?: string[];
  views?: { schema: string; name: string }[];
  procedures?: { schema: string; name: string }[];
  functions?: { schema: string; name: string; type: string }[];
  warnings?: string[];
  error?: string;
}

const SAMPLE_SQL = `-- Fabric Warehouse (Loom-Gov: backed by Synapse Dedicated SQL pool)\nSELECT 1 AS smoke, DB_NAME() AS db, SYSTEM_USER AS upn, SYSDATETIMEOFFSET() AS now_utc;`;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function WarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new';
  // Bundle-installed warehouses stamp their rich definition (DDL, dbt models,
  // starter queries) into the Cosmos item's state.content (WarehouseContent).
  // The live Synapse Dedicated pool may be Paused / not-yet-provisioned, in
  // which case /schema 409s and the explorer renders empty. Read the persisted
  // content from the React Query cache the host page primes at
  // ['item','warehouse',id] so the editor opens FULLY built-out — showing the
  // DDL, dbt medallion models, and starter queries — even before the live
  // warehouse exists. Run / Save-as-table still hit the live backend.
  const itemQ = useQuery<WorkspaceItem>({
    queryKey: ['item', 'warehouse', id],
    queryFn: () => getItem('warehouse', id),
    enabled: !isNew,
  });
  const content = (itemQ.data?.state as any)?.content as WarehouseContent | undefined;
  const bundleContent = content?.kind === 'warehouse' ? content : undefined;
  const starterQueries = bundleContent?.starterQueries ?? [];
  const dbtModels = bundleContent?.dbtModels ?? [];
  const hasBundle = !!bundleContent && (!!bundleContent.ddl || starterQueries.length > 0 || dbtModels.length > 0);

  const [sqlText0] = useState(SAMPLE_SQL);
  const { tabs, activeTabId, activeTab, setActiveTabId, addTab, closeTab, patchTab, setActiveSql, setActiveResult } =
    useSqlTabs<WHQueryResult>(sqlText0, {
      slug: 'warehouse',
      workspaceId: (itemQ.data as any)?.workspaceId,
      itemId: id !== 'new' ? id : undefined,
    });
  const sqlText = activeTab.sql;
  const setSqlText = setActiveSql;
  const result = activeTab.result;
  const loading = activeTab.loading;
  const setResult = setActiveResult;
  const editorRef = useRef<any>(null);
  const schemaCacheRef = useRef<SqlSchemaCache>(createEmptyCache());
  const [canceling, setCanceling] = useState(false);
  const [database, setDatabase] = useState('');
  const [schema, setSchema] = useState<WHSchemaResp | null>(null);
  const handleEditorReady = useCallback((ed: any, mc: any) => {
    editorRef.current = ed;
    registerSqlIntelliSense(mc, 'sql', () => schemaCacheRef.current);
  }, []);
  const cacheColumns = useCallback(async (schemaName: string, tbl: string) => {
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/schema?table=${encodeURIComponent(`${schemaName}.${tbl}`)}`);
      const j = (await r.json()) as WHSchemaResp;
      if (j.ok && j.columns) schemaCacheRef.current.columns.set(`${schemaName}.${tbl}`, j.columns);
    } catch { /* best-effort */ }
  }, [id]);
  // Query | Model | Monitoring — the Model view is the Loom-native parity of
  // Fabric/Power BI model view (table cards + relationship lines + measures),
  // with NO Power BI dependency. Monitoring shows the query-load chart + recent
  // requests on real sys.dm_pdw_exec_requests via the dedicated pool.
  const [editorTab, setEditorTab] = useState<'query' | 'model' | 'monitoring' | 'migrate'>('query');
  // Visual (no-code) query canvas — Power-Query diagram-view parity.
  const [vqOpen, setVqOpen] = useState(false);
  // Query parameters auto-detected from {{name}} tokens + chart-visualize toggle.
  const [queryParams, setQueryParams] = useState<QueryParam[]>([]);
  const [showViz, setShowViz] = useState(false);
  // Seed the SQL editor with the bundle DDL once, when the live warehouse has
  // no tables to show — so the surface lands populated instead of on a smoke
  // test. The user can Run it (creates the schema) against the live compute.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !bundleContent?.ddl) return;
    if (sqlText !== SAMPLE_SQL) return;
    setSqlText(`-- Starter DDL from the installed app bundle.\n-- Run against the warehouse compute to provision these tables.\n\n${bundleContent.ddl}`);
    seededRef.current = true;
  }, [bundleContent, sqlText]);
  // Surface the underlying Synapse Dedicated SQL pool via ComputePicker so
  // users can Resume the pool when paused without leaving the Warehouse
  // editor. Selection is informational here — Warehouse query routes to the
  // wired-in pool — but the lifecycle controls (Resume / Pause) are wired.
  const [computeId, setComputeId] = useState('');

  const loadSchema = useCallback(async () => {
    // Pre-save gate: /items/warehouse/new fires this before any record exists
    // (was returning 409 on the walkthrough validator). Skip until saved.
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/schema`);
      const j = (await r.json()) as WHSchemaResp;
      setSchema(j);
      if (j.ok) schemaCacheRef.current.catalogs = Object.keys(j.schemas || {});
    } catch (e: any) {
      setSchema({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const run = useCallback(async () => {
    const sqlToRun = getRunSql(editorRef, sqlText);
    if (!sqlToRun.trim()) return;
    const tabId = activeTabId;
    const queryId = `wh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    patchTab(tabId, { loading: true, result: null, queryId });
    try {
      // Rewrite {{name}} → @name; values bound via req.input() — injection-safe.
      const statement = substituteSynapse(sqlToRun, queryParams);
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: statement, parameters: queryParams, queryId, database: database || undefined }),
      });
      const j = (await r.json()) as WHQueryResult;
      patchTab(tabId, { result: j });
      if (r.status === 409 && j.state) loadSchema();
    } catch (e: any) {
      patchTab(tabId, { result: { ok: false, error: e?.message || String(e) } });
    } finally {
      patchTab(tabId, { loading: false, queryId: undefined });
      setCanceling(false);
    }
  }, [id, sqlText, database, queryParams, loadSchema, activeTabId, patchTab]);

  const cancel = useCallback(async () => {
    const qid = activeTab.queryId;
    if (!qid) return;
    setCanceling(true);
    try {
      await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId: qid }),
      });
    } catch { /* TDS attention may already have landed */ }
  }, [id, activeTab.queryId]);

  const schemaEntries = Object.entries(schema?.schemas || {});
  const ready = schema?.ok === true;
  const whViews = schema?.views ?? [];
  const whProcedures = schema?.procedures ?? [];
  const whFunctions = schema?.functions ?? [];

  // Script-out: load the real CREATE/ALTER/DROP into the editor buffer.
  const loadScript = useCallback(async (type: ScriptObjectType, objSchema: string, name: string, mode: ScriptMode) => {
    const r = await loadSqlScript('warehouse', id, { type, schema: objSchema, name, mode });
    if (r.ok && r.script != null) { setSqlText(r.script); setResult(null); }
    else { setResult({ ok: false, error: r.error || 'Could not script object' }); }
  }, [id]);
  const countRows = useCallback(
    (objSchema: string, name: string) => sqlRowCount('warehouse', id, objSchema, name),
    [id],
  );

  // Flatten the schema tree to a {schema, table} list for the visual-query
  // canvas's Add-table picker.
  const vqSourceTables = useMemo(
    () => schemaEntries.flatMap(([sName, tables]) => tables.map((t) => ({ schema: sName, table: t.table }))),
    [schemaEntries],
  );

  const canRun = ready && !loading;

  // Save-as-table dialog state — CTAS helper.
  const [ctasOpen, setCtasOpen] = useState(false);
  const [ctasSchema, setCtasSchema] = useState('dbo');
  const [ctasTable, setCtasTable] = useState('');
  const [ctasBusy, setCtasBusy] = useState(false);
  const [ctasError, setCtasError] = useState<string | null>(null);
  // Query-result alerts — Azure Monitor scheduled-query rule (Gov) /
  // Databricks SQL Alerts (Comm/GCC). Backend chosen server-side by cloud.
  const [alertsOpen, setAlertsOpen] = useState(false);

  // Column & Row security dialog (column-level GRANT, RLS, DDM) over the
  // backing Synapse Dedicated SQL pool — Azure-native, no Fabric dependency.
  const [secOpen, setSecOpen] = useState(false);

  // Query acceleration dialog — Azure-native parity of Fabric's GPU-accelerated
  // warehouse. GPU is a Fabric-engine-only capability (honest gate on the
  // Synapse default); result-set caching is the real Azure-native acceleration
  // knob (live ALTER DATABASE). Backed by /query-acceleration.
  const [accelOpen, setAccelOpen] = useState(false);

  // Statistics manager (CREATE / UPDATE / DROP STATISTICS) for a selected table.
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsTarget, setStatsTarget] = useState<{ schema: string; table: string } | null>(null);

  const newSql = useCallback(() => {
    // Open a fresh tab (multi-tab is wired via the tab bar + "+" control).
    addTab();
  }, [addTab]);

  const openCtas = useCallback(() => {
    setCtasError(null);
    setCtasTable('');
    setCtasOpen(true);
  }, []);

  const submitCtas = useCallback(async () => {
    if (!ctasTable.trim()) { setCtasError('table name required'); return; }
    setCtasBusy(true); setCtasError(null);
    try {
      // Strip a trailing semicolon if present so we can wrap in CTAS.
      const cleaned = sqlText.trim().replace(/;+\s*$/, '');
      if (!/^select\b/i.test(cleaned)) {
        throw new Error('CTAS requires the current query to start with SELECT.');
      }
      const ddl = `CREATE TABLE [${ctasSchema.replace(/]/g, '')}].[${ctasTable.replace(/]/g, '')}] AS\n${cleaned};`;
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: ddl }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCtasOpen(false);
      loadSchema();
    } catch (e: any) { setCtasError(e?.message || String(e)); }
    finally { setCtasBusy(false); }
  }, [id, sqlText, ctasSchema, ctasTable, loadSchema]);

  const openInExcel = useCallback(async () => {
    if (!sqlText.trim()) return;
    try {
      const r = await clientFetch(`/api/items/warehouse/${encodeURIComponent(id)}/iqy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-warehouse-${id}.iqy`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, sqlText]);

  // Warehouse Copilot — inline NL→SQL / explain / fix / optimize over the Loom
  // AOAI deployment (no Fabric Copilot). The hook owns the assist state machine
  // and the INSERT BRIDGE: an applied generate/fix suggestion replaces sqlText
  // and clears the prior result so the next Run executes the new query against
  // the real Synapse Dedicated SQL pool. Optimize grounds in a real EXPLAIN
  // WITH_RECOMMENDATIONS plan (see lib/editors/warehouse-editor.tsx).
  const copilot = useWarehouseCopilot(id, {
    sql: sqlText,
    resultError: result && !result.ok ? result.error || null : null,
    onInsert: (next) => {
      setSqlText(next);
      setResult(null);
    },
  });

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: newSql },
        { label: 'New visual query', onClick: () => setVqOpen(true), title: 'Build a query visually (Power Query diagram view) — no SQL required' },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        { label: 'Save as table', onClick: canRun && sqlText.trim() ? openCtas : undefined, disabled: !canRun || !sqlText.trim(), title: !canRun ? 'warehouse compute is not ready' : (!sqlText.trim() ? 'enter a SELECT first' : undefined) },
        { label: 'Open in Excel', onClick: sqlText.trim() ? openInExcel : undefined, disabled: !sqlText.trim(), title: !sqlText.trim() ? 'enter a query first' : undefined },
      ]},
      { label: 'Copilot', actions: [
        { label: 'Ask Copilot', onClick: copilot.openPrompt, title: 'Generate T-SQL from natural language' },
        { label: 'Explain', onClick: sqlText.trim() ? copilot.explain : undefined, disabled: !sqlText.trim(), title: 'Explain this T-SQL query' },
        { label: 'Optimize', onClick: (canRun && sqlText.trim()) ? copilot.optimize : undefined, disabled: !canRun || !sqlText.trim(), title: !ready ? 'warehouse compute is not ready' : 'Analyze the query plan (EXPLAIN WITH_RECOMMENDATIONS) and suggest optimizations' },
      ]},
      { label: 'Modeling', actions: [
        // Open the interactive Model view (table cards + relationship lines +
        // measures) — Loom-native, no Power BI dependency.
        { label: 'Model view', onClick: () => setEditorTab('model') },
        // Model view: a warehouse "measure" is a persisted scalar/inline TVF.
        // Loads a real CREATE FUNCTION template the user runs via the wired
        // /query path. Run executes it against the warehouse compute.
        { label: 'New measure', onClick: canRun ? () => { setSqlText(
          `-- Model view — define a reusable measure as an inline table-valued function.\n`
          + `CREATE FUNCTION dbo.fn_TotalSales()\n`
          + `RETURNS TABLE AS RETURN (\n`
          + `  SELECT SUM(Amount) AS TotalSales FROM dbo.Sales\n`
          + `);`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        // Real DMV — table relationships (foreign keys) that drive Model view.
        { label: 'Manage relationships', onClick: canRun ? () => { setSqlText(
          `-- Model view — table relationships (foreign keys).\n`
          + `SELECT fk.name AS relationship,\n`
          + `       OBJECT_NAME(fk.parent_object_id) AS from_table,\n`
          + `       OBJECT_NAME(fk.referenced_object_id) AS to_table\n`
          + `FROM sys.foreign_keys fk;`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
      ]},
      { label: 'Manage', actions: [
        // Real DMV — database principals & role membership.
        { label: 'Principals', onClick: canRun ? () => { setSqlText(
          `-- Warehouse permissions — principals and role membership.\n`
          + `SELECT p.name AS principal, p.type_desc, ISNULL(r.name, '') AS member_of\n`
          + `FROM sys.database_principals p\n`
          + `LEFT JOIN sys.database_role_members m ON m.member_principal_id = p.principal_id\n`
          + `LEFT JOIN sys.database_principals r ON r.principal_id = m.role_principal_id\n`
          + `WHERE p.type IN ('S','U','G','X','R') ORDER BY p.type_desc, p.name;`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        // Source control lives at the workspace level in Fabric — open the
        // workspace Git settings (honest navigation, not a stub).
        { label: 'Source control', onClick: () => window.open('https://learn.microsoft.com/fabric/data-warehouse/source-control', '_blank'), title: 'Warehouse Git integration — managed at the workspace level' },
      ]},
      { label: 'Statistics', actions: [
        {
          label: 'Manage statistics',
          onClick: statsTarget ? () => setStatsOpen(true) : undefined,
          disabled: !statsTarget,
          title: statsTarget
            ? `CREATE / UPDATE / DROP STATISTICS on [${statsTarget.schema}].[${statsTarget.table}]`
            : 'Select a table in the explorer first',
        },
      ]},
      { label: 'Performance', actions: [
        // Azure-native parity of Fabric's GPU-accelerated warehouse. GPU is a
        // Fabric-engine capability surfaced as an honest gate on Synapse;
        // result-set caching is the real Azure-native acceleration knob.
        { label: 'Query acceleration', onClick: () => setAccelOpen(true), title: 'GPU acceleration (Fabric-engine, opt-in) and result-set caching (Azure-native) for the warehouse' },
      ]},
      { label: 'Alerts', actions: [
        { label: 'Alerts', onClick: () => setAlertsOpen(true), title: 'Query-result alerts — query + condition + schedule + notification (Azure Monitor scheduled-query rule)' },
      ]},
      { label: 'Security', actions: [
        // Column-level GRANT, Row-Level Security and Dynamic Data Masking over
        // the backing Synapse Dedicated SQL pool (Azure-native — no Fabric).
        { label: 'Column & Row security', onClick: canRun ? () => setSecOpen(true) : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : 'Column-level GRANT, Row-Level Security, Dynamic Data Masking' },
      ]},
    ]},
  ], [loading, canRun, ready, run, newSql, sqlText, openCtas, openInExcel, statsTarget, copilot.openPrompt, copilot.explain, copilot.optimize]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: tokens.spacingVerticalS }}>
          <Tree aria-label="Warehouse explorer" defaultOpenItems={['schemas', 'starter', 'starter-queries', 'dbt-models']}>
            {hasBundle && (
              <TreeItem itemType="branch" value="starter">
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  Starter content (app bundle)
                </TreeItemLayout>
                <Tree>
                  {bundleContent?.ddl && (
                    <TreeItem
                      itemType="leaf"
                      value="starter-ddl"
                      onClick={() => { setSqlText(`-- Starter DDL from the installed app bundle.\n-- Run against the warehouse compute to provision these tables.\n\n${bundleContent.ddl}`); setResult(null); }}
                    >
                      <TreeItemLayout iconBefore={<DocumentTable20Regular />}>DDL — schema script</TreeItemLayout>
                    </TreeItem>
                  )}
                  {dbtModels.length > 0 && (
                    <TreeItem itemType="branch" value="dbt-models">
                      <TreeItemLayout iconBefore={<Folder20Regular />}>dbt models ({dbtModels.length})</TreeItemLayout>
                      <Tree>
                        {dbtModels.map((m, i) => (
                          <TreeItem
                            key={`${m.layer}.${m.name}.${i}`}
                            itemType="leaf"
                            value={`dbt-${m.layer}-${m.name}-${i}`}
                            onClick={() => { setSqlText(`-- dbt model [${m.layer}] ${m.name}\n\n${m.sql}`); setResult(null); }}
                          >
                            <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                              {m.name} <Caption1>· {m.layer}</Caption1>
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                  {starterQueries.length > 0 && (
                    <TreeItem itemType="branch" value="starter-queries">
                      <TreeItemLayout iconBefore={<Folder20Regular />}>Starter queries ({starterQueries.length})</TreeItemLayout>
                      <Tree>
                        {starterQueries.map((qy, i) => (
                          <TreeItem
                            key={`${qy.name}-${i}`}
                            itemType="leaf"
                            value={`sq-${qy.name}-${i}`}
                            onClick={() => { setSqlText(qy.sql); setResult(null); }}
                          >
                            <TreeItemLayout iconBefore={<Play20Regular />}>{qy.name}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                </Tree>
              </TreeItem>
            )}
            <TreeItem itemType="branch" value="schemas">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Schemas ({schemaEntries.length})
              </TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="not-ready">
                    <TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout>
                  </TreeItem>
                )}
                {ready && schemaEntries.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No user tables yet. Create with T-SQL.</TreeItemLayout>
                  </TreeItem>
                )}
                {schemaEntries.map(([schemaName, tables]) => (
                  <TreeItem key={schemaName} itemType="branch" value={`s-${schemaName}`}>
                    <TreeItemLayout iconBefore={<Folder20Regular />}>{schemaName} ({tables.length})</TreeItemLayout>
                    <Tree>
                      {tables.map((t) => (
                        <TreeItem
                          key={t.table}
                          itemType="leaf"
                          value={`t-${schemaName}.${t.table}`}
                          onClick={() => { setStatsTarget({ schema: schemaName, table: t.table }); setSqlText(`SELECT TOP 100 * FROM [${schemaName}].[${t.table}];`); void cacheColumns(schemaName, t.table); }}
                        >
                          <TreeItemLayout
                            iconBefore={<DocumentTable20Regular />}
                            // Drag onto the visual-query canvas to add a source.
                            draggable
                            onDragStart={(e: React.DragEvent) => {
                              e.dataTransfer.setData('application/loom-vq-table', JSON.stringify({ schema: schemaName, table: t.table }));
                              e.dataTransfer.effectAllowed = 'copy';
                            }}
                          >
                            {t.table} <Caption1>· {t.rows.toLocaleString()} rows</Caption1>
                          </TreeItemLayout>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Views */}
            <TreeItem itemType="branch" value="views">
              <TreeItemLayout iconBefore={<Eye20Regular />}>Views ({whViews.length})</TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="v-not-ready"><TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout></TreeItem>
                )}
                {ready && whViews.length === 0 && (
                  <TreeItem itemType="leaf" value="v-empty"><TreeItemLayout><Caption1>No views</Caption1></TreeItemLayout></TreeItem>
                )}
                {whViews.map((v) => (
                  <TreeItem key={`v-${v.schema}.${v.name}`} itemType="leaf" value={`v-${v.schema}.${v.name}`}
                    onClick={() => setSqlText(`SELECT TOP 100 * FROM [${v.schema}].[${v.name}];`)}>
                    <TreeItemLayout iconBefore={<Eye20Regular />}
                      actions={<SqlObjectScriptMenu name={`${v.schema}.${v.name}`}
                        onScriptCreate={() => loadScript('view', v.schema, v.name, 'create')}
                        onScriptAlter={() => loadScript('view', v.schema, v.name, 'alter')}
                        onScriptDrop={() => loadScript('view', v.schema, v.name, 'drop')} />}>
                      {v.schema}.{v.name}{' '}
                      <SqlRowCountBadge cacheKey={`v-${v.schema}.${v.name}`} load={() => countRows(v.schema, v.name)} />
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Stored procedures */}
            <TreeItem itemType="branch" value="procs">
              <TreeItemLayout iconBefore={<Form20Regular />}>Stored procedures ({whProcedures.length})</TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="p-not-ready"><TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout></TreeItem>
                )}
                {ready && whProcedures.length === 0 && (
                  <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>No procedures</Caption1></TreeItemLayout></TreeItem>
                )}
                {whProcedures.map((p) => (
                  <TreeItem key={`p-${p.schema}.${p.name}`} itemType="leaf" value={`p-${p.schema}.${p.name}`}
                    onClick={() => setSqlText(`EXEC [${p.schema}].[${p.name}];`)}>
                    <TreeItemLayout iconBefore={<Form20Regular />}
                      actions={<SqlObjectScriptMenu name={`${p.schema}.${p.name}`}
                        onScriptCreate={() => loadScript('procedure', p.schema, p.name, 'create')}
                        onScriptAlter={() => loadScript('procedure', p.schema, p.name, 'alter')}
                        onScriptDrop={() => loadScript('procedure', p.schema, p.name, 'drop')} />}>
                      {p.schema}.{p.name}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Functions */}
            <TreeItem itemType="branch" value="funcs">
              <TreeItemLayout iconBefore={<MathFormula20Regular />}>Functions ({whFunctions.length})</TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="f-not-ready"><TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout></TreeItem>
                )}
                {ready && whFunctions.length === 0 && (
                  <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1>No functions</Caption1></TreeItemLayout></TreeItem>
                )}
                {whFunctions.map((f) => (
                  <TreeItem key={`f-${f.schema}.${f.name}`} itemType="leaf" value={`f-${f.schema}.${f.name}`}
                    onClick={() => setSqlText(
                      f.type === 'FN'
                        ? `SELECT [${f.schema}].[${f.name}]();`
                        : `SELECT TOP 100 * FROM [${f.schema}].[${f.name}]();`,
                    )}>
                    <TreeItemLayout iconBefore={<MathFormula20Regular />}
                      actions={<SqlObjectScriptMenu name={`${f.schema}.${f.name}`}
                        onScriptCreate={() => loadScript('function', f.schema, f.name, 'create')}
                        onScriptAlter={() => loadScript('function', f.schema, f.name, 'alter')}
                        onScriptDrop={() => loadScript('function', f.schema, f.name, 'drop')} />}>
                      {f.schema}.{f.name}{' '}
                      <Caption1>· {f.type === 'FN' ? 'scalar' : f.type === 'IF' ? 'inline TVF' : 'TVF'}</Caption1>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={editorTab} onTabSelect={(_, d) => setEditorTab(d.value as 'query' | 'model' | 'monitoring' | 'migrate')}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="model" icon={<Flowchart20Regular />}>Model</Tab>
            <Tab value="monitoring" icon={<DataBarVertical20Regular />}>Monitoring</Tab>
            <Tab value="migrate" icon={<ArrowImport20Regular />}>Migrate</Tab>
          </TabList>
          {editorTab === 'migrate' && <SqlMigrationWizard />}
          {editorTab === 'monitoring' && (
            isNew
              ? <MessageBar intent="info"><MessageBarBody><MessageBarTitle>Save the warehouse first</MessageBarTitle>Monitoring activates once the warehouse item is saved.</MessageBarBody></MessageBar>
              : <WarehouseMonitoringTab itemId={id} engine="warehouse" />
          )}
          {editorTab === 'model' && (
            <ModelViewPanel
              engine="warehouse"
              id={id}
              ready={ready}
              measureKind="tvf"
              notReadyMessage={schema?.message || 'Resume the Synapse Dedicated SQL pool to load tables.'}
              onUseInQuery={(sql) => { setSqlText(sql); setResult(null); setEditorTab('query'); }}
            />
          )}
          {editorTab === 'query' && (
          <>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={ready ? 'success' : 'warning'}>{schema?.state || 'Unknown'}</Badge>
            <Badge appearance="outline">{schema?.warehouse || 'warehouse —'}</Badge>
            <Badge appearance="outline">{schema?.sku || 'DW—'}</Badge>
            <Button appearance="outline" onClick={loadSchema}>Refresh</Button>
            <OpenInPbiDesktopButton type="warehouse" id={id} name={schema?.warehouse} />
            <Dropdown
              aria-label="Database"
              placeholder={schema?.warehouse || 'database'}
              value={database || schema?.warehouse || ''}
              selectedOptions={database ? [database] : (schema?.warehouse ? [schema.warehouse] : [])}
              onOptionSelect={(_, d) => setDatabase(d.optionValue === schema?.warehouse ? '' : (d.optionValue || ''))}
              disabled={!ready || (schema?.databases?.length ?? 0) === 0}
              style={{ minWidth: 160 }}
            >
              {(schema?.databases || []).map((d) => (
                <Option key={d} value={d} text={d}>{d}</Option>
              ))}
            </Dropdown>
            {loading && (
              <Button appearance="outline" icon={<Stop20Regular />} onClick={cancel} disabled={canceling}>
                {canceling ? 'Canceling…' : 'Cancel'}
              </Button>
            )}
            <WarehouseCopilotActions
              copilot={copilot}
              sql={sqlText}
              canOptimize={canRun}
              hasError={!!(result && !result.ok && result.error)}
            />
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !ready} onClick={run} style={{ marginLeft: 'auto' }}>Run</Button>
          </div>
          {schema && !ready && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse compute is {schema.state}</MessageBarTitle>
                {schema.message || 'Pick the Synapse Dedicated SQL pool below and click Resume.'}
                {hasBundle && ' This warehouse was installed from an app bundle — its starter DDL, dbt models, and queries are listed in the explorer on the left. Resume the pool, then Run the DDL to provision them.'}
              </MessageBarBody>
            </MessageBar>
          )}
          {/*
           * Compute picker so users can Resume the underlying Synapse
           * Dedicated SQL pool when paused, directly from the Warehouse
           * editor instead of round-tripping to the dedicated-pool editor.
           */}
          <ComputePicker
            label="Backing compute (Synapse Dedicated SQL)"
            filter={['synapse-dedicated-sql']}
            value={computeId}
            onChange={setComputeId}
          />
          <SqlTabBar tabs={tabs} activeTabId={activeTabId} onSelect={setActiveTabId} onAdd={addTab} onClose={closeTab} />
          {/* Warehouse Copilot — NL prompt bar + loading spinner (generate mode) */}
          <WarehouseCopilotPanels copilot={copilot} />
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={260}
            minHeight={200}
            ariaLabel="Warehouse T-SQL editor"
            onReady={handleEditorReady}
          />
          <QueryParamsBar sql={sqlText} onChange={setQueryParams} showTypePicker={false} />
          {loading && <Spinner size="small" label="Executing T-SQL…" labelPosition="after" />}
          {result && !result.ok && (
            <MessageBar intent={result.canceled ? 'warning' : 'error'}>
              <MessageBarBody>
                <MessageBarTitle>{result.canceled ? 'Query canceled' : 'Query failed'}</MessageBarTitle>
                {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
              </MessageBarBody>
            </MessageBar>
          )}
          {result?.ok && (
            <>
              <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center' }}>
                <Badge appearance="filled" color="success">{result.rowCount ?? result.rows?.length ?? 0} rows</Badge>
                <Caption1>· {result.executionMs} ms</Caption1>
                {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
                {(result.rows?.length ?? 0) > 0 && (
                  <Button size="small" appearance={showViz ? 'primary' : 'outline'} icon={<DataBarVertical20Regular />}
                    onClick={() => setShowViz((v) => !v)} style={{ marginLeft: 'auto' }}>
                    {showViz ? 'Hide chart' : 'Visualize'}
                  </Button>
                )}
              </div>
              {showViz && (result.rows?.length ?? 0) > 0 && (
                <ResultVisualize columns={result.columns || []} rows={result.rows || []} />
              )}
              {(result.rows?.length ?? 0) === 0 ? (
                <EmptyState
                  icon={<DataBarVertical20Regular />}
                  title="Query returned no rows"
                  body="The T-SQL statement ran successfully but produced no rows. Adjust the predicates and run it again."
                />
              ) : (
                <div style={{ overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                  <Table aria-label="Query results" size="small">
                    <TableHeader><TableRow>
                      {(result.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                    </TableRow></TableHeader>
                    <TableBody>
                      {(result.rows || []).map((row, i) => (
                        <TableRow key={i}>
                          {(result.columns || []).map((_, j) => (
                            <TableCell key={j} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' }}>{formatCell(row[j])}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
          </>
          )}

          <Dialog open={ctasOpen} onOpenChange={(_, d) => setCtasOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save as table (CTAS)</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Wraps the current query as <code>CREATE TABLE … AS SELECT …</code> and runs it
                    against the warehouse. Schema + table must not already exist.
                  </Caption1>
                  <Field label="Schema">
                    <Input value={ctasSchema} onChange={(_, d) => setCtasSchema(d.value)} placeholder="dbo" />
                  </Field>
                  <Field label="Table name" required>
                    <Input value={ctasTable} onChange={(_, d) => setCtasTable(d.value)} placeholder="orders_top100" />
                  </Field>
                  {ctasError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCtasOpen(false)} disabled={ctasBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitCtas} disabled={ctasBusy || !ctasTable.trim()}>
                    {ctasBusy ? 'Creating…' : 'Create table'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {statsTarget && (
            <StatsMaintenanceDialog
              open={statsOpen}
              onOpenChange={setStatsOpen}
              engine="warehouse"
              itemId={id}
              schema={statsTarget.schema}
              tableName={statsTarget.table}
            />
          )}
          <WarehouseAlerts engine="warehouse" id={id} open={alertsOpen} onOpenChange={setAlertsOpen} />
          <WarehouseAcceleration id={id} open={accelOpen} onOpenChange={setAccelOpen} />
          <Dialog open={secOpen} onOpenChange={(_, d) => setSecOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '980px', width: '94vw' }}>
              <DialogBody>
                <DialogTitle>Column &amp; Row security — {schema?.warehouse || 'Warehouse'}</DialogTitle>
                <DialogContent>
                  <SqlSecurityPanel itemType="warehouse" itemId={id} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSecOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Visual (no-code) query canvas — Power Query diagram-view parity. */}
          <Dialog open={vqOpen} onOpenChange={(_, d) => setVqOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1280px', width: '96vw' }}>
              <DialogBody>
                <DialogTitle>Visual query — {schema?.warehouse || 'Warehouse'}</DialogTitle>
                <DialogContent>
                  <VisualQueryCanvas engine="warehouse" id={id} dialect="tsql" sourceTables={vqSourceTables} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setVqOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
