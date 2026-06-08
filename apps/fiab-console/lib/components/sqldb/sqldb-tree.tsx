'use client';

/**
 * SqlDbTree — the Azure SQL Database / Fabric SQL database **schema object**
 * navigator. The T-SQL equivalent of the ADX KQL-database / Databricks
 * workspace navigators: a typed left-pane tree of the connected database's
 * objects, one group per object type with a live count, a filter box, a
 * ＋ New affordance, inline drop, and an "open" action that loads a query
 * into the editor's query tab — matching the SSMS / Azure portal Query-editor
 * object tree with the Loom (Fluent v9) theme applied.
 *
 * Every count comes from a real `sys.*` catalog query over TDS; every drop is
 * a real, catalog-verified `DROP …` (the object name is looked up by id in
 * the catalog, never string-injected). Object enumeration is item-scoped via
 * `?workspaceId=&id=` (the Fabric SqlDatabase id), mirroring the ADX tree.
 *
 * Object creation is intentionally routed to the editor's T-SQL **Query** tab
 * (CREATE TABLE / CREATE PROCEDURE / CREATE VIEW / CREATE FUNCTION templates)
 * rather than faked as a form — the portal Query editor authors objects the
 * same way. Capabilities the Azure/SSMS UI exposes that we don't author from
 * this navigator yet (indexes, keys/constraints authoring, data editing,
 * query plan) render as honest ⚠️ "coming" rows naming the path — never a
 * fake list.
 *
 * When no connection is bound and no env default is set, the routes 503 and
 * the whole tree shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Table20Regular, DocumentText20Regular, MathFormula20Regular,
  Open16Regular, Search20Regular, Warning20Regular,
  Database20Regular, Folder20Regular, Column20Regular,
  ContentView20Regular, BranchRequest20Regular,
} from '@fluentui/react-icons';
import { CREATE_TEMPLATES, type CreatableGroup } from '@/lib/azure/sql-templates';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 264 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  colRow: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 },
});

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export interface SqlObjectRow {
  objectId: number; schema: string; name: string; fullName: string;
  type: string; typeDesc?: string; rowCount?: number;
}
interface SqlSchemaRow { schemaId: number; name: string }
interface SqlColumnRow {
  columnId: number; name: string; dataType: string; maxLength: number;
  precision: number; scale: number; isNullable: boolean; isIdentity: boolean;
  isComputed: boolean; isPrimaryKey: boolean;
}

export interface SqlDbTreeProps {
  /** Loom workspace id (to resolve the Fabric workspace). */
  workspaceId: string;
  /** The bound Fabric SqlDatabase item id (so routes resolve the right db). */
  itemId: string;
  /**
   * Explicit Azure SQL server FQDN override. When set, the navigator targets
   * this server/database directly (the Unified Azure SQL editor passes the
   * ARM-selected connection here) instead of resolving via the Fabric item.
   */
  server?: string;
  /** Explicit database override paired with {@link server}. */
  database?: string;
  /** Load a T-SQL statement into the editor's query tab. */
  onOpenQuery?: (sql: string) => void;
  /** Increment to force a refresh from the parent. */
  refreshKey?: number;
}

/** A typed, SSMS/portal-faithful Azure SQL / Fabric SQL object navigator. */
export function SqlDbTree({ workspaceId, itemId, server, database, onOpenQuery, refreshKey = 0 }: SqlDbTreeProps) {
  const s = useStyles();

  const q = useMemo(() => {
    const p = new URLSearchParams();
    if (itemId) p.set('id', itemId);
    if (workspaceId) p.set('workspaceId', workspaceId);
    // Explicit Azure SQL connection override (takes precedence in the guard).
    if (server) p.set('server', server);
    if (database) p.set('database', database);
    return p.toString();
  }, [itemId, workspaceId, server, database]);

  const TABLES = `/api/sqldb/tables?${q}`;
  const VIEWS = `/api/sqldb/views?${q}`;
  const PROCS = `/api/sqldb/procedures?${q}`;
  const FUNCS = `/api/sqldb/functions?${q}`;
  const SCHEMAS = `/api/sqldb/schemas?${q}`;
  const TABLE_TYPES = `/api/sqldb/table-types?${q}`;

  const [filter, setFilter] = useState('');
  const [gate, setGate] = useState<{ missing: string; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolvedDb, setResolvedDb] = useState<string>('');
  const [tables, setTables] = useState<SqlObjectRow[]>([]);
  const [views, setViews] = useState<SqlObjectRow[]>([]);
  const [procs, setProcs] = useState<SqlObjectRow[]>([]);
  const [funcs, setFuncs] = useState<SqlObjectRow[]>([]);
  const [schemas, setSchemas] = useState<SqlSchemaRow[]>([]);
  const [tableTypes, setTableTypes] = useState<SqlObjectRow[]>([]);

  // per-table column cache (lazy on expand)
  const [cols, setCols] = useState<Record<number, SqlColumnRow[] | 'loading' | { error: string }>>({});

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setGate({ missing: body.missing, error: body.error }); return true;
    }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null); setCols({});
    try {
      const [tr, vr, pr, fr, sr, ttr] = await Promise.all([
        fetch(TABLES).then(readJson),
        fetch(VIEWS).then(readJson),
        fetch(PROCS).then(readJson),
        fetch(FUNCS).then(readJson),
        fetch(SCHEMAS).then(readJson),
        fetch(TABLE_TYPES).then(readJson),
      ]);
      for (const b of [tr, vr, pr, fr, sr, ttr]) { if (applyGate(b)) { setLoading(false); return; } }
      setGate(null);
      if (tr.ok) { setTables(tr.tables || []); setResolvedDb(tr.database || ''); }
      else setError(tr.error || 'failed to list tables');
      if (vr.ok) setViews(vr.views || []);
      if (pr.ok) setProcs(pr.procedures || []);
      if (fr.ok) setFuncs(fr.functions || []);
      if (sr.ok) setSchemas(sr.schemas || []);
      if (ttr.ok) setTableTypes(ttr.tableTypes || []);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [TABLES, VIEWS, PROCS, FUNCS, SCHEMAS, TABLE_TYPES]);

  useEffect(() => { loadAll(); }, [loadAll, refreshKey]);

  const loadColumns = useCallback(async (objectId: number) => {
    setCols((c) => ({ ...c, [objectId]: 'loading' }));
    try {
      const body = await fetch(`/api/sqldb/columns?${q}&objectId=${objectId}`).then(readJson);
      if (body.ok) setCols((c) => ({ ...c, [objectId]: body.columns || [] }));
      else setCols((c) => ({ ...c, [objectId]: { error: body.error || 'failed to load columns' } }));
    } catch (e: any) {
      setCols((c) => ({ ...c, [objectId]: { error: e?.message || String(e) } }));
    }
  }, [q]);

  const drop = useCallback(async (route: string, objectId: number, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Drop ${label}? This cannot be undone.`)) return;
    setBusy(true); setError(null);
    try {
      const sep = route.includes('?') ? '&' : '?';
      const body = await fetch(`${route}${sep}objectId=${objectId}`, { method: 'DELETE' }).then(readJson);
      if (applyGate(body)) { setBusy(false); return; }
      if (!body.ok) { setError(body.error || 'drop failed'); setBusy(false); return; }
      await loadAll();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadAll]);

  const newObject = useCallback((g: CreatableGroup) => {
    onOpenQuery?.(CREATE_TEMPLATES[g]);
  }, [onOpenQuery]);

  // filtering
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fTables = useMemo(() => tables.filter((t) => match(t.fullName)), [tables, f]);
  const fViews = useMemo(() => views.filter((t) => match(t.fullName)), [views, f]);
  const fProcs = useMemo(() => procs.filter((t) => match(t.fullName)), [procs, f]);
  const fFuncs = useMemo(() => funcs.filter((t) => match(t.fullName)), [funcs, f]);
  const fSchemas = useMemo(() => schemas.filter((t) => match(t.name)), [schemas, f]);
  const fTableTypes = useMemo(() => tableTypes.filter((t) => match(t.fullName)), [tableTypes, f]);

  const openQuery = (sql: string) => onOpenQuery?.(sql);

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
        <div className={s.header}><span className={s.title}>SQL database objects</span></div>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>SQL connection not configured</MessageBarTitle>
            {gate.error || 'No reachable Azure SQL / Fabric SQL connection.'}{' '}
            Set <code>{gate.missing}</code> (or bind a connection on this SQL database item).
            The navigator stays here; objects appear once the database is reachable over TDS.
            The Loom UAMI must be an <strong>Microsoft Entra admin</strong> on the SQL server
            (or a database user with <code>VIEW DEFINITION</code> + <code>ALTER</code> for drops).
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.title}>{resolvedDb ? <>Database · <code>{resolvedDb}</code></> : 'SQL database objects'}</span>
        <span style={{ display: 'flex', gap: 2 }}>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Tooltip content="New (opens a template in the Query tab)" relationship="label">
                <Button size="small" appearance="primary" icon={<Add20Regular />} aria-label="New object" disabled={!onOpenQuery} />
              </Tooltip>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Table20Regular />} onClick={() => newObject('table')}>Table</MenuItem>
                <MenuItem icon={<ContentView20Regular />} onClick={() => newObject('view')}>View</MenuItem>
                <MenuItem icon={<DocumentText20Regular />} onClick={() => newObject('procedure')}>Stored procedure</MenuItem>
                <MenuItem icon={<MathFormula20Regular />} onClick={() => newObject('function')}>Function</MenuItem>
                <MenuItem icon={<BranchRequest20Regular />} onClick={() => newObject('index')}>Index</MenuItem>
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
        <Tree aria-label="SQL database objects" defaultOpenItems={['g-tables']}>
          {/* Tables (expand → columns) */}
          <TreeItem itemType="branch" value="g-tables">
            {groupHeader('Tables', <Table20Regular />, tables.length, onOpenQuery ? () => newObject('table') : undefined, 'New table (opens a CREATE TABLE template)')}
            <Tree>
              {fTables.length === 0 && <TreeItem itemType="leaf" value="t-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No tables yet'}</Caption1></TreeItemLayout></TreeItem>}
              {fTables.map((t) => (
                <TreeItem
                  key={t.objectId} itemType="branch" value={`t-${t.objectId}`}
                  onOpenChange={(_, data) => { if (data.open && cols[t.objectId] === undefined) loadColumns(t.objectId); }}
                >
                  <TreeItemLayout iconBefore={<Table20Regular />}>
                    <span className={s.leafRow}>
                      <span>{t.fullName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        {typeof t.rowCount === 'number' && <Caption1>{t.rowCount.toLocaleString()} rows</Caption1>}
                        <Tooltip content="Select top 1000" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`SELECT TOP 1000 * FROM [${t.schema}].[${t.name}];`)} aria-label={`Query ${t.fullName}`} />
                        </Tooltip>
                        <Tooltip content="Drop table" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => drop(TABLES, t.objectId, `table ${t.fullName}`)} aria-label={`Drop ${t.fullName}`} />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                  <Tree>
                    <TreeItem itemType="branch" value={`t-${t.objectId}-cols`}>
                      <TreeItemLayout iconBefore={<Folder20Regular />}>Columns</TreeItemLayout>
                      <Tree>
                        {cols[t.objectId] === undefined && <TreeItem itemType="leaf" value={`t-${t.objectId}-cload`}><TreeItemLayout><Caption1>Expand to load…</Caption1></TreeItemLayout></TreeItem>}
                        {cols[t.objectId] === 'loading' && <TreeItem itemType="leaf" value={`t-${t.objectId}-cspin`}><TreeItemLayout><Spinner size="tiny" label="Loading columns…" /></TreeItemLayout></TreeItem>}
                        {cols[t.objectId] && typeof cols[t.objectId] === 'object' && 'error' in (cols[t.objectId] as any) && (
                          <TreeItem itemType="leaf" value={`t-${t.objectId}-cerr`}><TreeItemLayout iconBefore={<Warning20Regular />}><Caption1>{(cols[t.objectId] as any).error}</Caption1></TreeItemLayout></TreeItem>
                        )}
                        {Array.isArray(cols[t.objectId]) && (cols[t.objectId] as SqlColumnRow[]).map((c) => (
                          <TreeItem key={c.columnId} itemType="leaf" value={`t-${t.objectId}-c-${c.columnId}`}>
                            <TreeItemLayout iconBefore={<Column20Regular />}>
                              <span className={s.colRow}>
                                <span>{c.name}</span>
                                <Caption1>{formatType(c)}</Caption1>
                                {c.isPrimaryKey && <Badge size="small" appearance="tint" color="brand">PK</Badge>}
                                {c.isIdentity && <Badge size="small" appearance="outline">identity</Badge>}
                                {!c.isNullable && <Badge size="small" appearance="outline">not null</Badge>}
                                {c.isComputed && <Badge size="small" appearance="outline">computed</Badge>}
                              </span>
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                        {Array.isArray(cols[t.objectId]) && (cols[t.objectId] as SqlColumnRow[]).length === 0 && (
                          <TreeItem itemType="leaf" value={`t-${t.objectId}-cnone`}><TreeItemLayout><Caption1>No columns</Caption1></TreeItemLayout></TreeItem>
                        )}
                      </Tree>
                    </TreeItem>
                  </Tree>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Views */}
          <TreeItem itemType="branch" value="g-views">
            {groupHeader('Views', <ContentView20Regular />, views.length, onOpenQuery ? () => newObject('view') : undefined, 'New view (opens a CREATE VIEW template)')}
            <Tree>
              {fViews.length === 0 && <TreeItem itemType="leaf" value="v-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No views'}</Caption1></TreeItemLayout></TreeItem>}
              {fViews.map((v) => (
                <TreeItem key={v.objectId} itemType="leaf" value={`v-${v.objectId}`}>
                  <TreeItemLayout iconBefore={<ContentView20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        onClick={() => openQuery(`SELECT TOP 1000 * FROM [${v.schema}].[${v.name}];`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`SELECT TOP 1000 * FROM [${v.schema}].[${v.name}];`); } }}
                      >{v.fullName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Select top 1000" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`SELECT TOP 1000 * FROM [${v.schema}].[${v.name}];`)} aria-label={`Query ${v.fullName}`} /></Tooltip>
                        <Tooltip content="Drop view" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => drop(VIEWS, v.objectId, `view ${v.fullName}`)} aria-label={`Drop ${v.fullName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Stored procedures */}
          <TreeItem itemType="branch" value="g-procs">
            {groupHeader('Stored procedures', <DocumentText20Regular />, procs.length, onOpenQuery ? () => newObject('procedure') : undefined, 'New procedure (opens a CREATE PROCEDURE template)')}
            <Tree>
              {fProcs.length === 0 && <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No stored procedures'}</Caption1></TreeItemLayout></TreeItem>}
              {fProcs.map((p) => (
                <TreeItem key={p.objectId} itemType="leaf" value={`p-${p.objectId}`}>
                  <TreeItemLayout iconBefore={<DocumentText20Regular />}>
                    <span className={s.leafRow}>
                      <span role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        onClick={() => openQuery(`EXEC [${p.schema}].[${p.name}];`)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQuery(`EXEC [${p.schema}].[${p.name}];`); } }}
                      >{p.fullName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="EXEC template" relationship="label"><Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`EXEC [${p.schema}].[${p.name}];`)} aria-label={`Exec ${p.fullName}`} /></Tooltip>
                        <Tooltip content="Drop procedure" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => drop(PROCS, p.objectId, `procedure ${p.fullName}`)} aria-label={`Drop ${p.fullName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Functions */}
          <TreeItem itemType="branch" value="g-funcs">
            {groupHeader('Functions', <MathFormula20Regular />, funcs.length, onOpenQuery ? () => newObject('function') : undefined, 'New function (opens a CREATE FUNCTION template)')}
            <Tree>
              {fFuncs.length === 0 && <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No functions'}</Caption1></TreeItemLayout></TreeItem>}
              {fFuncs.map((fn) => (
                <TreeItem key={fn.objectId} itemType="leaf" value={`f-${fn.objectId}`}>
                  <TreeItemLayout iconBefore={<MathFormula20Regular />}>
                    <span className={s.leafRow}>
                      <span>{fn.fullName} {fn.typeDesc ? <Caption1>· {fn.typeDesc.toLowerCase().replace(/_/g, ' ')}</Caption1> : null}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Drop function" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => drop(FUNCS, fn.objectId, `function ${fn.fullName}`)} aria-label={`Drop ${fn.fullName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Table types */}
          <TreeItem itemType="branch" value="g-tabletypes">
            {groupHeader('Table types', <Table20Regular />, tableTypes.length, undefined)}
            <Tree>
              {fTableTypes.length === 0 && <TreeItem itemType="leaf" value="tt-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No user-defined table types'}</Caption1></TreeItemLayout></TreeItem>}
              {fTableTypes.map((tt) => (
                <TreeItem key={tt.objectId} itemType="leaf" value={`tt-${tt.objectId}`}>
                  <TreeItemLayout iconBefore={<Table20Regular />}>
                    <span className={s.leafRow}>
                      <span>{tt.fullName}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Drop table type" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busy} onClick={() => drop(TABLE_TYPES, tt.objectId, `table type ${tt.fullName}`)} aria-label={`Drop ${tt.fullName}`} /></Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Schemas (read-only) */}
          <TreeItem itemType="branch" value="g-schemas">
            {groupHeader('Schemas', <Database20Regular />, schemas.length, undefined)}
            <Tree>
              {fSchemas.length === 0 && <TreeItem itemType="leaf" value="s-empty"><TreeItemLayout><Caption1>{f ? 'No matches' : 'No user schemas'}</Caption1></TreeItemLayout></TreeItem>}
              {fSchemas.map((sc) => (
                <TreeItem key={sc.schemaId} itemType="leaf" value={`s-${sc.schemaId}`}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>
                    <span className={s.leafRow}>
                      <span>{sc.name}</span>
                      <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="CREATE SCHEMA / DROP SCHEMA run from the Query tab" relationship="label">
                          <Button size="small" appearance="subtle" icon={<Open16Regular />} onClick={() => openQuery(`-- CREATE SCHEMA [${sc.name}];  -- DROP SCHEMA [${sc.name}];`)} aria-label={`Schema ${sc.name} DDL`} />
                        </Tooltip>
                      </span>
                    </span>
                  </TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>

          {/* Honest gate rows — SSMS/portal exposes these; not authored from this navigator yet. */}
          <TreeItem itemType="branch" value="g-not-wired">
            <TreeItemLayout iconBefore={<Warning20Regular />}>Not yet wired</TreeItemLayout>
            <Tree>
              {[
                ['Indexes', 'sys.indexes / sys.index_columns — per-table index list + CREATE/DROP INDEX. Author via the Query tab (CREATE INDEX …) until inline authoring lands.'],
                ['Keys & constraints', 'sys.key_constraints / sys.foreign_keys / sys.check_constraints — PK/FK/UNIQUE/CHECK authoring via ALTER TABLE in the Query tab; inline designer not wired.'],
                ['Data editing (edit rows)', 'The portal Edit-data grid (INSERT/UPDATE/DELETE) is not exposed here yet — use the Query tab for DML.'],
                ['Query plan', 'SET SHOWPLAN_XML / estimated + actual execution plan visualization is not wired; run SET STATISTICS / SHOWPLAN from the Query tab.'],
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
    </div>
  );
}

function formatType(c: SqlColumnRow): string {
  const t = c.dataType.toLowerCase();
  if (['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(t)) {
    const len = c.maxLength === -1 ? 'max' : (t.startsWith('n') ? c.maxLength / 2 : c.maxLength);
    return `${t}(${len})`;
  }
  if (['decimal', 'numeric'].includes(t)) return `${t}(${c.precision},${c.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(t) && c.scale > 0) return `${t}(${c.scale})`;
  return t;
}
