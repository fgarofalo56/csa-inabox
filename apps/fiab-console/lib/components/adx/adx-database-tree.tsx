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
 *   - Database schema     → /api/adx/overview             (.show database schema as json — read-only)
 *   - Continuous export   → /api/adx/overview             (.show continuous-exports — read-only)
 *   - Database policies   → /api/adx/policies             (.show database <db> policy <kind> — read-only)
 *
 * Capabilities the ADX/Fabric UI still surfaces read-only here (database
 * retention/caching/sharding policy *authoring* via `.alter database policy`,
 * and continuous-export *authoring*) render as honest ⚠️ rows naming the
 * control command + role required — never a fake list. No mocks.
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
  ArrowImport20Regular, Open16Regular, Search20Regular, Warning20Regular,
  Database20Regular, DataUsage20Regular, ShieldKeyhole20Regular,
  DataHistogram16Regular, Code16Regular, ChartMultiple16Regular,
  ShieldKeyhole16Regular, CloudLink20Regular,
} from '@fluentui/react-icons';
import { IngestionMappingWizardDialog } from './ingestion-mapping-wizard';
import {
  ColumnGridDesigner, toKustoSchema, parseKustoSchema,
} from './column-grid-designer';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 248 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
});

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

interface TableRow { name: string; totalRowCount?: number; totalExtentSizeMb?: number; folder?: string }
interface FnRow { name: string; parameters?: string; body?: string; folder?: string }
interface MvRow { name: string; sourceTable?: string }
interface MapRow { name: string; kind: string; table?: string; mapping?: string }
interface ExportRow { name: string; externalTableName?: string; isRunning?: boolean; isDisabled?: boolean; lastRunResult?: string }
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
    onAdd?: () => void, addTitle?: string,
  ) => (
    <TreeItemLayout iconBefore={icon}>
      <span className={s.groupLayout}>
        <span>{label} ({count})</span>
        <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
          {onAdd && (
            <Tooltip content={addTitle || `New ${label.toLowerCase()}`} relationship="label">
              <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={onAdd} disabled={busy} aria-label={addTitle || `New ${label}`} />
            </Tooltip>
          )}
        </span>
      </span>
    </TreeItemLayout>
  );

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
        <span style={{ display: 'flex', gap: 2 }}>
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

      {loading && <div style={{ padding: 8 }}><Spinner size="tiny" label="Loading database objects…" /></div>}
      {error && (
        <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Database error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
      )}

      <div style={{ overflow: 'auto', flex: 1 }}>
        <Tree aria-label="KQL database objects" defaultOpenItems={['g-tables']}>
          {/* Tables */}
          <TreeItem itemType="branch" value="g-tables">
            {groupHeader('Tables', <DocumentTable20Regular />, tables.length, () => openCreate('table'), 'New table')}
            <Tree>
              {fTables.length === 0 && <TreeItem itemType="leaf" value="t-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No tables yet'}</Caption1></TreeItemLayout></TreeItem>}
              {fTables.map((t) => (
                <TreeItem key={t.name} itemType="leaf" value={`t-${t.name}`}>
                  <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                    <span className={s.leafRow}>
                      <span
                        role="button" tabIndex={0} style={{ cursor: 'pointer' }}
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
            {groupHeader('Functions', <MathFormula20Regular />, functions.length, () => onEditFunction?.(), 'New function')}
            <Tree>
              {fFns.length === 0 && <TreeItem itemType="leaf" value="fn-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No functions'}</Caption1></TreeItemLayout></TreeItem>}
              {fFns.map((fn) => (
                <TreeItem key={fn.name} itemType="leaf" value={`fn-${fn.name}`}>
                  <TreeItemLayout iconBefore={<MathFormula20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
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
            {groupHeader('Materialized views', <Table20Regular />, mviews.length, () => openCreate('mv'), 'New materialized view')}
            <Tree>
              {fMvs.length === 0 && <TreeItem itemType="leaf" value="mv-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No materialized views'}</Caption1></TreeItemLayout></TreeItem>}
              {fMvs.map((mv) => (
                <TreeItem key={mv.name} itemType="leaf" value={`mv-${mv.name}`}>
                  <TreeItemLayout iconBefore={<Table20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
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
            {groupHeader('External tables', <CloudLink20Regular />, extTables.length, openExtCreate, 'New external table')}
            <Tree>
              {fExtTables.length === 0 && <TreeItem itemType="leaf" value="ext-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No external tables'}</Caption1></TreeItemLayout></TreeItem>}
              {fExtTables.map((x) => (
                <TreeItem key={x.name} itemType="leaf" value={`ext-${x.name}`}>
                  <TreeItemLayout iconBefore={<CloudLink20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
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
            {groupHeader('Ingestion mappings', <ArrowImport20Regular />, mappings.length, () => setMappingWizOpen(true), 'New ingestion mapping')}
            <Tree>
              {fMaps.length === 0 && <TreeItem itemType="leaf" value="map-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No ingestion mappings'}</Caption1></TreeItemLayout></TreeItem>}
              {fMaps.map((m) => (
                <TreeItem key={`${m.kind}-${m.table || 'db'}-${m.name}`} itemType="leaf" value={`map-${m.kind}-${m.name}`}>
                  <TreeItemLayout iconBefore={<ArrowImport20Regular />}>
                    <span className={s.leafRow}>
                      <span>{m.name}</span>
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

          {/* Continuous export (read-only) */}
          <TreeItem itemType="branch" value="g-exports">
            {groupHeader('Continuous export', <DataUsage20Regular />, exports.length, undefined)}
            <Tree>
              {fExports.length === 0 && (
                <TreeItem itemType="leaf" value="ce-empty">
                  <Tooltip content="Authoring a continuous export needs an external table + Database Admin: .create-or-alter continuous-export NAME over (T) to ExternalTable <| query. Listed read-only here." relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{f ? 'No matches' : 'No continuous exports'}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">read-only</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              )}
              {fExports.map((ce) => (
                <TreeItem key={ce.name} itemType="leaf" value={`ce-${ce.name}`}>
                  <TreeItemLayout iconBefore={<DataUsage20Regular />}>
                    <span className={s.leafRow}>
                      <span>{ce.name}</span>
                      <span className={s.leafActions}>
                        {ce.externalTableName && <Caption1>→ {ce.externalTableName}</Caption1>}
                        <Badge size="small" appearance="tint" color={ce.isDisabled ? 'warning' : ce.isRunning ? 'success' : 'informative'}>
                          {ce.isDisabled ? 'disabled' : ce.isRunning ? 'running' : (ce.lastRunResult || 'idle')}
                        </Badge>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Database policies (read-only) */}
          <TreeItem itemType="branch" value="g-policies">
            {groupHeader('Policies', <ShieldKeyhole20Regular />, policies.length, undefined)}
            <Tree>
              {fPolicies.length === 0 && (
                <TreeItem itemType="leaf" value="pol-empty">
                  <Tooltip content="Database policies are read from .show database <db> policy <kind> (retention, caching, sharding, mergepolicy, streamingingestion). Altering a policy needs Database Admin (.alter database <db> policy ...) and is not wired here. Listed read-only." relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{f ? 'No matches' : 'No policies set'}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">read-only</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              )}
              {fPolicies.map((p) => (
                <TreeItem key={p.kind} itemType="leaf" value={`pol-${p.kind}`}>
                  <Tooltip content={p.raw || JSON.stringify(p.policy ?? {})} relationship="description">
                    <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>
                      <span className={s.leafRow}>
                        <span>{p.kind}</span>
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
                  <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                    onClick={() => openQuery('.show database schema')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery('.show database schema'); } }}
                  >Show full schema (.show database schema)</span>
                </TreeItemLayout>
              </TreeItem>
            </Tree>
          </TreeItem>

          {/* Honest gate rows — ADX/Fabric exposes these; we don't author them yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Retention / caching policy authoring', '.alter table T policy retention / .alter database policy caching — per-table & per-db hot-cache + soft-delete tuning. Database policies are surfaced read-only in the Policies group above (.show database <db> policy <kind>); authoring (.alter …) needs Database Admin and is not wired.'],
                ['Continuous-export authoring', '.create-or-alter continuous-export over an external table; needs an external table (now authorable above) + Database Admin. Listed read-only in the Continuous export group.'],
              ].map(([label, why]) => (
                <TreeItem key={label} itemType="leaf" value={`nw-${label}`}>
                  <Tooltip content={why} relationship="description">
                    <TreeItemLayout iconBefore={<Warning20Regular />}>
                      <span style={{ color: tokens.colorNeutralForeground3 }}>{label}</span>{' '}
                      <Badge size="small" appearance="tint" color="warning">coming</Badge>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      </div>

      {/* Inline drop-confirm dialog (fallback when the parent doesn't own drop) */}
      <Dialog open={dropTarget !== null} onOpenChange={(_, d) => { if (!d.open) setDropTarget(null); }}>
        <DialogSurface style={{ maxWidth: 480 }}>
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
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Row-level security · {rlsTarget}</DialogTitle>
            <DialogContent>
              {rlsLoading ? <Spinner size="tiny" label="Loading RLS policy…" /> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                      style={{ fontFamily: 'Consolas, monospace' }}
                      placeholder={`${rlsTarget ?? 'T'} | where current_principal_is_member_of('aadgroup=analysts@contoso.com')`}
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
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'table' ? 'table (.create table)'
                : 'materialized view (.create materialized-view)'}
            </DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                      <Textarea value={cQuery} onChange={(_, d) => setCQuery(d.value)} rows={4} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events | summarize cnt = count() by bin(ts, 1d)" />
                    </Field>
                    <Field label="Backfill from existing data">
                      <Switch
                        label="async .create materialized-view with (backfill=true) — processes the source table's existing records"
                        checked={cBackfill}
                        onChange={(_, d) => setCBackfill(!!d.checked)}
                      />
                      {cBackfill && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
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
        <DialogSurface style={{ maxWidth: 600 }}>
          <DialogBody>
            <DialogTitle>New external table (.create-or-alter external table)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
        <DialogSurface style={{ maxWidth: 480 }}>
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
