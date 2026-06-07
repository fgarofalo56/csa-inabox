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
 *
 * Capabilities the ADX/Fabric UI exposes that we don't yet *author* (update
 * policies, retention/caching policies, row-level security, external tables,
 * continuous-export authoring) render as honest ⚠️ "coming" rows naming the
 * control command + role required — never a fake list. No mocks.
 *
 * The database is resolved per kql-database item; when the cluster env var
 * (LOOM_KUSTO_CLUSTER_URI) is unset the routes 503 and the whole tree shows a
 * single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner, Dropdown, Option, Textarea,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  DocumentTable20Regular, Table20Regular, MathFormula20Regular,
  ArrowImport20Regular, Open16Regular, Search20Regular, Warning20Regular,
  Database20Regular, DataUsage20Regular, ShieldKeyhole20Regular,
} from '@fluentui/react-icons';

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
interface FnRow { name: string; parameters?: string; folder?: string }
interface MvRow { name: string; sourceTable?: string }
interface MapRow { name: string; kind: string; table?: string; mapping?: string }
interface ExportRow { name: string; externalTableName?: string; isRunning?: boolean; isDisabled?: boolean; lastRunResult?: string }
interface PolicyRow { kind: string; policy?: unknown; raw?: string }

type CreatableGroup = 'table' | 'function' | 'mv' | 'mapping';

export interface AdxDatabaseTreeProps {
  /** The bound kql-database item id (so routes resolve the right database). */
  itemId: string;
  /** Load a query into the editor when a leaf is opened (e.g. `["T"] | take 100`). */
  onOpenQuery?: (kql: string) => void;
  /** Increment to force a refresh from the parent (e.g. after an external create). */
  refreshKey?: number;
}

/** A typed, ADX/Fabric-faithful KQL database object navigator. */
export function AdxDatabaseTree({ itemId, onOpenQuery, refreshKey = 0 }: AdxDatabaseTreeProps) {
  const s = useStyles();

  const idq = `id=${encodeURIComponent(itemId)}`;
  const TABLES = `/api/adx/tables?${idq}`;
  const FUNCTIONS = `/api/adx/functions?${idq}`;
  const MVIEWS = `/api/adx/materialized-views?${idq}`;
  const MAPPINGS = `/api/adx/ingestion-mappings?${idq}`;
  const OVERVIEW = `/api/adx/overview?${idq}`;
  const POLICIES = `/api/adx/policies?${idq}`;

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

  // ---- create dialog ----
  const [createGroup, setCreateGroup] = useState<CreatableGroup | null>(null);
  const [cName, setCName] = useState('');
  const [cSchema, setCSchema] = useState('ts:datetime, tenant:string, value:long');
  const [cSource, setCSource] = useState('');
  const [cQuery, setCQuery] = useState('');
  const [cArgs, setCArgs] = useState('');
  const [cKind, setCKind] = useState('json');
  const [cMapping, setCMapping] = useState('[\n  { "column": "ts", "Properties": { "Path": "$.ts" } }\n]');
  const [createError, setCreateError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing }); return true; }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [tr, fr, mr, ir, or, pr] = await Promise.all([
        fetch(TABLES).then(readJson),
        fetch(FUNCTIONS).then(readJson),
        fetch(MVIEWS).then(readJson),
        fetch(MAPPINGS).then(readJson),
        fetch(OVERVIEW).then(readJson),
        fetch(POLICIES).then(readJson),
      ]);
      for (const b of [tr, fr, mr, ir, or, pr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (tr.ok) { setTables(tr.tables || []); setDatabase(tr.database || ''); }
      else setError(tr.error || 'failed to list tables');
      if (fr.ok) setFunctions(fr.functions || []);
      if (mr.ok) setMviews(mr.materializedViews || []);
      if (ir.ok) setMappings(ir.mappings || []);
      if (or.ok) setExports(or.continuousExports || []);
      if (pr.ok) setPolicies(pr.policies || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [TABLES, FUNCTIONS, MVIEWS, MAPPINGS, OVERVIEW, POLICIES]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  // ---------------------------------------------------------------
  // Create / delete (real control commands)
  // ---------------------------------------------------------------
  const openCreate = useCallback((g: CreatableGroup) => {
    setCreateGroup(g); setCreateError(null);
    setCName(''); setCSchema('ts:datetime, tenant:string, value:long');
    setCSource(tables[0]?.name || ''); setCQuery(''); setCArgs('');
    setCKind('json'); setCMapping('[\n  { "column": "ts", "Properties": { "Path": "$.ts" } }\n]');
  }, [tables]);

  const submitCreate = useCallback(async () => {
    if (!createGroup || !cName.trim()) return;
    setBusy(true); setCreateError(null);
    const name = cName.trim();
    try {
      let route = TABLES; let payload: any = {};
      if (createGroup === 'table') { route = TABLES; payload = { name, schema: cSchema }; }
      else if (createGroup === 'function') { route = FUNCTIONS; payload = { name, args: cArgs, body: cQuery }; }
      else if (createGroup === 'mv') { route = MVIEWS; payload = { name, sourceTable: cSource, query: cQuery }; }
      else if (createGroup === 'mapping') { route = MAPPINGS; payload = { name, kind: cKind, table: cSource, mapping: cMapping }; }
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
  }, [createGroup, cName, cSchema, cSource, cQuery, cArgs, cKind, cMapping, TABLES, FUNCTIONS, MVIEWS, MAPPINGS, loadAll]);

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
            <code>https://&lt;cluster&gt;.kusto.windows.net</code>). The navigator stays here; objects
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
                <MenuItem icon={<MathFormula20Regular />} onClick={() => openCreate('function')}>Function</MenuItem>
                <MenuItem icon={<Table20Regular />} onClick={() => openCreate('mv')}>Materialized view</MenuItem>
                <MenuItem icon={<ArrowImport20Regular />} onClick={() => openCreate('mapping')}>Ingestion mapping</MenuItem>
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
                        <Tooltip content="Take 100" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`["${t.name}"]\n| take 100`)} aria-label={`Query ${t.name}`} /></Tooltip>
                        <Tooltip content="Drop table" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => del(TABLES, `name=${encodeURIComponent(t.name)}`)} aria-label={`Drop ${t.name}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Functions */}
          <TreeItem itemType="branch" value="g-functions">
            {groupHeader('Functions', <MathFormula20Regular />, functions.length, () => openCreate('function'), 'New function')}
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
            {groupHeader('Ingestion mappings', <ArrowImport20Regular />, mappings.length, () => openCreate('mapping'), 'New ingestion mapping')}
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
                ['Row-level security', '.alter table T policy row_level_security — RLS predicate per table; requires Database Admin, not wired.'],
                ['External tables', '.create external table — Blob/ADLS/SQL external tables (continuous-export targets); list/create not wired yet.'],
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

      {/* Create dialog */}
      <Dialog open={createGroup !== null} onOpenChange={(_, d) => { if (!d.open) setCreateGroup(null); }}>
        <DialogSurface style={{ maxWidth: 560 }}>
          <DialogBody>
            <DialogTitle>
              New {createGroup === 'table' ? 'table (.create table)'
                : createGroup === 'function' ? 'function (.create-or-alter function)'
                : createGroup === 'mv' ? 'materialized view (.create materialized-view)'
                : 'ingestion mapping (.create-or-alter … mapping)'}
            </DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Field label="Name" required>
                  <Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder={createGroup === 'mapping' ? 'EventMapping' : 'events'} />
                </Field>

                {createGroup === 'table' && (
                  <Field label="Schema (col:type, col:type, …)">
                    <Textarea value={cSchema} onChange={(_, d) => setCSchema(d.value)} rows={3} style={{ fontFamily: 'Consolas, monospace' }} />
                  </Field>
                )}

                {createGroup === 'function' && (
                  <>
                    <Field label="Argument list (e.g. days:int)">
                      <Input value={cArgs} onChange={(_, d) => setCArgs(d.value)} placeholder="days:int" />
                    </Field>
                    <Field label="Body (KQL)">
                      <Textarea value={cQuery} onChange={(_, d) => setCQuery(d.value)} rows={5} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events | where ts > ago(days*1d)" />
                    </Field>
                  </>
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
                  </>
                )}

                {createGroup === 'mapping' && (
                  <>
                    <Field label="Target table" required>
                      <Dropdown
                        placeholder={tables.length ? 'Select a table' : 'No tables — create one first'}
                        value={cSource} selectedOptions={cSource ? [cSource] : []}
                        onOptionSelect={(_, d) => setCSource(d.optionValue || '')}
                        disabled={!tables.length}
                      >
                        {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Kind">
                      <Dropdown value={cKind} selectedOptions={[cKind]} onOptionSelect={(_, d) => setCKind(d.optionValue || 'json')}>
                        {['csv', 'json', 'avro', 'parquet', 'orc', 'w3clogfile'].map((k) => <Option key={k} value={k} text={k}>{k}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Mapping (JSON: array of { column, datatype?, Properties })">
                      <Textarea value={cMapping} onChange={(_, d) => setCMapping(d.value)} rows={6} style={{ fontFamily: 'Consolas, monospace' }} />
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
    </div>
  );
}
