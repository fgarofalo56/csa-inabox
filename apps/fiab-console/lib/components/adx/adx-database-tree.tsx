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
 *   - Database schema     → /api/adx/overview             (.show database schema as json — read-only)
 *   - Continuous export   → /api/adx/overview             (.show continuous-exports — read-only)
 *   - Database policies   → /api/adx/policies             (.show database <db> policy <kind> — read-only)
 *   - Database roles      → /api/adx/roles                (.show/.add/.drop database <db> <role> ('fqn'))
 *   - Row-level security  → /api/adx/rls                  (.show/.alter table T policy row_level_security)
 *   - External tables     → /api/adx/external-tables      (.show/.create-or-alter/.drop external table — Delta + Storage)
 *
 * The Security group (database roles + per-table RLS) mirrors the ADX web UI
 * "Security" pane; the External tables group mirrors the ADX schema-tree group.
 *
 * Capabilities the ADX/Fabric UI exposes that we don't yet *author* (retention/
 * caching policy authoring, SQL external tables, continuous-export authoring)
 * render as honest ⚠️ "coming" rows naming the control command + role required
 * — never a fake list. No mocks.
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
  People20Regular, Person16Regular, ShieldLock16Regular, CloudLink20Regular,
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
interface PrincipalRow { role: string; roleLabel?: string; principalType: string; principalDisplayName: string; principalObjectId?: string; principalFQN: string; notes?: string }
interface ExtTableRow { name: string; tableType?: string; folder?: string }

const DATABASE_ROLES = ['admins', 'users', 'viewers', 'unrestrictedviewers', 'ingestors', 'monitors'] as const;
const EXT_DATA_FORMATS = ['csv', 'tsv', 'json', 'multijson', 'parquet', 'avro', 'orc', 'psv'] as const;

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
export function AdxDatabaseTree({ itemId, onOpenQuery, onEditFunction, onAlterTable, onDropTable, refreshKey = 0, onGetData, onCreateDashboard }: AdxDatabaseTreeProps) {
  const s = useStyles();

  const idq = `id=${encodeURIComponent(itemId)}`;
  const TABLES = `/api/adx/tables?${idq}`;
  const FUNCTIONS = `/api/adx/functions?${idq}`;
  const MVIEWS = `/api/adx/materialized-views?${idq}`;
  const MAPPINGS = `/api/adx/ingestion-mappings?${idq}`;
  const OVERVIEW = `/api/adx/overview?${idq}`;
  const POLICIES = `/api/adx/policies?${idq}`;
  const ROLES = `/api/adx/roles?${idq}`;
  const RLS = `/api/adx/rls?${idq}`;
  const EXT = `/api/adx/external-tables?${idq}`;

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
  const [principals, setPrincipals] = useState<PrincipalRow[]>([]);
  const [extTables, setExtTables] = useState<ExtTableRow[]>([]);

  // ---- RBAC: add-principal dialog ----
  const [addPrincipalOpen, setAddPrincipalOpen] = useState(false);
  const [pRole, setPRole] = useState<typeof DATABASE_ROLES[number]>('viewers');
  const [pType, setPType] = useState<'aaduser' | 'aadgroup' | 'aadapp'>('aaduser');
  const [pIdentity, setPIdentity] = useState('');     // UPN / object id / app id
  const [pTenant, setPTenant] = useState('');         // optional tenant for group/app
  const [pDesc, setPDesc] = useState('');
  const [pError, setPError] = useState<string | null>(null);

  // ---- RLS dialog (table-scoped, loaded on demand) ----
  const [rlsTable, setRlsTable] = useState<string | null>(null);
  const [rlsEnabled, setRlsEnabled] = useState(false);
  const [rlsQuery, setRlsQuery] = useState('');
  const [rlsLoading, setRlsLoading] = useState(false);
  const [rlsError, setRlsError] = useState<string | null>(null);
  const [rlsReceipt, setRlsReceipt] = useState<string | null>(null);

  // ---- External-table wizard dialog ----
  const [extOpen, setExtOpen] = useState(false);
  const [extKind, setExtKind] = useState<'delta' | 'storage'>('delta');
  const [extName, setExtName] = useState('');
  const [extAbfss, setExtAbfss] = useState('');
  const [extSchema, setExtSchema] = useState('ts:datetime, tenant:string, value:long');
  const [extFormat, setExtFormat] = useState<typeof EXT_DATA_FORMATS[number]>('parquet');
  const [extConn, setExtConn] = useState('');
  const [extFolder, setExtFolder] = useState('');
  const [extDoc, setExtDoc] = useState('');
  const [extError, setExtError] = useState<string | null>(null);

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

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [tr, fr, mr, ir, or, pr, rr, er] = await Promise.all([
        fetch(TABLES).then(readJson),
        fetch(FUNCTIONS).then(readJson),
        fetch(MVIEWS).then(readJson),
        fetch(MAPPINGS).then(readJson),
        fetch(OVERVIEW).then(readJson),
        fetch(POLICIES).then(readJson),
        fetch(ROLES).then(readJson),
        fetch(EXT).then(readJson),
      ]);
      for (const b of [tr, fr, mr, ir, or, pr, rr, er]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (tr.ok) { setTables(tr.tables || []); setDatabase(tr.database || ''); }
      else setError(tr.error || 'failed to list tables');
      if (fr.ok) setFunctions(fr.functions || []);
      if (mr.ok) setMviews(mr.materializedViews || []);
      if (ir.ok) setMappings(ir.mappings || []);
      if (or.ok) setExports(or.continuousExports || []);
      if (pr.ok) setPolicies(pr.policies || []);
      // RBAC + external tables are best-effort (need Database Admin); a 502/403
      // here must not blank the whole tree — the rest still renders.
      if (rr.ok) setPrincipals(rr.principals || []); else setPrincipals([]);
      if (er.ok) setExtTables(er.externalTables || []); else setExtTables([]);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [TABLES, FUNCTIONS, MVIEWS, MAPPINGS, OVERVIEW, POLICIES, ROLES, EXT]);

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

  // ---------------------------------------------------------------
  // RBAC principal add / drop (real .add/.drop database <role> ('fqn'))
  // ---------------------------------------------------------------
  /** Build the Kusto principal FQN from the dialog inputs. */
  const buildPrincipalFqn = useCallback((): string => {
    const id = pIdentity.trim();
    const tenant = pTenant.trim();
    if (!id) return '';
    if (pType === 'aaduser') {
      // A UPN already identifies the user; an object id needs ;tenant.
      return id.includes('@') ? `aaduser=${id}` : (tenant ? `aaduser=${id};${tenant}` : `aaduser=${id}`);
    }
    // group / app: object/app id, with tenant when provided
    return tenant ? `${pType}=${id};${tenant}` : `${pType}=${id}`;
  }, [pType, pIdentity, pTenant]);

  const submitAddPrincipal = useCallback(async () => {
    const fqn = buildPrincipalFqn();
    if (!fqn) { setPError('Enter the principal UPN / object id / app id.'); return; }
    setBusy(true); setPError(null);
    try {
      const res = await fetch(ROLES, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', role: pRole, principalFQN: fqn, description: pDesc.trim() || undefined }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setPError(body.error || 'grant failed'); setBusy(false); return; }
      setPrincipals(body.principals || []);
      setAddPrincipalOpen(false);
      setPIdentity(''); setPTenant(''); setPDesc('');
    } catch (e: any) {
      setPError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [ROLES, pRole, pDesc, buildPrincipalFqn]);

  const dropPrincipal = useCallback(async (role: string, principalFQN: string) => {
    if (!principalFQN) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(ROLES, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'drop', role, principalFQN }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'revoke failed'); setBusy(false); return; }
      setPrincipals(body.principals || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [ROLES]);

  // ---------------------------------------------------------------
  // Row-level security (real .show / .alter table policy row_level_security)
  // ---------------------------------------------------------------
  const openRls = useCallback(async (table: string) => {
    setRlsTable(table); setRlsError(null); setRlsReceipt(null);
    setRlsEnabled(false); setRlsQuery(''); setRlsLoading(true);
    try {
      const res = await fetch(`${RLS}&table=${encodeURIComponent(table)}`);
      const body = await readJson(res);
      if (applyGate(body)) { setRlsTable(null); return; }
      if (body.ok && body.policy) {
        setRlsEnabled(Boolean(body.policy.enabled));
        setRlsQuery(String(body.policy.query || ''));
      } else if (!body.ok) {
        setRlsError(body.error || 'failed to read RLS policy');
      }
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsLoading(false);
    }
  }, [RLS]);

  const saveRls = useCallback(async () => {
    if (!rlsTable) return;
    setBusy(true); setRlsError(null); setRlsReceipt(null);
    try {
      const res = await fetch(RLS, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: rlsTable, enabled: rlsEnabled, query: rlsQuery }),
      });
      const body = await readJson(res);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setRlsError(body.error || 'failed to apply RLS policy'); setBusy(false); return; }
      setRlsReceipt(`.show table ["${rlsTable}"] policy row_level_security → ${rlsEnabled ? 'enabled' : 'disabled'}`);
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [RLS, rlsTable, rlsEnabled, rlsQuery]);

  // ---------------------------------------------------------------
  // External tables (real .create-or-alter / .drop external table)
  // ---------------------------------------------------------------
  const openExtWizard = useCallback(() => {
    setExtOpen(true); setExtError(null); setExtKind('delta');
    setExtName(''); setExtAbfss(''); setExtConn('');
    setExtSchema('ts:datetime, tenant:string, value:long'); setExtFormat('parquet');
    setExtFolder(''); setExtDoc('');
  }, []);

  const submitExt = useCallback(async () => {
    if (!extName.trim()) { setExtError('Name is required.'); return; }
    setBusy(true); setExtError(null);
    try {
      const payload: any = {
        name: extName.trim(), kind: extKind,
        folder: extFolder.trim() || undefined, docString: extDoc.trim() || undefined,
      };
      if (extKind === 'delta') {
        payload.abfssUri = extAbfss.trim();
      } else {
        payload.schema = extSchema.trim();
        payload.dataFormat = extFormat;
        payload.connectionString = extConn.trim();
      }
      const res = await fetch(EXT, {
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
  }, [EXT, extName, extKind, extAbfss, extSchema, extFormat, extConn, extFolder, extDoc, loadAll]);

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
  const fPrincipals = useMemo(() => principals.filter((x) => match(x.principalDisplayName) || match(x.principalFQN) || match(x.role)), [principals, f]);
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
                        {/* 7. Delete table — parent-owned drop (with inline confirm fallback) or direct .drop table T ifexists */}
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

          {/* Security — database roles (RBAC) + row-level security.
              Mirrors the ADX web UI "Security" pane (Manage → Security). */}
          <TreeItem itemType="branch" value="g-security">
            <TreeItemLayout iconBefore={<ShieldKeyhole20Regular />}>Security</TreeItemLayout>
            <Tree>
              {/* Database roles (RBAC principals) */}
              <TreeItem itemType="branch" value="g-db-roles">
                {groupHeader('Database roles', <People20Regular />, principals.length, () => { setAddPrincipalOpen(true); setPError(null); }, 'Add principal')}
                <Tree>
                  {fPrincipals.length === 0 && (
                    <TreeItem itemType="leaf" value="role-empty">
                      <Tooltip content="Principals + roles come from .show database <db> principals. Add a grant with .add database <db> <role> ('aaduser=…'). Requires Database Admin; cluster-inherited AllDatabasesAdmin principals aren't listed here." relationship="description">
                        <TreeItemLayout iconBefore={<People20Regular />}>
                          <Caption1>{f ? 'No matches' : 'No explicit principals (Database Admin required to list/grant)'}</Caption1>
                        </TreeItemLayout>
                      </Tooltip>
                    </TreeItem>
                  )}
                  {fPrincipals.map((p, i) => (
                    <TreeItem key={`${p.role}-${p.principalFQN || p.principalObjectId || i}`} itemType="leaf" value={`role-${p.role}-${i}`}>
                      <TreeItemLayout iconBefore={<Person16Regular />}>
                        <span className={s.leafRow}>
                          <span title={p.principalFQN}>{p.principalDisplayName || p.principalFQN || '(unknown)'}</span>
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            <Badge size="small" appearance="tint" color="brand">{p.role}</Badge>
                            {p.principalType && <Caption1>{p.principalType.replace(/^Microsoft Entra /, '')}</Caption1>}
                            <Tooltip content={p.principalFQN ? 'Remove (.drop database principal)' : 'Cross-tenant principal — no FQN to remove from this UI'} relationship="label">
                              <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy || !p.principalFQN} onClick={() => dropPrincipal(p.role, p.principalFQN)} aria-label={`Remove ${p.principalDisplayName || p.principalFQN}`} />
                            </Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              </TreeItem>

              {/* Row-level security — per table */}
              <TreeItem itemType="branch" value="g-rls">
                {groupHeader('Row-level security', <ShieldLock16Regular />, tables.length, undefined)}
                <Tree>
                  {fTables.length === 0 && (
                    <TreeItem itemType="leaf" value="rls-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No tables to secure'}</Caption1></TreeItemLayout></TreeItem>
                  )}
                  {fTables.map((t) => (
                    <TreeItem key={`rls-${t.name}`} itemType="leaf" value={`rls-${t.name}`}>
                      <TreeItemLayout iconBefore={<ShieldLock16Regular />}>
                        <span className={s.leafRow}>
                          <span>{t.name}</span>
                          <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                            <Tooltip content="Edit row-level security policy (.alter table T policy row_level_security)" relationship="label">
                              <Button size="small" appearance="subtle" icon={<ShieldLock16Regular />} disabled={busy} onClick={() => openRls(t.name)} aria-label={`Edit RLS for ${t.name}`} />
                            </Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              </TreeItem>
            </Tree>
          </TreeItem>

          {/* External tables — list + create (Delta + Storage) + drop.
              Mirrors the ADX "External tables" schema-tree group. */}
          <TreeItem itemType="branch" value="g-ext-tables">
            {groupHeader('External tables', <CloudLink20Regular />, extTables.length, openExtWizard, 'New external table')}
            <Tree>
              {fExtTables.length === 0 && (
                <TreeItem itemType="leaf" value="ext-empty">
                  <Tooltip content="External tables come from .show external tables. Create a Delta (kind=delta) or Azure-Storage (kind=storage) external table; the cluster MI needs Storage Blob Data Reader on the account. SQL external tables need a secrets surface and are listed as coming below. Requires Database Admin to list." relationship="description">
                    <TreeItemLayout iconBefore={<CloudLink20Regular />}>
                      <Caption1>{f ? 'No matches' : 'No external tables (Database Admin required to list)'}</Caption1>
                    </TreeItemLayout>
                  </Tooltip>
                </TreeItem>
              )}
              {fExtTables.map((x) => (
                <TreeItem key={`ext-${x.name}`} itemType="leaf" value={`ext-${x.name}`}>
                  <TreeItemLayout iconBefore={<CloudLink20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        onClick={() => openQuery(`external_table("${x.name}")\n| take 100`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`external_table("${x.name}")\n| take 100`); } }}
                      >{x.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {x.tableType && <Badge size="small" appearance="outline">{x.tableType}</Badge>}
                        <Tooltip content="Explore (external_table)" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`external_table("${x.name}")\n| take 100`)} aria-label={`Explore ${x.name}`} /></Tooltip>
                        <Tooltip content="Drop external table (.drop external table N ifexists)" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(EXT, `name=${encodeURIComponent(x.name)}`)} aria-label={`Drop ${x.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — ADX/Fabric exposes these; we don't author them yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Retention / caching policy authoring', '.alter table T policy retention / .alter database policy caching — per-table & per-db hot-cache + soft-delete tuning. Database policies are surfaced read-only in the Policies group above (.show database <db> policy <kind>); authoring (.alter …) needs Database Admin and is not wired.'],
                ['SQL external tables', '.create external table … kind=sql — needs a SqlConnectionString with embedded credentials/MI. Loom has no secrets surface for it yet; Delta + Azure-Storage external tables ARE wired in the External tables group above.'],
                ['Continuous-export authoring', '.create-or-alter continuous-export over an external table; needs an external table + Database Admin. Listed read-only above.'],
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

      {/* Add database principal (RBAC) dialog */}
      <Dialog open={addPrincipalOpen} onOpenChange={(_, d) => { if (!d.open) setAddPrincipalOpen(false); }}>
        <DialogSurface style={{ maxWidth: 520 }}>
          <DialogBody>
            <DialogTitle>Add database principal (.add database {database || '<db>'} &lt;role&gt;)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Field label="Role" required>
                  <Dropdown value={pRole} selectedOptions={[pRole]} onOptionSelect={(_, d) => setPRole((d.optionValue as typeof DATABASE_ROLES[number]) || 'viewers')}>
                    {DATABASE_ROLES.map((r) => <Option key={r} value={r} text={r}>{r}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Principal type" required>
                  <Dropdown
                    value={pType === 'aaduser' ? 'User' : pType === 'aadgroup' ? 'Group' : 'Application'}
                    selectedOptions={[pType]}
                    onOptionSelect={(_, d) => setPType((d.optionValue as 'aaduser' | 'aadgroup' | 'aadapp') || 'aaduser')}
                  >
                    <Option value="aaduser" text="User">User</Option>
                    <Option value="aadgroup" text="Group">Group</Option>
                    <Option value="aadapp" text="Application">Application</Option>
                  </Dropdown>
                </Field>
                <Field label={pType === 'aaduser' ? 'User UPN or object id' : pType === 'aadgroup' ? 'Group object id' : 'Application (client) id'} required>
                  <Input
                    value={pIdentity}
                    onChange={(_, d) => setPIdentity(d.value)}
                    placeholder={pType === 'aaduser' ? 'user@contoso.com' : '00000000-0000-0000-0000-000000000000'}
                  />
                </Field>
                <Field label="Tenant id (required for groups/apps and object-id users)" hint="Omit only when granting a user by UPN.">
                  <Input value={pTenant} onChange={(_, d) => setPTenant(d.value)} placeholder="contoso.onmicrosoft.com or tenant GUID" />
                </Field>
                <Field label="Description (Notes column)">
                  <Input value={pDesc} onChange={(_, d) => setPDesc(d.value)} placeholder="Granted via CSA Loom" />
                </Field>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Will run <code>.add database {database || '<db>'} {pRole} ('{buildPrincipalFqn() || `${pType}=…`}')</code> — requires Database Admin.
                </Caption1>
                {pError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Grant failed</MessageBarTitle>{pError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAddPrincipalOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitAddPrincipal} disabled={busy || !pIdentity.trim()}>{busy ? 'Granting…' : 'Add principal'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Row-level security policy dialog */}
      <Dialog open={rlsTable !== null} onOpenChange={(_, d) => { if (!d.open) setRlsTable(null); }}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Row-level security · {rlsTable}</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rlsLoading && <Spinner size="tiny" label="Loading current policy…" />}
                <Field label="Enforcement">
                  <Switch
                    label={rlsEnabled ? 'Enabled — the predicate below filters every query' : 'Disabled — table returns all rows'}
                    checked={rlsEnabled}
                    onChange={(_, d) => setRlsEnabled(!!d.checked)}
                    disabled={rlsLoading}
                  />
                </Field>
                <Field
                  label="RLS predicate (KQL)"
                  required={rlsEnabled}
                  hint="A KQL query that re-shapes the table for the calling principal. Use current_principal() / current_principal_details() to scope rows."
                >
                  <Textarea
                    value={rlsQuery}
                    onChange={(_, d) => setRlsQuery(d.value)}
                    rows={6}
                    disabled={rlsLoading || !rlsEnabled}
                    style={{ fontFamily: 'Consolas, monospace' }}
                    placeholder={`${rlsTable} | where Owner == current_principal()`}
                  />
                </Field>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Applies <code>.alter table ["{rlsTable}"] policy row_level_security {rlsEnabled ? 'enable' : 'disable'} "&lt;query&gt;"</code> — requires Table/Database Admin.
                </Caption1>
                {rlsReceipt && <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Policy applied</MessageBarTitle>{rlsReceipt}</MessageBarBody></MessageBar>}
                {rlsError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RLS error</MessageBarTitle>{rlsError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRlsTable(null)} disabled={busy}>Close</Button>
              <Button appearance="primary" onClick={saveRls} disabled={busy || rlsLoading || (rlsEnabled && !rlsQuery.trim())}>{busy ? 'Applying…' : 'Apply policy'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* External-table wizard dialog */}
      <Dialog open={extOpen} onOpenChange={(_, d) => { if (!d.open) setExtOpen(false); }}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>New external table (.create-or-alter external table)</DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Field label="Name" required>
                  <Input value={extName} onChange={(_, d) => setExtName(d.value)} placeholder="orders_archive" />
                </Field>
                <Field label="Kind" required>
                  <Dropdown
                    value={extKind === 'delta' ? 'Delta (ADLS Delta Lake)' : 'Azure Storage (Blob/ADLS)'}
                    selectedOptions={[extKind]}
                    onOptionSelect={(_, d) => setExtKind((d.optionValue as 'delta' | 'storage') || 'delta')}
                  >
                    <Option value="delta" text="Delta (ADLS Delta Lake)">Delta (ADLS Delta Lake)</Option>
                    <Option value="storage" text="Azure Storage (Blob/ADLS)">Azure Storage (Blob/ADLS)</Option>
                  </Dropdown>
                </Field>

                {extKind === 'delta' && (
                  <Field label="Delta table root (abfss:// URI)" required hint="Schema is auto-inferred from the delta log. Storage auth uses the cluster system-assigned MI (impersonation).">
                    <Input value={extAbfss} onChange={(_, d) => setExtAbfss(d.value)} placeholder="abfss://bronze@acct.dfs.core.windows.net/orders" />
                  </Field>
                )}

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
                      <Dropdown value={extFormat} selectedOptions={[extFormat]} onOptionSelect={(_, d) => setExtFormat((d.optionValue as typeof EXT_DATA_FORMATS[number]) || 'parquet')}>
                        {EXT_DATA_FORMATS.map((fmt) => <Option key={fmt} value={fmt} text={fmt.toUpperCase()}>{fmt.toUpperCase()}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field
                      label="Storage connection string (h@'…')"
                      required
                      hint="Storage URI + auth, e.g. https://acct.blob.core.windows.net/container;managed_identity=system. See learn.microsoft.com/kusto/api/connection-strings/storage-connection-strings"
                    >
                      <Input value={extConn} onChange={(_, d) => setExtConn(d.value)} placeholder="https://acct.blob.core.windows.net/container;managed_identity=system" />
                    </Field>
                  </>
                )}

                <Field label="Folder (optional)">
                  <Input value={extFolder} onChange={(_, d) => setExtFolder(d.value)} placeholder="Archive" />
                </Field>
                <Field label="Doc string (optional)">
                  <Input value={extDoc} onChange={(_, d) => setExtDoc(d.value)} placeholder="Cold orders mirrored to ADLS" />
                </Field>

                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  SQL external tables (kind=sql) require an embedded credential and aren't supported here yet — see the &quot;Not yet wired&quot; group.
                </Caption1>
                {extError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Create failed</MessageBarTitle>{extError}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setExtOpen(false)} disabled={busy}>Cancel</Button>
              <Button appearance="primary" onClick={submitExt} disabled={busy || !extName.trim() || (extKind === 'delta' ? !extAbfss.trim() : !extConn.trim())}>{busy ? 'Creating…' : 'Create external table'}</Button>
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
