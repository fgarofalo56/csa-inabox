'use client';

/**
 * AdxDatabaseTree — the Azure Data Explorer / Fabric Eventhouse "KQL database"
 * object navigator.
 *
 * The Kusto equivalent of the Synapse Workspace Resources / Databricks
 * workspace navigators. Once a KQL database editor is open, this left pane is
 * a typed navigator of the database's objects: one group per object type with
 * a live count and a ＋ New affordance, a filter box, inline delete, and an
 * "open" (load into the query editor) action — matching the ADX web UI / Fabric
 * KQL database schema tree with the Loom theme applied.
 *
 * Every count comes from a real Kusto control command; every create/delete is a
 * real `.create` / `.drop` posted to `/v1/rest/mgmt` through the workspace BFF
 * routes (all item-scoped via `?id=<kql-database item id>`):
 *   - Tables              → /api/adx/tables               (.show tables details / .create table / .drop table)
 *   - Functions           → /api/adx/functions            (.show functions / .create-or-alter function / .drop function)
 *   - Materialized views  → /api/adx/materialized-views   (.show materialized-views / .create materialized-view / .drop)
 *   - Ingestion mappings  → /api/adx/ingestion-mappings   (.show ingestion mappings / .create-or-alter ... mapping / .drop)
 *   - External tables     → /api/adx/external-tables       (.show external tables / .create-or-alter external table / .drop external table)
 *   - Row-level security  → /api/adx/rls                  (.show / .alter table T policy row_level_security — authored inline or via the parent editor)
 *   - Update policy       → /api/adx/policies (POST)       (.alter table T policy update — transform-on-ingest ETL)
 *   - Retention/caching   → /api/adx/policy-authoring (POST) (.alter table|database policy retention|caching — real authoring dialogs)
 *   - Continuous export   → /api/adx/continuous-exports    (.show / .create-or-alter / .drop continuous-export — create/edit/drop)
 *   - Database schema     → /api/adx/overview             (.show database schema as json — read-only)
 *   - Database policies   → /api/adx/policies             (.show database <db> policy <kind> — current values, display)
 *
 * Retention/caching policy *authoring* (`.alter table|database policy …`, from
 * the Policies group's ⚙ menu) and continuous-export *authoring* (`.create-or-alter`
 * / `.drop continuous-export`, from the Continuous export group's ＋ / row
 * actions) are fully wired — the same authoring the ADX portal / Fabric RTI
 * dialogs perform. A principal lacking Database Admin gets the cluster's
 * 403/Forbidden surfaced as an honest "needs Database Admin" MessageBar in the
 * dialog. No mocks.
 *
 * The database is resolved per kql-database item; when the cluster env var
 * (LOOM_KUSTO_CLUSTER_URI) is unset the routes 503 and the whole tree shows a
 * single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option, Textarea, Switch,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular, Edit16Regular,
  DocumentTable20Regular, Table20Regular, MathFormula20Regular,
  ArrowImport20Regular, Open16Regular, Search20Regular,
  Database20Regular, DataUsage20Regular, ShieldKeyhole20Regular,
  DataHistogram16Regular, Code16Regular, ChartMultiple16Regular,
  ShieldKeyhole16Regular, CloudLink20Regular, Settings16Regular,
} from '@fluentui/react-icons';
import { IngestionMappingWizardDialog } from './ingestion-mapping-wizard';
import {
  ColumnGridDesigner, toKustoSchema, parseKustoSchema,
} from './column-grid-designer';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalS, height: '100%', minWidth: '248px',
  },
  header: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, justifyContent: 'space-between' },
  headerActions: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXXS },
  title: {
    fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300,
    display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXXS,
    minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  groupLayout: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalSNudge, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXXS },
  leafRow: { display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXS, width: '100%', minWidth: 0 },
  leafLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  clickable: {
    cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    borderRadius: tokens.borderRadiusSmall,
    ':hover': { textDecorationLine: 'underline', color: tokens.colorBrandForeground1 },
    ':focus-visible': {
      outlineWidth: tokens.strokeWidthThick,
      outlineStyle: 'solid',
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: '1px',
    },
  },
  leafActions: {
    marginLeft: 'auto', display: 'flex', alignItems: 'center', columnGap: tokens.spacingHorizontalXXS, flexShrink: 0,
  },
  treeScroll: { overflowY: 'auto', overflowX: 'hidden', flex: '1 1 auto' },
  spinnerBox: { padding: tokens.spacingVerticalS },
  muted: { color: tokens.colorNeutralForeground3 },
  dialogStack: { display: 'flex', flexDirection: 'column', rowGap: tokens.spacingVerticalSNudge },
  kqlInput: { fontFamily: tokens.fontFamilyMonospace },
  surfaceSm: { maxWidth: '480px' },
  surfaceMd: { maxWidth: '560px' },
  surfaceLg: { maxWidth: '620px' },
  inlineRow: { display: 'flex', alignItems: 'flex-end', columnGap: tokens.spacingHorizontalS },
  grow: { flex: '1 1 auto', minWidth: 0 },
});

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface TableRow { name: string; totalRowCount?: number; totalExtentSizeMb?: number; folder?: string }
interface FnRow { name: string; parameters?: string; body?: string; folder?: string }
interface MvRow { name: string; sourceTable?: string }
interface MapRow { name: string; kind: string; table?: string; mapping?: string }
interface ExportRow { name: string; externalTableName?: string; isRunning?: boolean; isDisabled?: boolean; lastRunResult?: string; query?: string; intervalBetweenRuns?: string }
interface PolicyRow { kind: string; policy?: unknown; raw?: string }
interface ExtTableRow { name: string; tableType?: string; folder?: string; docString?: string }

/** Export-capable Azure-Storage external-table formats (Microsoft Learn). */
const EXTERNAL_TABLE_FORMATS = ['csv', 'tsv', 'json', 'parquet'] as const;

// Functions are authored through the structured stored-function editor
// (onEditFunction) and ingestion mappings through their own wizard, so the
// generic create dialog only carries table + materialized-view.
type CreatableGroup = 'table' | 'mv';

export interface AdxDatabaseTreeProps {
  /** The bound kql-database item id (so routes resolve the right database). */
  itemId: string;
  /** Load a query into the editor when a leaf is opened (e.g. `["T"] | take 100`). */
  onOpenQuery?: (kql: string) => void;
  /**
   * Open the structured stored-function editor (params grid + KQL body) owned by
   * the parent KQL database editor. Called with no argument for a fresh create,
   * or with the selected function (name/parameters/body) to edit-in-place.
   * Function create/edit/delete is funnelled through this single editor so the
   * navigator never carries a divergent raw-args function form.
   */
  onEditFunction?: (fn?: { name: string; parameters?: string; body?: string }) => void;
  /** Open the parent's schema designer in ALTER mode for an existing table.
   *  When omitted the tree hides the per-table "Edit schema" affordance. */
  onAlterTable?: (tableName: string) => void;
  /** Open the parent's drop-confirm flow for a table. When omitted the tree
   *  falls back to its own inline confirm dialog. */
  onDropTable?: (tableName: string) => void;
  /** Increment to force a refresh from the parent (e.g. after an external create). */
  refreshKey?: number;
  /** Called when the user clicks "Get data" on a table. Parent opens the ingest wizard pre-filled. */
  onGetData?: (tableName: string) => void;
  /** Called when the user clicks "Create dashboard" on a table. Parent creates + navigates. */
  onCreateDashboard?: (tableName: string) => void;
  /**
   * Called when the user clicks the per-table Row-Level Security shield. When
   * provided, the parent owns the RLS editor (e.g. KqlDatabaseEditor's drawer);
   * when omitted the tree opens its own inline RLS dialog so the navigator is
   * fully functional standalone.
   */
  onEditRls?: (tableName: string) => void;
}

/**
 * KQL data-profile query for a table.
 * Mirrors the ADX web UI "Data profile" action (hot-cache row/time statistics).
 * Uses ingestion_time() — a built-in ADX scalar that returns the extent-level
 * ingestion timestamp; zero network cost, runs on hot-cache extents only.
 * Ref: https://learn.microsoft.com/azure/data-explorer/kusto/query/ingestiontimefunction
 */
function dataProfileKql(table: string): string {
  const q = `["${table}"]`;
  return [
    `// ── Data profile: ${table} ────────────────────────────────────────`,
    `// Based on ADX hot-cache data. Mirrors the "Data profile" side panel`,
    `// in the Azure Data Explorer and Fabric Eventhouse web UIs.`,
    `${q}`,
    `| summarize`,
    `    TotalRows       = count(),`,
    `    OldestIngestion = tostring(min(ingestion_time())),`,
    `    NewestIngestion = tostring(max(ingestion_time())),`,
    `    Last24hRows     = countif(ingestion_time() >= ago(24h)),`,
    `    Last7dRows      = countif(ingestion_time() >= ago(7d)),`,
    `    Last30dRows     = countif(ingestion_time() >= ago(30d))`,
    `| extend Table = "${table}", ProfiledAt = now()`,
  ].join('\n');
}

/**
 * KQL insert-script template for a table.
 * Mirrors the ADX web UI "Insert script" context-menu item which emits a
 * .ingest inline command template the user fills in.
 * Ref: https://learn.microsoft.com/kusto/management/data-ingestion/ingest-inline
 */
function insertScriptKql(table: string): string {
  return [
    `// ── Insert script: ${table} ────────────────────────────────────────`,
    `// Inline CSV ingest — for small payloads (≤1 MB) or ad-hoc rows.`,
    `// For larger files or continuous ingest, use the "Get data" wizard.`,
    `.ingest inline into table ["${table}"] <|`,
    `// Replace with your CSV rows (no header, one row per line):`,
    `// col1,col2,col3`,
    `// val1,val2,val3`,
  ].join('\n');
}

/**
 * Best-effort parse of an `IntervalBetweenRuns` timespan (returned by
 * `.show continuous-exports` as `hh:mm:ss` or `d.hh:mm:ss`, or a KQL literal)
 * into a {value, unit} pair for the edit dialog's structured interval input.
 */
function parseIntervalParts(raw?: string): { value: string; unit: 'm' | 'h' | 'd' } {
  const str = (raw || '').trim();
  let m = str.match(/^(\d+)([smhd])$/);
  if (m) return { value: m[1], unit: (m[2] === 's' ? 'm' : (m[2] as 'm' | 'h' | 'd')) };
  m = str.match(/^(\d+)\.(\d{2}):(\d{2}):(\d{2})$/); // d.hh:mm:ss
  if (m) {
    const days = parseInt(m[1], 10);
    if (days > 0) return { value: String(days), unit: 'd' };
    const hh = parseInt(m[2], 10);
    if (hh > 0) return { value: String(hh), unit: 'h' };
    return { value: String(Math.max(parseInt(m[3], 10), 1)), unit: 'm' };
  }
  m = str.match(/^(\d{2}):(\d{2}):(\d{2})$/); // hh:mm:ss
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh > 0 && mm === 0) return { value: String(hh), unit: 'h' };
    if (hh > 0) return { value: String(hh * 60 + mm), unit: 'm' };
    return { value: String(Math.max(mm, 1)), unit: 'm' };
  }
  return { value: '1', unit: 'h' };
}

/** Find the first known table name referenced in a continuous-export query
 *  (bracket-quoted or bare), so the edit dialog can prefill the `over` source. */
function inferSourceTable(query: string | undefined, tables: { name: string }[]): string {
  const q = query || '';
  for (const t of tables) {
    const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)`).test(q)) return t.name;
  }
  return '';
}

/** A typed, ADX/Fabric-faithful KQL database object navigator. */
export function AdxDatabaseTree({ itemId, onOpenQuery, onEditFunction, onAlterTable, onDropTable, refreshKey = 0, onGetData, onCreateDashboard, onEditRls }: AdxDatabaseTreeProps) {
  const s = useStyles();

  const idq = `id=${encodeURIComponent(itemId)}`;
  const TABLES = `/api/adx/tables?${idq}`;
  const FUNCTIONS = `/api/adx/functions?${idq}`;
  const MVIEWS = `/api/adx/materialized-views?${idq}`;
  const MAPPINGS = `/api/adx/ingestion-mappings?${idq}`;
  const OVERVIEW = `/api/adx/overview?${idq}`;
  const POLICIES = `/api/adx/policies?${idq}`;
  const EXTERNAL = `/api/adx/external-tables?${idq}`;
  const POLICY_AUTHORING = `/api/adx/policy-authoring?${idq}`;
  const CONTINUOUS_EXPORTS = `/api/adx/continuous-exports?${idq}`;

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [database, setDatabase] = useState<string>('');
  const [tables, setTables] = useState<TableRow[]>([]);
  const [functions, setFunctions] = useState<FnRow[]>([]);
  const [mviews, setMviews] = useState<MvRow[]>([]);
  const [mappings, setMappings] = useState<MapRow[]>([]);
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [extTables, setExtTables] = useState<ExtTableRow[]>([]);

  // ---- external-table create dialog (structured; no raw KQL) ----
  const [extOpen, setExtOpen] = useState(false);
  const [extName, setExtName] = useState('');
  const [extKind, setExtKind] = useState<'delta' | 'storage'>('delta');
  const [extUri, setExtUri] = useState('');
  const [extSchema, setExtSchema] = useState('ts:datetime, tenant:string, value:long');
  const [extFormat, setExtFormat] = useState<typeof EXTERNAL_TABLE_FORMATS[number]>('parquet');
  const [extMi, setExtMi] = useState('');
  const [extHotDays, setExtHotDays] = useState('');
  const [extError, setExtError] = useState<string | null>(null);
  const [extDropTarget, setExtDropTarget] = useState<string | null>(null);

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreatableGroup | null>(null);
  const [cName, setCName] = useState('');
  const [cSchema, setCSchema] = useState('ts:datetime, tenant:string, value:long');
  const [cSource, setCSource] = useState('');
  const [cQuery, setCQuery] = useState('');
  const [cBackfill, setCBackfill] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Ingestion mapping is authored by its own two-step wizard (auto-detect grid),
  // not the generic create dialog above.
  const [mappingWizOpen, setMappingWizOpen] = useState(false);

  // ---- inline drop-confirm dialog (used when the parent doesn't own drop) ----
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // ---- inline Row-Level Security dialog (used when the parent doesn't own RLS) ----
  const [rlsTarget, setRlsTarget] = useState<string | null>(null);
  const [rlsEnabled, setRlsEnabled] = useState(false);
  const [rlsQuery, setRlsQuery] = useState('');
  const [rlsLoading, setRlsLoading] = useState(false);
  const [rlsBusy, setRlsBusy] = useState(false);
  const [rlsError, setRlsError] = useState<string | null>(null);
  const [rlsNotice, setRlsNotice] = useState<string | null>(null);

  // ---- continuous-export create/edit dialog + drop-confirm ----
  const [ceOpen, setCeOpen] = useState(false);
  const [ceEditing, setCeEditing] = useState<string | null>(null);
  const [ceName, setCeName] = useState('');
  const [ceSource, setCeSource] = useState('');
  const [ceTarget, setCeTarget] = useState('');
  const [ceIntervalValue, setCeIntervalValue] = useState('1');
  const [ceIntervalUnit, setCeIntervalUnit] = useState<'m' | 'h' | 'd'>('h');
  const [ceQuery, setCeQuery] = useState('');
  const [ceBusy, setCeBusy] = useState(false);
  const [ceError, setCeError] = useState<string | null>(null);
  const [ceNotice, setCeNotice] = useState<string | null>(null);
  const [ceDropTarget, setCeDropTarget] = useState<string | null>(null);

  // ---- retention policy dialog (table | database scope) ----
  const [retOpen, setRetOpen] = useState(false);
  const [retScope, setRetScope] = useState<'database' | 'table'>('database');
  const [retTable, setRetTable] = useState('');
  const [retDays, setRetDays] = useState('365');
  const [retRecoverability, setRetRecoverability] = useState(true);
  const [retBusy, setRetBusy] = useState(false);
  const [retError, setRetError] = useState<string | null>(null);
  const [retNotice, setRetNotice] = useState<string | null>(null);

  // ---- caching policy dialog (table | database scope) ----
  const [cacheOpen, setCacheOpen] = useState(false);
  const [cacheScope, setCacheScope] = useState<'database' | 'table'>('database');
  const [cacheTable, setCacheTable] = useState('');
  const [cacheValue, setCacheValue] = useState('31');
  const [cacheUnit, setCacheUnit] = useState<'h' | 'd'>('d');
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);

  const RLS = `/api/adx/rls?${idq}`;

  const openRls = useCallback(async (tableName: string) => {
    // Parent-owned editor wins (e.g. KqlDatabaseEditor drawer).
    if (onEditRls) { onEditRls(tableName); return; }
    setRlsTarget(tableName); setRlsError(null); setRlsNotice(null);
    setRlsEnabled(false); setRlsQuery(''); setRlsLoading(true);
    try {
      const body = await fetch(`${RLS}&table=${encodeURIComponent(tableName)}`).then(readJson);
      if (applyGate(body)) { setRlsLoading(false); setRlsTarget(null); return; }
      if (body.ok && body.policy) {
        setRlsEnabled(!!body.policy.isEnabled);
        setRlsQuery(body.policy.query || '');
      }
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsLoading(false);
    }
  }, [onEditRls, RLS]);

  const submitRls = useCallback(async () => {
    if (!rlsTarget) return;
    setRlsBusy(true); setRlsError(null); setRlsNotice(null);
    try {
      const res = await fetch(`/api/adx/rls?${idq}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: rlsTarget, enabled: rlsEnabled, query: rlsQuery }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setRlsBusy(false); return; }
      if (!body.ok) { setRlsError(body.error || 'failed to set RLS policy'); setRlsBusy(false); return; }
      setRlsNotice(
        `RLS ${body.policy?.isEnabled ? 'enabled' : 'disabled'} on ${rlsTarget}.` +
        (body.warning ? ` Warning: ${body.warning}` : ''),
      );
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsBusy(false);
    }
  }, [rlsTarget, rlsEnabled, rlsQuery, idq]);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [tr, fr, mr, ir, or, pr, er] = await Promise.all([
        fetch(TABLES).then(readJson),
        fetch(FUNCTIONS).then(readJson),
        fetch(MVIEWS).then(readJson),
        fetch(MAPPINGS).then(readJson),
        fetch(OVERVIEW).then(readJson),
        fetch(POLICIES).then(readJson),
        fetch(EXTERNAL).then(readJson),
      ]);
      for (const b of [tr, fr, mr, ir, or, pr, er]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (tr.ok) { setTables(tr.tables || []); setDatabase(tr.database || ''); }
      else setError(tr.error || 'failed to list tables');
      if (fr.ok) setFunctions(fr.functions || []);
      if (mr.ok) setMviews(mr.materializedViews || []);
      if (ir.ok) setMappings(ir.mappings || []);
      if (or.ok) setExports(or.continuousExports || []);
      if (pr.ok) setPolicies(pr.policies || []);
      if (er.ok) setExtTables(er.externalTables || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [TABLES, FUNCTIONS, MVIEWS, MAPPINGS, OVERVIEW, POLICIES, EXTERNAL]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete (real control commands)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreatableGroup) => {
    setCreateGroup(g); setCreateError(null);
    setCName(''); setCSchema('ts:datetime, tenant:string, value:long');
    setCSource(tables[0]?.name || ''); setCQuery(''); setCBackfill(false);
  }, [tables]);

  const submitCreate = useCallback(async () => {
    if (!createGroup || !cName.trim()) return;
    setBusy(true); setCreateError(null);
    const name = cName.trim();
    try {
      let route = TABLES; let payload: any = {};
      if (createGroup === 'table') { route = TABLES; payload = { name, schema: cSchema }; }
      else if (createGroup === 'mv') { route = MVIEWS; payload = { name, sourceTable: cSource, query: cQuery, backfill: cBackfill }; }
      const res = await fetch(route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setCreateError(body.error || 'create failed'); setBusy(false); return; }
      setCreateGroup(null);
      await loadAll();
    } catch (e: any) {
      setCreateError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [createGroup, cName, cSchema, cSource, cQuery, cBackfill, TABLES, MVIEWS, loadAll]);

  const del = useCallback(async (route: string, query: string) => {
    setBusy(true); setError(null);
    try {
      const sep = route.includes('?') ? '&' : '?';
      const res = await fetch(`${route}${sep}${query}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'delete failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const openExtCreate = useCallback(() => {
    setExtOpen(true); setExtError(null);
    setExtName(''); setExtKind('delta'); setExtUri('');
    setExtSchema('ts:datetime, tenant:string, value:long');
    setExtFormat('parquet'); setExtMi(''); setExtHotDays('');
  }, []);

  const submitExtCreate = useCallback(async () => {
    const name = extName.trim();
    if (!name || !extUri.trim()) return;
    setBusy(true); setExtError(null);
    try {
      const payload: any = { name, kind: extKind, abfssUri: extUri.trim() };
      if (extKind === 'storage') { payload.schema = extSchema; payload.dataFormat = extFormat; }
      if (extMi.trim()) payload.miObjectId = extMi.trim();
      const hot = parseInt(extHotDays, 10);
      if (Number.isFinite(hot) && hot >= 1) payload.queryAccelerationHotDays = hot;
      const res = await fetch(EXTERNAL, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setExtError(body.error || 'create failed'); setBusy(false); return; }
      setExtOpen(false);
      await loadAll();
    } catch (e: any) {
      setExtError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [extName, extKind, extUri, extSchema, extFormat, extMi, extHotDays, EXTERNAL, loadAll]);

  // ---------------------------------------------------------------
  // Policy + continuous-export authoring (real .alter / .create-or-alter)
  // ---------------------------------------------------------------
  /** Turn a 403/Forbidden from the cluster into the honest Database-Admin gate. */
  const describeAdminError = useCallback((status: number, msg: string): string => {
    const forbidden = status === 403 ||
      /forbidden|unauthorized|not authorized|permission|access denied|principal .*(isn'?t|not) authorized/i.test(msg || '');
    if (forbidden) {
      return `Needs Database Admin on ${database || 'this database'}. The signed-in principal (or the Loom Console UAMI) lacks it — grant Database Admin (add the principal to the database "admins" role, or AllDatabasesAdmin on the cluster) and retry. Cluster said: ${msg}`;
    }
    return msg;
  }, [database]);

  const openRetention = useCallback(() => {
    setRetOpen(true); setRetError(null); setRetNotice(null);
    setRetScope('database'); setRetTable(tables[0]?.name || '');
    setRetDays('365'); setRetRecoverability(true);
  }, [tables]);

  const submitRetention = useCallback(async () => {
    setRetBusy(true); setRetError(null); setRetNotice(null);
    try {
      const res = await fetch(POLICY_AUTHORING, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'retention', scope: retScope,
          table: retScope === 'table' ? retTable : undefined,
          softDeleteDays: parseInt(retDays, 10),
          recoverability: retRecoverability ? 'Enabled' : 'Disabled',
        }),
      });
      const b = await readJson(res);
      if (applyGate(b)) { setRetBusy(false); return; }
      if (!b.ok) { setRetError(describeAdminError(res.status, b.error || 'failed to set retention policy')); setRetBusy(false); return; }
      setRetNotice(`Retention policy applied on ${retScope === 'table' ? retTable : (database || 'the database')}.`);
      await loadAll();
    } catch (e: any) { setRetError(e?.message || String(e)); }
    finally { setRetBusy(false); }
  }, [POLICY_AUTHORING, retScope, retTable, retDays, retRecoverability, database, loadAll, describeAdminError]);

  const openCaching = useCallback(() => {
    setCacheOpen(true); setCacheError(null); setCacheNotice(null);
    setCacheScope('database'); setCacheTable(tables[0]?.name || '');
    setCacheValue('31'); setCacheUnit('d');
  }, [tables]);

  const submitCaching = useCallback(async () => {
    setCacheBusy(true); setCacheError(null); setCacheNotice(null);
    try {
      const res = await fetch(POLICY_AUTHORING, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'caching', scope: cacheScope,
          table: cacheScope === 'table' ? cacheTable : undefined,
          hotValue: parseInt(cacheValue, 10), hotUnit: cacheUnit,
        }),
      });
      const b = await readJson(res);
      if (applyGate(b)) { setCacheBusy(false); return; }
      if (!b.ok) { setCacheError(describeAdminError(res.status, b.error || 'failed to set caching policy')); setCacheBusy(false); return; }
      setCacheNotice(`Hot-cache policy set to ${parseInt(cacheValue, 10)}${cacheUnit} on ${cacheScope === 'table' ? cacheTable : (database || 'the database')}.`);
      await loadAll();
    } catch (e: any) { setCacheError(e?.message || String(e)); }
    finally { setCacheBusy(false); }
  }, [POLICY_AUTHORING, cacheScope, cacheTable, cacheValue, cacheUnit, database, loadAll, describeAdminError]);

  const openCeCreate = useCallback(() => {
    setCeOpen(true); setCeEditing(null); setCeError(null); setCeNotice(null);
    setCeName(''); setCeSource(tables[0]?.name || ''); setCeTarget(extTables[0]?.name || '');
    setCeIntervalValue('1'); setCeIntervalUnit('h'); setCeQuery('');
  }, [tables, extTables]);

  const openCeEdit = useCallback((ce: ExportRow) => {
    setCeOpen(true); setCeEditing(ce.name); setCeError(null); setCeNotice(null);
    setCeName(ce.name);
    setCeTarget(ce.externalTableName || extTables[0]?.name || '');
    const { value, unit } = parseIntervalParts(ce.intervalBetweenRuns);
    setCeIntervalValue(value); setCeIntervalUnit(unit);
    setCeQuery(ce.query || '');
    setCeSource(inferSourceTable(ce.query, tables) || tables[0]?.name || '');
  }, [tables, extTables]);

  const submitCe = useCallback(async () => {
    const name = ceName.trim();
    if (!name || !ceSource || !ceTarget) return;
    setCeBusy(true); setCeError(null); setCeNotice(null);
    try {
      const res = await fetch(CONTINUOUS_EXPORTS, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name, sourceTable: ceSource, externalTable: ceTarget,
          interval: `${ceIntervalValue}${ceIntervalUnit}`,
          query: ceQuery.trim() || undefined,
        }),
      });
      const b = await readJson(res);
      if (applyGate(b)) { setCeBusy(false); return; }
      if (!b.ok) { setCeError(describeAdminError(res.status, b.error || 'failed to save continuous export')); setCeBusy(false); return; }
      setCeOpen(false);
      await loadAll();
    } catch (e: any) { setCeError(e?.message || String(e)); }
    finally { setCeBusy(false); }
  }, [ceName, ceSource, ceTarget, ceIntervalValue, ceIntervalUnit, ceQuery, CONTINUOUS_EXPORTS, loadAll, describeAdminError]);

  const dropCe = useCallback(async (name: string) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${CONTINUOUS_EXPORTS}&name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const b = await readJson(res);
      if (applyGate(b)) { setBusy(false); return; }
      if (!b.ok) { setError(describeAdminError(res.status, b.error || 'drop failed')); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [CONTINUOUS_EXPORTS, loadAll, describeAdminError]);

  // ---------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fTables = useMemo(() => tables.filter((t) => match(t.name)), [tables, f]);
  const fFns = useMemo(() => functions.filter((x) => match(x.name)), [functions, f]);
  const fMvs = useMemo(() => mviews.filter((x) => match(x.name)), [mviews, f]);
  const fMaps = useMemo(() => mappings.filter((x) => match(x.name)), [mappings, f]);
  const fExports = useMemo(() => exports.filter((x) => match(x.name)), [exports, f]);
  const fPolicies = useMemo(() => policies.filter((x) => match(x.kind)), [policies, f]);
  const fExtTables = useMemo(() => extTables.filter((x) => match(x.name)), [extTables, f]);

  const openQuery = (kql: string) => onOpenQuery?.(kql);

  const groupHeader = (
    label: string, icon: React.ReactElement, count: number,
    onAdd?: () => void, addTitle?: string, shown?: number, extra?: React.ReactNode,
  ) => {
    // When a filter is active and hides some rows, show "matched / total".
    const filtered = f && typeof shown === 'number' && shown !== count;
    return (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label}</span>
        <Badge
          size="small"
          appearance="tint"
          color={filtered ? 'brand' : 'informative'}
          aria-label={filtered ? `${shown} of ${count} ${label}` : `${count} ${label}`}
        >
          {filtered ? `${shown}/${count}` : count}
        </Badge>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {extra}
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
    );
  };

  if (gate) {
    return (
      <div className={s.root}>
        <div className={s.header}><span className={s.title}>KQL database</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>ADX cluster not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> so the Loom console can reach a real Azure Data Explorer /
            Fabric Eventhouse cluster (the Kusto data plane at{' '}
            <code>https://&lt;cluster&gt;.&lt;region&gt;.kusto.&lt;cloud-suffix&gt;</code>). The navigator stays here; objects
            appear once the cluster is reachable. The Loom UAMI needs at least{' '}
            <strong>Database Admin</strong> (or <strong>AllDatabasesAdmin</strong> on the cluster) to
            create/drop tables, functions, materialized views, and ingestion mappings.
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>{database ? <>KQL database · <code>{database}</code></> : 'KQL database'}</span>
        <span className={s.headerActions}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="New" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="New object" />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<DocumentTable20Regular />} onClick={() => openCreate('table')}>Table</MenuItem>
                <MenuItem icon={<MathFormula20Regular />} onClick={() => onEditFunction?.()}>Function</MenuItem>
                <MenuItem icon={<Table20Regular />} onClick={() => openCreate('mv')}>Materialized view</MenuItem>
                <MenuItem icon={<CloudLink20Regular />} onClick={openExtCreate}>External table</MenuItem>
                <MenuItem icon={<ArrowImport20Regular />} onClick={() => setMappingWizOpen(true)}>Ingestion mapping</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <Tooltip content="Refresh" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={loadAll} disabled={loading} aria-label="Refresh database objects" />
          </Tooltip>
        </span>
      </div>

      <Field>
        <Input
          size="small"
          contentBefore={<Search20Regular />}
          placeholder="Filter objects by name"
          value={filter}
          onChange={(_, d) => setFilter(d.value)}
        />
      </Field>

      {loading && <div className={s.spinnerBox}><Spinner size="tiny" label="Loading database objects…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Database error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div className={s.treeScroll}>
        <Tree aria-label="KQL database objects" defaultOpenItems={['g-tables']}>
          {/* Tables */}
          <TreeItem itemType="branch" value="g-tables">
            {groupHeader('Tables', <DocumentTable20Regular />, tables.length, () => openCreate('table'), 'New table', fTables.length)}
            <Tree>
              {fTables.length === 0 && <TreeItem itemType="leaf" value="t-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No tables yet'}</Caption1></TreeItemLayout></TreeItem>}
              {fTables.map((t) => (
                <TreeItem key={t.name} itemType="leaf" value={`t-${t.name}`}>
                  <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0} className={s.clickable}
                        onClick={() => openQuery(`["${t.name}"]\n| take 100`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`["${t.name}"]\n| take 100`); } }}
                      >{t.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof t.totalRowCount === 'number' && <Caption1>{t.totalRowCount.toLocaleString()} rows</Caption1>}
                        {/* 1. Data profile — runs ADX hot-cache statistics query in the editor */}
                        <Tooltip content="Data profile" relationship="label"><Button size="small" appearance="subtle" icon={<DataHistogram16Regular />} onClick={() => openQuery(dataProfileKql(t.name))} aria-label={`Data profile for ${t.name}`} /></Tooltip>
                        {/* 2. Explore data — take 100, same as clicking the table name */}
                        <Tooltip content="Explore data" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`["${t.name}"]\n| take 100`)} aria-label={`Explore ${t.name}`} /></Tooltip>
                        {/* 3. Insert script — .ingest inline template loaded into the editor */}
                        <Tooltip content="Insert script" relationship="label"><Button size="small" appearance="subtle" icon={<Code16Regular />} onClick={() => openQuery(insertScriptKql(t.name))} aria-label={`Insert script for ${t.name}`} /></Tooltip>
                        {/* 4. Get data — opens the parent's ingest wizard pre-filled with this table */}
                        <Tooltip content={onGetData ? 'Get data' : 'Get data (mount via KqlDatabaseEditor)'} relationship="label"><Button size="small" appearance="subtle" icon={<ArrowImport20Regular />} disabled={!onGetData} onClick={() => onGetData?.(t.name)} aria-label={`Get data into ${t.name}`} /></Tooltip>
                        {/* 5. Create dashboard — creates a kql-dashboard with a starter tile for this table */}
                        <Tooltip content={onCreateDashboard ? 'Create dashboard' : 'Create dashboard (mount via KqlDatabaseEditor)'} relationship="label"><Button size="small" appearance="subtle" icon={<ChartMultiple16Regular />} disabled={!onCreateDashboard} onClick={() => onCreateDashboard?.(t.name)} aria-label={`Create dashboard from ${t.name}`} /></Tooltip>
                        {/* 6. Edit schema — .alter-merge table via the parent's schema editor */}
                        {onAlterTable && (
                          <Tooltip content="Edit schema (.alter-merge table)" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={busy} onClick={() => onAlterTable(t.name)} aria-label={`Edit schema of ${t.name}`} /></Tooltip>
                        )}
                        {/* 7. Row-level security — .alter table T policy row_level_security (parent-owned editor or inline dialog) */}
                        <Tooltip content="Row-level security" relationship="label"><Button size="small" appearance="subtle" icon={<ShieldKeyhole16Regular />} disabled={busy} onClick={() => openRls(t.name)} aria-label={`Row-level security for ${t.name}`} /></Tooltip>
                        {/* 8. Delete table — parent-owned drop (with inline confirm fallback) or direct .drop table T ifexists */}
                        <Tooltip content="Delete table" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => { if (onDropTable) onDropTable(t.name); else setDropTarget(t.name); }} aria-label={`Drop ${t.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Functions */}
          <TreeItem itemType="branch" value="g-functions">
            {groupHeader('Functions', <MathFormula20Regular />, functions.length, () => onEditFunction?.(), 'New function', fFns.length)}
            <Tree>
              {fFns.length === 0 && <TreeItem itemType="leaf" value="fn-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No functions'}</Caption1></TreeItemLayout></TreeItem>}
              {fFns.map((fn) => (
                <TreeItem key={fn.name} itemType="leaf" value={`fn-${fn.name}`}>
                  <TreeItemLayout iconBefore={<MathFormula20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} className={s.clickable}
                        onClick={() => openQuery(`${fn.name}(${(fn.parameters || '').trim()})`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`${fn.name}(${(fn.parameters || '').trim()})`); } }}
                      >{fn.name}{fn.parameters ? <Caption1> ({fn.parameters})</Caption1> : null}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {onEditFunction && (
                          <Tooltip content="Edit function" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => onEditFunction(fn)} aria-label={`Edit ${fn.name}`} /></Tooltip>
                        )}
                        <Tooltip content="Drop function" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(FUNCTIONS, `name=${encodeURIComponent(fn.name)}`)} aria-label={`Drop ${fn.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Materialized views */}
          <TreeItem itemType="branch" value="g-mviews">
            {groupHeader('Materialized views', <Table20Regular />, mviews.length, () => openCreate('mv'), 'New materialized view', fMvs.length)}
            <Tree>
              {fMvs.length === 0 && <TreeItem itemType="leaf" value="mv-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No materialized views'}</Caption1></TreeItemLayout></TreeItem>}
              {fMvs.map((mv) => (
                <TreeItem key={mv.name} itemType="leaf" value={`mv-${mv.name}`}>
                  <TreeItemLayout iconBefore={<Table20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} className={s.clickable}
                        onClick={() => openQuery(`["${mv.name}"]\n| take 100`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`["${mv.name}"]\n| take 100`); } }}
                      >{mv.name}{mv.sourceTable ? <Caption1> · on {mv.sourceTable}</Caption1> : null}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Drop materialized view" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(MVIEWS, `name=${encodeURIComponent(mv.name)}`)} aria-label={`Drop ${mv.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* External tables */}
          <TreeItem itemType="branch" value="g-exttables">
            {groupHeader('External tables', <CloudLink20Regular />, extTables.length, openExtCreate, 'New external table', fExtTables.length)}
            <Tree>
              {fExtTables.length === 0 && <TreeItem itemType="leaf" value="ext-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No external tables'}</Caption1></TreeItemLayout></TreeItem>}
              {fExtTables.map((x) => (
                <TreeItem key={x.name} itemType="leaf" value={`ext-${x.name}`}>
                  <TreeItemLayout iconBefore={<CloudLink20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} className={s.clickable}
                        onClick={() => openQuery(`external_table("${x.name}")\n| take 100`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`external_table("${x.name}")\n| take 100`); } }}
                      >{x.name}{x.tableType ? <Caption1> · {x.tableType}</Caption1> : null}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Query external table" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`external_table("${x.name}")\n| take 100`)} aria-label={`Query ${x.name}`} /></Tooltip>
                        <Tooltip content="Drop external table" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => setExtDropTarget(x.name)} aria-label={`Drop external table ${x.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Ingestion mappings */}
          <TreeItem itemType="branch" value="g-mappings">
            {groupHeader('Ingestion mappings', <ArrowImport20Regular />, mappings.length, () => setMappingWizOpen(true), 'New ingestion mapping', fMaps.length)}
            <Tree>
              {fMaps.length === 0 && <TreeItem itemType="leaf" value="map-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No ingestion mappings'}</Caption1></TreeItemLayout></TreeItem>}
              {fMaps.map((m) => (
                <TreeItem key={`${m.kind}-${m.table || 'db'}-${m.name}`} itemType="leaf" value={`map-${m.kind}-${m.name}`}>
                  <TreeItemLayout iconBefore={<ArrowImport20Regular />}>
                    <span className={s.leafRow}>
                      <span className={s.leafLabel}>{m.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Badge size="small" appearance="outline">{m.kind}</Badge>
                        {m.table ? <Caption1>on {m.table}</Caption1> : <Caption1>db</Caption1>}
                        <Tooltip content="Drop mapping" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(MAPPINGS, `name=${encodeURIComponent(m.name)}&kind=${encodeURIComponent(m.kind)}${m.table ? `&table=${encodeURIComponent(m.table)}` : ''}`)} aria-label={`Drop mapping ${m.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Continuous export (authorable: create/edit/drop) */}
          <TreeItem itemType="branch" value="g-exports">
            {groupHeader('Continuous export', <DataUsage20Regular />, exports.length, openCeCreate, 'New continuous export', fExports.length)}
            <Tree>
              {fExports.length === 0 && (
                <TreeItem itemType="leaf" value="ce-empty">
                  <Tooltip content="A continuous export periodically writes new rows from a source table into an existing external table (.create-or-alter continuous-export). Create an external table first, then ＋ to author one. Requires Database Admin." relationship="description">
                    <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                      <Caption1 className={s.muted}>{f ? 'No matches' : 'No continuous exports — ＋ to create one over an external table'}</Caption1>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              )}
              {fExports.map((ce) => (
                <TreeItem key={ce.name} itemType="leaf" value={`ce-${ce.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <span className={s.leafRow}>
                      <span className={s.leafLabel}>{ce.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {ce.externalTableName && <Caption1>→ {ce.externalTableName}</Caption1>}
                        <Badge size="small" appearance="tint" color={ce.isDisabled ? 'warning' : ce.isRunning ? 'success' : 'informative'}>
                          {ce.isDisabled ? 'disabled' : ce.isRunning ? 'running' : (ce.lastRunResult || 'idle')}
                        </Badge>
                        <Tooltip content="Edit continuous export (.create-or-alter)" relationship="label"><Button size="small" appearance="subtle" icon={<Edit16Regular />} disabled={busy} onClick={() => openCeEdit(ce)} aria-label={`Edit continuous export ${ce.name}`} /></Tooltip>
                        <Tooltip content="Drop continuous export" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => setCeDropTarget(ce.name)} aria-label={`Drop continuous export ${ce.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Database policies (current values shown; retention/caching authorable via ⚙) */}
          <TreeItem itemType="branch" value="g-policies">
            {groupHeader('Policies', <ShieldKeyhole20Regular />, policies.length, undefined, undefined, fPolicies.length, (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Tooltip content="Author retention / caching policy" relationship="label">
                    <Button size="small" appearance="subtle" icon={<Settings16Regular />} aria-label="Author retention or caching policy" />
                  </Tooltip>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<DataHistogram16Regular />} onClick={openRetention}>Retention policy…</MenuItem>
                    <MenuItem icon={<DataUsage20Regular />} onClick={openCaching}>Caching policy…</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            ))}
            <Tree>
              {fPolicies.length === 0 && (
                <TreeItem itemType="leaf" value="pol-empty">
                  <Tooltip content="Database policies are read from .show database <db> policy <kind> (retention, caching, sharding, mergepolicy, streamingingestion). Author retention/caching (table or database scope) via the ⚙ menu above — real .alter policy commands, Database Admin required." relationship="description">
                    <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                      <span className={s.muted}>{f ? 'No matches' : 'No policies set — author via the ⚙ menu'}</span>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              )}
              {fPolicies.map((p) => (
                <TreeItem key={p.kind} itemType="leaf" value={`pol-${p.kind}`}>
                  <Tooltip content={p.raw || JSON.stringify(p.policy ?? {})} relationship="description">
                    <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                      <span className={s.leafRow}>
                        <span className={s.leafLabel}>{p.kind}</span>
                        <span className={s.leafActions}>
                          <Badge size="small" appearance="tint" color="informative">read-only</Badge>
                        </span>
                      </span>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Database schema (read-only export to the query editor) */}
          <TreeItem itemType="branch" value="g-schema">
            <TreeItemLayout iconBefore={<Database20Regular />}>Database schema</TreeItemLayout>
            <Tree>
              <TreeItem itemType="leaf" value="schema-show">
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  <span role="button" tabIndex={0} className={s.clickable}
                    onClick={() => openQuery('.show database schema')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery('.show database schema'); } }}
                  >Show full schema (.show database schema)</span>
                </TreeItemLayout>
              </TreeItem>
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Inline drop-confirm dialog (fallback when the parent doesn't own drop) */}
      <Dialog open={dropTarget !== null} onOpenChange={(_, d) => { if (!d.open) setDropTarget(null); }}>
        <DialogSurface className={s.surfaceSm}>
          <DialogBody>
            <DialogTitle>Drop table {dropTarget}?</DialogTitle>
            <DialogContent>
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>This cannot be undone</MessageBarTitle>
                  Permanently deletes <strong>{dropTarget}</strong> and all its data via{' '}
                  <code>.drop table [&quot;{dropTarget}&quot;] ifexists</code>.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDropTarget(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={async () => {
                  const name = dropTarget;
                  if (!name) return;
                  setDropTarget(null);
                  await del(TABLES, `name=${encodeURIComponent(name)}`);
                }}
              >
                {busy ? 'Dropping…' : 'Drop table'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Row-Level Security dialog (inline; used when the parent doesn't own RLS) */}
      <Dialog open={rlsTarget !== null} onOpenChange={(_, d) => { if (!d.open) setRlsTarget(null); }}>
        <DialogSurface className={s.surfaceLg}>
          <DialogBody>
            <DialogTitle>Row-level security · {rlsTarget}</DialogTitle>
            <DialogContent>
              {rlsLoading ? <Spinner size="tiny" label="Loading RLS policy…" /> : (
                <div className={s.dialogStack}>
                  <MessageBar intent="info">
                    <MessageBarBody>
                      Sets <code>.alter table [&quot;{rlsTarget}&quot;] policy row_level_security</code>.
                      The query is a KQL predicate (or a stored-function call) that filters rows for the
                      calling principal — e.g.{' '}
                      <code>{rlsTarget} | where current_principal_is_member_of(&apos;aadgroup=analysts@contoso.com&apos;)</code>.
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
                      className={s.kqlInput}
                      placeholder={`${rlsTarget ?? 'T'} | where current_principal_is_member_of('aadgroup=analysts@contoso.com')`}
                    />
                  </Field>
                  <Caption1 className={s.muted}>
                    Test without affecting users in the query editor with{' '}
                    <code>set query_force_row_level_security;</code>.
                  </Caption1>
                  {rlsNotice && <MessageBar intent="success"><MessageBarBody>{rlsNotice}</MessageBarBody></MessageBar>}
                  {rlsError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RLS error</MessageBarTitle>{rlsError}</MessageBarBody></MessageBar>}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRlsTarget(null)} disabled={rlsBusy}>Close</Button>
              <Button appearance="primary" onClick={submitRls} disabled={rlsBusy || rlsLoading || (rlsEnabled && !rlsQuery.trim())}>
                {rlsBusy ? 'Applying…' : (rlsEnabled ? 'Enable RLS' : 'Disable RLS')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Create dialog */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface className={s.surfaceMd}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'table' ? 'table (.create table)'
                : 'materialized view (.create materialized-view)'}
            </DialogTitle>
            <DialogContent>
              <div className={s.dialogStack}>
                <Field label="Name" required>
                  <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="events" />
                </Field>

                {createGroup === 'table' && (
                  <Field label="Columns" required>
                    <ColumnGridDesigner
                      columns={parseKustoSchema(cSchema)}
                      onChange={(cols) => setCSchema(toKustoSchema(cols))}
                      disabled={busy}
                    />
                  </Field>
                )}

                {createGroup === 'mv' && (
                  <>
                    <Field label="Source table" required>
                      <Dropdown
                        placeholder={tables.length ? 'Select a source table' : 'No tables — create one first'}
                        value={cSource} selectedOptions={cSource ? [cSource] : []}
                        onOptionSelect={(_, d) => setCSource(d.optionValue || '')}
                        disabled={!tables.length}
                      >
                        {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Query (one row per group key)">
                      <Textarea value={cQuery} onChange={(_, d) => setCQuery(d.value)} rows={4} className={s.kqlInput} placeholder="events | summarize cnt = count() by bin(ts, 1d)" />
                    </Field>
                    <Field label="Backfill from existing data">
                      <Switch
                        label="async .create materialized-view with (backfill=true) — processes the source table's existing records"
                        checked={cBackfill}
                        onChange={(_, d) => setCBackfill(!!d.checked)}
                      />
                      {cBackfill && (
                        <Caption1 className={s.muted}>
                          Large tables may take minutes to hours; the view is unavailable for query until the backfill completes. Track with <code>.show operations</code>.
                        </Caption1>
                      )}
                    </Field>
                  </>
                )}

                {createError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{createError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCreateGroup(null)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitCreate} disabled={busy || !cName.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* External-table create dialog (structured; no raw KQL) */}
      <Dialog open={extOpen} onOpenChange={(_, d) => { if (!d.open) setExtOpen(false); }}>
        <DialogSurface className={s.surfaceLg}>
          <DialogBody>
            <DialogTitle>New external table (.create-or-alter external table)</DialogTitle>
            <DialogContent>
              <div className={s.dialogStack}>
                <MessageBar intent="info">
                  <MessageBarBody>
                    An external table references data in ADLS Gen2 / Blob without ingesting it.
                    <strong> Delta</strong> auto-infers the schema from the Delta log;
                    <strong> Storage</strong> needs an explicit schema + data format. Storage auth uses the
                    ADX cluster managed identity (<code>;managed_identity=system</code>) — the cluster MI needs
                    <strong> Storage Blob Data Reader</strong> on the account. Pure ADX ↔ ADLS Gen2 (no Fabric / OneLake).
                  </MessageBarBody>
                </MessageBar>
                <Field label="Name" required>
                  <Input value={extName} onChange={(_, d) => setExtName(d.value)} placeholder="bronze_events" />
                </Field>
                <Field label="Kind" required>
                  <Dropdown
                    value={extKind === 'delta' ? 'Delta (schema auto-inferred)' : 'Storage (explicit schema)'}
                    selectedOptions={[extKind]}
                    onOptionSelect={(_, d) => setExtKind((d.optionValue as 'delta' | 'storage') || 'delta')}
                  >
                    <Option value="delta" text="Delta (schema auto-inferred)">Delta (schema auto-inferred)</Option>
                    <Option value="storage" text="Storage (explicit schema)">Storage (explicit schema)</Option>
                  </Dropdown>
                </Field>
                <Field label="Storage URI (abfss://)" required hint="Operator supplies the correct cloud suffix (Commercial: dfs.core.windows.net · Gov: dfs.core.usgovcloudapi.net).">
                  <Input
                    value={extUri}
                    onChange={(_, d) => setExtUri(d.value)}
                    placeholder="abfss://container@account.dfs.core.windows.net/path"
                  />
                </Field>
                {extKind === 'storage' && (
                  <>
                    <Field label="Columns" required>
                      <ColumnGridDesigner
                        columns={parseKustoSchema(extSchema)}
                        onChange={(cols) => setExtSchema(toKustoSchema(cols))}
                        disabled={busy}
                      />
                    </Field>
                    <Field label="Data format" required>
                      <Dropdown
                        value={extFormat}
                        selectedOptions={[extFormat]}
                        onOptionSelect={(_, d) => setExtFormat((d.optionValue as typeof EXTERNAL_TABLE_FORMATS[number]) || 'parquet')}
                      >
                        {EXTERNAL_TABLE_FORMATS.map((fmt) => <Option key={fmt} value={fmt} text={fmt}>{fmt}</Option>)}
                      </Dropdown>
                    </Field>
                  </>
                )}
                <Field label="User-assigned MI object id (optional)" hint="Leave blank to use the cluster system-assigned managed identity.">
                  <Input value={extMi} onChange={(_, d) => setExtMi(d.value)} placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
                <Field label="Query-acceleration hot days (optional)" hint="Caches recent data for sub-second KQL. Blank = no acceleration policy.">
                  <Input type="number" min={1} value={extHotDays} onChange={(_, d) => setExtHotDays(d.value)} placeholder="e.g. 7" />
                </Field>
                {extError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{extError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setExtOpen(false)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={submitExtCreate}
                disabled={busy || !extName.trim() || !extUri.trim() || (extKind === 'storage' && !extSchema.trim())}
              >
                {busy ? 'Creating…' : 'Create'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* External-table drop-confirm dialog */}
      <Dialog open={extDropTarget !== null} onOpenChange={(_, d) => { if (!d.open) setExtDropTarget(null); }}>
        <DialogSurface className={s.surfaceSm}>
          <DialogBody>
            <DialogTitle>Drop external table {extDropTarget}?</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Removes the definition only</MessageBarTitle>
                  Drops <strong>{extDropTarget}</strong> via <code>.drop external table [&quot;{extDropTarget}&quot;] ifexists</code>.
                  The referenced storage data is <strong>not</strong> deleted.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setExtDropTarget(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={async () => {
                  const name = extDropTarget;
                  if (!name) return;
                  setExtDropTarget(null);
                  await del(EXTERNAL, `name=${encodeURIComponent(name)}`);
                }}
              >
                {busy ? 'Dropping…' : 'Drop external table'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Retention policy authoring dialog (.alter table|database policy retention) */}
      <Dialog open={retOpen} onOpenChange={(_, d) => { if (!d.open) setRetOpen(false); }}>
        <DialogSurface className={s.surfaceMd}>
          <DialogBody>
            <DialogTitle>Retention policy (.alter {retScope} policy retention)</DialogTitle>
            <DialogContent>
              <div className={s.dialogStack}>
                <MessageBar intent="info">
                  <MessageBarBody>
                    Sets the <strong>soft-delete period</strong> (how long data stays queryable before ADX
                    deletes it) via <code>.alter {retScope} policy retention</code>. Requires{' '}
                    <strong>Database Admin</strong> (table scope also accepts Table Admin). Pure ADX — no Fabric.
                  </MessageBarBody>
                </MessageBar>
                <Field label="Scope" required>
                  <Dropdown
                    value={retScope === 'table' ? 'Table' : 'Database'}
                    selectedOptions={[retScope]}
                    onOptionSelect={(_, d) => setRetScope((d.optionValue as 'database' | 'table') || 'database')}
                  >
                    <Option value="database" text="Database">Database{database ? ` (${database})` : ''}</Option>
                    <Option value="table" text="Table">Table</Option>
                  </Dropdown>
                </Field>
                {retScope === 'table' && (
                  <Field label="Table" required>
                    <Dropdown
                      placeholder={tables.length ? 'Select a table' : 'No tables — create one first'}
                      value={retTable} selectedOptions={retTable ? [retTable] : []}
                      onOptionSelect={(_, d) => setRetTable(d.optionValue || '')}
                      disabled={!tables.length}
                    >
                      {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                <Field label="Soft-delete period (days)" required hint="How many days data stays queryable. 0 = delete immediately.">
                  <Input type="number" min={0} value={retDays} onChange={(_, d) => setRetDays(d.value)} />
                </Field>
                <Field label="Recoverability">
                  <Switch
                    checked={retRecoverability}
                    label={retRecoverability ? 'Enabled — soft-deleted data recoverable for ~14 days' : 'Disabled — no recovery window'}
                    onChange={(_, d) => setRetRecoverability(!!d.checked)}
                  />
                </Field>
                {retNotice && <MessageBar intent="success"><MessageBarBody>{retNotice}</MessageBarBody></MessageBar>}
                {retError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Retention policy failed</MessageBarTitle>{retError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRetOpen(false)} disabled={retBusy}>Close</Button>
              <Button
                appearance="primary"
                onClick={submitRetention}
                disabled={retBusy || (retScope === 'table' && !retTable) || !/^\d+$/.test(retDays.trim())}
              >
                {retBusy ? 'Applying…' : 'Apply retention'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Caching policy authoring dialog (.alter table|database policy caching) */}
      <Dialog open={cacheOpen} onOpenChange={(_, d) => { if (!d.open) setCacheOpen(false); }}>
        <DialogSurface className={s.surfaceMd}>
          <DialogBody>
            <DialogTitle>Caching policy (.alter {cacheScope} policy caching)</DialogTitle>
            <DialogContent>
              <div className={s.dialogStack}>
                <MessageBar intent="info">
                  <MessageBarBody>
                    Sets the <strong>hot-cache window</strong> — how much recent data is kept on local SSD for
                    sub-second KQL — via <code>.alter {cacheScope} policy caching hot = …</code>. Requires{' '}
                    <strong>Database Admin</strong> (table scope also accepts Table Admin). Pure ADX — no Fabric.
                  </MessageBarBody>
                </MessageBar>
                <Field label="Scope" required>
                  <Dropdown
                    value={cacheScope === 'table' ? 'Table' : 'Database'}
                    selectedOptions={[cacheScope]}
                    onOptionSelect={(_, d) => setCacheScope((d.optionValue as 'database' | 'table') || 'database')}
                  >
                    <Option value="database" text="Database">Database{database ? ` (${database})` : ''}</Option>
                    <Option value="table" text="Table">Table</Option>
                  </Dropdown>
                </Field>
                {cacheScope === 'table' && (
                  <Field label="Table" required>
                    <Dropdown
                      placeholder={tables.length ? 'Select a table' : 'No tables — create one first'}
                      value={cacheTable} selectedOptions={cacheTable ? [cacheTable] : []}
                      onOptionSelect={(_, d) => setCacheTable(d.optionValue || '')}
                      disabled={!tables.length}
                    >
                      {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                    </Dropdown>
                  </Field>
                )}
                <Field label="Hot-cache period" required>
                  <span className={s.inlineRow}>
                    <span className={s.grow}>
                      <Input type="number" min={0} value={cacheValue} onChange={(_, d) => setCacheValue(d.value)} />
                    </span>
                    <Dropdown
                      value={cacheUnit === 'h' ? 'Hours' : 'Days'}
                      selectedOptions={[cacheUnit]}
                      onOptionSelect={(_, d) => setCacheUnit((d.optionValue as 'h' | 'd') || 'd')}
                    >
                      <Option value="h" text="Hours">Hours</Option>
                      <Option value="d" text="Days">Days</Option>
                    </Dropdown>
                  </span>
                </Field>
                {cacheNotice && <MessageBar intent="success"><MessageBarBody>{cacheNotice}</MessageBarBody></MessageBar>}
                {cacheError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Caching policy failed</MessageBarTitle>{cacheError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCacheOpen(false)} disabled={cacheBusy}>Close</Button>
              <Button
                appearance="primary"
                onClick={submitCaching}
                disabled={cacheBusy || (cacheScope === 'table' && !cacheTable) || !/^\d+$/.test(cacheValue.trim())}
              >
                {cacheBusy ? 'Applying…' : 'Apply caching'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Continuous-export create/edit dialog (.create-or-alter continuous-export) */}
      <Dialog open={ceOpen} onOpenChange={(_, d) => { if (!d.open) setCeOpen(false); }}>
        <DialogSurface className={s.surfaceLg}>
          <DialogBody>
            <DialogTitle>{ceEditing ? `Edit continuous export · ${ceEditing}` : 'New continuous export (.create-or-alter continuous-export)'}</DialogTitle>
            <DialogContent>
              <div className={s.dialogStack}>
                <MessageBar intent="info">
                  <MessageBarBody>
                    Periodically exports new rows from a source table into an existing <strong>external table</strong>{' '}
                    via <code>.create-or-alter continuous-export</code> (<code>managedIdentity=system</code>). Create
                    the external-table target first in the <strong>External tables</strong> group. Requires{' '}
                    <strong>Database Admin</strong>. Pure ADX ↔ ADLS Gen2 — no Fabric.
                  </MessageBarBody>
                </MessageBar>
                <Field label="Name" required>
                  <Input value={ceName} onChange={(_, d) => setCeName(d.value)} placeholder="export_events" disabled={!!ceEditing} />
                </Field>
                <Field label="Source table (over)" required>
                  <Dropdown
                    placeholder={tables.length ? 'Select the source table' : 'No tables — create one first'}
                    value={ceSource} selectedOptions={ceSource ? [ceSource] : []}
                    onOptionSelect={(_, d) => setCeSource(d.optionValue || '')}
                    disabled={!tables.length}
                  >
                    {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="External table target" required hint={extTables.length ? undefined : 'No external tables — create one in the External tables group first.'}>
                  <Dropdown
                    placeholder={extTables.length ? 'Select an external table' : 'No external tables'}
                    value={ceTarget} selectedOptions={ceTarget ? [ceTarget] : []}
                    onOptionSelect={(_, d) => setCeTarget(d.optionValue || '')}
                    disabled={!extTables.length}
                  >
                    {extTables.map((x) => <Option key={x.name} value={x.name} text={x.name}>{x.name}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Run interval" required>
                  <span className={s.inlineRow}>
                    <span className={s.grow}>
                      <Input type="number" min={1} value={ceIntervalValue} onChange={(_, d) => setCeIntervalValue(d.value)} />
                    </span>
                    <Dropdown
                      value={ceIntervalUnit === 'm' ? 'Minutes' : ceIntervalUnit === 'h' ? 'Hours' : 'Days'}
                      selectedOptions={[ceIntervalUnit]}
                      onOptionSelect={(_, d) => setCeIntervalUnit((d.optionValue as 'm' | 'h' | 'd') || 'h')}
                    >
                      <Option value="m" text="Minutes">Minutes</Option>
                      <Option value="h" text="Hours">Hours</Option>
                      <Option value="d" text="Days">Days</Option>
                    </Dropdown>
                  </span>
                </Field>
                <Field label="Export query (optional)" hint="KQL after <| — leave blank to export the whole source table. Project/filter before export, e.g. T | project ts, tenant, value.">
                  <Textarea
                    value={ceQuery} onChange={(_, d) => setCeQuery(d.value)} rows={4} className={s.kqlInput}
                    placeholder={ceSource ? `${ceSource} | project ...` : 'source | project ...'}
                  />
                </Field>
                {ceNotice && <MessageBar intent="success"><MessageBarBody>{ceNotice}</MessageBarBody></MessageBar>}
                {ceError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Continuous export failed</MessageBarTitle>{ceError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCeOpen(false)} disabled={ceBusy}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={submitCe}
                disabled={ceBusy || !ceName.trim() || !ceSource || !ceTarget || !/^\d+$/.test(ceIntervalValue.trim())}
              >
                {ceBusy ? 'Saving…' : (ceEditing ? 'Save changes' : 'Create')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Continuous-export drop-confirm dialog */}
      <Dialog open={ceDropTarget !== null} onOpenChange={(_, d) => { if (!d.open) setCeDropTarget(null); }}>
        <DialogSurface className={s.surfaceSm}>
          <DialogBody>
            <DialogTitle>Drop continuous export {ceDropTarget}?</DialogTitle>
            <DialogContent>
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Stops future exports</MessageBarTitle>
                  Removes the job via <code>.drop continuous-export [&quot;{ceDropTarget}&quot;]</code>. The
                  external table and already-exported data are <strong>not</strong> deleted.
                </MessageBarBody>
              </MessageBar>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setCeDropTarget(null)} disabled={busy}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={busy}
                onClick={async () => {
                  const name = ceDropTarget;
                  if (!name) return;
                  setCeDropTarget(null);
                  await dropCe(name);
                }}
              >
                {busy ? 'Dropping…' : 'Drop continuous export'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Ingestion mapping wizard (format selector + auto-detect grid) */}
      <IngestionMappingWizardDialog
        itemId={itemId}
        tables={tables.map((t) => ({ name: t.name }))}
        open={mappingWizOpen}
        onOpenChange={setMappingWizOpen}
        onCreated={(_name, _kind, _table, kql) => {
          setMappingWizOpen(false);
          onOpenQuery?.(kql);
          loadAll();
        }}
      />
    </div>
  );
}
