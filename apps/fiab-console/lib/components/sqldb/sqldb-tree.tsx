'use client';

/**
 * SqlDbTree — the Azure SQL Database / Fabric SQL database **schema object**
 * navigator. The T-SQL equivalent of the ADX KQL-database / Databricks
 * workspace navigators: a typed left-pane tree of the connected database's
 * objects, one group per object type with a live count, a filter box, a
 * ＋ New affordance, and a full **Fluent context menu per node** (Select top
 * 1000, Data preview, New query, New query in notebook, Rename, Script as
 * CREATE/ALTER/DROP, Delete, Refresh) — matching the SSMS / Azure portal
 * Query-editor object tree with the Loom (Fluent v9) theme applied.
 *
 * Every count comes from a real `sys.*` catalog query over TDS; every drop /
 * rename is a real, catalog-verified statement (the object name is looked up
 * by id in the catalog, never string-injected). `Script as …` emits real DDL
 * from `sys.sql_modules.definition` (views/procs/fns) or reconstructed from
 * `sys.columns`/`sys.key_constraints`/`sys.indexes` (tables/table-types); the
 * generated script is loaded into the editor's Query tab. `Data preview` runs a
 * real `SELECT TOP 1000` and renders it in a sortable/filterable grid. The
 * Indexes sub-node lists real `sys.indexes` rows (key + INCLUDE columns).
 *
 * Object creation is routed to the editor's T-SQL **Query** tab (CREATE
 * templates) — the portal Query editor authors objects the same way.
 *
 * When no connection is bound and no env default is set, the routes 503 and
 * the whole tree shows a single honest infra-gate MessageBar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Tree, TreeItem, TreeItemLayout,
  Button, Input, Field, Caption1, Badge, Spinner,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuDivider,
  Tooltip, MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync16Regular, Delete16Regular,
  Table20Regular, DocumentText20Regular, MathFormula20Regular,
  Open16Regular, Search20Regular, Warning20Regular,
  Database20Regular, Folder20Regular, Column20Regular,
  ContentView20Regular, MoreHorizontal20Regular, Rename16Regular,
  Code20Regular, Notebook20Regular, TableSearch20Regular, KeyMultiple20Regular,
} from '@fluentui/react-icons';
import { LoomDataTable } from '@/lib/components/ui/loom-data-table';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: 8, padding: 8, height: '100%', minWidth: 264 },
  header: { display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'space-between' },
  title: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  groupLayout: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  groupActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  leafRow: { display: 'flex', alignItems: 'center', gap: 4, width: '100%' },
  leafActions: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 },
  colRow: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 },
  ixRow: { display: 'flex', alignItems: 'center', gap: 6, width: '100%' },
  previewSurface: { maxWidth: '92vw', width: '92vw', display: 'flex', flexDirection: 'column' },
  previewBody: { flex: 1, minHeight: 0, overflow: 'auto', maxHeight: '64vh' },
  mono: { fontFamily: 'Consolas, monospace', fontSize: 12, color: tokens.colorNeutralForeground3 },
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
export interface SqlIndexRow {
  indexId: number; name: string; type: number; typeDesc: string;
  isUnique: boolean; isPrimaryKey: boolean; isUniqueConstraint: boolean;
  filterDefinition: string | null; keyColumns: string; includeColumns: string;
}

type CreatableGroup = 'table' | 'view' | 'procedure' | 'function';
type RenameableGroup = 'table' | 'view' | 'procedure' | 'function';
type ScriptGroup = 'table' | 'view' | 'procedure' | 'function' | 'table-type' | 'index';
type ScriptVariant = 'CREATE' | 'ALTER' | 'DROP';

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
  /** Open a new notebook pre-filled with the given SQL (deep-link). */
  onOpenInNotebook?: (sql: string) => void;
  /** Increment to force a refresh from the parent. */
  refreshKey?: number;
}

const CREATE_TEMPLATES: Record<CreatableGroup, string> = {
  table:
`-- New table. Edit and run from the Query tab.
CREATE TABLE dbo.NewTable (
    Id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    Name      NVARCHAR(200)     NOT NULL,
    CreatedAt DATETIME2         NOT NULL DEFAULT SYSUTCDATETIME()
);`,
  view:
`-- New view. Edit and run from the Query tab.
CREATE VIEW dbo.NewView
AS
SELECT TOP 100 *
FROM dbo.NewTable;`,
  procedure:
`-- New stored procedure. Edit and run from the Query tab.
CREATE PROCEDURE dbo.NewProcedure
    @Id INT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM dbo.NewTable WHERE Id = @Id;
END;`,
  function:
`-- New inline table-valued function. Edit and run from the Query tab.
CREATE FUNCTION dbo.NewFunction (@Id INT)
RETURNS TABLE
AS
RETURN (
    SELECT * FROM dbo.NewTable WHERE Id = @Id
);`,
};

/** Build a Python notebook cell template that runs the given SQL via pyodbc. */
function notebookCell(sql: string): string {
  return [
    '# Auto-generated from the SQL Database Object Explorer.',
    '# Set your connection string (Azure SQL / Fabric SQL share the TDS engine).',
    'import pyodbc, pandas as pd',
    '# conn = pyodbc.connect("Driver={ODBC Driver 18 for SQL Server};Server=...;Database=...;Authentication=ActiveDirectoryMsi;")',
    `sql = """${sql}"""`,
    '# df = pd.read_sql(sql, conn)',
    '# display(df)',
  ].join('\n');
}

/** A typed, SSMS/portal-faithful Azure SQL / Fabric SQL object navigator. */
export function SqlDbTree({ workspaceId, itemId, server, database, onOpenQuery, onOpenInNotebook, refreshKey = 0 }: SqlDbTreeProps) {
  const s = useStyles();
  const router = useRouter();

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

  // per-table column + index caches (lazy on expand)
  const [cols, setCols] = useState<Record<number, SqlColumnRow[] | 'loading' | { error: string }>>({});
  const [indexes, setIndexes] = useState<Record<number, SqlIndexRow[] | 'loading' | { error: string }>>({});

  // Data preview dialog
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewName, setPreviewName] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ columns: string[]; rows: unknown[][]; truncated: boolean } | null>(null);

  // Rename dialog
  const [renameState, setRenameState] = useState<{ objectId: number; currentName: string; group: RenameableGroup } | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [renameWarn, setRenameWarn] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  function applyGate(body: any): boolean {
    if (body?.code === 'not_configured' && body?.missing) {
      setGate({ missing: body.missing, error: body.error }); return true;
    }
    return false;
  }

  const loadAll = useCallback(async () => {
    setLoading(true); setError(null); setCols({}); setIndexes({});
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

  const loadIndexes = useCallback(async (objectId: number) => {
    setIndexes((ix) => ({ ...ix, [objectId]: 'loading' }));
    try {
      const body = await fetch(`/api/sqldb/indexes?${q}&objectId=${objectId}`).then(readJson);
      if (body.ok) setIndexes((ix) => ({ ...ix, [objectId]: body.indexes || [] }));
      else setIndexes((ix) => ({ ...ix, [objectId]: { error: body.error || 'failed to load indexes' } }));
    } catch (e: any) {
      setIndexes((ix) => ({ ...ix, [objectId]: { error: e?.message || String(e) } }));
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

  const dropIndex = useCallback(async (tableObjectId: number, indexId: number, label: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Drop index ${label}? This cannot be undone.`)) return;
    setBusy(true); setError(null);
    try {
      const body = await fetch(`/api/sqldb/indexes?${q}&objectId=${tableObjectId}&indexId=${indexId}`, { method: 'DELETE' }).then(readJson);
      if (!body.ok) { setError(body.error || 'drop index failed'); setBusy(false); return; }
      await loadIndexes(tableObjectId);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [q, loadIndexes]);

  const newObject = useCallback((g: CreatableGroup) => {
    onOpenQuery?.(CREATE_TEMPLATES[g]);
  }, [onOpenQuery]);

  const openQuery = useCallback((sql: string) => { onOpenQuery?.(sql); }, [onOpenQuery]);

  const openInNotebook = useCallback((sql: string) => {
    if (onOpenInNotebook) { onOpenInNotebook(sql); return; }
    // Standalone fallback: stash the prefill + route to a new notebook (the
    // notebook editor reads `loom.notebook.prefill` from localStorage on mount).
    try {
      localStorage.setItem('loom.notebook.prefill', JSON.stringify({ source: 'sql-db', sql, code: notebookCell(sql) }));
    } catch { /* ignore */ }
    router.push('/items/notebook/new?source=sql-db');
  }, [onOpenInNotebook, router]);

  const scriptAs = useCallback(async (group: ScriptGroup, objectId: number, variant: ScriptVariant, indexId?: number) => {
    setBusy(true); setError(null);
    try {
      const ixp = indexId != null ? `&indexId=${indexId}` : '';
      const body = await fetch(`/api/sqldb/script?${q}&objectId=${objectId}&group=${group}&variant=${variant}${ixp}`).then(readJson);
      if (body.ok && typeof body.script === 'string') openQuery(body.script);
      else setError(body.error || 'script generation failed');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [q, openQuery]);

  const openPreview = useCallback(async (objectId: number, fullName: string) => {
    setPreviewOpen(true); setPreviewName(fullName);
    setPreviewLoading(true); setPreviewData(null); setPreviewError(null);
    try {
      const body = await fetch(`/api/sqldb/preview?${q}&objectId=${objectId}&top=1000`).then(readJson);
      if (body.ok) setPreviewData({ columns: body.columns || [], rows: body.rows || [], truncated: !!body.truncated });
      else setPreviewError(body.error || 'preview failed');
    } catch (e: any) { setPreviewError(e?.message || String(e)); }
    finally { setPreviewLoading(false); }
  }, [q]);

  const openRename = useCallback((objectId: number, currentName: string, group: RenameableGroup) => {
    setRenameState({ objectId, currentName, group });
    setRenameTo(currentName.split('.').pop() || currentName); // bare name, no schema
    setRenameError(null);
    setRenameWarn(
      group === 'view' || group === 'procedure' || group === 'function'
        ? 'sp_rename does not update this object’s definition body (sys.sql_modules). '
          + 'Microsoft recommends DROP + CREATE to keep the definition in sync — the rename still applies to the object name.'
        : '',
    );
  }, []);

  const doRename = useCallback(async () => {
    if (!renameState) return;
    setBusy(true); setRenameError(null);
    try {
      const body = await fetch(`/api/sqldb/rename?${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group: renameState.group, objectId: renameState.objectId, newName: renameTo }),
      }).then(readJson);
      if (!body.ok) { setRenameError(body.error || 'rename failed'); setBusy(false); return; }
      setRenameState(null);
      await loadAll(); // re-list verifies the new name appears
    } catch (e: any) { setRenameError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [renameState, renameTo, q, loadAll]);

  // filtering
  const f = filter.trim().toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const fTables = useMemo(() => tables.filter((t) => match(t.fullName)), [tables, f]);
  const fViews = useMemo(() => views.filter((t) => match(t.fullName)), [views, f]);
  const fProcs = useMemo(() => procs.filter((t) => match(t.fullName)), [procs, f]);
  const fFuncs = useMemo(() => funcs.filter((t) => match(t.fullName)), [funcs, f]);
  const fSchemas = useMemo(() => schemas.filter((t) => match(t.name)), [schemas, f]);
  const fTableTypes = useMemo(() => tableTypes.filter((t) => match(t.fullName)), [tableTypes, f]);

  /** A node "…" context menu button wrapping a MenuList of actions. */
  const nodeMenu = (label: string, items: React.ReactNode) => (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="More actions" relationship="label">
          <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`${label} actions`} disabled={busy} />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>{items}</MenuList>
      </MenuPopover>
    </Menu>
  );

  /** A nested "Script as ▸ CREATE/ALTER/DROP" submenu. */
  const scriptSubmenu = (group: ScriptGroup, objectId: number, variants: ScriptVariant[], indexId?: number) => (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <MenuItem icon={<Code20Regular />}>Script as</MenuItem>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {variants.map((v) => (
            <MenuItem key={v} onClick={() => scriptAs(group, objectId, v, indexId)}>{v}</MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );

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
            (or a database user with <code>VIEW DEFINITION</code> + <code>ALTER</code> for drops/renames).
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
          {/* Tables (expand → columns + indexes) */}
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
                        {nodeMenu(t.fullName, (
                          <>
                            <MenuItem icon={<Open16Regular />} onClick={() => openQuery(`SELECT TOP 1000 * FROM [${t.schema}].[${t.name}];`)}>Select top 1000</MenuItem>
                            <MenuItem icon={<TableSearch20Regular />} onClick={() => openPreview(t.objectId, t.fullName)}>Data preview</MenuItem>
                            <MenuItem icon={<Open16Regular />} onClick={() => openQuery(`SELECT * FROM [${t.schema}].[${t.name}] WHERE 1 = 1;`)}>New query</MenuItem>
                            <MenuItem icon={<Notebook20Regular />} onClick={() => openInNotebook(`SELECT TOP 1000 * FROM [${t.schema}].[${t.name}];`)}>New query in notebook</MenuItem>
                            <MenuDivider />
                            <MenuItem icon={<Rename16Regular />} onClick={() => openRename(t.objectId, t.fullName, 'table')}>Rename</MenuItem>
                            {scriptSubmenu('table', t.objectId, ['CREATE', 'ALTER', 'DROP'])}
                            <MenuDivider />
                            <MenuItem icon={<Delete16Regular />} onClick={() => drop(TABLES, t.objectId, `table ${t.fullName}`)}>Delete</MenuItem>
                            <MenuItem icon={<ArrowSync16Regular />} onClick={() => loadAll()}>Refresh</MenuItem>
                          </>
                        ))}
                      </span>
                    </span>
                  </TreeItemLayout>
                  <Tree>
                    {/* Columns */}
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

                    {/* Indexes */}
                    <TreeItem
                      itemType="branch" value={`t-${t.objectId}-idxs`}
                      onOpenChange={(_, data) => { if (data.open && indexes[t.objectId] === undefined) loadIndexes(t.objectId); }}
                    >
                      <TreeItemLayout iconBefore={<KeyMultiple20Regular />}>
                        <span className={s.groupLayout}>
                          <span>Indexes</span>
                          <span className={s.groupActions} onClick={(e) => e.stopPropagation()}>
                            <Tooltip content="Refresh indexes" relationship="label">
                              <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => loadIndexes(t.objectId)} disabled={busy} aria-label={`Refresh indexes for ${t.fullName}`} />
                            </Tooltip>
                          </span>
                        </span>
                      </TreeItemLayout>
                      <Tree>
                        {indexes[t.objectId] === undefined && <TreeItem itemType="leaf" value={`t-${t.objectId}-iload`}><TreeItemLayout><Caption1>Expand to load…</Caption1></TreeItemLayout></TreeItem>}
                        {indexes[t.objectId] === 'loading' && <TreeItem itemType="leaf" value={`t-${t.objectId}-ispin`}><TreeItemLayout><Spinner size="tiny" label="Loading indexes…" /></TreeItemLayout></TreeItem>}
                        {indexes[t.objectId] && typeof indexes[t.objectId] === 'object' && 'error' in (indexes[t.objectId] as any) && (
                          <TreeItem itemType="leaf" value={`t-${t.objectId}-ierr`}><TreeItemLayout iconBefore={<Warning20Regular />}><Caption1>{(indexes[t.objectId] as any).error}</Caption1></TreeItemLayout></TreeItem>
                        )}
                        {Array.isArray(indexes[t.objectId]) && (indexes[t.objectId] as SqlIndexRow[]).map((ix) => (
                          <TreeItem key={ix.indexId} itemType="leaf" value={`t-${t.objectId}-ix-${ix.indexId}`}>
                            <TreeItemLayout iconBefore={<KeyMultiple20Regular />}>
                              <span className={s.ixRow}>
                                <span>{ix.name}</span>
                                {ix.isPrimaryKey && <Badge size="small" appearance="tint" color="brand">PK</Badge>}
                                {ix.isUnique && !ix.isPrimaryKey && <Badge size="small" appearance="outline">unique</Badge>}
                                <Caption1>{ix.typeDesc.toLowerCase().replace(/_/g, ' ')}</Caption1>
                                {ix.keyColumns && <Caption1 className={s.mono}>({ix.keyColumns})</Caption1>}
                                <span className={s.leafActions} onClick={(e) => e.stopPropagation()}>
                                  {nodeMenu(`index ${ix.name}`, (
                                    <>
                                      {scriptSubmenu('index', t.objectId, ['CREATE', 'DROP'], ix.indexId)}
                                      {!ix.isPrimaryKey && (
                                        <>
                                          <MenuDivider />
                                          <MenuItem icon={<Delete16Regular />} onClick={() => dropIndex(t.objectId, ix.indexId, `${ix.name} on ${t.fullName}`)}>Delete</MenuItem>
                                        </>
                                      )}
                                    </>
                                  ))}
                                </span>
                              </span>
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                        {Array.isArray(indexes[t.objectId]) && (indexes[t.objectId] as SqlIndexRow[]).length === 0 && (
                          <TreeItem itemType="leaf" value={`t-${t.objectId}-inone`}><TreeItemLayout><Caption1>No indexes (heap)</Caption1></TreeItemLayout></TreeItem>
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
                        {nodeMenu(v.fullName, (
                          <>
                            <MenuItem icon={<Open16Regular />} onClick={() => openQuery(`SELECT TOP 1000 * FROM [${v.schema}].[${v.name}];`)}>Select top 1000</MenuItem>
                            <MenuItem icon={<TableSearch20Regular />} onClick={() => openPreview(v.objectId, v.fullName)}>Data preview</MenuItem>
                            <MenuItem icon={<Notebook20Regular />} onClick={() => openInNotebook(`SELECT TOP 1000 * FROM [${v.schema}].[${v.name}];`)}>New query in notebook</MenuItem>
                            <MenuDivider />
                            <MenuItem icon={<Rename16Regular />} onClick={() => openRename(v.objectId, v.fullName, 'view')}>Rename</MenuItem>
                            {scriptSubmenu('view', v.objectId, ['CREATE', 'ALTER', 'DROP'])}
                            <MenuDivider />
                            <MenuItem icon={<Delete16Regular />} onClick={() => drop(VIEWS, v.objectId, `view ${v.fullName}`)}>Delete</MenuItem>
                            <MenuItem icon={<ArrowSync16Regular />} onClick={() => loadAll()}>Refresh</MenuItem>
                          </>
                        ))}
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
                        {nodeMenu(p.fullName, (
                          <>
                            <MenuItem icon={<Open16Regular />} onClick={() => openQuery(`EXEC [${p.schema}].[${p.name}];`)}>EXEC template</MenuItem>
                            <MenuItem icon={<Notebook20Regular />} onClick={() => openInNotebook(`EXEC [${p.schema}].[${p.name}];`)}>New query in notebook</MenuItem>
                            <MenuDivider />
                            <MenuItem icon={<Rename16Regular />} onClick={() => openRename(p.objectId, p.fullName, 'procedure')}>Rename</MenuItem>
                            {scriptSubmenu('procedure', p.objectId, ['CREATE', 'ALTER', 'DROP'])}
                            <MenuDivider />
                            <MenuItem icon={<Delete16Regular />} onClick={() => drop(PROCS, p.objectId, `procedure ${p.fullName}`)}>Delete</MenuItem>
                            <MenuItem icon={<ArrowSync16Regular />} onClick={() => loadAll()}>Refresh</MenuItem>
                          </>
                        ))}
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
                        {nodeMenu(fn.fullName, (
                          <>
                            <MenuItem icon={<Notebook20Regular />} onClick={() => openInNotebook(`-- ${fn.fullName} (table-valued/scalar function)\nSELECT * FROM [${fn.schema}].[${fn.name}](/* args */);`)}>New query in notebook</MenuItem>
                            <MenuDivider />
                            <MenuItem icon={<Rename16Regular />} onClick={() => openRename(fn.objectId, fn.fullName, 'function')}>Rename</MenuItem>
                            {scriptSubmenu('function', fn.objectId, ['CREATE', 'ALTER', 'DROP'])}
                            <MenuDivider />
                            <MenuItem icon={<Delete16Regular />} onClick={() => drop(FUNCS, fn.objectId, `function ${fn.fullName}`)}>Delete</MenuItem>
                            <MenuItem icon={<ArrowSync16Regular />} onClick={() => loadAll()}>Refresh</MenuItem>
                          </>
                        ))}
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
                        {nodeMenu(tt.fullName, (
                          <>
                            {scriptSubmenu('table-type', tt.objectId, ['CREATE', 'DROP'])}
                            <MenuDivider />
                            <MenuItem icon={<Delete16Regular />} onClick={() => drop(TABLE_TYPES, tt.objectId, `table type ${tt.fullName}`)}>Delete</MenuItem>
                            <MenuItem icon={<ArrowSync16Regular />} onClick={() => loadAll()}>Refresh</MenuItem>
                          </>
                        ))}
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
                ['Keys & constraints', 'sys.key_constraints / sys.foreign_keys / sys.check_constraints — PK/FK/UNIQUE/CHECK authoring via ALTER TABLE in the Query tab; inline designer not wired.'],
                ['Data editing (edit rows)', 'The portal Edit-data grid (INSERT/UPDATE/DELETE) is not exposed here yet — use the Query tab for DML (Data preview is read-only).'],
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

      {/* Data preview dialog — real SELECT TOP 1000 in a sortable/filterable grid */}
      <Dialog open={previewOpen} onOpenChange={(_, d) => { if (!d.open) setPreviewOpen(false); }}>
        <DialogSurface className={s.previewSurface}>
          <DialogBody>
            <DialogTitle>Data preview — top 1000 rows{previewName ? <> · <code>{previewName}</code></> : null}</DialogTitle>
            <DialogContent className={s.previewBody}>
              {previewLoading && <Spinner size="small" label="Loading data…" />}
              {previewError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Preview failed</MessageBarTitle>{previewError}</MessageBarBody></MessageBar>}
              {previewData && !previewLoading && (
                previewData.columns.length === 0 ? (
                  <Caption1>No columns returned.</Caption1>
                ) : (
                  <>
                    {previewData.truncated && <MessageBar intent="info"><MessageBarBody>Showing the first rows (result truncated).</MessageBarBody></MessageBar>}
                    <LoomDataTable
                      ariaLabel={`Data preview for ${previewName}`}
                      getRowId={(r: any) => String(r.__rowid)}
                      columns={previewData.columns.map((c) => ({
                        key: c, label: c, sortable: true, filterable: true,
                        getValue: (r: any) => (r[c] == null ? '' : String(r[c])),
                        render: (r: any) => (r[c] == null ? <span className={s.mono}>NULL</span> : <span className={s.mono}>{String(r[c])}</span>),
                      }))}
                      rows={previewData.rows.map((row, i) => {
                        const obj: Record<string, unknown> = { __rowid: i };
                        previewData.columns.forEach((c, ci) => { obj[c] = row[ci]; });
                        return obj;
                      })}
                    />
                  </>
                )
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPreviewOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameState} onOpenChange={(_, d) => { if (!d.open) setRenameState(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Rename {renameState?.group} "{renameState?.currentName}"</DialogTitle>
            <DialogContent>
              {renameWarn && <MessageBar intent="warning"><MessageBarBody>{renameWarn}</MessageBarBody></MessageBar>}
              {renameError && <MessageBar intent="error"><MessageBarBody>{renameError}</MessageBarBody></MessageBar>}
              <Field label="New name (single-part identifier, no schema)">
                <Input value={renameTo} onChange={(_, d) => setRenameTo(d.value)} />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRenameState(null)}>Cancel</Button>
              <Button appearance="primary" onClick={doRename} disabled={busy || !renameTo.trim()}>{busy ? 'Renaming…' : 'Rename'}</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
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
