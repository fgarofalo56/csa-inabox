'use client';

/**
 * SqlDatabaseEditor — Fabric-native SQL database (Microsoft.Fabric
 * SQLDatabase REST type) focused editor.
 *
 * Tabs: Tables · Query · Mirroring · Properties
 *
 * The Fabric SQL database is an Azure SQL DB with Fabric-managed mirroring
 * on top. List / get / create / delete go through Fabric REST
 * `/v1/workspaces/{ws}/SqlDatabases`. T-SQL Tables/Query reuse the existing
 * azure-sql-database routes when the connection string is exposed, since
 * the engine is the same.
 *
 * Per .claude/rules/no-vaporware.md: every action calls a real Fabric REST
 * endpoint or surfaces an honest MessageBar if the Loom workspace doesn't
 * yet have a Fabric workspace attached.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Field,
  Tree, TreeItem, TreeItemLayout, Select,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Database20Regular, Delete20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { TsqlMonaco } from '@/lib/editors/components/tsql-monaco';
import { SqlDbTree } from '@/lib/components/sqldb/sqldb-tree';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: tokens.spacingVerticalS },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '240px' },
  propsPane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0, maxWidth: '100%' },
  breakAll: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
});

interface WorkspaceLite { id: string; name: string }
interface SqlDbLite { id: string; displayName: string; description?: string }

interface QueryResp {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  error?: string;
  code?: string;
}

interface Props { item: FabricItemType; id: string }

export function SqlDatabaseEditor({ item, id }: Props) {
  const s = useStyles();
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [fabricWsId, setFabricWsId] = useState<string | null>(null);
  const [dbs, setDbs] = useState<SqlDbLite[] | null>(null);
  const [dbId, setDbId] = useState(id !== 'new' ? id : '');
  const [active, setActive] = useState<SqlDbLite | null>(null);
  const [tab, setTab] = useState<string>('tables');
  const [listErr, setListErr] = useState<{ error: string; code?: string; hint?: string } | null>(null);

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  // Query state
  const [sqlText, setSqlText] = useState<string>(
    `-- Fabric SQL DB query. Runs against the underlying Azure SQL engine.
-- The BFF dispatches through /api/items/azure-sql-database/[id]/query.
SELECT TOP 100 *
FROM sys.tables
WHERE is_ms_shipped = 0;`,
  );
  const [sqlResult, setSqlResult] = useState<QueryResp | null>(null);
  const [sqlBusy, setSqlBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/loom/workspaces').then(r => r.json()).then(j => {
      if (j.ok) setWorkspaces(j.workspaces || []);
      else setWorkspaces([]);
    }).catch(() => setWorkspaces([]));
  }, []);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await fetch(`/api/items/sql-database?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) {
        setListErr({ error: j.error, code: j.code, hint: j.hint });
        setDbs([]); setFabricWsId(null);
        return;
      }
      setFabricWsId(j.fabricWorkspaceId || null);
      setDbs(j.sqlDatabases || []);
      if (!dbId && (j.sqlDatabases || []).length) setDbId(j.sqlDatabases[0].id);
    } catch (e: any) {
      setListErr({ error: e?.message || String(e) });
      setDbs([]);
    }
  }, [dbId]);

  const loadDetail = useCallback(async (wsId: string, dId: string) => {
    try {
      const r = await fetch(`/api/items/sql-database/${encodeURIComponent(dId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActive(null); return; }
      setActive(j.sqlDatabase);
    } catch { setActive(null); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && dbId) loadDetail(workspaceId, dbId); }, [workspaceId, dbId, loadDetail]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim()) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await fetch(`/api/items/sql-database?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: cName.trim(), description: cDesc.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCName(''); setCDesc('');
      setActionMsg(`Create accepted — Fabric may take ~30s to provision`);
      await loadList(workspaceId);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cDesc, loadList]);

  const runSql = useCallback(async (sqlOverride?: string) => {
    if (!dbId) return;
    const sqlToRun = sqlOverride ?? sqlText;
    setSqlBusy(true); setSqlResult(null);
    try {
      // The Fabric SQL DB shares the engine with Azure SQL DB; route through
      // the existing azure-sql-database query path.
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(dbId)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlToRun }),
      });
      const j = (await r.json()) as QueryResp;
      setSqlResult(j);
    } catch (e: any) { setSqlResult({ ok: false, error: e?.message || String(e) }); }
    finally { setSqlBusy(false); }
  }, [dbId, sqlText]);

  const openInQuery = useCallback((sql: string) => {
    setSqlText(sql);
    setTab('query');
  }, []);

  const openInNotebook = useCallback((sql: string) => {
    // Deep-link a new notebook pre-filled with the SQL (read on mount via
    // localStorage `loom.notebook.prefill`, same pattern as the lakehouse editor).
    const code = [
      '# Auto-generated from the SQL Database Object Explorer.',
      'import pyodbc, pandas as pd',
      '# conn = pyodbc.connect("Driver={ODBC Driver 18 for SQL Server};Server=...;Database=...;Authentication=ActiveDirectoryMsi;")',
      `sql = """${sql}"""`,
      '# df = pd.read_sql(sql, conn)',
      '# display(df)',
    ].join('\n');
    try {
      localStorage.setItem('loom.notebook.prefill', JSON.stringify({ source: 'sql-db', sql, code }));
    } catch { /* ignore */ }
    router.push('/items/notebook/new?source=sql-db');
  }, [router]);

  const del = useCallback(async () => {
    if (!workspaceId || !dbId) return;
    if (typeof window !== 'undefined' && !window.confirm('Delete this Fabric SQL database?')) return;
    const r = await fetch(`/api/items/sql-database/${encodeURIComponent(dbId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    const j = await r.json();
    if (!j.ok) { setActionMsg(`Delete failed: ${j.error}`); return; }
    setActionMsg('Delete accepted');
    setDbId(''); setActive(null);
    await loadList(workspaceId);
  }, [workspaceId, dbId, loadList]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Database', actions: [
        { label: 'New SQL DB', onClick: workspaceId && fabricWsId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId || !fabricWsId },
        { label: 'Refresh', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
        { label: 'Delete', onClick: dbId ? del : undefined, disabled: !dbId },
      ]},
      { label: 'Query', actions: [
        { label: 'Run', onClick: dbId && !sqlBusy ? () => runSql() : undefined, disabled: !dbId || sqlBusy },
        { label: 'Tables', onClick: () => setTab('tables'), disabled: !dbId },
        { label: 'Mirroring', onClick: () => setTab('mirroring'), disabled: !dbId },
      ]},
    ]},
  ], [workspaceId, dbId, fabricWsId, sqlBusy, runSql, del, loadList]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS }}>Fabric SQL DBs</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && dbs === null && <Spinner size="tiny" label="Loading…" />}
          {dbs && dbs.length === 0 && !listErr && <Caption1>No SQL databases yet.</Caption1>}
          <Tree aria-label="Fabric SQL DBs">
            {(dbs || []).map(d => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDbId(d.id)}>
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  {dbId === d.id ? <strong>{d.displayName}</strong> : d.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <>
          <div className={s.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="tables">Tables</Tab>
              <Tab value="query">Query</Tab>
              <Tab value="mirroring">Mirroring</Tab>
              <Tab value="properties">Properties</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">SQLDatabase</Badge>
              <div className={s.field}>
                <Caption1>Workspace</Caption1>
                <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(workspaces?.length ?? 0) === 0}>
                  {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
                  {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
              <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId || !fabricWsId}>New SQL DB</Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Create a Fabric SQL database</DialogTitle>
                    <DialogContent>
                      <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} /></Field>
                      <Field label="Description"><Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} /></Field>
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                      <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
              <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!workspaceId} onClick={() => workspaceId && loadList(workspaceId)}>Refresh</Button>
            </div>

            {listErr && (
              <MessageBar intent={listErr.code === 'NO_FABRIC_WS' ? 'warning' : 'error'}>
                <MessageBarBody className={s.breakAll}>
                  <MessageBarTitle>{listErr.code === 'NO_FABRIC_WS' ? 'No Fabric workspace attached' : 'Fabric error'}</MessageBarTitle>
                  {listErr.error}
                  {listErr.hint && <><br /><Caption1>{listErr.hint}</Caption1></>}
                </MessageBarBody>
              </MessageBar>
            )}
            {actionMsg && <MessageBar intent="info"><MessageBarBody>{actionMsg}</MessageBarBody></MessageBar>}

            {tab === 'tables' && (
              <>
                {!dbId && <Caption1>Select a SQL database from the left panel.</Caption1>}
                {dbId && workspaceId && (
                  <div style={{ flex: 1, minHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' }}>
                    <SqlDbTree
                      workspaceId={workspaceId}
                      itemId={dbId}
                      onOpenQuery={openInQuery}
                      onOpenInNotebook={openInNotebook}
                    />
                  </div>
                )}
              </>
            )}

            {tab === 'query' && (
              <>
                {!dbId && <Caption1>Select a database first.</Caption1>}
                {dbId && (
                  <>
                    <div className={s.toolbar}>
                      <Body1>T-SQL (runs through Azure SQL engine)</Body1>
                    </div>
                    <TsqlMonaco
                      value={sqlText}
                      onChange={setSqlText}
                      onRun={(sql) => runSql(sql)}
                      itemId={dbId}
                      workspaceId={workspaceId}
                      height={240}
                      busy={sqlBusy}
                    />
                    {sqlBusy && <Spinner size="small" label="Executing…" labelPosition="after" />}
                    {!sqlBusy && sqlResult && !sqlResult.ok && (
                      <MessageBar intent="error"><MessageBarBody className={s.breakAll}><MessageBarTitle>Query failed</MessageBarTitle>{sqlResult.error}</MessageBarBody></MessageBar>
                    )}
                    {!sqlBusy && sqlResult?.ok && (sqlResult.columns?.length ?? 0) > 0 && (
                      <div className={s.tableWrap}>
                        <Table aria-label="Query result" size="small">
                          <TableHeader><TableRow>
                            {(sqlResult.columns || []).map(c => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                          </TableRow></TableHeader>
                          <TableBody>
                            {(sqlResult.rows || []).map((row, i) => (
                              <TableRow key={i}>
                                {(sqlResult.columns || []).map((_, j) => (
                                  <TableCell key={j} className={s.cell}>{String((row as unknown[])[j] ?? 'NULL')}</TableCell>
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

            {tab === 'mirroring' && (
              <>
                {!dbId && <Caption1>Select a database first.</Caption1>}
                {dbId && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Auto-mirroring to OneLake</MessageBarTitle>
                      Fabric SQL databases auto-mirror to OneLake by default. The mirroring status surfaces in the <em>Mirrored Database</em> editor under the auto-generated mirror with id matching this SQL DB.
                    </MessageBarBody>
                  </MessageBar>
                )}
              </>
            )}

            {tab === 'properties' && active && (
              <div className={s.propsPane}>
                <Subtitle2 className={s.breakAll}>{active.displayName}</Subtitle2>
                <Caption1 className={s.breakAll}>id: <code>{active.id}</code></Caption1>
                {active.description && <Caption1 className={s.breakAll}>{active.description}</Caption1>}
                <Caption1 className={s.breakAll}>Fabric workspace: <code>{fabricWsId || '(not attached)'}</code></Caption1>
              </div>
            )}
          </div>
        </>
      }
    />
  );
}
