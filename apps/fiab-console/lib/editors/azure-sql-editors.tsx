'use client';

/**
 * Azure SQL family editors — Server, Database, Managed Instance, and SQL
 * Server 2025 Vector Index. Pattern mirrors `synapse-sql-editors.tsx` so
 * the muscle memory carries over: tree on left, ribbon up top, T-SQL
 * editor + results on the right.
 *
 * Real REST:
 *   - ARM list servers / databases / managed instances (azure-sql-client)
 *   - TDS + AAD MI query against <server>.database.<suffix>
 *   - Fabric mirroring toggle (deferred runtime by default)
 *   - Geo-replication PUT
 *   - SQL Server 2025 feature probe
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Label,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  TabList, Tab, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Server20Regular, Play20Regular, Add20Regular,
  ShieldKeyhole20Regular, Globe20Regular, Sparkle20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 200,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 200 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8 },
  formRow: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 },
});

interface QueryResponse {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  code?: string;
  sqlNumber?: number;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ResultsPanel({ result, loading }: { result: QueryResponse | null; loading: boolean }) {
  const s = useStyles();
  if (loading) return (<div className={s.resultBox}><Spinner size="small" label="Executing T-SQL…" labelPosition="after" /></div>);
  if (!result) return (<div className={s.resultBox}><Caption1>Click <strong>Run</strong> to execute.</Caption1></div>);
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  const rows = result.rows || [];
  const columns = result.columns || [];
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
      </div>
      {rows.length === 0 ? (
        <Caption1>Query returned no rows.</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Query results" size="small">
            <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => (<TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Server editor
// ============================================================
// Refresh list is wired to the inline refresh handler; Firewall + AAD
// admin render as disabled with reason (ARM mutation BFF deferred). See
// no-vaporware.md for the gate-with-reason pattern.

interface ServerInfo {
  id: string; name: string; location: string; fqdn: string;
  state?: string; administratorLogin?: string; publicNetworkAccess?: string; version?: string;
}

export function AzureSqlServerEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selected, setSelected] = useState<ServerInfo | null>(null);
  const [databases, setDatabases] = useState<Array<{ name: string; status?: string; sku?: any }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true); setError(null);
    fetch(`/api/items/azure-sql-server`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setServers(j.servers || []);
        else setError(j.error);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const pickServer = useCallback(async (sv: ServerInfo) => {
    setSelected(sv);
    setDatabases([]);
    try {
      const r = await fetch(`/api/items/azure-sql-server/${id}/databases?server=${encodeURIComponent(sv.name)}`);
      const j = await r.json();
      if (j.ok) setDatabases(j.databases || []);
      else setError(j.error);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [id]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Databases', actions: [
        { label: loading ? 'Refreshing…' : 'Refresh list', onClick: loading ? undefined : refresh, disabled: loading },
      ]},
      { label: 'Security', actions: [
        { label: 'Firewall', disabled: true, title: 'needs ARM mutation BFF (deferred)' },
        { label: 'AAD admin', disabled: true, title: 'needs ARM mutation BFF (deferred)' },
      ]},
    ]},
  ], [loading, refresh]);

  return (
    <ItemEditorChrome
      item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="SQL servers" defaultOpenItems={['servers']}>
            <TreeItem itemType="branch" value="servers">
              <TreeItemLayout iconBefore={<Server20Regular />}>Servers ({servers.length})</TreeItemLayout>
              <Tree>
                {loading && <TreeItem itemType="leaf" value="loading"><TreeItemLayout>Loading…</TreeItemLayout></TreeItem>}
                {servers.map((sv) => (
                  <TreeItem key={sv.id} itemType="leaf" value={sv.id} onClick={() => pickServer(sv)}>
                    <TreeItemLayout iconBefore={<Server20Regular />}>{sv.name}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {id === 'new' && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure SQL servers are provisioned out-of-band</MessageBarTitle>
                Servers are created via bicep (<code>Microsoft.Sql/servers</code>) or the Azure portal — not from inside
                Loom. This is a read-only registry view. Pick an existing server on the left, or run
                <code> az sql server create</code> first.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Button size="small" appearance="outline" onClick={refresh} disabled={loading}>Refresh list</Button>
            {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
          </div>
          {error && (
            <BackendStateBar error={error} title="Azure SQL" />
          )}
          {!selected ? (
            <Caption1>Pick a server on the left to inspect its databases.</Caption1>
          ) : (
            <>
              <Subtitle2>{selected.name}</Subtitle2>
              <div className={s.toolbar}>
                <Badge appearance="filled" color={selected.state === 'Ready' ? 'success' : 'informative'}>{selected.state || 'Unknown'}</Badge>
                <Badge appearance="outline">{selected.location}</Badge>
                <Badge appearance="outline">v{selected.version || '?'}</Badge>
                <Badge appearance="outline" color={selected.publicNetworkAccess === 'Disabled' ? 'success' : 'warning'}>
                  Public access: {selected.publicNetworkAccess || 'Unknown'}
                </Badge>
              </div>
              <Body1>FQDN: <code>{selected.fqdn}</code></Body1>
              <Body1>AAD admin login: <code>{selected.administratorLogin || '— set via Microsoft.Sql/servers/administrators —'}</code></Body1>

              <Subtitle2 style={{ marginTop: 12 }}>Databases ({databases.length})</Subtitle2>
              <div className={s.tableWrap}>
                <Table aria-label="Databases" size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>SKU</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {databases.map((d) => (
                      <TableRow key={d.name}>
                        <TableCell><strong>{d.name}</strong></TableCell>
                        <TableCell>{d.status || '—'}</TableCell>
                        <TableCell>{d.sku?.name || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Caption1>
                Server-level firewall + AAD admin mutation deferred to v3.x — provision via bicep
                (<code>Microsoft.Sql/servers/firewallRules</code>, <code>Microsoft.Sql/servers/administrators</code>).
              </Caption1>
            </>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// Database editor
// ============================================================

interface ServerLite { name: string; location?: string; fqdn?: string; state?: string }
interface DatabaseLite { name: string; status?: string; sku?: { name?: string } }

function useSqlServers() {
  const [servers, setServers] = useState<ServerLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/azure-sql-server');
        const j = await r.json();
        if (!j.ok) {
          setError(j.error || `HTTP ${r.status}`);
          setHint('Grant the Console UAMI the Reader role on the subscription, or provision a Microsoft.Sql/servers resource via bicep.');
          setServers([]);
        } else {
          setServers(j.servers || []);
        }
      } catch (e: any) {
        setError(e?.message || String(e));
        setServers([]);
      } finally { setLoading(false); }
    })();
  }, []);
  return { servers, error, hint, loading };
}

function useSqlDatabases(server: string) {
  const [databases, setDatabases] = useState<DatabaseLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!server) { setDatabases(null); setError(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        // The /api/items/azure-sql-server/[id]/databases route only reads
        // the ?server= query param, not the [id] path segment — use a
        // stable "current" placeholder so the route is satisfied.
        const r = await fetch(`/api/items/azure-sql-server/current/databases?server=${encodeURIComponent(server)}`);
        if (cancelled) return;
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setDatabases([]); }
        else { setDatabases(j.databases || []); }
      } catch (e: any) {
        if (!cancelled) { setError(e?.message || String(e)); setDatabases([]); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [server]);
  return { databases, error, loading };
}

export function AzureSqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const srv = useSqlServers();
  const [server, setServer] = useState<string>(process.env.NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_SERVER || '');
  const [database, setDatabase] = useState<string>(process.env.NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_DB || '');
  const dbs = useSqlDatabases(server);
  const [tab, setTab] = useState<'query' | 'mirroring' | 'replication' | 'sql2025'>('query');
  const [sqlText, setSqlText] = useState<string>(
    `-- Azure SQL database — TDS over AAD MI from the Loom Console BFF.\nSELECT 1 AS smoke, DB_NAME() AS db, SUSER_NAME() AS upn, @@VERSION AS version;`,
  );
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [mirrorState, setMirrorState] = useState<any>(null);
  const [sql2025State, setSql2025State] = useState<any>(null);

  const run = useCallback(async () => {
    if (!server || !database) { setResult({ ok: false, error: 'server + database required' }); return; }
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server, database, sql: sqlText }),
      });
      setResult(await r.json());
    } catch (e: any) { setResult({ ok: false, error: e?.message || String(e) }); }
    finally { setLoading(false); }
  }, [id, server, database, sqlText]);

  const toggleMirror = useCallback(async () => {
    const r = await fetch(`/api/items/azure-sql-database/${id}/mirroring`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database }),
    });
    const j = await r.json();
    setMirrorState(j.config || j);
  }, [id, server, database]);

  const probe2025 = useCallback(async () => {
    const r = await fetch(`/api/items/azure-sql-database/${id}/sql2025-features`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database }),
    });
    setSql2025State(await r.json());
  }, [id, server, database]);

  const newTsql = useCallback(() => {
    setSqlText('-- New T-SQL.\nSELECT 1;');
    setResult(null);
  }, []);

  // v3.28 Phase 4.5: Ctrl+S / Cmd+S triggers Run when on the Query tab.
  // T-SQL text is ephemeral query state (not persisted item state), so
  // there is no SAVE-RELOAD round-trip — the action surfaced by Ctrl+S
  // is Run, matching SSMS / Azure Data Studio muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (tab === 'query' && server && database && !loading) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, server, database, loading, run]);

  const canRun = !!server && !!database && !loading;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New T-SQL', onClick: newTsql },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
      ]},
      { label: 'Mirroring', actions: [
        { label: 'Toggle Fabric mirror', onClick: canRun ? toggleMirror : undefined, disabled: !canRun },
      ]},
      { label: 'Replication', actions: [
        { label: 'Add geo-replica', disabled: true, title: 'needs ARM mutation BFF (deferred)' },
      ]},
      { label: '2025', actions: [
        { label: 'Probe engine', onClick: canRun ? probe2025 : undefined, disabled: !canRun },
      ]},
    ]},
  ], [canRun, loading, run, toggleMirror, probe2025, newTsql]);

  return (
    <ItemEditorChrome
      item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.formRow}>
            <Label>Server</Label>
            <select
              value={server}
              onChange={(e) => { setServer(e.target.value); setDatabase(''); }}
              disabled={srv.loading || (srv.servers?.length ?? 0) === 0}
              style={{ padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
            >
              {srv.loading && <option value="">Loading servers…</option>}
              {!srv.loading && (srv.servers?.length ?? 0) === 0 && (
                <option value="">{srv.error ? 'Discovery failed — see below' : 'No SQL servers found'}</option>
              )}
              {!srv.loading && (srv.servers?.length ?? 0) > 0 && !server && (
                <option value="">Select a server</option>
              )}
              {(srv.servers || []).map((sv) => (
                <option key={sv.name} value={sv.name}>{sv.name}{sv.location ? ` · ${sv.location}` : ''}</option>
              ))}
            </select>
          </div>
          <div className={s.formRow}>
            <Label>Database</Label>
            <select
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              disabled={!server || dbs.loading || (dbs.databases?.length ?? 0) === 0}
              style={{ padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
            >
              {!server && <option value="">Select a server first</option>}
              {server && dbs.loading && <option value="">Loading databases…</option>}
              {server && !dbs.loading && (dbs.databases?.length ?? 0) === 0 && (
                <option value="">{dbs.error ? 'Discovery failed' : 'No databases on this server'}</option>
              )}
              {server && !dbs.loading && (dbs.databases?.length ?? 0) > 0 && !database && (
                <option value="">Select a database</option>
              )}
              {(dbs.databases || []).map((db) => (
                <option key={db.name} value={db.name}>{db.name}{db.status ? ` · ${db.status}` : ''}</option>
              ))}
            </select>
          </div>
          {srv.error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>SQL servers not reachable</MessageBarTitle>
                {srv.error}
                {srv.hint && <><br /><Caption1>{srv.hint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {server && dbs.error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Databases not reachable</MessageBarTitle>
                {dbs.error}
              </MessageBarBody>
            </MessageBar>
          )}
          <Caption1>
            The console MI must be the AAD admin on the server (or a member of the AAD admin group).
            Tables, schemas, and sample queries deferred to v3.x.
          </Caption1>
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="mirroring" icon={<ShieldKeyhole20Regular />}>Mirroring</Tab>
            <Tab value="replication" icon={<Globe20Regular />}>Replication</Tab>
            <Tab value="sql2025" icon={<Sparkle20Regular />}>SQL 2025</Tab>
          </TabList>
          {tab === 'query' && (
            <>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand">Azure SQL</Badge>
                <Caption1>server: <strong>{server || 'not set'}</strong>, db: <strong>{database || 'not set'}</strong></Caption1>
                <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !server || !database} onClick={run} style={{ marginLeft: 'auto' }}>Run</Button>
              </div>
              <MonacoTextarea value={sqlText} onChange={setSqlText} language="tsql" height={240} minHeight={200} ariaLabel="T-SQL editor" />
              <ResultsPanel result={result} loading={loading} />
            </>
          )}
          {tab === 'mirroring' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Fabric mirroring</MessageBarTitle>
                  Toggles change-feed on the database + initiates Fabric Mirror config. Provisioning execution gated on{' '}
                  <code>LOOM_AZURE_SQL_MIRRORING_LIVE=true</code>; otherwise toggle is recorded but state stays NotConfigured.
                </MessageBarBody>
              </MessageBar>
              <Button onClick={toggleMirror} icon={<ShieldKeyhole20Regular />}>Enable / Refresh mirror</Button>
              {mirrorState && <pre style={{ fontSize: 12, background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>{JSON.stringify(mirrorState, null, 2)}</pre>}
            </>
          )}
          {tab === 'replication' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Geo-replication</MessageBarTitle>
                  Creates a Secondary database on a replica server via ARM REST. Form deferred to v3.x — call{' '}
                  <code>POST /api/items/azure-sql-database/[id]/replication</code> with{' '}
                  <code>{`{ server, database, replicaServer, location, skuName? }`}</code>.
                </MessageBarBody>
              </MessageBar>
            </>
          )}
          {tab === 'sql2025' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>SQL Server 2025 features</MessageBarTitle>
                  Probes <code>SERVERPROPERTY('ProductVersion')</code>. SQL 2025 (major ≥17) gates native vector index,{' '}
                  <code>JSON_AGG</code> family, and regex (<code>REGEXP_LIKE</code>, <code>REGEXP_REPLACE</code>).
                </MessageBarBody>
              </MessageBar>
              <Button onClick={probe2025} icon={<Sparkle20Regular />}>Probe engine</Button>
              {sql2025State && <pre style={{ fontSize: 12, background: tokens.colorNeutralBackground3, padding: 8, borderRadius: 4 }}>{JSON.stringify(sql2025State, null, 2)}</pre>}
            </>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// Managed Instance editor (list-only in v3)
// ============================================================
export function SqlManagedInstanceEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [instances, setInstances] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true); setErr(null);
    fetch(`/api/items/azure-sql-managed-instance`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setInstances(j.instances || []); else setErr(j.error); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Instances', actions: [
        { label: loading ? 'Refreshing…' : 'Refresh list', onClick: loading ? undefined : refresh, disabled: loading },
      ]},
    ]},
  ], [loading, refresh]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={<div className={s.treePad}><Caption1>Managed Instance editor — list-only in v3. Query execution deferred to v3.x (TDS via dedicated PE in the MI subnet).</Caption1></div>}
      main={
        <div className={s.pad}>
          {id === 'new' && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Managed Instances are provisioned out-of-band</MessageBarTitle>
                Create via bicep <code>Microsoft.Sql/managedInstances</code> (45+ min deploy) or the Azure portal.
                This is a read-only registry view.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Button size="small" appearance="outline" onClick={refresh} disabled={loading}>Refresh list</Button>
            {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
          </div>
          {err && <BackendStateBar error={err} title="Azure SQL" />}
          <Subtitle2>Managed Instances ({instances.length})</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small">
              <TableHeader><TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>State</TableHeaderCell>
                <TableHeaderCell>Location</TableHeaderCell>
                <TableHeaderCell>SKU</TableHeaderCell>
                <TableHeaderCell>FQDN</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {instances.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell><strong>{i.name}</strong></TableCell>
                    <TableCell>{i.state}</TableCell>
                    <TableCell>{i.location}</TableCell>
                    <TableCell>{i.sku?.name}</TableCell>
                    <TableCell><code style={{ fontSize: 11 }}>{i.fqdn}</code></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      }
    />
  );
}

// ============================================================
// SQL Server 2025 Vector Index editor
// ============================================================
export function SqlServer2025VectorIndexEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const srv = useSqlServers();
  const [server, setServer] = useState<string>('');
  const [database, setDatabase] = useState<string>('');
  const dbs = useSqlDatabases(server);
  const [table, setTable] = useState<string>('docs');
  const [column, setColumn] = useState<string>('embedding');
  const [dim, setDim] = useState<number>(1536);
  const [metric, setMetric] = useState<'cosine' | 'euclidean' | 'dot'>('cosine');
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const ddl = `-- SQL Server 2025 native vector index DDL.\n-- Requires SQL 2025 (major ≥17). Use Probe engine in the Database editor first.\nCREATE VECTOR INDEX idx_${table}_${column}\nON dbo.${table}(${column})\nWITH (METRIC = '${metric.toUpperCase()}', DIMENSIONS = ${dim});`;

  const runDdl = useCallback(async () => {
    if (!server || !database) { setResult({ ok: false, error: 'server + database required' }); return; }
    setLoading(true); setResult(null);
    const r = await fetch(`/api/items/azure-sql-database/${id}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database, sql: ddl }),
    });
    setResult(await r.json());
    setLoading(false);
  }, [id, server, database, ddl]);

  const canCreate = !!server && !!database && !loading;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Index', actions: [
        { label: loading ? 'Creating…' : 'Create', onClick: canCreate ? runDdl : undefined, disabled: !canCreate },
        { label: 'Test similarity', disabled: true, title: 'needs vector similarity probe BFF (deferred)' },
      ]},
    ]},
  ], [canCreate, loading, runDdl]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div className={s.formRow}>
            <Label>Server</Label>
            <select
              value={server}
              onChange={(e) => { setServer(e.target.value); setDatabase(''); }}
              disabled={srv.loading || (srv.servers?.length ?? 0) === 0}
              style={{ padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
            >
              {srv.loading && <option value="">Loading servers…</option>}
              {!srv.loading && (srv.servers?.length ?? 0) === 0 && (
                <option value="">{srv.error ? 'Discovery failed' : 'No SQL servers found'}</option>
              )}
              {!srv.loading && (srv.servers?.length ?? 0) > 0 && !server && (
                <option value="">Select a server</option>
              )}
              {(srv.servers || []).map((sv) => (
                <option key={sv.name} value={sv.name}>{sv.name}{sv.location ? ` · ${sv.location}` : ''}</option>
              ))}
            </select>
          </div>
          <div className={s.formRow}>
            <Label>Database</Label>
            <select
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              disabled={!server || dbs.loading || (dbs.databases?.length ?? 0) === 0}
              style={{ padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
            >
              {!server && <option value="">Select a server first</option>}
              {server && dbs.loading && <option value="">Loading databases…</option>}
              {server && !dbs.loading && (dbs.databases?.length ?? 0) === 0 && (
                <option value="">{dbs.error ? 'Discovery failed' : 'No databases on this server'}</option>
              )}
              {server && !dbs.loading && (dbs.databases?.length ?? 0) > 0 && !database && (
                <option value="">Select a database</option>
              )}
              {(dbs.databases || []).map((db) => (
                <option key={db.name} value={db.name}>{db.name}{db.status ? ` · ${db.status}` : ''}</option>
              ))}
            </select>
          </div>
          {srv.error && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>SQL servers not reachable</MessageBarTitle>
                {srv.error}
                {srv.hint && <><br /><Caption1>{srv.hint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.formRow}><Label>Table</Label><Input value={table} onChange={(_, d) => setTable(d.value)} /></div>
          <div className={s.formRow}><Label>Vector column</Label><Input value={column} onChange={(_, d) => setColumn(d.value)} /></div>
          <div className={s.formRow}><Label>Dimensions</Label><Input type="number" value={String(dim)} onChange={(_, d) => setDim(Number(d.value || '0'))} /></div>
          <div className={s.formRow}>
            <Label>Metric</Label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as any)} style={{ padding: 4 }}>
              <option value="cosine">cosine</option>
              <option value="euclidean">euclidean</option>
              <option value="dot">dot</option>
            </select>
          </div>
        </div>
      }
      main={
        <div className={s.pad}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>SQL 2025 required</MessageBarTitle>
              Native <code>CREATE VECTOR INDEX</code> ships in SQL Server 2025. On older engines this DDL will fail —
              use the SQL 2025 tab in the Database editor to verify the version first.
            </MessageBarBody>
          </MessageBar>
          <MonacoTextarea value={ddl} onChange={() => {}} language="tsql" readOnly height={200} minHeight={160} ariaLabel="Vector index DDL" />
          <Button appearance="primary" icon={<Add20Regular />} disabled={loading} onClick={runDdl}>Create vector index</Button>
          <ResultsPanel result={result} loading={loading} />
        </div>
      }
    />
  );
}
