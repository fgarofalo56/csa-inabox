'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 *
 * v2.1 KQL family (Eventhouse, KQL Database, KQL Queryset, KQL Dashboard,
 * Eventstream) are wired live against the shared Loom ADX cluster
 * (default `adx-csa-loom-shared` in `eastus2`, cloud-correct suffix) via the Console UAMI
 * (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt, ARM for database
 * create). Eventstream persists pipeline config to Cosmos; runtime
 * wiring lands in v3.
 *
 * Warehouse is real-REST (Fabric Warehouse over Synapse Dedicated pool).
 *
 * v2.1 Power BI / Fabric family — Semantic model, Report, Dashboard,
 * Paginated report, Scorecard, and Activator — are now wired against
 * live Power BI REST (api.powerbi.com/v1.0/myorg) and Fabric REST
 * (api.fabric.microsoft.com/v1) via the Console UAMI. If the UAMI's SP
 * is not yet registered in the Power BI tenant or hasn't been added to
 * a workspace, the editors surface the underlying 401/403 verbatim with
 * a remediation hint — no mock data is shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getItem, createItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { WarehouseContent, RollupMethod, StatusColor, StatusOperator, StatusMetricKind, StatusRule } from '@/lib/apps/content-bundles/types';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field, Link,
  Card, Divider,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch, Checkbox, ProgressBar, SpinButton,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular, Stop20Regular,
  MathFormula20Regular, Table20Regular, DatabaseLink20Regular,
  Flowchart20Regular,
  Apps20Regular, List20Regular, Open20Regular,
  Sparkle16Regular, Info16Regular, Wrench16Regular,
  Warning20Regular, ErrorCircle20Regular, CheckmarkCircle20Regular, Info20Regular,
  DataBarVertical20Regular,
  ArrowImport20Regular,
  Eye20Regular, Form20Regular,
  ArrowMaximize20Regular, Pin20Regular, Flash20Regular, Sparkle20Regular,
  ArrowDownload20Regular, Copy20Regular, Edit20Regular,
} from '@fluentui/react-icons';
import { AdxDatabaseTree } from '@/lib/components/adx/adx-database-tree';
import { AdxRbacPanel } from '@/lib/components/adx/adx-rbac-panel';
import { AdxClusterEditor } from '@/lib/components/adx/adx-cluster-editor';
import { IngestionMappingWizardDialog } from '@/lib/components/adx/ingestion-mapping-wizard';
import {
  ColumnGridDesigner, toKustoSchema, parseKustoSchema, validateColumns,
  type ColumnDef,
} from '@/lib/components/adx/column-grid-designer';
import {
  SchemaDiagramCanvas,
  type SchemaGraphNode, type SchemaGraphEdge, type SchemaNodeKind,
} from '@/lib/components/adx/schema-diagram-canvas';
import { KustoResultsGrid } from '@/lib/components/adx/kusto-results-grid';
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
// Wave-3 Model-view extras (Azure-native by DEFAULT, no Fabric/Power BI required):
// what-if parameters, quick measures, calculated tables, and Q&A synonyms — each
// section owns its real BFF save flow + persists onto the owned item's state.model.
import { ItemEditorChrome } from './item-editor-chrome';
import { OpenInPbiDesktopButton } from './components/open-in-pbi-desktop-button';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';
import { EmptyState } from '@/lib/components/empty-state';
import type {
  RdlReportDefinition, RdlDataSource, RdlDataset, RdlTablix, RdlParameter,
  RdlField, RdlDataSourceType, RdlExportFormat,
} from '@/lib/azure/paginated-report-client';
import { WarehouseMonitoringTab } from './components/warehouse-monitoring';
import { NewItemCreateGate } from './new-item-gate';
import { openCopilotWithPersona } from '@/lib/components/copilot-pane';
import { StatsMaintenanceDialog } from './components/stats-maintenance-dialog';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { sqlRowCount, loadSqlScript } from './sql-explorer-helpers';
import type { ScriptObjectType, ScriptMode } from '@/lib/azure/sql-object-scripting';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from './components/warehouse-alerts';
import { WarehouseAcceleration } from './components/warehouse-acceleration';
import {
  useWarehouseCopilot,
  WarehouseCopilotActions,
  WarehouseCopilotPanels,
} from './warehouse-editor';
import { VisualQueryCanvas } from './components/visual-query-canvas';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { ComputePicker } from '@/lib/components/compute-picker';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { QueryParamsBar, substituteSynapse, type QueryParam } from './components/query-params';
import { ResultVisualize } from './components/result-visualize';
import { SqlMigrationWizard } from './sql-migration-wizard';
import {
  evalConditionalRules,
  CF_OPERATORS, CF_COLORS, CF_ICONS, CF_THEMES,
  type ConditionalRule, type CfCondition, type CfMatch,
  type CfColor, type CfIcon, type CfOperator, type CfTheme,
} from '@/lib/azure/kql-dashboard-model';

import { useStyles } from './phase3/styles';

// ============================================================
// Shared KQL results panel — extracted to ./phase3/kql-results
// ============================================================
import {
  KqlResultsPanel, TileVisual, kqlResultToCsv, downloadTextFile, slugifyForFile,
  type KqlResult, type TileViz,
} from './phase3/kql-results';

// ----- Eventhouse -----
export { EventhouseEditor, EventhouseCapacityPanel } from './phase3/eventhouse-editor';

// ----- KQL Database -----
// Ribbon is built inside the editor via useMemo. None of the actions
// below have inline handlers yet (table creation, schema mgmt, ingestion
// wizards all land in a follow-up PR) so each is disabled with a
// "not yet wired" tooltip — see no-vaporware.md.

interface KqlDbInfo {
  ok: boolean;
  cluster?: string;
  database?: string;
  details?: Record<string, unknown> | null;
  tables?: Array<{ name: string; fromContent?: boolean }>;
  tableCount?: number;
  functions?: Array<{ name: string; parameters?: string; fromContent?: boolean }>;
  functionCount?: number;
  materializedViews?: Array<{ name: string; sourceTable?: string }>;
  materializedViewCount?: number;
  // Content-derived projections surfaced when the live ADX object is absent
  // (bundle-installed KQL database not yet provisioned to the cluster). Lets
  // the editor open FULLY BUILT-OUT — schema + starter queries.
  schema?: Array<{ name: string; columns: Array<{ name: string; type: string }>; sample?: unknown[][]; live?: boolean }>;
  starterQueries?: Array<{ name: string; kql: string }>;
  contentFallback?: boolean;
  // Follower (database-shortcut) state — read-only replica of a leader cluster.
  isFollower?: boolean;
  followerLeaderCluster?: string | null;
  followerConfigName?: string | null;
  followerDatabaseName?: string | null;
  error?: string;
}

const SAMPLE_KQL_DB = `// Welcome to KQL. Try a sample:
print smoke = "ok", server_time = now(), current_user = current_principal()`;

// Functions are authored through the structured stored-function editor below
// (params grid + KQL body), so 'function' is intentionally NOT a generic
// wizard kind — it has its own dialog (openFnEditor / submitFnEditor).
type KqlWizardKind = 'table' | 'mv' | 'update-policy' | 'ingest' | 'data-connection' | 'alter-table' | 'drop-table' | 'follower';

const DEFAULT_TABLE_COLUMNS: ColumnDef[] = [
  { name: 'ts', type: 'datetime' },
  { name: 'tenant', type: 'string' },
  { name: 'value', type: 'long' },
];

/** A row from /api/azure/resources (IoT Hub / Event Hub namespace picker). */
interface DcSourceRow { id: string; name: string; resourceGroup?: string; subscriptionId?: string; location?: string }
/** A row from GET /api/items/kql-database/[id]/data-connections. */
interface DcConnectionRow { name?: string; kind?: string; tableName?: string; consumerGroup?: string; dataFormat?: string; provisioningState?: string; source?: string }

// ADX-supported data formats offered by the wizard. RAW is intentionally
// excluded — IoT Hub data connections do not support it (per ADX docs).
const DC_FORMATS = ['MULTIJSON', 'JSON', 'CSV', 'TSV', 'PSV', 'SCSV', 'SOHSV', 'TXT', 'TSVE', 'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'W3CLOGFILE'];

/**
 * Scalar parameter data types accepted in a KQL stored-function signature
 * (`paramName:paramType`). Mirrors the scalar types valid in `let` / function
 * signatures per the .create-or-alter function reference. Surfaced as a real
 * dropdown so the params grid never relies on free-typed type strings.
 */
const FN_PARAM_TYPES = [
  'string', 'long', 'int', 'real', 'double', 'decimal',
  'bool', 'datetime', 'timespan', 'dynamic', 'guid',
] as const;

type FnParam = { name: string; type: string };

/**
 * Parse a KQL function parameters string as returned by `.show functions`
 * (e.g. "(days:int, tenant:string)") into structured rows for the params grid.
 * A no-arg signature ("" or "()") yields [].
 */
function parseFnParams(raw: string | undefined): FnParam[] {
  if (!raw) return [];
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((p) => {
      const [n, t] = p.split(':');
      return { name: (n || '').trim(), type: (t || 'string').trim() };
    })
    .filter((p) => p.name);
}

/** Serialize the params grid back into the `name:type, …` argument list. */
function serializeFnParams(params: FnParam[]): string {
  return params
    .filter((p) => p.name.trim())
    .map((p) => `${p.name.trim()}:${p.type || 'string'}`)
    .join(', ');
}

export function KqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [info, setInfo] = useState<KqlDbInfo | null>(null);
  const [kql, setKql] = useState(SAMPLE_KQL_DB);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  // ── KQL Copilot (NL2KQL / explain / fix) ──────────────────────────────
  // Persona-backed inline assist — POSTs to /api/items/kql-database/<id>/assist,
  // which grounds generation in the live ADX schema (KQL_COPILOT_PERSONA) and
  // calls real AOAI. Azure-native; no Fabric dependency.
  type AssistView = 'idle' | 'prompt' | 'loading' | 'suggestion' | 'explain-result';
  const [assistView, setAssistView] = useState<AssistView>('idle');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assistResult, setAssistResult] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const lastModeRef = useRef<'generate' | 'explain' | 'fix'>('generate');
  // Bumped after a ribbon-wizard create so the AdxDatabaseTree re-lists objects.
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  // Wizard dialog state — Fabric-parity create flows for table/MV/function/update-policy
  const [wizardKind, setWizardKind] = useState<KqlWizardKind | null>(null);
  const [wizName, setWizName] = useState('');
  const [wizSchema, setWizSchema] = useState('ts:datetime, tenant:string, value:long');
  // Visual column-grid state for the table create / alter schema designer.
  const [wizColumns, setWizColumns] = useState<ColumnDef[]>(DEFAULT_TABLE_COLUMNS);
  // For alter-table / drop-table: the target table name (read-only in the dialog).
  const [wizAlterTarget, setWizAlterTarget] = useState('');
  const [wizSource, setWizSource] = useState(''); // table name (mv source / update policy source)
  const [wizQuery, setWizQuery] = useState(''); // MV query / update policy query
  const [wizBackfill, setWizBackfill] = useState(false); // MV: .create async materialized-view with (backfill=true)
  // Live source-table picker for the MV wizard — fetched from /api/adx/tables.
  const [wizTables, setWizTables] = useState<string[]>([]);
  const [wizError, setWizError] = useState<string | null>(null);
  const [wizSubmitting, setWizSubmitting] = useState(false);
  const [wizSuccess, setWizSuccess] = useState<string | null>(null);
  // Ingest wizard
  const [wizIngestFile, setWizIngestFile] = useState<File | null>(null);
  const [wizIngestFormat, setWizIngestFormat] = useState('csv');
  const [wizIngestMapping, setWizIngestMapping] = useState('');
  // Ingestion mapping wizard (format selector + auto-detect column grid)
  const [mappingWizOpen, setMappingWizOpen] = useState(false);
  // Event Hub data-connection wizard
  const [wizDcHub, setWizDcHub] = useState('');
  const [wizDcConsumerGroup, setWizDcConsumerGroup] = useState('');
  const [wizDcFormat, setWizDcFormat] = useState('JSON');
  const [wizDcCompression, setWizDcCompression] = useState('None');
  const [wizDcTargetTable, setWizDcTargetTable] = useState('');
  const [wizDcMappingRule, setWizDcMappingRule] = useState('');
  const [wizDcHubs, setWizDcHubs] = useState<string[]>([]);
  const [wizDcGroups, setWizDcGroups] = useState<string[]>([]);
  const [wizDcTables, setWizDcTables] = useState<string[]>([]);
  const [wizDcConnections, setWizDcConnections] = useState<Array<{ name: string; properties?: any }>>([]);
  const [wizDcNamespace, setWizDcNamespace] = useState('');
  const [wizDcEhGate, setWizDcEhGate] = useState<string | null>(null);
  const [wizDcLoading, setWizDcLoading] = useState(false);
  // Update-policy wizard — table pickers + transform-function selector + transactional toggle
  const [wizTransactional, setWizTransactional] = useState(false);
  const [wizFn, setWizFn] = useState(''); // selected stored function; '' = use inline query
  const [upTables, setUpTables] = useState<string[]>([]);
  const [upFunctions, setUpFunctions] = useState<string[]>([]);
  const [upLoading, setUpLoading] = useState(false);
  // Query | Diagram tab — the Diagram tab is the React Flow entity diagram of
  // the live ADX database (tables / MVs / functions / shortcuts + dependency
  // edges), Fabric RTI schema-graph parity built on the Azure-native cluster.
  const [editorTab, setEditorTab] = useState<'query' | 'diagram'>('query');
  const [graphData, setGraphData] = useState<{ nodes: SchemaGraphNode[]; edges: SchemaGraphEdge[] } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  // Delete-from-diagram confirmation dialog.
  const [deleteDlgOpen, setDeleteDlgOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; kind: SchemaNodeKind } | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Follower (database-shortcut) wizard
  const [wizLeaderResourceId, setWizLeaderResourceId] = useState('');
  const [wizLeaderUri, setWizLeaderUri] = useState('');
  const [wizFollowerDbName, setWizFollowerDbName] = useState('');
  const [wizPrincipalsKind, setWizPrincipalsKind] = useState<'Union' | 'Replace' | 'None'>('Union');
  // Detach-follower busy flag
  const [detaching, setDetaching] = useState(false);

  // ── RBAC + cluster lifecycle + per-table RLS (this task) ────────────────
  // Manage-principals (RBAC) drawer-dialog, cluster lifecycle dialog, and the
  // per-table Row-Level Security dialog opened from the navigator shield.
  const [rbacOpen, setRbacOpen] = useState(false);
  const [clusterOpen, setClusterOpen] = useState(false);
  const [rlsTable, setRlsTable] = useState<string | null>(null);
  const [rlsEnabled, setRlsEnabled] = useState(false);
  const [rlsQuery, setRlsQuery] = useState('');
  const [rlsLoading, setRlsLoading] = useState(false);
  const [rlsBusy, setRlsBusy] = useState(false);
  const [rlsError, setRlsError] = useState<string | null>(null);
  const [rlsNotice, setRlsNotice] = useState<string | null>(null);

  const openRlsEditor = useCallback(async (tableName: string) => {
    setRlsTable(tableName); setRlsError(null); setRlsNotice(null);
    setRlsEnabled(false); setRlsQuery(''); setRlsLoading(true);
    try {
      const res = await fetch(`/api/adx/rls?id=${encodeURIComponent(id)}&table=${encodeURIComponent(tableName)}`);
      const body = await res.json().catch(() => ({}));
      if (body?.ok && body.policy) { setRlsEnabled(!!body.policy.isEnabled); setRlsQuery(body.policy.query || ''); }
      else if (!body?.ok && body?.error) setRlsError(body.error);
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsLoading(false);
    }
  }, [id]);

  const submitRlsEditor = useCallback(async () => {
    if (!rlsTable) return;
    setRlsBusy(true); setRlsError(null); setRlsNotice(null);
    try {
      const res = await fetch(`/api/adx/rls?id=${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: rlsTable, enabled: rlsEnabled, query: rlsQuery }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body?.ok) { setRlsError(body?.error || 'failed to set RLS policy'); setRlsBusy(false); return; }
      setRlsNotice(
        `RLS ${body.policy?.isEnabled ? 'enabled' : 'disabled'} on ${rlsTable}.` +
        (body.warning ? ` Warning: ${body.warning}` : ''),
      );
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsBusy(false);
    }
  }, [id, rlsTable, rlsEnabled, rlsQuery]);

  const router = useRouter();

  // The workspace item record (for workspaceId, needed by "Create dashboard").
  // Reads from the React Query cache page.tsx already populated (same key), so
  // it does NOT fire an extra network request in normal use.
  const { data: itemRecord } = useQuery<WorkspaceItem>({
    queryKey: ['item', 'kql-database', id],
    queryFn: () => getItem('kql-database', id),
    enabled: !!(id && id !== 'new'),
    staleTime: 60_000,
  });

  // ── Data-connection wizard (Event Hub / IoT Hub → ADX) ──────────────────
  // Azure-native parity for a Fabric Eventhouse data connection. Works with NO
  // Fabric workspace bound — streams device-to-cloud / event messages into a
  // target table via a real Microsoft.Kusto data connection.
  const [dcOpen, setDcOpen] = useState(false);
  const [dcKind, setDcKind] = useState<'iothub' | 'eventhub'>('iothub');
  const [dcSources, setDcSources] = useState<DcSourceRow[] | null>(null);
  const [dcSourcesErr, setDcSourcesErr] = useState<string | null>(null);
  const [dcSourcesLoading, setDcSourcesLoading] = useState(false);
  const [dcSelectedSourceId, setDcSelectedSourceId] = useState('');
  const [dcPolicies, setDcPolicies] = useState<{ name: string; rights?: string }[]>([]);
  const [dcPolicyNote, setDcPolicyNote] = useState<string | null>(null);
  const [dcPolicy, setDcPolicy] = useState('iothubowner');
  const [dcConsumerGroup, setDcConsumerGroup] = useState('$Default');
  const [dcFormat, setDcFormat] = useState('MULTIJSON');
  const [dcTable, setDcTable] = useState('');
  const [dcEhEntity, setDcEhEntity] = useState(''); // Event Hub entity name (eventhub kind only)
  const [dcBusy, setDcBusy] = useState(false);
  const [dcError, setDcError] = useState<string | null>(null);
  const [dcSuccess, setDcSuccess] = useState<string | null>(null);
  const [dcExisting, setDcExisting] = useState<DcConnectionRow[] | null>(null);

  // ---- Stored function editor (params grid + KQL body, /api/adx/functions) ----
  // Owned here so both the ribbon (New → Function) and the navigator's per-row
  // "Edit function" affordance open the same structured editor.
  const [fnDlgOpen, setFnDlgOpen] = useState(false);
  const [fnDlgMode, setFnDlgMode] = useState<'create' | 'edit'>('create');
  const [fnName, setFnName] = useState('');
  const [fnNameLocked, setFnNameLocked] = useState(false); // true in edit mode
  const [fnParams, setFnParams] = useState<FnParam[]>([]);
  const [fnBody, setFnBody] = useState('');
  const [fnErr, setFnErr] = useState<string | null>(null);
  const [fnBusy, setFnBusy] = useState(false);
  const [fnDeleteBusy, setFnDeleteBusy] = useState(false);
  const [fnReceipt, setFnReceipt] = useState<{ name: string; action: 'saved' | 'deleted'; rowCount?: number; ts: string } | null>(null);

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-database/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-database/${id}`);
      const j = (await r.json()) as KqlDbInfo;
      setInfo(j);
      // Re-list the navigator (ribbon wizards call load() after a create).
      setTreeRefreshKey((k) => k + 1);
    } catch (e: any) {
      setInfo({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql }),
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, kql]);

  // KQL Copilot edge — generate (NL2KQL) / explain (Markdown) / fix.
  const callAssist = useCallback(async (mode: 'generate' | 'explain' | 'fix') => {
    lastModeRef.current = mode;
    setAssistView('loading'); setAssistError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/assist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          kql,
          prompt: mode === 'generate' ? assistPrompt : undefined,
          errorText: mode === 'fix' ? (result && !result.ok ? result.error || '' : '') : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAssistView('idle');
        setAssistError(j?.code === 'no_aoai'
          ? `KQL Copilot not configured: ${j?.hint || 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.'}`
          : (j?.error || 'AI assist failed'));
        return;
      }
      setAssistResult(j.result);
      setAssistView(mode === 'explain' ? 'explain-result' : 'suggestion');
    } catch (e: any) {
      setAssistView('idle');
      setAssistError(e?.message || String(e));
    }
  }, [id, kql, assistPrompt, result]);

  // Shift+Enter runs the query (the "Run (Shift+Enter)" button label promises
  // this). Only fires when focus is inside the KQL editor surface so it never
  // hijacks the shortcut elsewhere on the page. Mirrors the Ctrl+S pattern
  // used by the Queryset / Dashboard / Eventstream editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        const active = document.activeElement as HTMLElement | null;
        const inEditor = !!active?.closest?.('[aria-label="KQL query editor"]');
        if (inEditor && !loading && id && id !== 'new') {
          e.preventDefault();
          run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, id, run]);

  /**
   * Create a kql-dashboard item in the same workspace as this kql-database,
   * seed its first tile with a `| take 100` for the given table, then navigate
   * to the new dashboard. Mirrors the ADX web UI / Fabric "Create dashboard"
   * table context-menu action. Azure-native: uses Cosmos item creation via
   * POST /api/workspaces/<id>/items + PUT /api/items/kql-dashboard/<id>.
   * No Fabric REST involved.
   */
  const createDashboardFromTable = useCallback(async (tableName: string) => {
    const wsId = itemRecord?.workspaceId;
    const kqlTile = `["${tableName}"]\n| take 100`;
    const displayName = `${tableName} — Dashboard`;
    if (!wsId) {
      // No workspace context yet (item not loaded). Fall back to empty new-item flow.
      router.push(`/items/kql-dashboard/new`);
      return;
    }
    try {
      // Step 1: create the Cosmos item (POST /api/workspaces/<wsId>/items).
      const created = await createItem(wsId, { itemType: 'kql-dashboard', displayName });
      // Step 2: seed the first tile (PUT /api/items/kql-dashboard/<id>).
      await fetch(`/api/items/kql-dashboard/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tiles: [{ title: tableName, kql: kqlTile, viz: 'table' }],
          dataSources: [],
          parameters: [],
        }),
      });
      // Step 3: navigate. Receipt = user arrives at the working dashboard editor.
      router.push(`/items/kql-dashboard/${created.id}`);
    } catch {
      // Best-effort fallback: open new dashboard without pre-seeded tile.
      router.push(`/items/kql-dashboard/new`);
    }
  }, [itemRecord, router]);

  // Load Event Hub pickers (namespace, hubs, tables, existing connections) when
  // the data-connection wizard opens. Real ARM via the data-connections route.
  useEffect(() => {
    if (wizardKind !== 'data-connection' || !id || id === 'new') return;
    setWizDcLoading(true);
    setWizDcHubs([]); setWizDcGroups([]); setWizDcEhGate(null);
    fetch(`/api/items/kql-database/${id}/data-connections`)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok === false && j?.code === 'not_configured') {
          setWizDcEhGate((j.missing && (Array.isArray(j.missing) ? j.missing.join(', ') : j.missing)) || 'ADX cluster env');
          return;
        }
        setWizDcNamespace(j.namespace || '');
        setWizDcHubs(j.eventHubs || []);
        setWizDcTables(j.tables || []);
        setWizDcConnections(j.connections || []);
        setWizDcEhGate(j.ehNotConfigured || null);
      })
      .catch(() => { /* leave empty — the wizard surfaces the gate */ })
      .finally(() => setWizDcLoading(false));
  }, [wizardKind, id]);

  // Refresh the dedicated consumer-group list when the selected hub changes
  // (each ADX data connection needs its OWN consumer group, per Azure docs).
  useEffect(() => {
    if (wizardKind !== 'data-connection' || !wizDcHub || !id || id === 'new') return;
    setWizDcGroups([]);
    fetch(`/api/items/kql-database/${id}/data-connections?hub=${encodeURIComponent(wizDcHub)}`)
      .then((r) => r.json())
      .then((j: any) => setWizDcGroups(j.consumerGroups || []))
      .catch(() => { /* leave empty */ });
  }, [wizardKind, wizDcHub, id]);

  // Lazy-load the entity diagram graph from the live ADX schema. Only fires
  // for a saved database (id !== 'new'). Real backend: GET schema-graph →
  // .show database schema as json + .show materialized-views + .show functions.
  const loadGraph = useCallback(async () => {
    if (!id || id === 'new') return;
    setGraphLoading(true); setGraphError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/schema-graph`);
      const j = await r.json();
      if (!j.ok) setGraphError(j.error || 'Schema graph failed');
      else setGraphData({ nodes: j.nodes || [], edges: j.edges || [] });
    } catch (e: any) {
      setGraphError(e?.message || String(e));
    } finally {
      setGraphLoading(false);
    }
  }, [id]);

  // Fetch the graph the first time the Diagram tab is opened (and after a
  // delete clears graphData). Narrow deps so it doesn't re-fetch on every
  // graphData change.
  useEffect(() => {
    if (editorTab === 'diagram' && !graphData && !graphLoading && id && id !== 'new') {
      loadGraph();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTab, graphData, id]);

  // Drop a table / materialized-view / function from the diagram. Issues a real
  // `.drop ... ifexists` mgmt command via the existing /query route (mgmt
  // commands starting with `.` are auto-routed to /v1/rest/mgmt) against ADX.
  const deleteFromDiagram = useCallback(async () => {
    if (!deleteTarget) return;
    const { name, kind } = deleteTarget;
    const cmd =
      kind === 'table' ? `.drop table ["${name}"] ifexists`
      : kind === 'materialized-view' ? `.drop materialized-view ["${name}"] ifexists`
      : kind === 'function' ? `.drop function ["${name}"] ifexists`
      : kind === 'shortcut' ? `.drop external table ["${name}"]`
      : null;
    if (!cmd) { setDeleteError('This entity type cannot be deleted from the diagram.'); return; }
    setDeleteSubmitting(true); setDeleteError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: cmd }),
      });
      const j = await r.json();
      if (!j.ok) { setDeleteError(j.error || 'Delete failed'); return; }
      setDeleteDlgOpen(false); setDeleteTarget(null);
      setGraphData(null); // force the Diagram tab to re-fetch
      await Promise.all([load(), loadGraph()]);
    } catch (e: any) {
      setDeleteError(e?.message || String(e));
    } finally {
      setDeleteSubmitting(false);
    }
  }, [deleteTarget, id, load, loadGraph]);

  const openWizard = useCallback((k: KqlWizardKind, preTable?: string) => {
    setWizardKind(k); setWizError(null); setWizSuccess(null);
    setWizName(''); setWizSchema('ts:datetime, tenant:string, value:long');
    setWizColumns(DEFAULT_TABLE_COLUMNS); setWizAlterTarget('');
    // preTable: when called from a tree "Get data" hover, pre-fill the target table.
    setWizSource(preTable || ''); setWizQuery(''); setWizIngestFile(null);
    setWizIngestFormat('csv'); setWizIngestMapping('');
    // Event Hub data-connection fields
    setWizDcHub(''); setWizDcConsumerGroup(''); setWizDcFormat('JSON');
    setWizDcCompression('None'); setWizDcTargetTable(''); setWizDcMappingRule('');
    setWizDcHubs([]); setWizDcGroups([]); setWizDcTables([]); setWizDcConnections([]);
    setWizDcNamespace(''); setWizDcEhGate(null);
    setWizBackfill(false);
    setWizTransactional(false); setWizFn(''); setUpTables([]); setUpFunctions([]);
    setWizLeaderResourceId(''); setWizLeaderUri(''); setWizFollowerDbName(''); setWizPrincipalsKind('Union');
    // MV + ingest + update-policy wizards need a live source-table picker —
    // pull the real table list off the bound ADX/Eventhouse cluster.
    if ((k === 'mv' || k === 'ingest' || k === 'update-policy') && id && id !== 'new') {
      setWizTables([]);
      fetch(`/api/adx/tables?id=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.ok && Array.isArray(j.tables)) {
            setWizTables(j.tables.map((t: { name: string }) => t.name).filter(Boolean));
          }
        })
        .catch(() => { /* picker falls back to free-text via info.tables */ });
    }
  }, [id]);

  // When the update-policy wizard opens, populate the table pickers and the
  // transform-function selector from the live database (real .show tables /
  // .show functions via the existing ADX navigator routes). Best-effort: a
  // load failure leaves empty dropdowns; the user can still type a function
  // call into the inline-query box.
  useEffect(() => {
    if (wizardKind !== 'update-policy' || !id || id === 'new') return;
    let cancelled = false;
    setUpLoading(true);
    Promise.all([
      fetch(`/api/adx/tables?id=${id}`).then((r) => r.json()),
      fetch(`/api/adx/functions?id=${id}`).then((r) => r.json()),
    ]).then(([tj, fj]) => {
      if (cancelled) return;
      setUpTables(((tj.tables || []) as Array<{ name: string }>).map((t) => t.name));
      setUpFunctions(((fj.functions || []) as Array<{ name: string }>).map((f) => f.name));
    }).catch(() => { /* best-effort — leave dropdowns empty */ })
      .finally(() => { if (!cancelled) setUpLoading(false); });
    return () => { cancelled = true; };
  }, [wizardKind, id]);

  // Open the schema designer in ALTER mode for an existing table. Fetches the
  // current CSL schema so the grid pre-populates with the live columns; the
  // analyst then appends new columns (.alter-merge — additive, no data loss).
  const openAlterTable = useCallback(async (tableName: string) => {
    setWizardKind('alter-table'); setWizError(null); setWizSuccess(null);
    setWizAlterTarget(tableName); setWizColumns([]);
    try {
      const r = await fetch(`/api/adx/tables?id=${encodeURIComponent(id)}&schema=${encodeURIComponent(tableName)}`);
      const j = await r.json();
      if (j.ok && j.cslSchema) setWizColumns(parseKustoSchema(j.cslSchema));
    } catch {
      // Pre-population is best-effort — the analyst can still add columns.
    }
  }, [id]);

  const openDropTable = useCallback((tableName: string) => {
    setWizardKind('drop-table'); setWizError(null); setWizSuccess(null);
    setWizAlterTarget(tableName);
  }, []);

  // Submit the wizard. Table create / alter / drop go through the dedicated
  // `/api/adx/tables` route (POST/PATCH/DELETE → real .create / .alter-merge /
  // .drop control commands). The other object types issue a `.` mgmt command
  // via the query route (auto-routed to /v1/rest/mgmt). No mocks.
  const submitWizard = useCallback(async () => {
    if (!wizardKind) return;
    setWizError(null); setWizSuccess(null);

    // Event Hub data connection — ARM REST, NOT a `.create` mgmt command.
    if (wizardKind === 'data-connection') {
      if (wizDcEhGate) { setWizError(`Event Hubs not configured: set ${wizDcEhGate}`); return; }
      if (!wizDcHub) { setWizError('Event hub is required'); return; }
      if (!wizDcConsumerGroup) { setWizError('Consumer group is required'); return; }
      setWizSubmitting(true);
      try {
        const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: wizName.trim() || undefined,
            eventHubName: wizDcHub,
            consumerGroup: wizDcConsumerGroup,
            tableName: wizDcTargetTable || undefined,
            mappingRuleName: wizDcMappingRule.trim() || undefined,
            dataFormat: wizDcFormat,
            compression: wizDcCompression,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setWizError(j.error || (j.missing ? `Not configured: ${j.missing}` : 'Create failed'));
        } else {
          const st = j.connection?.properties?.provisioningState ?? 'Creating';
          setWizSuccess(`Data connection "${j.connection?.name}" created (state: ${st}). Streaming ingestion starts within seconds. Refreshing…`);
          await load();
          setTimeout(() => setWizardKind(null), 900);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    // --- Table schema designer flows (dedicated ADX route) ---
    if (wizardKind === 'table' || wizardKind === 'alter-table' || wizardKind === 'drop-table') {
      const tablesRoute = `/api/adx/tables?id=${encodeURIComponent(id)}`;
      setWizSubmitting(true);
      try {
        let res: Response;
        let receipt = '';
        if (wizardKind === 'table') {
          if (!wizName.trim()) { setWizError('Table name is required'); setWizSubmitting(false); return; }
          const colErr = validateColumns(wizColumns);
          if (colErr) { setWizError(colErr); setWizSubmitting(false); return; }
          const schema = toKustoSchema(wizColumns);
          res = await fetch(tablesRoute, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizName.trim(), schema }),
          });
          receipt = `Table "${wizName.trim()}" created — .create table ["${wizName.trim()}"] (${schema}).`;
        } else if (wizardKind === 'alter-table') {
          const colErr = validateColumns(wizColumns);
          if (colErr) { setWizError(colErr); setWizSubmitting(false); return; }
          const schema = toKustoSchema(wizColumns);
          res = await fetch(tablesRoute, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizAlterTarget, schema }),
          });
          receipt = `Table "${wizAlterTarget}" altered — .alter-merge table ["${wizAlterTarget}"] (${schema}).`;
        } else {
          res = await fetch(`${tablesRoute}&name=${encodeURIComponent(wizAlterTarget)}`, { method: 'DELETE' });
          receipt = `Table "${wizAlterTarget}" dropped — .drop table ["${wizAlterTarget}"] ifexists.`;
        }
        const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!j.ok) {
          setWizError(j.error || 'Command failed');
        } else {
          setWizSuccess(`Done. ${receipt} Refreshing…`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 800);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    // Follower (database-shortcut) attach — does NOT issue a `.` mgmt command;
    // it PUTs an attachedDatabaseConfiguration via the dedicated ARM route.
    if (wizardKind === 'follower') {
      if (!wizLeaderResourceId.trim()) { setWizError('Leader cluster ARM resource ID is required'); return; }
      setWizSubmitting(true);
      try {
        const r = await fetch(`/api/items/kql-database/${id}/follower`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            leaderClusterResourceId: wizLeaderResourceId.trim(),
            leaderClusterUri: wizLeaderUri.trim(),
            databaseName: wizFollowerDbName.trim() || '*',
            principalsModificationKind: wizPrincipalsKind,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setWizError(j.error || (Array.isArray(j.missing) ? `Not configured: ${j.missing.join(', ')}` : 'Attach failed'));
        } else {
          setWizSuccess(`Follower attach ${j.provisioningState} (config ${j.configName}). Refreshing…`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 900);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    if (wizardKind !== 'ingest' && !wizName.trim()) {
      setWizError('Name is required');
      return;
    }
    let mgmtCmd = '';
    switch (wizardKind) {
      case 'mv':
        if (!wizSource || !wizQuery) { setWizError('Source table + query required'); return; }
        // Materialized views go through the dedicated /api/adx/materialized-views
        // route so the backfill toggle maps to `.create async materialized-view
        // with (backfill=true)`. Short-circuit the generic /query path below.
        setWizSubmitting(true);
        try {
          const res = await fetch(`/api/adx/materialized-views?id=${encodeURIComponent(id)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizName, sourceTable: wizSource, query: wizQuery, backfill: wizBackfill }),
          });
          const jj = await res.json();
          if (!jj.ok) {
            setWizError(jj.error || 'Command failed');
          } else {
            setWizSuccess(
              wizBackfill
                ? `Backfill started async (operation row returned). Track with .show materialized-views / .show operations. Refreshing…`
                : `Materialized view '${jj.name}' created. ${jj.rowCount ?? 0} rows. Refreshing…`,
            );
            await load();
            setTimeout(() => { setWizardKind(null); }, 600);
          }
        } catch (e: any) {
          setWizError(e?.message || String(e));
        } finally {
          setWizSubmitting(false);
        }
        return;
      case 'update-policy': {
        // Target table = wizName; source table = wizSource. Prefer a stored
        // function (wizFn) over the inline KQL query (wizQuery).
        if (!wizName.trim() || !wizSource.trim()) { setWizError('Target table and source table are required'); return; }
        const queryValue = wizFn ? `${wizFn}()` : wizQuery.trim();
        if (!queryValue) { setWizError('Transform function or inline KQL query is required'); return; }
        setWizSubmitting(true);
        try {
          // POST to the dedicated policies route (.alter table policy update),
          // NOT the generic query route — the route reads the policy back as a receipt.
          const r2 = await fetch(`/api/adx/policies?id=${id}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              targetTable: wizName.trim(),
              source: wizSource.trim(),
              query: queryValue,
              isTransactional: wizTransactional,
              propagateIngestionProperties: false,
            }),
          });
          const j2 = await r2.json();
          if (!j2.ok) { setWizError(j2.error || 'Command failed'); return; }
          const receipt = j2.policy?.raw ? ` Receipt: ${j2.policy.raw}` : '';
          setWizSuccess(`Update policy applied to ${j2.targetTable}.${receipt}`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 2500);
        } catch (e: any) {
          setWizError(e?.message || String(e));
        } finally {
          setWizSubmitting(false);
        }
        return; // dedicated route handled the submit — skip the common mgmtCmd path
      }
      case 'ingest': {
        if (!wizIngestFile) { setWizError('Choose a file to ingest'); return; }
        if (!wizSource) { setWizError('Target table required'); return; }
        const fmt = wizIngestFormat;
        const mapRef = wizIngestMapping.trim();
        // Binary formats (Parquet/Avro/ORC) can't be ingested inline — surface
        // the real blob-ingest command template instead.
        if (['parquet', 'avro', 'orc'].includes(fmt)) {
          const blobCmd = [
            `// ${fmt.toUpperCase()} is a binary format — inline ingest is not supported.`,
            `// Ingest from blob storage using the mapping you created:`,
            `.ingest into table ["${wizSource}"] from @'https://<account>.blob.core.windows.net/<container>/<file>.${fmt}'`,
            mapRef
              ? `  with (format='${fmt}', ingestionMappingReference='${mapRef}')`
              : `  with (format='${fmt}')`,
          ].join('\n');
          setKql(blobCmd);
          setWizardKind(null);
          const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
          el?.focus();
          return;
        }
        // Real inline ingest for small text files (CSV/TSV/PSV/JSON).
        if (wizIngestFile.size > 5 * 1024 * 1024) { setWizError('File too large for inline ingest (5 MB max). Use a Get-data pipeline or ingest from blob.'); return; }
        const text = await wizIngestFile.text();
        const lines = text.split(/\r?\n/).filter(Boolean);
        // For CSV-family identity ingest (no mapping reference) the header row would
        // be ingested as data — strip it. With an explicit mapping reference the
        // mapping addresses columns by Ordinal/Path so the header must also go.
        const csvFamily = ['csv', 'tsv', 'psv'].includes(fmt);
        if (csvFamily && lines.length > 0 && /[a-zA-Z]/.test(lines[0])) lines.shift();
        const body = lines.join('\n');
        const withClause = [
          `format='${fmt}'`,
          mapRef ? `ingestionMappingReference='${mapRef}'` : '',
        ].filter(Boolean).join(', ');
        mgmtCmd = `.ingest inline into table ["${wizSource}"] with (${withClause}) <|\n${body}`;
        break;
      }
    }
    setWizSubmitting(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: mgmtCmd }),
      });
      const j = await r.json();
      if (!j.ok) {
        setWizError(j.error || 'Command failed');
      } else {
        setWizSuccess(`Done. ${j.rowCount ?? 0} rows. Refreshing…`);
        await load();
        setTimeout(() => { setWizardKind(null); }, 600);
      }
    } catch (e: any) {
      setWizError(e?.message || String(e));
    } finally {
      setWizSubmitting(false);
    }
  }, [wizardKind, wizName, wizSchema, wizColumns, wizAlterTarget, wizSource, wizQuery, wizBackfill, wizIngestFile, wizIngestFormat, wizIngestMapping, wizFn, wizTransactional, wizLeaderResourceId, wizLeaderUri, wizFollowerDbName, wizPrincipalsKind, id, load,
      wizDcEhGate, wizDcHub, wizDcConsumerGroup, wizDcTargetTable, wizDcMappingRule, wizDcFormat, wizDcCompression]);

  // ---------------------------------------------------------------
  // Stored function editor (params grid + KQL body) — real control
  // commands via the dedicated /api/adx/functions BFF route
  // (.create-or-alter function / .drop function on /v1/rest/mgmt).
  // ---------------------------------------------------------------
  const openFnEditor = useCallback((fn?: { name: string; parameters?: string; body?: string }) => {
    setFnErr(null); setFnReceipt(null); setFnBusy(false); setFnDeleteBusy(false);
    if (fn) {
      setFnDlgMode('edit');
      setFnName(fn.name);
      setFnNameLocked(true);
      setFnParams(parseFnParams(fn.parameters));
      // .show functions returns the body wrapped in `{ … }`; strip the braces
      // for editing — createFunction re-wraps it on save.
      setFnBody((fn.body || '').replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim());
    } else {
      setFnDlgMode('create');
      setFnName('');
      setFnNameLocked(false);
      setFnParams([]);
      setFnBody('');
    }
    setFnDlgOpen(true);
  }, []);

  const submitFnEditor = useCallback(async () => {
    if (!fnName.trim()) { setFnErr('Function name is required'); return; }
    if (!fnBody.trim()) { setFnErr('Body is required, e.g. "events | take 10"'); return; }
    setFnBusy(true); setFnErr(null); setFnReceipt(null);
    try {
      const res = await fetch(`/api/adx/functions?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: fnName.trim(),
          args: serializeFnParams(fnParams),
          body: fnBody.trim(),
        }),
      });
      const j = await res.json();
      if (!j.ok) { setFnErr(j.error || `Save failed (HTTP ${res.status})`); return; }
      setFnReceipt({ name: fnName.trim(), action: 'saved', rowCount: j.rowCount, ts: new Date().toISOString() });
      setTreeRefreshKey((k) => k + 1);
      setFnNameLocked(true); // it now exists — re-saves are alters
      setFnDlgMode('edit');
    } catch (e: any) {
      setFnErr(e?.message || String(e));
    } finally {
      setFnBusy(false);
    }
  }, [id, fnName, fnParams, fnBody]);

  const deleteFnEditor = useCallback(async () => {
    if (!fnName.trim()) return;
    setFnDeleteBusy(true); setFnErr(null); setFnReceipt(null);
    try {
      const res = await fetch(
        `/api/adx/functions?id=${encodeURIComponent(id)}&name=${encodeURIComponent(fnName.trim())}`,
        { method: 'DELETE' },
      );
      const j = await res.json();
      if (!j.ok) { setFnErr(j.error || `Delete failed (HTTP ${res.status})`); return; }
      setFnReceipt({ name: fnName.trim(), action: 'deleted', ts: new Date().toISOString() });
      setTreeRefreshKey((k) => k + 1);
      setTimeout(() => setFnDlgOpen(false), 900);
    } catch (e: any) {
      setFnErr(e?.message || String(e));
    } finally {
      setFnDeleteBusy(false);
    }
  }, [id, fnName]);

  // Detach the follower configuration — restores read/write on the item.
  const detachFollower = useCallback(async () => {
    if (!info?.followerConfigName) return;
    setDetaching(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/follower?configName=${encodeURIComponent(info.followerConfigName)}`, {
        method: 'DELETE',
      });
      const j = await r.json();
      if (j.ok) await load();
    } finally {
      setDetaching(false);
    }
  }, [info?.followerConfigName, id, load]);

  // ── Data-connection wizard handlers ─────────────────────────────────────
  const ARM_TYPE_BY_KIND: Record<'iothub' | 'eventhub', string> = {
    iothub: 'Microsoft.Devices/IotHubs',
    eventhub: 'Microsoft.EventHub/namespaces',
  };

  // List the existing data connections on this database (real ARM REST).
  const loadDcExisting = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`);
      const j = await r.json();
      setDcExisting(j.ok ? (j.connections ?? []) : []);
    } catch {
      setDcExisting([]);
    }
  }, [id]);

  // Discover IoT Hubs / Event Hub namespaces via Resource Graph (per-user RBAC).
  const discoverDcSources = useCallback(async (kind: 'iothub' | 'eventhub') => {
    setDcSourcesLoading(true);
    setDcSources(null);
    setDcSourcesErr(null);
    setDcSelectedSourceId('');
    setDcPolicies([]);
    setDcPolicyNote(null);
    try {
      const r = await fetch(`/api/azure/resources?type=${encodeURIComponent(ARM_TYPE_BY_KIND[kind])}`);
      const j = await r.json();
      const rows: DcSourceRow[] = Array.isArray(j.resources) ? j.resources : [];
      if (!j.ok || rows.length === 0) {
        const noun = kind === 'iothub' ? 'IoT Hub (Microsoft.Devices/IotHubs)' : 'Event Hubs namespace (Microsoft.EventHub/namespaces)';
        setDcSourcesErr(
          j.error ||
          `No ${noun} found in the subscriptions visible to Loom. Provision the resource ` +
          `(or grant the Loom identity Reader access at the management-group scope) to enable this connection.`,
        );
        setDcSources([]);
      } else {
        setDcSources(rows);
      }
    } catch (e: any) {
      setDcSourcesErr(e?.message || String(e));
      setDcSources([]);
    } finally {
      setDcSourcesLoading(false);
    }
  }, []);

  const openDcWizard = useCallback(() => {
    setDcOpen(true);
    setDcKind('iothub');
    setDcError(null);
    setDcSuccess(null);
    setDcConsumerGroup('$Default');
    setDcFormat('MULTIJSON');
    setDcPolicy('iothubowner');
    setDcTable('');
    discoverDcSources('iothub');
    loadDcExisting();
  }, [discoverDcSources, loadDcExisting]);

  const onDcKindChange = useCallback((kind: 'iothub' | 'eventhub') => {
    setDcKind(kind);
    setDcError(null);
    setDcSuccess(null);
    setDcFormat(kind === 'iothub' ? 'MULTIJSON' : 'JSON');
    discoverDcSources(kind);
  }, [discoverDcSources]);

  // When an IoT Hub is picked, fetch its shared-access policy names.
  const onDcSourceChange = useCallback(async (sourceId: string) => {
    setDcSelectedSourceId(sourceId);
    setDcPolicies([]);
    setDcPolicyNote(null);
    if (dcKind !== 'iothub' || !sourceId) return;
    try {
      const r = await fetch(`/api/azure/iothub/policies?iotHubId=${encodeURIComponent(sourceId)}`);
      const j = await r.json();
      const list = (j.ok ? j.policies : j.fallback) ?? [];
      setDcPolicies(list);
      if (!j.ok && j.error) setDcPolicyNote(j.error);
      // Prefer a ServiceConnect policy for ADX ingestion.
      const preferred = list.find((p: any) => /service/i.test(p.name)) || list.find((p: any) => /iothubowner/i.test(p.name)) || list[0];
      if (preferred) setDcPolicy(preferred.name);
    } catch (e: any) {
      setDcPolicyNote(e?.message || String(e));
      setDcPolicies([{ name: 'iothubowner' }, { name: 'service' }]);
      setDcPolicy('iothubowner');
    }
  }, [dcKind]);

  const submitDc = useCallback(async () => {
    setDcError(null);
    setDcSuccess(null);
    if (!dcSelectedSourceId) { setDcError(dcKind === 'iothub' ? 'Select an IoT Hub' : 'Select an Event Hubs namespace'); return; }
    if (!dcTable.trim()) { setDcError('Target table is required'); return; }
    let payload: Record<string, unknown>;
    if (dcKind === 'iothub') {
      if (!dcPolicy) { setDcError('Select a shared access policy'); return; }
      payload = {
        kind: 'iothub',
        iotHubResourceId: dcSelectedSourceId,
        sharedAccessPolicyName: dcPolicy,
        consumerGroup: dcConsumerGroup || '$Default',
        dataFormat: dcFormat,
        tableName: dcTable.trim(),
      };
    } else {
      // Event Hub: the picker selects a NAMESPACE; the operator names the event
      // hub entity inside it. Compose the full eventhubs child resource id.
      if (!dcEhEntity.trim()) { setDcError('Event Hub entity name is required'); return; }
      payload = {
        kind: 'eventhub',
        eventHubResourceId: `${dcSelectedSourceId}/eventhubs/${dcEhEntity.trim()}`,
        consumerGroup: dcConsumerGroup || '$Default',
        dataFormat: dcFormat,
        tableName: dcTable.trim(),
      };
    }
    setDcBusy(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) {
        setDcError(j.error || 'Failed to create data connection');
      } else {
        setDcSuccess(`Data connection "${j.connectionName}" — ${j.provisioningState || 'Creating'}. Device-to-cloud messages will land in ${dcTable.trim()}.`);
        await loadDcExisting();
      }
    } catch (e: any) {
      setDcError(e?.message || String(e));
    } finally {
      setDcBusy(false);
    }
  }, [dcKind, dcSelectedSourceId, dcPolicy, dcConsumerGroup, dcFormat, dcTable, dcEhEntity, id, loadDcExisting]);

  const deleteDc = useCallback(async (connectionName?: string) => {
    if (!connectionName) return;
    setDcBusy(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionName }),
      });
      const j = await r.json();
      if (!j.ok) setDcError(j.error || 'Delete failed');
      else await loadDcExisting();
    } catch (e: any) {
      setDcError(e?.message || String(e));
    } finally {
      setDcBusy(false);
    }
  }, [id, loadDcExisting]);

  const ribbon: RibbonTab[] = useMemo(() => {
    const isFollower = !!info?.isFollower;
    const roTitle = 'Follower databases are read-only — write operations are blocked. Detach the follower to write.';
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'New', actions: [
          { label: 'Table', onClick: () => openWizard('table'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Materialized view', onClick: () => openWizard('mv'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Function', onClick: () => openFnEditor(), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Update policy', onClick: () => openWizard('update-policy'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Ingestion mapping', onClick: () => setMappingWizOpen(true), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Shortcut (follower DB)',
            onClick: () => openWizard('follower'),
            disabled: isFollower,
            title: isFollower ? 'Already attached as a follower. Detach first to re-point.' : 'Attach a leader cluster database as a read-only follower (Azure-native database shortcut)' },
        ]},
        { label: 'Data', actions: [
          { label: 'Get data', onClick: () => openWizard('ingest'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Data connections', onClick: () => openWizard('data-connection'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Query with code', onClick: () => {
            // Already in code editor — focus the textarea.
            const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
            el?.focus();
          } },
        ]},
        { label: 'Connections', actions: [
          { label: 'Add data connection', onClick: openDcWizard },
        ]},
        { label: 'Manage', actions: [
          { label: 'Data policies', onClick: () => { setKql('.show database policy caching\n.show database policy retention'); } },
          { label: 'Manage principals (RBAC)', onClick: () => setRbacOpen(true), title: 'Add/remove database & table principals (Kusto .add/.drop principal commands)' },
          { label: 'Row-level security', onClick: () => { const first = info?.tables?.[0]?.name; if (first) openRlsEditor(first); }, disabled: isFollower || !(info?.tables && info.tables.length), title: isFollower ? roTitle : (!(info?.tables && info.tables.length) ? 'No tables yet — create a table first' : 'Author the RLS predicate per table (.alter table policy row_level_security)') },
          { label: 'Cluster lifecycle & scale', onClick: () => setClusterOpen(true), title: 'Stop/start/scale/delete the ADX cluster (ARM)' },
          { label: 'OneLake availability', disabled: true, title: 'OneLake mirroring requires Fabric-managed cluster (LOOM_KUSTO_FABRIC_MANAGED=true)' },
        ]},
      ]},
    ];
  }, [openWizard, openFnEditor, openDcWizard, openRlsEditor, info?.isFollower, info?.tables]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        id && id !== 'new'
          ? (
            <AdxDatabaseTree
              itemId={id}
              refreshKey={treeRefreshKey}
              onAlterTable={openAlterTable}
              onDropTable={openDropTable}
              onOpenQuery={(q) => {
                setKql(q);
                const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
                el?.focus();
              }}
              onEditFunction={(fn) => openFnEditor(fn)}
              onGetData={(tableName) => openWizard('ingest', tableName)}
              onCreateDashboard={createDashboardFromTable}
              onEditRls={openRlsEditor}
            />
          )
          : (
            <div className={s.treePad}>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Save the KQL database first</MessageBarTitle>
                  The object navigator (Tables, Functions, Materialized views, Ingestion mappings)
                  appears once this database is saved and bound to a Kusto database.
                </MessageBarBody>
              </MessageBar>
            </div>
          )
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">KQL Database</Badge>
            <Badge appearance="outline" color={info?.ok ? 'success' : 'severe'}>
              {info?.cluster || 'cluster not configured'}
            </Badge>
            <Caption1>db: <strong>{info?.database || '—'}</strong></Caption1>
            {info?.isFollower && (
              <Badge appearance="filled" color="warning" title="Attached read-only follower (database shortcut)">
                Read-only (follower)
              </Badge>
            )}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
            <OpenInPbiDesktopButton type="kql-database" id={id} name={info?.database} />
            {info?.isFollower && (
              <Button appearance="outline" icon={<Delete20Regular />} disabled={detaching} onClick={detachFollower}>
                {detaching ? 'Detaching…' : 'Detach follower'}
              </Button>
            )}
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run (Shift+Enter)'}
            </Button>
          </div>
          {info?.isFollower && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Read-only follower database</MessageBarTitle>
                This KQL database is attached as a follower of{' '}
                <strong>{info.followerLeaderCluster || 'a leader cluster'}</strong>
                {info.followerDatabaseName ? ` (database: ${info.followerDatabaseName})` : ''}.
                Data is synchronized from the leader in near-real-time. Write operations
                (ingest, create table, alter, drop, purge) are blocked — run queries against
                the follower, or write to the leader database directly. Use{' '}
                <strong>Detach follower</strong> to remove the shortcut and restore read/write.
              </MessageBarBody>
            </MessageBar>
          )}
          {info && !info.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Database unavailable</MessageBarTitle>
                {info.error || 'Unknown error'}
              </MessageBarBody>
            </MessageBar>
          )}
          <TabList
            selectedValue={editorTab}
            onTabSelect={(_: unknown, d: any) => setEditorTab(d.value as 'query' | 'diagram')}
            style={{ marginBottom: tokens.spacingVerticalXS}}
          >
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="diagram" icon={<Flowchart20Regular />}>Diagram</Tab>
          </TabList>

          {editorTab === 'query' && (
          <>
          <div className={s.toolbar}>
            <Tooltip content="Generate KQL from a description (NL2KQL, grounded in the live ADX schema)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Sparkle16Regular />}
                disabled={assistView === 'loading' || !id || id === 'new'}
                onClick={() => { setAssistResult(null); setAssistError(null); setAssistView('prompt'); }}
                aria-label="Ask Copilot to generate KQL">Ask Copilot</Button>
            </Tooltip>
            <Tooltip content="Explain this query in Markdown" relationship="label">
              <Button size="small" appearance="subtle" icon={<Info16Regular />}
                disabled={!kql.trim() || assistView === 'loading' || !id || id === 'new'}
                onClick={() => callAssist('explain')}
                aria-label="Explain KQL">Explain</Button>
            </Tooltip>
            {result && !result.ok && result.error && (
              <Tooltip content="Fix the KQL error" relationship="label">
                <Button size="small" appearance="subtle" icon={<Wrench16Regular />}
                  disabled={assistView === 'loading' || !id || id === 'new'}
                  onClick={() => callAssist('fix')}
                  aria-label="Fix KQL error">
                  {assistView === 'loading' && lastModeRef.current === 'fix' ? 'Fixing…' : 'Fix'}
                </Button>
              </Tooltip>
            )}
          </div>
          <MonacoTextarea
            value={kql}
            onChange={setKql}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query editor"
          />
          {/* NL prompt input — generate mode */}
          {assistView === 'prompt' && (
            <div className={s.assistBar}>
              <Input size="small" autoFocus style={{ flex: 1 }}
                placeholder="Describe the query (e.g. 'count events per hour for the last day')…"
                value={assistPrompt}
                onChange={(_: unknown, d: any) => setAssistPrompt(d.value)}
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter' && assistPrompt.trim()) callAssist('generate');
                  if (e.key === 'Escape') setAssistView('idle');
                }}
                aria-label="AI KQL generation prompt" />
              <Button size="small" appearance="primary"
                disabled={!assistPrompt.trim()}
                onClick={() => callAssist('generate')}>Generate</Button>
              <Button size="small" onClick={() => { setAssistView('idle'); setAssistPrompt(''); }}>Cancel</Button>
            </div>
          )}
          {/* Loading spinner */}
          {assistView === 'loading' && (
            <div className={s.assistBar}>
              <Spinner size="tiny" labelPosition="after"
                label={lastModeRef.current === 'generate' ? 'Generating…' : lastModeRef.current === 'explain' ? 'Explaining…' : 'Fixing…'} />
            </div>
          )}
          {/* Suggestion / explanation result */}
          {(assistView === 'suggestion' || assistView === 'explain-result') && assistResult && (
            <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>
                <pre className={s.assistResult}>{assistResult}</pre>
              </MessageBarBody>
              <MessageBarActions>
                {assistView === 'suggestion' && (
                  <>
                    <Button size="small" appearance="primary"
                      onClick={() => { setKql(assistResult); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); }}>
                      Apply
                    </Button>
                    <Button size="small" appearance="outline"
                      onClick={() => { setKql(assistResult); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); setTimeout(() => run(), 0); }}>
                      Apply &amp; Run
                    </Button>
                  </>
                )}
                <Button size="small" onClick={() => { setAssistView('idle'); setAssistResult(null); }}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {/* Honest config gate / error */}
          {assistError && (
            <MessageBar intent="error" style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>{assistError}</MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => setAssistError(null)}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          <KqlResultsPanel result={result} loading={loading} itemId={id} itemType="kql-database" />

          {/* Starter schema + queries from the app-install template. Surfaced
              when the live ADX object isn't provisioned yet so a bundle-
              installed KQL database opens FULLY BUILT-OUT (tables + columns +
              sample rows + starter analyst queries) instead of empty. Once the
              tables/functions exist on the live cluster the navigator + Run
              hit the real backend; these template rows are clearly labeled. */}
          {info?.contentFallback && (
            <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>App template — schema & starter queries</MessageBarTitle>
                  This KQL database ships a starter schema and analyst queries from its app
                  bundle. Create the tables on the live cluster (New → Table, or run a
                  starter query that references them) to ingest data; until then these are
                  the template definitions.
                </MessageBarBody>
              </MessageBar>

              {Array.isArray(info.schema) && info.schema.length > 0 && (
                <div>
                  <Subtitle2>Tables ({info.schema.length})</Subtitle2>
                  <Tree aria-label="Starter table schema" style={{ marginTop: tokens.spacingVerticalS}}>
                    {info.schema.map((t) => (
                      <TreeItem key={t.name} itemType="branch" value={`stbl-${t.name}`}>
                        <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                          {t.name}{' '}
                          <Caption1>({t.columns.length} cols)</Caption1>{' '}
                          <Badge size="small" appearance="tint" color={t.live ? 'success' : 'warning'}>
                            {t.live ? 'live' : 'template'}
                          </Badge>
                        </TreeItemLayout>
                        <Tree>
                          {t.columns.map((c) => (
                            <TreeItem key={c.name} itemType="leaf" value={`stcol-${t.name}-${c.name}`}>
                              <TreeItemLayout iconBefore={<Table20Regular />}>
                                {c.name} <Caption1>: {c.type}</Caption1>
                              </TreeItemLayout>
                            </TreeItem>
                          ))}
                        </Tree>
                        {Array.isArray(t.sample) && t.sample.length > 0 && (
                          <div style={{ overflowX: 'auto', margin: `${tokens.spacingVerticalXS} 0 ${tokens.spacingVerticalS} ${tokens.spacingHorizontalXXL}` }}>
                            <Table size="extra-small" aria-label={`${t.name} sample rows`}>
                              <TableHeader>
                                <TableRow>
                                  {t.columns.map((c) => (
                                    <TableHeaderCell key={c.name}>{c.name}</TableHeaderCell>
                                  ))}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {t.sample.slice(0, 5).map((row, ri) => (
                                  <TableRow key={ri}>
                                    {(Array.isArray(row) ? row : []).map((cell, ci) => (
                                      <TableCell key={ci}>{String(cell)}</TableCell>
                                    ))}
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                      </TreeItem>
                    ))}
                  </Tree>
                </div>
              )}

              {Array.isArray(info.starterQueries) && info.starterQueries.length > 0 && (
                <div>
                  <Subtitle2>Starter queries ({info.starterQueries.length})</Subtitle2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS}}>
                    {info.starterQueries.map((q) => (
                      <Button
                        key={q.name}
                        appearance="subtle"
                        icon={<Play20Regular />}
                        style={{ justifyContent: 'flex-start' }}
                        onClick={() => {
                          setKql(q.kql);
                          const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
                          el?.focus();
                        }}
                      >
                        {q.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          )}

          {editorTab === 'diagram' && (
            id && id !== 'new'
              ? graphLoading
                ? <Spinner label="Loading entity diagram…" />
                : graphError
                  ? (
                    <MessageBar intent="error">
                      <MessageBarBody>
                        <MessageBarTitle>Entity diagram unavailable</MessageBarTitle>
                        {graphError}
                      </MessageBarBody>
                    </MessageBar>
                  )
                  : (
                    <SchemaDiagramCanvas
                      nodes={graphData?.nodes || []}
                      edges={graphData?.edges || []}
                      onQueryNode={(name, kind) => {
                        setKql(kind === 'function' ? `${name}()` : `["${name}"]\n| take 100`);
                        setEditorTab('query');
                      }}
                      onDeleteNode={(name, kind) => {
                        setDeleteTarget({ name, kind }); setDeleteError(null); setDeleteDlgOpen(true);
                      }}
                    />
                  )
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Save the KQL database first</MessageBarTitle>
                    The entity diagram appears once this database is saved and bound to a Kusto database.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* Delete-from-diagram confirmation — issues a real .drop ... ifexists
              mgmt command against the live ADX cluster via the /query route. */}
          <Dialog open={deleteDlgOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) { setDeleteDlgOpen(false); setDeleteTarget(null); } }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Delete {deleteTarget?.kind} &quot;{deleteTarget?.name}&quot;?</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <Caption1>
                      Issues a <code>.drop {deleteTarget?.kind ?? ''} [&quot;{deleteTarget?.name ?? ''}&quot;]</code> management
                      command against the live ADX cluster. This cannot be undone.
                    </Caption1>
                    {deleteError && <MessageBar intent="error"><MessageBarBody>{deleteError}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" disabled={deleteSubmitting} onClick={() => { setDeleteDlgOpen(false); setDeleteTarget(null); }}>Cancel</Button>
                  <Button appearance="primary" disabled={deleteSubmitting} onClick={deleteFromDiagram}>
                    {deleteSubmitting ? 'Deleting…' : 'Delete'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={!!wizardKind} onOpenChange={(_: unknown, d: any) => { if (!d.open) setWizardKind(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>
                  {wizardKind === 'table' && 'New table (.create table)'}
                  {wizardKind === 'alter-table' && `Edit schema — ${wizAlterTarget} (.alter-merge table)`}
                  {wizardKind === 'drop-table' && `Drop table — ${wizAlterTarget}`}
                  {wizardKind === 'mv' && 'New materialized view (.create materialized-view)'}
                  {wizardKind === 'update-policy' && 'New update policy (.alter table policy update)'}
                  {wizardKind === 'ingest' && 'Get data — ingest a file (.ingest with format + mapping)'}
                  {wizardKind === 'data-connection' && 'New Event Hub data connection'}
                  {wizardKind === 'follower' && 'Database shortcut — attach follower (read-only)'}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    {wizardKind === 'table' && (
                      <>
                        <Field label="Table name" required>
                          <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events" />
                        </Field>
                        <Field label="Columns">
                          <ColumnGridDesigner columns={wizColumns} onChange={setWizColumns} disabled={wizSubmitting} />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'alter-table' && (
                      <>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>.alter-merge table — additive</MessageBarTitle>
                            New columns are appended to <strong>{wizAlterTarget}</strong>; existing
                            columns and their data are preserved. Removing a row here will NOT drop
                            that column (use .drop column separately). To rename or change a column
                            type, drop and recreate the column.
                          </MessageBarBody>
                        </MessageBar>
                        <Field label="Columns (existing + new)">
                          <ColumnGridDesigner
                            columns={wizColumns}
                            onChange={setWizColumns}
                            disabled={wizSubmitting}
                            emptyHint="Loading current columns… add new columns to append."
                          />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'drop-table' && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Drop table {wizAlterTarget}?</MessageBarTitle>
                          This permanently deletes <strong>{wizAlterTarget}</strong> and all its data.
                          The command issued is <code>.drop table [&quot;{wizAlterTarget}&quot;] ifexists</code>.
                          This cannot be undone.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {wizardKind === 'mv' && (() => {
                      // Source-table picker: live cluster tables preferred, fall
                      // back to the bound item's declared tables. De-duped.
                      const srcNames = Array.from(new Set([
                        ...wizTables,
                        ...((info?.tables || []).map((t) => t.name)),
                      ].filter(Boolean)));
                      return (
                      <>
                        <Caption1>View name</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events_daily" />
                        <Caption1>Source table</Caption1>
                        {srcNames.length > 0 ? (
                          <Select value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} aria-label="Source table">
                            <option value="">Select a source table…</option>
                            {srcNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          </Select>
                        ) : (
                          <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        )}
                        <Caption1>Aggregation query (must end in summarize — one row per group key)</Caption1>
                        <MonacoTextarea
                          value={wizQuery}
                          onChange={setWizQuery}
                          language="kql"
                          height={180}
                          ariaLabel="Materialized view KQL query"
                        />
                        <Switch
                          label="Backfill from existing data (.create async materialized-view with (backfill=true))"
                          checked={wizBackfill}
                          onChange={(_: unknown, d: any) => setWizBackfill(!!d.checked)}
                        />
                        {wizBackfill && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            Runs asynchronously over the source table&apos;s existing records. Large tables may take minutes to hours; the view stays unavailable for query until the backfill completes. Track with <code>.show materialized-views</code> / <code>.show operations</code>.
                          </Caption1>
                        )}
                      </>
                      );
                    })()}
                    {wizardKind === 'update-policy' && (
                      <>
                        <Caption1>Target table (receives the transformed rows)</Caption1>
                        {upLoading
                          ? <Spinner size="tiny" label="Loading tables…" />
                          : (
                            <Select
                              value={wizName}
                              onChange={(_: unknown, d: any) => setWizName(d.value)}
                              aria-label="Target table"
                            >
                              <option value="">— select target table —</option>
                              {upTables.map((t) => <option key={t} value={t}>{t}</option>)}
                            </Select>
                          )}
                        <Caption1>Source table (incoming raw rows trigger the policy)</Caption1>
                        <Select
                          value={wizSource}
                          onChange={(_: unknown, d: any) => setWizSource(d.value)}
                          aria-label="Source table"
                          disabled={upLoading}
                        >
                          <option value="">— select source table —</option>
                          {upTables.map((t) => <option key={t} value={t}>{t}</option>)}
                        </Select>
                        <Caption1>Transform function (recommended — a stored KQL function)</Caption1>
                        <Select
                          value={wizFn}
                          onChange={(_: unknown, d: any) => { setWizFn(d.value); if (d.value) setWizQuery(''); }}
                          aria-label="Transform function"
                          disabled={upLoading}
                        >
                          <option value="">— none (use inline query below) —</option>
                          {upFunctions.map((f) => <option key={f} value={f}>{f}</option>)}
                        </Select>
                        {!wizFn && (
                          <>
                            <Caption1>Inline transform query (used when no function is selected)</Caption1>
                            <Textarea value={wizQuery} onChange={(_: unknown, d: any) => setWizQuery(d.value)} rows={4} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events_raw | extend ts = todatetime(timestamp) | project-away rawField" />
                          </>
                        )}
                        <Switch
                          checked={wizTransactional}
                          onChange={(_: unknown, d: any) => setWizTransactional(!!d.checked)}
                          label={wizTransactional
                            ? 'Transactional (ingest fails if the transform fails — recommended for production)'
                            : 'Non-transactional (source table is updated even if the transform fails)'}
                        />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Applies <code>.alter table {wizName || '«target»'} policy update</code>; the wizard reads
                          {' '}<code>.show table {wizName || '«target»'} policy update</code> back as the receipt.
                        </Caption1>
                      </>
                    )}
                    {wizardKind === 'ingest' && (
                      <>
                        <Caption1>Target table</Caption1>
                        <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        <Caption1>Format</Caption1>
                        <Select value={wizIngestFormat} onChange={(_: unknown, d: any) => setWizIngestFormat(d.value)}>
                          {['csv', 'tsv', 'psv', 'json', 'parquet', 'avro', 'orc'].map((fmt) => (
                            <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
                          ))}
                        </Select>
                        <Caption1>Ingestion mapping name (optional — blank uses the table&apos;s identity mapping)</Caption1>
                        <Input value={wizIngestMapping} onChange={(_: unknown, d: any) => setWizIngestMapping(d.value)} placeholder="EventMapping" />
                        <Caption1>
                          File ({['parquet', 'avro', 'orc'].includes(wizIngestFormat)
                            ? 'binary — generates a blob ingest command'
                            : '≤5 MB — inline ingest'})
                        </Caption1>
                        <input
                          type="file"
                          accept=".csv,.tsv,.psv,.json,.jsonl,.txt,.parquet,.avro,.orc"
                          aria-label="File to ingest"
                          onChange={(e) => setWizIngestFile(e.target.files?.[0] || null)}
                        />
                        <Caption1>
                          Create a named mapping first via Home → New → Ingestion mapping, then reference it here.
                          For continuous ingest use Eventhouse → Get data (Event Hub data-connection).
                        </Caption1>
                      </>
                    )}
                    {wizardKind === 'data-connection' && (
                      <>
                        {wizDcEhGate && (
                          <MessageBar intent="warning">
                            <MessageBarBody>
                              <MessageBarTitle>Event Hubs not configured</MessageBarTitle>
                              Set <code>{wizDcEhGate}</code> to enable the Event Hub picker. The cluster MI also needs
                              {' '}<code>Azure Event Hubs Data Receiver</code> on the namespace (granted by eventhubs.bicep).
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {wizDcConnections.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                            <Caption1>Existing data connections ({wizDcConnections.length})</Caption1>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS}}>
                              {wizDcConnections.map((c) => (
                                <Badge key={c.name} appearance="outline" color="informative">
                                  {c.name}{c.properties?.provisioningState ? ` · ${c.properties.provisioningState}` : ''}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        <Field label="Connection name (auto-generated if blank)">
                          <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder={`loom-dc-${wizDcHub || 'hub'}`} />
                        </Field>
                        <Field label="Event Hubs namespace">
                          <Input value={wizDcNamespace || (wizDcLoading ? 'loading…' : '(not configured)')} readOnly />
                        </Field>
                        <Field label="Event hub">
                          <Select value={wizDcHub} onChange={(_: unknown, d: any) => { setWizDcHub(d.value); setWizDcConsumerGroup(''); }} disabled={!!wizDcEhGate}>
                            <option value="">— select hub —</option>
                            {wizDcHubs.map((h) => <option key={h} value={h}>{h}</option>)}
                          </Select>
                        </Field>
                        <Field label="Consumer group (must be dedicated — one per ADX connection)">
                          <Select value={wizDcConsumerGroup} onChange={(_: unknown, d: any) => setWizDcConsumerGroup(d.value)} disabled={!wizDcHub}>
                            <option value="">— select consumer group —</option>
                            {wizDcGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                          </Select>
                        </Field>
                        <Field label="Data format">
                          <Select value={wizDcFormat} onChange={(_: unknown, d: any) => setWizDcFormat(d.value)}>
                            {['JSON', 'MULTIJSON', 'CSV', 'TSV', 'SCSV', 'PSV', 'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'RAW', 'TXT', 'W3CLOGFILE'].map((f) => <option key={f} value={f}>{f}</option>)}
                          </Select>
                        </Field>
                        <Field label="Compression">
                          <Select value={wizDcCompression} onChange={(_: unknown, d: any) => setWizDcCompression(d.value)}>
                            <option value="None">None</option>
                            <option value="GZip">GZip</option>
                          </Select>
                        </Field>
                        <Field label="Target table (optional — leave blank for per-event / dynamic routing)">
                          <Select value={wizDcTargetTable} onChange={(_: unknown, d: any) => setWizDcTargetTable(d.value)}>
                            <option value="">— none (per-event routing) —</option>
                            {wizDcTables.map((t) => <option key={t} value={t}>{t}</option>)}
                          </Select>
                        </Field>
                        <Field label="Ingestion mapping name (optional)">
                          <Input value={wizDcMappingRule} onChange={(_: unknown, d: any) => setWizDcMappingRule(d.value)} placeholder="myMapping" />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'follower' && (
                      <>
                        <Caption1>Leader cluster ARM resource ID</Caption1>
                        <Input
                          value={wizLeaderResourceId}
                          onChange={(_: unknown, d: any) => setWizLeaderResourceId(d.value)}
                          placeholder="/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Kusto/clusters/{name}"
                          style={{ fontFamily: 'Consolas, monospace' }}
                        />
                        <Caption1>Leader cluster URI (optional, display only)</Caption1>
                        <Input
                          value={wizLeaderUri}
                          onChange={(_: unknown, d: any) => setWizLeaderUri(d.value)}
                          placeholder="https://mycluster.eastus2.kusto.windows.net"
                        />
                        <Caption1>Database to follow (leave blank or * to follow all leader databases)</Caption1>
                        <Input
                          value={wizFollowerDbName}
                          onChange={(_: unknown, d: any) => setWizFollowerDbName(d.value)}
                          placeholder="MyLeaderDb or *"
                        />
                        <Caption1>Principal modification kind</Caption1>
                        <Select
                          value={wizPrincipalsKind}
                          onChange={(_: unknown, d: any) => setWizPrincipalsKind(d.value as 'Union' | 'Replace' | 'None')}
                        >
                          <option value="Union">Union — leader principals + this cluster&apos;s principals</option>
                          <option value="Replace">Replace — follower principals only</option>
                          <option value="None">None — leader principals only</option>
                        </Select>
                        <MessageBar intent="info">
                          <MessageBarBody>
                            <MessageBarTitle>Prerequisites</MessageBarTitle>
                            The Loom managed identity must hold <strong>Contributor</strong> (or Azure
                            Kusto Contributor) on the <em>leader</em> cluster — granted out-of-band; the
                            follower cluster (this deployment) is already configured. Leader and follower
                            must be in the <strong>same Azure region</strong>. The follower is read-only:
                            queries return live leader data; writes are blocked.
                          </MessageBarBody>
                        </MessageBar>
                      </>
                    )}
                    {wizError && <MessageBar intent="error"><MessageBarBody>{wizError}</MessageBarBody></MessageBar>}
                    {wizSuccess && <MessageBar intent="success"><MessageBarBody>{wizSuccess}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setWizardKind(null)} disabled={wizSubmitting}>Cancel</Button>
                  <Button appearance="primary" onClick={submitWizard} disabled={wizSubmitting}>
                    {wizSubmitting ? 'Submitting…'
                      : wizardKind === 'drop-table' ? 'Drop table'
                      : wizardKind === 'alter-table' ? 'Apply (.alter-merge)'
                      : wizardKind === 'follower' ? 'Attach follower'
                      : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ---- Stored function editor (create / edit / delete) ---- */}
          <Dialog open={fnDlgOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setFnDlgOpen(false); }}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>
                  {fnDlgMode === 'create'
                    ? 'New function (.create-or-alter function)'
                    : `Edit function · ${fnName}`}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <Field label="Function name" required hint="Stored as a database-scoped KQL function (folder: Loom).">
                      <Input
                        value={fnName}
                        readOnly={fnNameLocked}
                        disabled={fnNameLocked}
                        onChange={(_: unknown, d: any) => setFnName(d.value)}
                        placeholder="fn_recent_events"
                        style={fnNameLocked ? { fontFamily: 'Consolas, monospace', fontWeight: 600 } : undefined}
                      />
                    </Field>

                    <Field label="Parameters" hint="Typed signature, e.g. days:int. Leave empty for a no-argument function.">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                        {fnParams.map((p, i) => (
                          <div key={i} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                            <Input
                              size="small"
                              placeholder="paramName"
                              value={p.name}
                              onChange={(_: unknown, d: any) => setFnParams((prev) => prev.map((x, xi) => (xi === i ? { ...x, name: d.value } : x)))}
                              style={{ flex: 1 }}
                              aria-label={`Parameter ${i + 1} name`}
                            />
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>:</Caption1>
                            <Select
                              size="small"
                              value={p.type}
                              onChange={(_: unknown, d: any) => setFnParams((prev) => prev.map((x, xi) => (xi === i ? { ...x, type: d.value } : x)))}
                              style={{ minWidth: 130 }}
                              aria-label={`Parameter ${i + 1} type`}
                            >
                              {FN_PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </Select>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Delete20Regular />}
                              onClick={() => setFnParams((prev) => prev.filter((_, xi) => xi !== i))}
                              aria-label={`Remove parameter ${i + 1}`}
                            />
                          </div>
                        ))}
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Add20Regular />}
                          onClick={() => setFnParams((prev) => [...prev, { name: '', type: 'string' }])}
                          style={{ alignSelf: 'flex-start' }}
                        >
                          Add parameter
                        </Button>
                        {fnParams.length === 0 && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            No parameters — function takes no arguments.
                          </Caption1>
                        )}
                      </div>
                    </Field>

                    <Field label="Body (KQL)" required>
                      <MonacoTextarea
                        value={fnBody}
                        onChange={setFnBody}
                        language="kql"
                        height={220}
                        minHeight={140}
                        ariaLabel="Function body KQL editor"
                      />
                    </Field>

                    {fnReceipt && (
                      <MessageBar intent="success">
                        <MessageBarBody>
                          <MessageBarTitle>{fnReceipt.action === 'saved' ? 'Saved' : 'Deleted'}</MessageBarTitle>
                          Function <code>{fnReceipt.name}</code>{' '}
                          {fnReceipt.action === 'saved'
                            ? <>created/altered via <code>.create-or-alter function</code>{fnReceipt.rowCount !== undefined ? ` (${fnReceipt.rowCount} rows returned)` : ''}.</>
                            : <>dropped via <code>.drop function</code>.</>}
                          {' '}<Caption1>{fnReceipt.ts}</Caption1>
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {fnErr && (
                      <MessageBar intent="error">
                        <MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{fnErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setFnDlgOpen(false)} disabled={fnBusy || fnDeleteBusy}>Close</Button>
                  {fnDlgMode === 'edit' && (
                    <Button
                      appearance="subtle"
                      icon={<Delete20Regular />}
                      disabled={fnBusy || fnDeleteBusy}
                      onClick={deleteFnEditor}
                      style={{ color: tokens.colorPaletteRedForeground1 }}
                    >
                      {fnDeleteBusy ? 'Deleting…' : 'Delete function'}
                    </Button>
                  )}
                  <Button appearance="primary" disabled={fnBusy || fnDeleteBusy} onClick={submitFnEditor}>
                    {fnBusy ? 'Saving…' : 'Save'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ── Data-connection wizard (Event Hub / IoT Hub → ADX) ─────────── */}
          <Dialog open={dcOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setDcOpen(false); }}>
            <DialogSurface style={{ maxWidth: 620 }}>
              <DialogBody>
                <DialogTitle>New data connection (Microsoft.Kusto/dataConnections)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                    <Caption1>
                      Stream events into a table via a real ADX data connection. Azure-native — no Fabric
                      workspace required. The ADX cluster managed identity must be able to read the source’s
                      keys (IoT Hub Contributor for IoT Hub; Event Hubs Data Receiver for Event Hub).
                    </Caption1>

                    <Field label="Source type">
                      <Select
                        value={dcKind}
                        onChange={(_: unknown, d: any) => onDcKindChange(d.value as 'iothub' | 'eventhub')}
                      >
                        <option value="iothub">IoT Hub (device-to-cloud)</option>
                        <option value="eventhub">Event Hub</option>
                      </Select>
                    </Field>

                    {dcSourcesLoading && (
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
                        <Spinner size="tiny" /> <Caption1>Discovering {dcKind === 'iothub' ? 'IoT Hubs' : 'Event Hubs namespaces'}…</Caption1>
                      </div>
                    )}

                    {/* Honest-gate: no source resource visible to Loom. */}
                    {!dcSourcesLoading && dcSourcesErr && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>{dcKind === 'iothub' ? 'No IoT Hub available' : 'No Event Hubs namespace available'}</MessageBarTitle>
                          {dcSourcesErr}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {!dcSourcesLoading && dcSources && dcSources.length > 0 && (
                      <Field label={dcKind === 'iothub' ? 'IoT Hub' : 'Event Hubs namespace'}>
                        <Select
                          value={dcSelectedSourceId}
                          onChange={(_: unknown, d: any) => onDcSourceChange(d.value)}
                        >
                          <option value="">— select —</option>
                          {dcSources.map((srcRow) => (
                            <option key={srcRow.id} value={srcRow.id}>
                              {srcRow.name}{srcRow.resourceGroup ? ` (${srcRow.resourceGroup})` : ''}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}

                    {/* Event Hub entity name (namespace picker selects the namespace only). */}
                    {dcKind === 'eventhub' && dcSelectedSourceId && (
                      <Field label="Event Hub entity name">
                        <Input value={dcEhEntity} onChange={(_: unknown, d: any) => setDcEhEntity(d.value)} placeholder="telemetry" />
                      </Field>
                    )}

                    {/* IoT Hub shared-access policy (ServiceConnect required for ADX). */}
                    {dcKind === 'iothub' && dcSelectedSourceId && (
                      <>
                        <Field label="Shared access policy">
                          <Select value={dcPolicy} onChange={(_: unknown, d: any) => setDcPolicy(d.value)}>
                            {dcPolicies.length === 0 && <option value="iothubowner">iothubowner</option>}
                            {dcPolicies.map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.name}{/service|iothubowner/i.test(p.name) ? ' — recommended for ADX' : ''}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {dcPolicyNote && (
                          <MessageBar intent="info"><MessageBarBody>{dcPolicyNote}</MessageBarBody></MessageBar>
                        )}
                      </>
                    )}

                    {dcSelectedSourceId && (
                      <>
                        <Field label="Consumer group">
                          <Input value={dcConsumerGroup} onChange={(_: unknown, d: any) => setDcConsumerGroup(d.value)} placeholder="$Default" />
                        </Field>
                        <Field label="Data format">
                          <Select value={dcFormat} onChange={(_: unknown, d: any) => setDcFormat(d.value)}>
                            {DC_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                          </Select>
                        </Field>
                        <Field label="Target table">
                          <Input value={dcTable} onChange={(_: unknown, d: any) => setDcTable(d.value)} placeholder="DeviceEvents" />
                        </Field>
                      </>
                    )}

                    {dcError && <MessageBar intent="error"><MessageBarBody>{dcError}</MessageBarBody></MessageBar>}
                    {dcSuccess && <MessageBar intent="success"><MessageBarBody>{dcSuccess}</MessageBarBody></MessageBar>}

                    {/* Existing connections on this database (real ARM list). */}
                    {dcExisting && dcExisting.length > 0 && (
                      <div>
                        <Subtitle2>Existing connections ({dcExisting.length})</Subtitle2>
                        <Table size="extra-small" aria-label="Existing data connections" style={{ marginTop: tokens.spacingVerticalS}}>
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Name</TableHeaderCell>
                              <TableHeaderCell>Kind</TableHeaderCell>
                              <TableHeaderCell>Table</TableHeaderCell>
                              <TableHeaderCell>State</TableHeaderCell>
                              <TableHeaderCell />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {dcExisting.map((c) => (
                              <TableRow key={c.name}>
                                <TableCell>{c.name}</TableCell>
                                <TableCell>{c.kind}</TableCell>
                                <TableCell>{c.tableName}</TableCell>
                                <TableCell>{c.provisioningState}</TableCell>
                                <TableCell>
                                  <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                                    disabled={dcBusy} onClick={() => deleteDc(c.name)} aria-label={`Delete ${c.name}`} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDcOpen(false)} disabled={dcBusy}>Close</Button>
                  <Button appearance="primary" onClick={submitDc}
                    disabled={dcBusy || !dcSelectedSourceId || !dcTable.trim()}>
                    {dcBusy ? 'Creating…' : 'Create connection'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Ingestion mapping wizard — format selector + sample-file auto-detect grid */}
          <IngestionMappingWizardDialog
            itemId={id}
            tables={info?.tables ?? []}
            open={mappingWizOpen}
            onOpenChange={setMappingWizOpen}
            onCreated={(_name, _kind, _table, kqlSnippet) => {
              setMappingWizOpen(false);
              setTreeRefreshKey((k) => k + 1);
              setKql(kqlSnippet);
              const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
              el?.focus();
            }}
          />

          {/* RBAC — Manage principals (database + table scope) */}
          <Dialog open={rbacOpen} onOpenChange={(_, d) => setRbacOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>Manage principals (RBAC) · {info?.database || 'KQL database'}</DialogTitle>
                <DialogContent>
                  <AdxRbacPanel
                    itemId={id}
                    database={info?.database}
                    tables={(info?.tables ?? []).map((t) => t.name)}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRbacOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Cluster lifecycle + scale (ARM) */}
          <Dialog open={clusterOpen} onOpenChange={(_, d) => setClusterOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>ADX cluster — lifecycle &amp; scale</DialogTitle>
                <DialogContent>
                  <AdxClusterEditor onChanged={() => load()} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setClusterOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Row-Level Security — per table (.alter table policy row_level_security) */}
          <Dialog open={rlsTable !== null} onOpenChange={(_, d) => { if (!d.open) setRlsTable(null); }}>
            <DialogSurface style={{ maxWidth: 640 }}>
              <DialogBody>
                <DialogTitle>Row-level security · {rlsTable}</DialogTitle>
                <DialogContent>
                  {rlsLoading ? <Spinner size="tiny" label="Loading RLS policy…" /> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Sets <code>.alter table [&quot;{rlsTable}&quot;] policy row_level_security</code>.
                          The query is a KQL predicate (or a stored-function call) that filters rows for
                          the calling principal — e.g.{' '}
                          <code>{rlsTable} | where current_principal_is_member_of(&apos;aadgroup=analysts@contoso.com&apos;)</code>.
                          Requires Database / Table Admin.
                        </MessageBarBody>
                      </MessageBar>
                      <Switch
                        checked={rlsEnabled}
                        label={rlsEnabled ? 'RLS enabled' : 'RLS disabled'}
                        onChange={(_, d) => setRlsEnabled(!!d.checked)}
                      />
                      <Field label="RLS query (KQL predicate)" required={rlsEnabled}>
                        <Textarea
                          value={rlsQuery}
                          onChange={(_, d) => setRlsQuery(d.value)}
                          rows={5}
                          style={{ fontFamily: 'Consolas, monospace' }}
                          placeholder={`${rlsTable ?? 'T'} | where current_principal_is_member_of('aadgroup=analysts@contoso.com')`}
                        />
                      </Field>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Test without affecting users in the query editor with{' '}
                        <code>set query_force_row_level_security;</code>.
                      </Caption1>
                      {rlsNotice && <MessageBar intent="success"><MessageBarBody>{rlsNotice}</MessageBarBody></MessageBar>}
                      {rlsError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RLS error</MessageBarTitle>{rlsError}</MessageBarBody></MessageBar>}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRlsTable(null)} disabled={rlsBusy}>Close</Button>
                  <Button appearance="primary" onClick={submitRlsEditor} disabled={rlsBusy || rlsLoading || (rlsEnabled && !rlsQuery.trim())}>
                    {rlsBusy ? 'Applying…' : (rlsEnabled ? 'Enable RLS' : 'Disable RLS')}
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

// ----- KQL Queryset -----
export { KqlQuerysetEditor } from './phase3/kql-queryset-editor';

// ----- KQL Dashboard (Fabric Real-Time Dashboard parity) -----
// A real dashboard builder: tile grid (add/remove/resize) where each tile has
// a KQL query bound to a data source + a visual type, rendering its REAL Kusto
// result; a data-sources panel; dashboard parameters (free-text / fixed /
// query-based / time range) substituted into tile KQL; per-dashboard
// auto-refresh + manual refresh; Save persists the full model to Cosmos.
// Backed by /api/items/kql-dashboard/[id] (GET ?run=1 / PUT) + /run + /param-values.

interface DashTile {
  title: string;
  kql: string;
  viz: TileViz;
  dataSourceId?: string;
  database?: string;
  w?: number; // grid column span 1..12
  h?: number; // grid row units 1..8
  conditionalRules?: ConditionalRule[];
  /** Drill-through: clicking a result value sets a dashboard parameter. */
  drillthrough?: { column: string; paramName: string };
  result?: KqlResult;
  error?: string;
}

interface DashDataSource { id: string; name: string; database: string; clusterUri?: string; }

/** A shared KQL snippet referenced by tiles via `$baseQuery('name')`. */
interface DashBaseQuery { id: string; name: string; kql: string; }

type DashParamType = 'freetext' | 'fixed' | 'multi' | 'query' | 'datasource' | 'duration';
type DashParamDataType = 'string' | 'long' | 'int' | 'real' | 'datetime' | 'bool';

interface DashParam {
  variableName: string;
  label?: string;
  type: DashParamType;
  dataType?: DashParamDataType;
  values?: string[];
  query?: string;
  dataSourceId?: string;
  value?: string | string[];
}

interface DashboardState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  tiles?: DashTile[];
  dataSources?: DashDataSource[];
  parameters?: DashParam[];
  baseQueries?: DashBaseQuery[];
  timeRange?: string;
  autoRefreshMs?: number;
  error?: string;
}

type TimeRangeKey = 'last-15m' | 'last-1h' | 'last-4h' | 'last-24h' | 'last-7d' | 'last-30d' | 'all';
const TIME_ORDER: TimeRangeKey[] = ['last-15m', 'last-1h', 'last-4h', 'last-24h', 'last-7d', 'last-30d', 'all'];

const TILE_VIZ_OPTIONS: TileViz[] = ['table', 'timechart', 'line', 'column', 'bar', 'pie', 'stat', 'map'];

// Auto-refresh interval choices (Fabric "Manage > Auto refresh" exposes an
// explicit minimum interval + default rate). The ADX /v1/rest/query round-trip
// is 2–10s, so the tightest live cadences (5s/30s) are paired with an in-flight
// guard in the auto-refresh effect below: a tick is SKIPPED while the previous
// runAll() is still resolving, so a slow cluster can never pile up overlapping
// queries. Matches the Fabric Real-Time Dashboard continuous-refresh behavior.
const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 0,         label: 'Off' },
  { ms: 5_000,     label: '5 seconds' },
  { ms: 30_000,    label: '30 seconds' },
  { ms: 60_000,    label: '1 minute' },
  { ms: 300_000,   label: '5 minutes' },
  { ms: 1_800_000, label: '30 minutes' },
  { ms: 3_600_000, label: '1 hour' },
];

function refreshLabel(ms: number): string {
  const hit = REFRESH_INTERVALS.find((r) => r.ms === ms);
  if (!ms) return 'Auto-refresh: off';
  return `Auto-refresh: ${hit ? hit.label : `${ms / 1000}s`}`;
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* noop */ }
  return 'ds-' + Math.random().toString(36).slice(2, 10);
}

const CF_COLOR_LABELS: Record<CfColor, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const CF_ICON_LABELS: Record<CfIcon, string> = { warning: 'Warning', error: 'Error', success: 'Success', info: 'Info' };
const CF_THEME_LABELS: Record<CfTheme, string> = {
  'traffic-lights': 'Traffic lights', cold: 'Cold', warm: 'Warm', blue: 'Blue', red: 'Red', yellow: 'Yellow',
};

/** A column field — Select when the live result has columns, else a free Input. */
function CfColumnField({ value, columns, onChange, label }: { value: string; columns: string[]; onChange: (v: string) => void; label: string }) {
  if (columns.length > 0) {
    return (
      <Select size="small" value={value} aria-label={label} onChange={(_: unknown, d: any) => onChange(d.value)}>
        {!columns.includes(value) && <option value={value}>{value || '(pick column)'}</option>}
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    );
  }
  return <Input size="small" value={value} aria-label={label} placeholder="column name" onChange={(_: unknown, d: any) => onChange(d.value)} />;
}

/**
 * Per-tile conditional-formatting rule editor (Fabric Real-Time Dashboard
 * parity). Supports "Color by condition" (threshold → color/icon/tag, AND-ed
 * conditions, cells-or-row) and table-only "Color by value" (gradient theme).
 * Every field is a dropdown / typed Input — no freeform JSON (operator
 * no-freeform-config mandate). Rules apply client-side at render time.
 */
function ConditionalFormattingEditor({ viz, rules, columns, onChange }: {
  viz: 'table' | 'stat';
  rules: ConditionalRule[];
  columns: string[];
  onChange: (rules: ConditionalRule[]) => void;
}) {
  const isTable = viz === 'table';
  const update = (idx: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx));
  const addRule = (type: 'condition' | 'value') => {
    const col = columns[0] || '';
    const base: ConditionalRule = type === 'condition'
      ? { type, color: 'red', colorStyle: 'bold', applyTo: 'cells', conditions: [{ column: col, operator: '>', value: '' }] }
      : { type, theme: 'traffic-lights', column: col, applyTo: 'cells' };
    onChange([...rules, base]);
  };
  const updateCond = (ri: number, ci: number, patch: Partial<CfCondition>) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : r)));
  const addCond = (ri: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: [...(r.conditions || []), { column: columns[0] || '', operator: '>', value: '' }] } : r)));
  const removeCond = (ri: number, ci: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).filter((_, j) => j !== ci) } : r)));

  const fieldRow: React.CSSProperties = { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>Conditional formatting</Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
          <Button size="small" icon={<Add20Regular />} onClick={() => addRule('condition')}>Color by condition</Button>
          {isTable && <Button size="small" icon={<Add20Regular />} onClick={() => addRule('value')}>Color by value</Button>}
        </div>
      </div>
      {columns.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run the tile first to pick columns from its real result. You can still type column names below.</Caption1>
      )}
      {rules.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rules — cells render unstyled. Add a rule to color cells by a data threshold.</Caption1>
      )}
      {rules.map((rule, ri) => (
        <div key={ri} style={{ border: `1px solid ${tokens.colorNeutralStroke3}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground1 }}>
          <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', justifyContent: 'space-between' }}>
            <Badge appearance="outline" color={rule.type === 'value' ? 'informative' : 'brand'}>{rule.type === 'value' ? 'Color by value' : 'Color by condition'}</Badge>
            <Input size="small" style={{ flex: 1 }} value={rule.name || ''} placeholder={`Rule ${ri + 1} name (optional)`} aria-label={`Rule ${ri + 1} name`} onChange={(_: unknown, d: any) => update(ri, { name: d.value || undefined })} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete rule ${ri + 1}`} onClick={() => removeRule(ri)} />
          </div>

          {rule.type === 'condition' ? (
            <>
              {(rule.conditions || []).map((cond, ci) => (
                <div key={ci} style={fieldRow}>
                  {ci > 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>AND</Caption1>}
                  <div style={{ minWidth: 130 }}>
                    <CfColumnField label={`Rule ${ri + 1} condition ${ci + 1} column`} value={cond.column} columns={columns} onChange={(v) => updateCond(ri, ci, { column: v })} />
                  </div>
                  <Select size="small" value={cond.operator} aria-label={`Rule ${ri + 1} condition ${ci + 1} operator`} onChange={(_: unknown, d: any) => updateCond(ri, ci, { operator: d.value as CfOperator })}>
                    {CF_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  <Input
                    size="small"
                    style={{ width: 110 }}
                    value={cond.value || ''}
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} value`}
                    placeholder="value"
                    disabled={cond.operator === 'is empty' || cond.operator === 'is not empty'}
                    onChange={(_: unknown, d: any) => updateCond(ri, ci, { value: d.value })}
                  />
                  {(rule.conditions || []).length > 1 && (
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove condition ${ci + 1}`} onClick={() => removeCond(ri, ci)} />
                  )}
                </div>
              ))}
              <div>
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => addCond(ri)}>Add condition</Button>
              </div>
              <div style={fieldRow}>
                <Label size="small">Color</Label>
                <Select size="small" value={rule.color || 'red'} aria-label={`Rule ${ri + 1} color`} onChange={(_: unknown, d: any) => update(ri, { color: d.value as CfColor })}>
                  {CF_COLORS.map((c) => <option key={c} value={c}>{CF_COLOR_LABELS[c]}</option>)}
                </Select>
                <Label size="small">Style</Label>
                <Select size="small" value={rule.colorStyle || 'bold'} aria-label={`Rule ${ri + 1} style`} onChange={(_: unknown, d: any) => update(ri, { colorStyle: d.value as 'bold' | 'light' })}>
                  <option value="bold">Bold</option>
                  <option value="light">Light</option>
                </Select>
                <Label size="small">Icon</Label>
                <Select size="small" value={rule.icon || ''} aria-label={`Rule ${ri + 1} icon`} onChange={(_: unknown, d: any) => update(ri, { icon: (d.value || undefined) as CfIcon | undefined })}>
                  <option value="">None</option>
                  {CF_ICONS.map((ic) => <option key={ic} value={ic}>{CF_ICON_LABELS[ic]}</option>)}
                </Select>
                <Label size="small">Tag</Label>
                <Input size="small" style={{ width: 110 }} value={rule.tag || ''} placeholder="optional" aria-label={`Rule ${ri + 1} tag`} onChange={(_: unknown, d: any) => update(ri, { tag: d.value || undefined })} />
              </div>
            </>
          ) : (
            <div style={fieldRow}>
              <Label size="small">Column</Label>
              <div style={{ minWidth: 130 }}>
                <CfColumnField label={`Rule ${ri + 1} value column`} value={rule.column || ''} columns={columns} onChange={(v) => update(ri, { column: v })} />
              </div>
              <Label size="small">Theme</Label>
              <Select size="small" value={rule.theme || 'traffic-lights'} aria-label={`Rule ${ri + 1} theme`} onChange={(_: unknown, d: any) => update(ri, { theme: d.value as CfTheme })}>
                {CF_THEMES.map((th) => <option key={th} value={th}>{CF_THEME_LABELS[th]}</option>)}
              </Select>
              <Label size="small">Min</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.minValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} min`} onChange={(_: unknown, d: any) => update(ri, { minValue: d.value === '' ? undefined : Number(d.value) })} />
              <Label size="small">Max</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.maxValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} max`} onChange={(_: unknown, d: any) => update(ri, { maxValue: d.value === '' ? undefined : Number(d.value) })} />
              <Switch label="Reverse" checked={!!rule.reverseColors} aria-label={`Rule ${ri + 1} reverse colors`} onChange={(_: unknown, d: any) => update(ri, { reverseColors: d.checked || undefined })} />
            </div>
          )}

          {isTable && (
            <div style={fieldRow}>
              <Label size="small">Apply to</Label>
              <Select size="small" value={rule.applyTo || 'cells'} aria-label={`Rule ${ri + 1} apply to`} onChange={(_: unknown, d: any) => update(ri, { applyTo: d.value as 'cells' | 'row' })}>
                <option value="cells">Matched cells</option>
                <option value="row">Entire row</option>
              </Select>
              {(rule.applyTo || 'cells') === 'cells' && (
                <>
                  <Label size="small">Target column</Label>
                  <Select size="small" value={rule.targetColumn || ''} aria-label={`Rule ${ri + 1} target column`} onChange={(_: unknown, d: any) => update(ri, { targetColumn: d.value || undefined })}>
                    <option value="">{rule.type === 'value' ? '(graded column)' : '(all conditioned columns)'}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <Switch label="Hide text" checked={!!rule.hideText} aria-label={`Rule ${ri + 1} hide text`} onChange={(_: unknown, d: any) => update(ri, { hideText: d.checked || undefined })} />
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<DashTile[]>([]);
  const [dataSources, setDataSources] = useState<DashDataSource[]>([]);
  const [params, setParams] = useState<DashParam[]>([]);
  const [baseQueries, setBaseQueries] = useState<DashBaseQuery[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  // True while a runAll() ADX requery is in flight. Read synchronously inside
  // the auto-refresh interval so a tight cadence (5s/30s) skips a tick rather
  // than stacking overlapping /run round-trips against a slow cluster.
  const runInFlightRef = useRef(false);
  // Wall-clock of the last successful auto/manual refresh — surfaced in the
  // toolbar so the user can see the live cadence is actually firing.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Index of the tile whose edit flyout (Dialog) is open, or null. Mirrors the
  // Fabric Real-Time Dashboard "tile editing window" — a single side panel that
  // edits one tile at a time, rather than expanding the card inline.
  const [tileFlyoutIdx, setTileFlyoutIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('last-24h');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [baseQueriesOpen, setBaseQueriesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // AI tile generator (NL → KQL) — Fabric RTI "Copilot add a tile" parity.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiDataSourceId, setAiDataSourceId] = useState('');
  // Query-based param value caches: variableName → string[]
  const [paramValueCache, setParamValueCache] = useState<Record<string, string[]>>({});
  // Real KQL databases on the shared Loom ADX cluster — populates the data
  // source database dropdown so binding a source defaults to a deployed DB
  // instead of a blank free-text box (operator no-freeform mandate).
  const [clusterDbs, setClusterDbs] = useState<string[]>([]);

  const defaultDb = state?.database || state?.defaultDatabase || 'loomdb-default';

  // Build the live model the /run + /param-values + PUT routes consume.
  const buildModel = useCallback(() => ({
    tiles: tiles.map(({ result, error, ...t }) => t),
    dataSources,
    parameters: params,
    baseQueries,
    timeRange,
    autoRefreshMs,
  }), [tiles, dataSources, params, baseQueries, timeRange, autoRefreshMs]);

  // Load the saved model (GET). When runTiles, GET ?run=1 executes every tile.
  const load = useCallback(async (runTiles = false) => {
    if (!id || id === 'new') return;
    const sp = new URLSearchParams();
    if (runTiles) { sp.set('run', '1'); sp.set('time', timeRange); }
    for (const p of params) {
      if (!p.variableName) continue;
      if (Array.isArray(p.value)) p.value.forEach((v) => sp.append(`param.${p.variableName}`, v));
      else if (p.value !== undefined && p.value !== '') sp.set(`param.${p.variableName}`, String(p.value));
    }
    const qs = sp.toString();
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}${qs ? '?' + qs : ''}`);
      const ct = r.headers.get('content-type') || '';
      const j: DashboardState = ct.includes('application/json')
        ? await r.json()
        : { ok: false, error: `HTTP ${r.status}` };
      setState(j);
      if (j.ok) {
        setTiles(j.tiles || []);
        setDataSources(j.dataSources || []);
        setParams(j.parameters || []);
        setBaseQueries(j.baseQueries || []);
        if (typeof j.autoRefreshMs === 'number') setAutoRefreshMs(j.autoRefreshMs);
        if (j.timeRange && TIME_ORDER.includes(j.timeRange as TimeRangeKey)) setTimeRange(j.timeRange as TimeRangeKey);
        setDirty(false);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, timeRange, params]);

  // Run the CURRENT (possibly unsaved) builder model live via POST /run.
  const runAll = useCallback(async () => {
    if (tiles.length === 0) return;
    runInFlightRef.current = true;
    setRunning(true); setSaveErr(null);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setSaveErr(j.error || `run failed (HTTP ${r.status})`); return; }
      // Merge results back onto tiles by index (order preserved by /run).
      setTiles((prev) => prev.map((t, i) => ({
        ...t,
        result: j.tiles?.[i]?.result,
        error: j.tiles?.[i]?.error,
      })));
      setLastRefreshedAt(Date.now());
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      runInFlightRef.current = false;
      setRunning(false);
    }
  }, [id, tiles.length, buildModel]);

  // Initial load: fetch the saved model, then run it live so tiles render real data.
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (state?.ok && tiles.length > 0) runAll(); /* eslint-disable-next-line */ }, [state?.ok]);

  // Fetch the real KQL databases on the shared cluster once, so data-source
  // binding is a dropdown of deployed databases (not a blank text box). Best
  // effort: if the cluster is unreachable the dialog falls back to free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/items/eventhouse/cluster');
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false };
        if (!cancelled && j.ok && Array.isArray(j.databases)) {
          setClusterDbs(j.databases.map((d: { name: string }) => d.name).filter(Boolean));
        }
      } catch { /* dropdown falls back to free text */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const addTile = useCallback(() => {
    setTiles((prev) => {
      const next: DashTile[] = [...prev, {
        title: `Tile ${prev.length + 1}`,
        kql: `// KQL for this tile. Use parameters (_startTime, _endTime, or your own _vars).\nprint value = 1`,
        viz: 'table', w: 4, h: 2,
      }];
      setTileFlyoutIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, []);

  // AI tile generator: POST the NL prompt → server grounds on the live ADX
  // schema, asks AOAI for {title, kql, viz}, validates by executing the KQL,
  // and returns a ready tile (with its first-page result inlined). We append it
  // to the grid and open its editor so the operator can review/tweak. This is
  // the Fabric Real-Time Dashboard "Copilot — add a tile from a question" flow,
  // Azure-native (ADX + AOAI), no Fabric/Power BI on the path.
  const generateTile = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) { setAiErr('Describe the tile you want (e.g. "errors per service over time").'); return; }
    setAiBusy(true); setAiErr(null); setAiNote(null);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/generate-tile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, dataSourceId: aiDataSourceId || undefined, timeRange }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setAiErr(j.error || `generation failed (HTTP ${r.status})`); return; }
      const g = j.tile || {};
      const newTile: DashTile = {
        title: g.title || prompt.slice(0, 60),
        kql: g.kql || '',
        viz: (g.viz || 'table') as TileViz,
        dataSourceId: g.dataSourceId || undefined,
        database: g.database || undefined,
        w: g.w || 4,
        h: g.h || 2,
        result: g.result,
        error: j.validated ? undefined : (j.validationError || undefined),
      };
      let insertedIdx = 0;
      setTiles((prev) => { insertedIdx = prev.length; return [...prev, newTile]; });
      setDirty(true);
      setTileFlyoutIdx(insertedIdx);
      if (!j.schemaGrounded) {
        setAiNote('Generated without a live schema (the database returned no tables). Review the column names in the tile editor.');
      } else if (!j.validated) {
        setAiNote(`Tile added, but its KQL did not validate against ${j.resolvedDatabase}: ${j.validationError || 'unknown error'}. Edit it in the tile editor.`);
      }
      setAiOpen(false);
      setAiPrompt('');
    } catch (e: any) {
      setAiErr(e?.message || String(e));
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiDataSourceId, id, timeRange]);

  const deleteTile = useCallback((idx: number) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this tile? This cannot be undone until you reload without saving.')) return;
    setTiles((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setTileFlyoutIdx((cur) => (cur === idx ? null : cur !== null && cur > idx ? cur - 1 : cur));
  }, []);

  const updateTile = useCallback((idx: number, patch: Partial<DashTile>) => {
    setTiles((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
    setDirty(true);
  }, []);

  // Export a tile's REAL result (the same Kusto rows already rendered) to CSV.
  // Fabric Real-Time Dashboard tiles expose an "Export to CSV" / "Copy to
  // clipboard" tile action; this is the 1:1. Pure client-side — the result is
  // already in memory, so no backend round-trip is needed.
  const exportTileCsv = useCallback((idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to export yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    downloadTextFile(`${slugifyForFile(t.title)}.csv`, csv);
    setSaveErr(null);
    setSaveMsg(`Exported ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to CSV.`);
  }, [tiles]);

  const copyTileCsv = useCallback(async (idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to copy yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable in this browser.');
      await navigator.clipboard.writeText(csv);
      setSaveErr(null);
      setSaveMsg(`Copied ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to the clipboard (CSV).`);
    } catch (e: any) {
      setSaveErr(`Could not copy to clipboard: ${e?.message || e}. Use Export CSV instead.`);
    }
  }, [tiles]);

  // Run a single tile live (the tile-editor "Run" button — Fabric parity).
  const runTile = useCallback(async (idx: number) => {
    const t = tiles[idx];
    if (!t) return;
    updateTile(idx, { error: undefined });
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildModel(), tiles: [{ title: t.title, kql: t.kql, viz: t.viz, dataSourceId: t.dataSourceId, database: t.database }] }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { updateTile(idx, { error: j.error || `run failed (HTTP ${r.status})`, result: undefined }); return; }
      updateTile(idx, { result: j.tiles?.[0]?.result, error: j.tiles?.[0]?.error });
    } catch (e: any) {
      updateTile(idx, { error: e?.message || String(e) });
    }
  }, [id, tiles, buildModel, updateTile]);

  // Re-run ONLY the tiles whose KQL body references the given parameter
  // variable name (selective dependent-tile re-run, like Fabric re-evaluating
  // just the tiles a changed filter feeds). `duration` params affect every
  // tile that uses the synthetic _startTime/_endTime tokens, so those re-run
  // the whole dashboard via runAll.
  const runDependentTiles = useCallback((varName: string) => {
    if (!varName) return;
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`);
    tiles.forEach((t, idx) => {
      if (re.test(t.kql)) runTile(idx);
    });
  }, [tiles, runTile]);

  const save = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, buildModel]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  // Auto-refresh — re-run the live model (real ADX requery via /run) every N ms.
  // A tick is SKIPPED when the previous requery is still resolving so a tight
  // cadence (5s/30s) against a slow cluster can never pile up overlapping
  // queries — the next tick simply picks up once the in-flight run completes.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => {
      if (runInFlightRef.current) return;
      runAll();
    }, autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, runAll]);

  // --- Data sources ---
  const addDataSource = useCallback(() => {
    // Default to a real deployed database (prefer the cluster default) rather
    // than a blank box — operator no-freeform mandate.
    const seedDb = clusterDbs.includes(defaultDb) ? defaultDb : (clusterDbs[0] || defaultDb);
    setDataSources((prev) => [...prev, { id: genId(), name: `Source ${prev.length + 1}`, database: seedDb }]);
    setDirty(true);
  }, [defaultDb, clusterDbs]);
  const updateDataSource = useCallback((idx: number, patch: Partial<DashDataSource>) => {
    setDataSources((prev) => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  const removeDataSource = useCallback((idx: number) => {
    setDataSources((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Parameters ---
  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { variableName: `_param${prev.length + 1}`, label: `Parameter ${prev.length + 1}`, type: 'freetext', dataType: 'string', value: '' }]);
    setDirty(true);
  }, []);
  const updateParam = useCallback((idx: number, patch: Partial<DashParam>) => {
    setParams((prev) => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    setDirty(true);
  }, []);
  const removeParam = useCallback((idx: number) => {
    setParams((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Base queries (shared KQL snippets referenced via $baseQuery('name')) ---
  const addBaseQuery = useCallback(() => {
    setBaseQueries((prev) => [...prev, { id: genId(), name: `Query${prev.length + 1}`, kql: '// Shared KQL — referenced from a tile as $baseQuery(\'Query1\')\nStormEvents | where StartTime > _startTime' }]);
    setDirty(true);
  }, []);
  const updateBaseQuery = useCallback((idx: number, patch: Partial<DashBaseQuery>) => {
    setBaseQueries((prev) => prev.map((q, i) => i === idx ? { ...q, ...patch } : q));
    setDirty(true);
  }, []);
  const removeBaseQuery = useCallback((idx: number) => {
    setBaseQueries((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // Resolve a query-based parameter's dropdown values from the real cluster.
  const loadParamValues = useCallback(async (p: DashParam) => {
    if (p.type !== 'query' || !p.query?.trim()) return;
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/param-values`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: p.query, dataSourceId: p.dataSourceId, dataSources }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setParamValueCache((prev) => ({ ...prev, [p.variableName]: j.values || [] }));
    } catch { /* surfaced lazily; dropdown just stays empty */ }
  }, [id, dataSources]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(buildModel(), null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }, [buildModel]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const model = Array.isArray(parsed) ? { tiles: parsed } : parsed;
      if (Array.isArray(model.tiles)) setTiles(model.tiles);
      if (Array.isArray(model.dataSources)) setDataSources(model.dataSources);
      if (Array.isArray(model.parameters)) setParams(model.parameters);
      if (Array.isArray(model.baseQueries)) setBaseQueries(model.baseQueries);
      if (typeof model.timeRange === 'string' && TIME_ORDER.includes(model.timeRange)) setTimeRange(model.timeRange);
      setDirty(true); setJsonOpen(false); setJsonErr(null);
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  }, [jsonText]);

  const cycleTime = useCallback(() => {
    const i = TIME_ORDER.indexOf(timeRange);
    const next = TIME_ORDER[(i + 1) % TIME_ORDER.length];
    setTimeRange(next);
    setTimeout(() => runAll(), 0);
  }, [timeRange, runAll]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Add tile', onClick: addTile },
        { label: 'Add tile with Copilot', onClick: () => { setAiErr(null); setAiNote(null); setAiOpen(true); } },
        { label: 'Data sources', onClick: () => setSourcesOpen(true) },
        { label: 'Parameters', onClick: () => setParamsOpen(true) },
        { label: 'Base queries', onClick: () => setBaseQueriesOpen(true) },
        { label: 'Edit JSON', onClick: openJson },
      ]},
      { label: 'View', actions: [
        { label: running ? 'Refreshing…' : 'Refresh all', onClick: running ? undefined : runAll, disabled: running },
        // The interval is authored via the toolbar <Select>; the ribbon shows
        // current state (a one-state cycle button was undiscoverable).
        { label: refreshLabel(autoRefreshMs), onClick: undefined, disabled: true },
        { label: `Time: ${timeRange}`, onClick: cycleTime },
      ]},
      { label: 'Manage', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Share', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [addTile, openJson, running, runAll, autoRefreshMs, timeRange, cycleTime, saving, save]);

  const main = (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">Real-Time Dashboard</Badge>
        <Caption1>db: <strong>{defaultDb}</strong> · {tiles.length} tiles · {dataSources.length} sources · {params.length} params</Caption1>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
        <Button size="small" appearance="primary" icon={<Sparkle20Regular />} onClick={() => { setAiErr(null); setAiNote(null); setAiOpen(true); }}>Add tile with Copilot</Button>
        <Button size="small" appearance="outline" icon={<Database20Regular />} onClick={() => setSourcesOpen(true)}>Data sources</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setParamsOpen(true)}>Parameters</Button>
        <Button size="small" appearance="outline" onClick={() => setBaseQueriesOpen(true)}>Base queries</Button>
        <Button size="small" appearance="outline" onClick={openJson}>Edit JSON</Button>
        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={runAll} disabled={running}>{running ? 'Refreshing…' : 'Refresh all'}</Button>
        <Select
          size="small"
          aria-label="Auto-refresh interval"
          value={String(autoRefreshMs)}
          onChange={(_: unknown, d: any) => { setAutoRefreshMs(Number(d.value) || 0); setDirty(true); }}
          style={{ minWidth: 150 }}
        >
          {REFRESH_INTERVALS.map(({ ms, label }) => (
            <option key={ms} value={String(ms)}>
              {ms === 0 ? 'Auto-refresh: off' : `Auto-refresh: every ${label}`}
            </option>
          ))}
        </Select>
        {autoRefreshMs > 0 && (
          <span
            className={s.livePill}
            role="status"
            aria-live="polite"
            title={`Auto-refreshing every ${refreshLabel(autoRefreshMs).replace(/^Auto-refresh:\s*/i, '')}`}
          >
            <span className={mergeClasses(s.liveDot, running && s.liveDotActive)} aria-hidden />
            <Caption1>
              {running
                ? 'Refreshing…'
                : lastRefreshedAt
                  ? `Live · updated ${new Date(lastRefreshedAt).toLocaleTimeString()}`
                  : 'Live · waiting for first refresh…'}
            </Caption1>
          </span>
        )}
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </Button>
      </div>

      {/* Parameter filter bar — Fabric renders selected dashboard params here. */}
      {params.length > 0 && (
        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'flex-end', padding: `${tokens.spacingVerticalXS} 0` }}>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 160 }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.label || p.variableName}</Caption1>
              {p.type === 'fixed' || p.type === 'datasource' ? (
                <Select value={(p.value as string) || ''}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(p.type === 'datasource' ? dataSources.map((d) => d.name) : (p.values || [])).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'query' ? (
                <Select value={(p.value as string) || ''}
                  onFocus={() => { if (!paramValueCache[p.variableName]) loadParamValues(p); }}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(paramValueCache[p.variableName] || []).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'duration' ? (
                // Time-range picker — matches the Fabric "Duration" param type.
                // Changing it sets the global time range (which drives the
                // synthetic _startTime/_endTime tokens) and re-runs every tile.
                <Select value={(p.value as string) || timeRange}
                  onChange={(_: unknown, d: any) => {
                    updateParam(i, { value: d.value });
                    if (TIME_ORDER.includes(d.value as TimeRangeKey)) setTimeRange(d.value as TimeRangeKey);
                    setTimeout(() => runAll(), 0);
                  }}>
                  {TIME_ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              ) : p.type === 'multi' ? (
                p.values && p.values.length > 0 ? (
                  // Fixed-value multi-select — native <select multiple> backed
                  // by the param's allowed values list.
                  <select
                    multiple
                    size={Math.min(p.values.length, 5)}
                    value={Array.isArray(p.value) ? (p.value as string[]) : []}
                    onChange={(e) => updateParam(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                    onBlur={() => runDependentTiles(p.variableName)}
                    aria-label={p.label || p.variableName}
                    style={{ minWidth: 160, padding: tokens.spacingVerticalXS, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                    {p.values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <Input placeholder="comma,separated,values"
                    value={Array.isArray(p.value) ? p.value.join(',') : ''}
                    onChange={(_: unknown, d: any) => updateParam(i, { value: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
                    onBlur={() => runDependentTiles(p.variableName)} />
                )
              ) : (
                <Input value={Array.isArray(p.value) ? '' : (p.value || '')}
                  onChange={(_: unknown, d: any) => updateParam(i, { value: d.value })}
                  onBlur={() => runDependentTiles(p.variableName)} />
              )}
            </div>
          ))}
          <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={runAll} disabled={running}>Apply</Button>
        </div>
      )}

      {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
      {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
      {aiNote && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Copilot tile</MessageBarTitle>{aiNote}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => setAiNote(null)}>Dismiss</Button>
          </MessageBarActions>
        </MessageBar>
      )}
      {state && !state.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Dashboard data source not ready</MessageBarTitle>
            {state.error || 'unknown'} — the dashboard still renders; bind tiles to a KQL database
            (via Data sources) on the Loom shared ADX cluster. If no Eventhouse / KQL DB is provisioned,
            create one in the Eventhouse editor first (ARM Microsoft.Kusto/clusters/databases).
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Tile grid — 12-col CSS grid; each tile spans its w/h. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: tokens.spacingVerticalM, gridAutoRows: 'minmax(120px, auto)' }}>
        {tiles.map((t, i) => {
          const span = Math.max(1, Math.min(12, t.w || 4));
          const rowSpan = Math.max(1, Math.min(8, t.h || 2));
          const dsName = t.dataSourceId ? (dataSources.find((d) => d.id === t.dataSourceId)?.name || t.dataSourceId) : (t.database || defaultDb);
          return (
            <div key={i} className={s.card} style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.viz.toUpperCase()} · {dsName}</Caption1>
                  <div style={{ fontSize: tokens.fontSizeBase300, fontWeight: 600 }}>{t.title}</div>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingVerticalXXS}}>
                  <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runTile(i)} aria-label="Run tile" title="Run this tile" />
                  <Button
                    size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                    onClick={() => exportTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Export tile result to CSV"
                    title={t.result?.ok ? 'Export this tile’s result to CSV' : 'Run the tile first to enable export'} />
                  <Button
                    size="small" appearance="subtle" icon={<Copy20Regular />}
                    onClick={() => copyTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Copy tile result to clipboard"
                    title={t.result?.ok ? 'Copy this tile’s result (CSV) to the clipboard' : 'Run the tile first to enable copy'} />
                  <Button size="small" appearance="subtle" onClick={() => setTileFlyoutIdx(i)} aria-label="Edit tile">
                    Edit
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
                </div>
              </div>

              {t.error && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{t.error}</MessageBarBody></MessageBar>}
              {t.result && t.result.ok && (
                <div style={{ marginTop: tokens.spacingVerticalS, flex: 1, minHeight: 0 }}>
                  <TileVisual
                    viz={t.viz}
                    result={t.result}
                    conditionalRules={t.conditionalRules}
                    drillthrough={t.drillthrough}
                    onDrillthrough={t.drillthrough ? (paramName, value) => {
                      // Inject the clicked value into the target parameter, then
                      // re-run every tile so the dashboard cross-filters — the
                      // single-page Loom equivalent of Fabric drill-through.
                      setParams((prev) => prev.map((p) => p.variableName === paramName ? { ...p, value } : p));
                      setTimeout(() => runAll(), 0);
                    } : undefined}
                  />
                  {/* Stable, machine-readable first-row snapshot — the
                      before/after receipt target for the param-change E2E. */}
                  <span data-testid="tile-result-row" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    {JSON.stringify(t.result.rows?.[0] ?? [])}
                  </span>
                </div>
              )}
              {!t.result && !t.error && <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>Run the tile to see results.</Caption1>}
            </div>
          );
        })}
        {tiles.length === 0 && <Caption1 style={{ gridColumn: 'span 12' }}>No tiles yet. Click <strong>Add tile</strong> to start building.</Caption1>}
      </div>

      {/* Tile edit flyout — Fabric "tile editing window": one Dialog edits the
          tile at tileFlyoutIdx (title, visual, data source, geometry, KQL),
          runs it live, and renders the real result inline before Apply. */}
      <Dialog open={tileFlyoutIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open) setTileFlyoutIdx(null); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>Edit tile</DialogTitle>
            <DialogContent>
              {tileFlyoutIdx !== null && tiles[tileFlyoutIdx] && (() => {
                const i = tileFlyoutIdx;
                const t = tiles[i];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div>
                      <Caption1>Title</Caption1>
                      <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" aria-label="Tile title" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Visual</Caption1>
                        <Select value={t.viz} onChange={(_: unknown, d: any) => updateTile(i, { viz: d.value as TileViz })} aria-label="Tile visual type">
                          {TILE_VIZ_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                        </Select>
                      </div>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Data source</Caption1>
                        <Select value={t.dataSourceId || ''} onChange={(_: unknown, d: any) => updateTile(i, { dataSourceId: d.value || undefined })} aria-label="Tile data source">
                          <option value="">{`(dashboard default: ${defaultDb})`}</option>
                          {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} → {ds.database}</option>)}
                        </Select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Width (1–12)</Caption1>
                        <Input type="number" value={String(t.w || 4)} onChange={(_: unknown, d: any) => updateTile(i, { w: Math.max(1, Math.min(12, parseInt(d.value, 10) || 4)) })} aria-label="Tile width" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Height (1–8)</Caption1>
                        <Input type="number" value={String(t.h || 2)} onChange={(_: unknown, d: any) => updateTile(i, { h: Math.max(1, Math.min(8, parseInt(d.value, 10) || 2)) })} aria-label="Tile height" />
                      </div>
                    </div>
                    <Caption1>KQL query{baseQueries.length > 0 ? ' — reference a base query as $baseQuery(\'name\')' : ''}</Caption1>
                    <MonacoTextarea
                      value={t.kql}
                      onChange={(v) => updateTile(i, { kql: v })}
                      language="kql"
                      height={220}
                      minHeight={180}
                      ariaLabel={`Tile ${i + 1} KQL`}
                    />
                    <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={() => runTile(i)}>Run tile</Button>
                    {t.error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{t.error}</MessageBarBody></MessageBar>}
                    {t.result && t.result.ok && (
                      <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS }}>
                        <TileVisual viz={t.viz} result={t.result} conditionalRules={t.conditionalRules} />
                      </div>
                    )}

                    {/* Drill-through (Fabric: visual Interactions > Drillthrough).
                        Clicking a result value sets a dashboard parameter and
                        re-runs every tile (single-page cross-filter). */}
                    <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: tokens.spacingVerticalXS}}>
                      <Caption1 style={{ fontWeight: 600 }}>Drill-through</Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXS}}>
                        Clicking a value in this tile injects it into a dashboard parameter and re-runs all tiles.
                      </Caption1>
                      {params.length === 0 ? (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Add at least one dashboard <strong>Parameter</strong> first — drill-through targets a parameter.
                          </MessageBarBody>
                        </MessageBar>
                      ) : (
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Column (from query result)</Caption1>
                            {t.result?.ok && (t.result.columns?.length ?? 0) > 0 ? (
                              <Select
                                value={t.drillthrough?.column || ''}
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              >
                                <option value="">(none)</option>
                                {(t.result.columns || []).map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                value={t.drillthrough?.column || ''}
                                placeholder="Run the tile to pick a column"
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Target parameter</Caption1>
                            <Select
                              value={t.drillthrough?.paramName || ''}
                              aria-label="Drillthrough target parameter"
                              onChange={(_: unknown, d: any) => {
                                const paramName = d.value;
                                const column = t.drillthrough?.column || '';
                                updateTile(i, {
                                  drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                });
                              }}
                            >
                              <option value="">(none — disable drill-through)</option>
                              {params.map((p) => (
                                <option key={p.variableName} value={p.variableName}>{p.label || p.variableName}</option>
                              ))}
                            </Select>
                          </div>
                        </div>
                      )}
                      {t.drillthrough?.column && t.drillthrough?.paramName && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                          Click a value in this tile → sets <code>{t.drillthrough.paramName}</code> to the value in column <code>{t.drillthrough.column}</code> and re-runs all tiles.
                        </Caption1>
                      )}
                    </div>

                    {/* Conditional formatting (Fabric RTD: color by condition / by value).
                        Applies to table + stat (card) visuals. */}
                    {(t.viz === 'table' || t.viz === 'stat') && (
                      <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: tokens.spacingVerticalXS}}>
                        <ConditionalFormattingEditor
                          viz={t.viz}
                          rules={t.conditionalRules || []}
                          columns={t.result?.columns || []}
                          onChange={(rules) => updateTile(i, { conditionalRules: rules.length ? rules : undefined })}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </DialogContent>
            <DialogActions>
              {tileFlyoutIdx !== null && (
                <Button appearance="secondary" icon={<Delete20Regular />} onClick={() => deleteTile(tileFlyoutIdx)}>Delete tile</Button>
              )}
              <Button appearance="primary" onClick={() => setTileFlyoutIdx(null)}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Base queries dialog — shared KQL snippets referenced via $baseQuery('name') */}
      <Dialog open={baseQueriesOpen} onOpenChange={(_: unknown, d: any) => setBaseQueriesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>Base queries</DialogTitle>
            <DialogContent>
              <Caption1>
                Define shared KQL snippets once and reference them from any tile with
                <code> $baseQuery('name')</code>. At run time the snippet is inlined as a
                parenthesised sub-query, so a common filter or projection backs many tiles
                without copy-paste (Fabric Real-Time Dashboard base-query parity).
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {baseQueries.map((q, idx) => (
                  <div key={q.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Name (referenced as $baseQuery('…'))</Caption1>
                        <Input value={q.name} onChange={(_: unknown, d: any) => updateBaseQuery(idx, { name: d.value })} placeholder="Filtered" aria-label="Base query name" />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeBaseQuery(idx)} aria-label="Remove base query" />
                    </div>
                    <Caption1>KQL</Caption1>
                    <MonacoTextarea
                      value={q.kql}
                      onChange={(v) => updateBaseQuery(idx, { kql: v })}
                      language="kql"
                      height={120}
                      minHeight={90}
                      ariaLabel={`Base query ${idx + 1} KQL`}
                    />
                  </div>
                ))}
                {baseQueries.length === 0 && <Caption1>No base queries yet. Add one to share a KQL snippet across tiles.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addBaseQuery}>Add base query</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setBaseQueriesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* AI tile generator dialog (NL → KQL) — Fabric RTI "Copilot add a tile" parity. */}
      <Dialog open={aiOpen} onOpenChange={(_: unknown, d: any) => { if (!aiBusy) setAiOpen(d.open); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                <Sparkle20Regular /> Add a tile with Copilot
              </span>
            </DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
                Describe the visualization you want in plain language. Copilot reads the live
                schema of <strong>{defaultDb}</strong>, writes the KQL, picks a chart type, and
                validates the query against Azure Data Explorer before adding the tile.
              </Caption1>
              <Field label="What should this tile show?">
                <Textarea
                  value={aiPrompt}
                  onChange={(_: unknown, d: any) => setAiPrompt(d.value)}
                  placeholder="e.g. Count of failed requests per service over time as a line chart"
                  rows={3}
                  disabled={aiBusy}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !aiBusy) { e.preventDefault(); generateTile(); }
                  }}
                />
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                Press <kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Ctrl</kbd>+<kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Enter</kbd> to generate.
              </Caption1>
              {dataSources.length > 0 && (
                <Field label="Data source (optional)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Select value={aiDataSourceId} onChange={(_: unknown, d: any) => setAiDataSourceId(d.value)} disabled={aiBusy}>
                    <option value="">Dashboard default ({defaultDb})</option>
                    {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} · {ds.database}</option>)}
                  </Select>
                </Field>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, width: '100%' }}>Try:</Caption1>
                {[
                  'Total events in the last 24 hours',
                  'Top 10 error messages by count as a bar chart',
                  'Requests per minute over time',
                ].map((ex) => (
                  <Button
                    key={ex}
                    size="small"
                    appearance="outline"
                    shape="circular"
                    disabled={aiBusy}
                    onClick={() => setAiPrompt(ex)}
                  >
                    {ex}
                  </Button>
                ))}
              </div>
              {aiErr && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                  <MessageBarBody><MessageBarTitle>Could not generate the tile</MessageBarTitle>{aiErr}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAiOpen(false)} disabled={aiBusy}>Cancel</Button>
              <Button appearance="primary" icon={aiBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={generateTile} disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? 'Generating…' : 'Generate tile'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Data sources dialog */}
      <Dialog open={sourcesOpen} onOpenChange={(_: unknown, d: any) => setSourcesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Data sources</DialogTitle>
            <DialogContent>
              <Caption1>Bind the dashboard to one or more KQL databases on the Loom shared ADX cluster. Tiles select a source; query-based parameters can run against a source.</Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
                {dataSources.map((ds, idx) => (
                  <div key={ds.id} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Caption1>Name</Caption1>
                      <Input value={ds.name} onChange={(_: unknown, d: any) => updateDataSource(idx, { name: d.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Caption1>KQL database</Caption1>
                      {clusterDbs.length > 0 ? (
                        <Select
                          value={clusterDbs.includes(ds.database) ? ds.database : '__custom__'}
                          onChange={(_: unknown, d: any) => { if (d.value !== '__custom__') updateDataSource(idx, { database: d.value }); }}
                          aria-label="KQL database"
                        >
                          {clusterDbs.map((db) => <option key={db} value={db}>{db}</option>)}
                          <option value="__custom__">Other (type below)…</option>
                        </Select>
                      ) : null}
                      {(clusterDbs.length === 0 || !clusterDbs.includes(ds.database)) && (
                        <Input value={ds.database} onChange={(_: unknown, d: any) => updateDataSource(idx, { database: d.value })} placeholder="loomdb-default" aria-label="KQL database (custom)" style={{ marginTop: clusterDbs.length > 0 ? 4 : 0 }} />
                      )}
                    </div>
                    <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeDataSource(idx)} aria-label="Remove data source" />
                  </div>
                ))}
                {dataSources.length === 0 && <Caption1>No explicit data sources — tiles use the dashboard default database <strong>{defaultDb}</strong>.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addDataSource}>Add data source</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSourcesOpen(false)}>Done</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Parameters dialog — free-text / fixed / multi / query / datasource / duration */}
      <Dialog open={paramsOpen} onOpenChange={(_: unknown, d: any) => setParamsOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Dashboard parameters</DialogTitle>
            <DialogContent>
              <Caption1>
                Parameters substitute into tile KQL by their variable name (Fabric convention, e.g. <code>_eventType</code>).
                Time range exposes <code>_startTime</code>/<code>_endTime</code>; <code>_loomTimeFrom</code> is also supported.
                <code> multi</code> renders as <code>dynamic([...])</code> for <code>x in (_var)</code> filters.
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {params.map((p, idx) => (
                  <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Variable name</Caption1>
                        <Input value={p.variableName} onChange={(_: unknown, d: any) => updateParam(idx, { variableName: d.value })} placeholder="_eventType" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Label</Caption1>
                        <Input value={p.label || ''} onChange={(_: unknown, d: any) => updateParam(idx, { label: d.value })} />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeParam(idx)} aria-label="Remove parameter" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Type</Caption1>
                        <Select value={p.type} onChange={(_: unknown, d: any) => updateParam(idx, { type: d.value as DashParamType })}>
                          <option value="freetext">Free text</option>
                          <option value="fixed">Fixed values (single)</option>
                          <option value="multi">Multi-select</option>
                          <option value="query">Query-based</option>
                          <option value="datasource">Data source</option>
                          <option value="duration">Duration (time range)</option>
                        </Select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Data type</Caption1>
                        <Select value={p.dataType || 'string'} onChange={(_: unknown, d: any) => updateParam(idx, { dataType: d.value as DashParamDataType })}>
                          <option value="string">string</option>
                          <option value="long">long</option>
                          <option value="int">int</option>
                          <option value="real">real</option>
                          <option value="datetime">datetime</option>
                          <option value="bool">bool</option>
                        </Select>
                      </div>
                    </div>
                    {(p.type === 'fixed' || p.type === 'multi') && (
                      <div>
                        <Caption1>Allowed values (comma-separated)</Caption1>
                        <Input value={(p.values || []).join(',')} onChange={(_: unknown, d: any) => updateParam(idx, { values: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
                      </div>
                    )}
                    {p.type === 'query' && (
                      <>
                        <Caption1>Values query (returns one column)</Caption1>
                        <Textarea value={p.query || ''} onChange={(_: unknown, d: any) => updateParam(idx, { query: d.value })} rows={2} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} placeholder="StormEvents | distinct State" />
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
                          <div style={{ flex: 1 }}>
                            <Caption1>Run against source</Caption1>
                            <Select value={p.dataSourceId || ''} onChange={(_: unknown, d: any) => updateParam(idx, { dataSourceId: d.value || undefined })}>
                              <option value="">{`(default: ${defaultDb})`}</option>
                              {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                            </Select>
                          </div>
                          <Button size="small" appearance="outline" onClick={() => loadParamValues(p)}>Preview values</Button>
                        </div>
                        {paramValueCache[p.variableName] && <Caption1>{paramValueCache[p.variableName].length} values loaded.</Caption1>}
                      </>
                    )}
                  </div>
                ))}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addParam}>Add parameter</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setParamsOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={() => { setParamsOpen(false); runAll(); }}>Apply &amp; re-run</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit JSON model dialog */}
      <Dialog open={jsonOpen} onOpenChange={(_: unknown, d: any) => setJsonOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit dashboard model (JSON)</DialogTitle>
            <DialogContent>
              <Caption1>Full model: <code>{`{ tiles, dataSources, parameters, timeRange }`}</code>. An array root is accepted as just the tiles.</Caption1>
              <Textarea
                value={jsonText}
                onChange={(_: unknown, d: any) => { setJsonText(d.value); setJsonErr(null); }}
                rows={20}
                style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalS}}
                aria-label="Dashboard JSON model"
              />
              {jsonErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={applyJson}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Share dashboard</DialogTitle>
            <DialogContent>
              <Caption1>Anyone with access to this Loom item can view it. Permissions are managed via the workspace item ACL.</Caption1>
              <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                <Caption1>Canonical URL</Caption1>
                <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly />
                <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                <Caption1>To grant another user access, add them to this item via the workspace permissions page (Loom RBAC). Tenant-wide sharing is not enabled in this deployment.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );

  // On /new there is no Cosmos record yet, so Save (PUT) / Run (POST) would
  // 404/operate without persistence. Mirror the Eventstream/Activator pattern:
  // an ENABLED create surface mints a Cosmos kql-dashboard item, then routes to
  // this live editor where Add tile + Run + Save + parameters all work against
  // the real Kusto cluster + Cosmos.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New Real-Time Dashboard"
        intro="A Real-Time (KQL) Dashboard is a collection of tiles — each a KQL query bound to a KQL database, rendered as a table, time chart, bar/column, pie, stat card, or map. Bind data sources, add dashboard parameters (free-text, fixed, query-based, time range) that substitute into tile KQL, set auto-refresh, and Save. Create it, then build tiles that run live against the Loom shared ADX cluster." />
    );
  }

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

// ----- Eventstream -----
// Ribbon built inside the editor via useMemo so Save binds to the
// existing inline save handler; the rest stay disabled with reasons.

export { EventstreamEditor } from './phase3/eventstream-editor';


// ============================================================
// Power BI / Fabric editor shells — v2.1 live REST.
//
// IMPORTANT: All six editors below require the Console UAMI's service
// principal to be (a) registered in the Power BI tenant and (b) added to
// each target workspace. If either is missing, the editor surfaces the
// underlying 401/403 verbatim via MessageBar so the operator knows
// exactly what to fix. No mock data is shown when the call fails.
// ============================================================

// ----- Activator -----
// Ribbon built inside the editor via useMemo so New rule binds to the
// existing setRuleOpen handler; the rest stay disabled with reasons.

export { ActivatorEditor } from './phase3/activator-editor';

// ----- Warehouse -----
// Ribbon built inside the editor via useMemo so Run binds to the
// existing inline run handler; the rest stay disabled with reasons.

export { WarehouseEditor } from './phase3/warehouse-editor';

// ============================================================
// Semantic Model (Power BI dataset)
// ============================================================
// Ribbon built inside SemanticModelEditor via useMemo so Refresh binds
// to the existing inline refreshNow handler; the rest stay disabled.

export { SemanticModelEditor } from './phase3/semantic-model-editor';
export { ReportEditor } from './phase3/report-editor';
export type { ReportLite } from './phase3/report-editor';
export { PaginatedReportEditor } from './phase3/paginated-report-editor';

// ============================================================
// Dashboard (Power BI dashboard viewer + Loom-native tile canvas)
//
// Azure-native by default (no-fabric-dependency.md): the Loom canvas tab — pin
// a DAX tile, add a Copilot Q&A→DAX tile, add a streaming ADX/KQL tile, drag
// the grid, drill, fullscreen, mobile layout — works with NO Power BI / Fabric
// workspace bound (streaming tiles run on ADX; DAX tiles run on Azure Analysis
// Services when LOOM_SEMANTIC_BACKEND=analysis-services). Power BI embed + the
// "pin from a PBI dashboard" clone path are the opt-in Fabric-family surface.
// Layout + Loom tiles persist to Cosmos (pbi-dashboard-overlays) via
// PUT /api/items/dashboard/[id]; tiles execute via .../tile-query.
// ============================================================

export { DashboardEditor } from './phase3/dashboard-editor';

// ============================================================
// Scorecard (Fabric)
// ============================================================
export { ScorecardEditor } from './phase3/scorecard-editor';

// ============================================================
// Datamart (DEPRECATED) — migration assistant
// ============================================================
//
// Power BI datamarts are deprecated. There is NO create path: id === 'new'
// renders a permanent deprecation notice with no authoring surface. An existing
// datamart shows a Fluent MessageBar intent="warning" with a Migrate button
// that POSTs /api/items/datamart/migrate — provisioning a Synapse Serverless
// database + an Azure Analysis Services server (real backends, no Fabric).
// Once migrated, the receipt (Synapse DB, AAS server, AAS connection URI) is
// surfaced from the Cosmos item's state.migration.

export { DatamartEditor } from './phase3/datamart-editor';
