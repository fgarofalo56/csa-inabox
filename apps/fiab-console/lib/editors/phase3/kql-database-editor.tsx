'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * KqlDatabaseEditor — extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * Azure-native by DEFAULT — wired live against the shared Loom ADX cluster via
 * the Console UAMI (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt, ARM for
 * database create); no Fabric is required. The editor's exclusive helpers
 * (KqlDbInfo / KqlWizardKind / FnParam types + SAMPLE_KQL_DB / DEFAULT_TABLE_COLUMNS /
 * DC_FORMATS / FN_PARAM_TYPES + parseFnParams / serializeFnParams) move with it.
 * The shared KQL results surface (KqlResultsPanel + the KqlResult model) is
 * imported from ./kql-results; the shared phase3 styles hook from ./styles.
 * phase3-editors.tsx re-exports KqlDatabaseEditor from a barrel line so the
 * registry resolves it unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getItem, createItem, type WorkspaceItem } from '@/lib/api/workspaces';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Textarea, Switch,
  tokens,
} from '@fluentui/react-components';
import {
  DocumentTable20Regular, Play20Regular,
  Add20Regular, Delete20Regular, ArrowSync20Regular,
  Table20Regular, Flowchart20Regular,
  Sparkle16Regular, Info16Regular, Wrench16Regular,
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
import { ItemEditorChrome } from '../item-editor-chrome';
import { OpenInPbiDesktopButton } from '../components/open-in-pbi-desktop-button';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { KqlResultsPanel, type KqlResult } from './kql-results';
import { AnomalyForecastDialog } from './anomaly-forecast';
import { useStyles } from './styles';

// ----- KQL Database -----
// Ribbon is built inside the editor via useMemo. Every action is wired to a
// real, working dialog against the live ADX cluster (kusto-client executeMgmt
// / executeQuery): New → Table opens a guided column grid → .create table;
// Materialized view, Function, Update policy, Ingestion mapping, Get data
// (.ingest inline / blob), and Data connections (Event Hub / IoT Hub) all post
// to dedicated /api/adx/* + /api/items/kql-database/[id]/* routes. The only
// disabled item is OneLake availability — an honest Fabric-managed gate. If the
// cluster env (LOOM_KUSTO_CLUSTER_URI) is unset, the info fetch returns ok:false
// and the editor shows the "Database unavailable" MessageBar — no fake data.

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

  // ── Anomaly detection / forecasting (this task) ─────────────────────────
  // Native-KQL time-series ML over ADX (series_decompose_anomalies /
  // series_decompose_forecast) — a table-level action opening the shared
  // AnomalyForecastDialog. No Fabric, no external ML service.
  const [anomalyOpen, setAnomalyOpen] = useState(false);
  const [anomalyMode, setAnomalyMode] = useState<'anomaly' | 'forecast'>('anomaly');
  const [anomalyTable, setAnomalyTable] = useState<string>('');

  const openAnomaly = useCallback((mode: 'anomaly' | 'forecast', table?: string) => {
    setAnomalyMode(mode);
    setAnomalyTable(table || info?.tables?.[0]?.name || '');
    setAnomalyOpen(true);
  }, [info?.tables]);

  const openRlsEditor = useCallback(async (tableName: string) => {
    setRlsTable(tableName); setRlsError(null); setRlsNotice(null);
    setRlsEnabled(false); setRlsQuery(''); setRlsLoading(true);
    try {
      const res = await clientFetch(`/api/adx/rls?id=${encodeURIComponent(id)}&table=${encodeURIComponent(tableName)}`);
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
      const res = await clientFetch(`/api/adx/rls?id=${encodeURIComponent(id)}`, {
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
      const r = await clientFetch(`/api/items/kql-database/${id}`);
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
      const r = await clientFetch(`/api/items/kql-database/${id}/query`, {
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
      const r = await clientFetch(`/api/items/kql-database/${id}/assist`, {
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
      await clientFetch(`/api/items/kql-dashboard/${created.id}`, {
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
    clientFetch(`/api/items/kql-database/${id}/data-connections`)
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
    clientFetch(`/api/items/kql-database/${id}/data-connections?hub=${encodeURIComponent(wizDcHub)}`)
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
      const r = await clientFetch(`/api/items/kql-database/${id}/schema-graph`);
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
      const r = await clientFetch(`/api/items/kql-database/${id}/query`, {
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
      clientFetch(`/api/adx/tables?id=${encodeURIComponent(id)}`)
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
      clientFetch(`/api/adx/tables?id=${id}`).then((r) => r.json()),
      clientFetch(`/api/adx/functions?id=${id}`).then((r) => r.json()),
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
      const r = await clientFetch(`/api/adx/tables?id=${encodeURIComponent(id)}&schema=${encodeURIComponent(tableName)}`);
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
        const r = await clientFetch(`/api/items/kql-database/${id}/data-connections`, {
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
        const r = await clientFetch(`/api/items/kql-database/${id}/follower`, {
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
          const res = await clientFetch(`/api/adx/materialized-views?id=${encodeURIComponent(id)}`, {
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
          const r2 = await clientFetch(`/api/adx/policies?id=${id}`, {
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
      const r = await clientFetch(`/api/items/kql-database/${id}/query`, {
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
      const res = await clientFetch(`/api/adx/functions?id=${encodeURIComponent(id)}`, {
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
      const res = await clientFetch(
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
      const r = await clientFetch(`/api/items/kql-database/${id}/follower?configName=${encodeURIComponent(info.followerConfigName)}`, {
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
      const r = await clientFetch(`/api/items/kql-database/${id}/data-connections`);
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
      const r = await clientFetch(`/api/azure/resources?type=${encodeURIComponent(ARM_TYPE_BY_KIND[kind])}`);
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
      const r = await clientFetch(`/api/azure/iothub/policies?iotHubId=${encodeURIComponent(sourceId)}`);
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
      const r = await clientFetch(`/api/items/kql-database/${id}/data-connections`, {
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
      const r = await clientFetch(`/api/items/kql-database/${id}/data-connections`, {
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
        { label: 'Analyze', actions: [
          { label: 'Detect anomalies', onClick: () => openAnomaly('anomaly'), title: 'Native-KQL time-series anomaly detection (series_decompose_anomalies) over a table' },
          { label: 'Forecast', onClick: () => openAnomaly('forecast'), title: 'Native-KQL time-series forecasting (series_decompose_forecast) over a table' },
        ]},
      ]},
    ];
  }, [openWizard, openFnEditor, openDcWizard, openRlsEditor, openAnomaly, info?.isFollower, info?.tables]);

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

          {/* Anomaly detection / forecasting — native KQL time-series ML over ADX */}
          <AnomalyForecastDialog
            open={anomalyOpen}
            onOpenChange={setAnomalyOpen}
            itemId={id}
            database={info?.database}
            tables={(info?.tables ?? []).map((t) => t.name)}
            defaultTable={anomalyTable}
            defaultMode={anomalyMode}
          />
        </div>
      }
    />
  );
}
