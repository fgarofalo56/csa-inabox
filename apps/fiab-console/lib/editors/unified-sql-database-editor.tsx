'use client';

/**
 * UnifiedSqlDatabaseEditor — the Loom "SQL database" surface, backed by REAL
 * Azure database services (NOT Fabric SQL). Replaces the misleading
 * "Fabric SQL / no Fabric workspace attached" framing entirely.
 *
 * Families (all real ARM REST + TDS):
 *   - azure-sql        → Microsoft.Sql/servers + /databases   (TDS query LIVE)
 *   - managed-instance → Microsoft.Sql/managedInstances        (TDS via PE — honest gate)
 *   - postgres         → Microsoft.DBforPostgreSQL/flexibleServers (PG query — honest gate)
 *
 * Tabs:
 *   - Connect   : tenant inventory across all 3 families; pick + bind to item state
 *   - Provision : create a new Azure SQL DB (ARM PUT) or PostgreSQL flex server (ARM PUT)
 *   - Query     : Monaco SQL editor → /query (TDS for SQL; honest 501 gate for MI/PG)
 *   - Schema    : INFORMATION_SCHEMA browser via the live query path
 *   - Catalog   : register the DB as a Purview/OneLake catalog asset
 *
 * Every control calls a real BFF route; every fetch is content-type guarded.
 * The only non-functional states are honest Fluent MessageBar infra-gates
 * naming the exact env var / role to provision (per no-vaporware.md +
 * ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Label, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  TabList, Tab, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Add20Regular, PlugConnected20Regular,
  Table20Regular, BookDatabase20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 160 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8, display: 'flex', flexDirection: 'column', gap: 10 },
  formRow: { display: 'flex', flexDirection: 'column', gap: 4 },
  formGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  select: {
    padding: 6, borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1,
  },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
});

// ---- content-type guarded fetch ----------------------------------------
async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  let r: Response;
  try {
    r = await fetch(input, init);
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message || String(e) };
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    return {
      ok: false,
      status: r.status,
      error:
        `Expected JSON from ${input} but received ${ct || 'an unknown content type'} (HTTP ${r.status}). ` +
        (r.status === 401 || r.status === 403
          ? 'Your session may have expired — sign in again.'
          : `First bytes: ${text.slice(0, 120)}`),
    };
  }
  try { return await r.json(); }
  catch (e: any) { return { ok: false, status: r.status, error: `Malformed JSON from ${input}: ${e?.message || String(e)}` }; }
}

type Family = 'azure-sql' | 'managed-instance' | 'postgres';

interface SqlServer { id: string; name: string; location: string; fqdn: string; state?: string; version?: string; resourceGroup?: string }
interface ManagedInstance { id: string; name: string; location: string; state?: string; fqdn?: string; sku?: { name?: string } }
interface PgServer { id: string; name: string; location: string; fqdn: string; state?: string; version?: string; resourceGroup?: string }

interface Inventory {
  sql: { servers: SqlServer[]; error?: string };
  mi: { instances: ManagedInstance[]; error?: string };
  postgres: { servers: PgServer[]; error?: string };
}

interface QueryResponse {
  ok: boolean; columns?: string[]; rows?: unknown[][]; rowCount?: number;
  executionMs?: number; truncated?: boolean; error?: string; code?: string; gated?: boolean;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ResultsPanel({ result, loading }: { result: QueryResponse | null; loading: boolean }) {
  const s = useStyles();
  if (loading) return <div className={s.resultBox}><Spinner size="small" label="Executing…" labelPosition="after" /></div>;
  if (!result) return <div className={s.resultBox}><Caption1>Click <strong>Run</strong> to execute.</Caption1></div>;
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent={result.gated ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.gated ? 'Query path gated' : 'Query failed'}</MessageBarTitle>
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
      {rows.length === 0 ? <Caption1>Query returned no rows.</Caption1> : (
        <div className={s.tableWrap}>
          <Table aria-label="Query results" size="small">
            <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>{columns.map((_, j) => <TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>)}</TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function UnifiedSqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // ---- tenant inventory ----
  const [inv, setInv] = useState<Inventory | null>(null);
  const [invLoading, setInvLoading] = useState(true);
  const [invError, setInvError] = useState<string | null>(null);

  const loadInventory = useCallback(async () => {
    setInvLoading(true); setInvError(null);
    const j = await fetchJson('/api/items/sql-databases');
    if (!j.ok) { setInvError(j.error || 'inventory failed'); setInv(null); }
    else setInv({ sql: j.sql, mi: j.mi, postgres: j.postgres });
    setInvLoading(false);
  }, []);
  useEffect(() => { loadInventory(); }, [loadInventory]);

  // ---- active connection (bound to item state) ----
  const [family, setFamily] = useState<Family>('azure-sql');
  const [server, setServer] = useState('');
  const [database, setDatabase] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [bindMsg, setBindMsg] = useState<string | null>(null);

  const serverFqdn = useMemo(() => {
    if (!inv) return '';
    if (family === 'azure-sql') return inv.sql.servers.find((x) => x.name === server)?.fqdn || '';
    if (family === 'postgres') return inv.postgres.servers.find((x) => x.name === server)?.fqdn || '';
    return inv.mi.instances.find((x) => x.name === server)?.fqdn || '';
  }, [inv, family, server]);

  const loadDatabases = useCallback(async (fam: Family, srv: string) => {
    setDatabases([]); setDbError(null);
    if (!srv || fam === 'managed-instance') return;
    setDbLoading(true);
    const url = fam === 'postgres'
      ? `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/databases?server=${encodeURIComponent(srv)}`
      : `/api/items/azure-sql-server/${encodeURIComponent(id)}/databases?server=${encodeURIComponent(srv)}`;
    const j = await fetchJson(url);
    if (!j.ok) setDbError(j.error || 'databases failed');
    else setDatabases((j.databases || []).map((d: any) => d.name));
    setDbLoading(false);
  }, [id]);

  const pickServer = useCallback((fam: Family, srv: string) => {
    setFamily(fam); setServer(srv); setDatabase('');
    loadDatabases(fam, srv);
  }, [loadDatabases]);

  const bindConnection = useCallback(async () => {
    setBindMsg(null);
    if (id === 'new') { setBindMsg('Save this item first (it lives in a workspace), then bind a connection.'); return; }
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ family, server, database }),
    });
    setBindMsg(j.ok ? `Bound ${family} · ${server}${database ? ' / ' + database : ''} to this item.` : (j.error || 'bind failed'));
  }, [id, family, server, database]);

  // ---- query ----
  const [tab, setTab] = useState<'connect' | 'provision' | 'query' | 'schema' | 'catalog'>('connect');
  const dialect = family === 'postgres' ? 'sql' : 'tsql';
  const [sqlText, setSqlText] = useState(
    `-- ${family === 'postgres' ? 'PostgreSQL' : 'Azure SQL'} smoke query\nSELECT 1 AS smoke;`,
  );
  const [qResult, setQResult] = useState<QueryResponse | null>(null);
  const [qLoading, setQLoading] = useState(false);

  const queryUrl = useMemo(() => {
    if (family === 'postgres') return `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/query`;
    return `/api/items/azure-sql-database/${encodeURIComponent(id)}/query`;
  }, [family, id]);

  const run = useCallback(async (sqlOverride?: string) => {
    const sqlToRun = sqlOverride ?? sqlText;
    if (!server) { setQResult({ ok: false, error: 'select a server first' }); return; }
    if (family !== 'postgres' && !database) { setQResult({ ok: false, error: 'select a database first' }); return; }
    setQLoading(true); setQResult(null);
    const j = await fetchJson(queryUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database: database || 'postgres', sql: sqlToRun }),
    });
    setQResult(j);
    setQLoading(false);
  }, [queryUrl, server, database, family, sqlText]);

  // ---- schema browser (INFORMATION_SCHEMA via the live query path) ----
  const [schema, setSchema] = useState<QueryResponse | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const loadSchema = useCallback(async () => {
    if (!server || (family !== 'postgres' && !database)) { setSchema({ ok: false, error: 'select a server + database first' }); return; }
    setSchemaLoading(true); setSchema(null);
    const sql =
      'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME;';
    const j = await fetchJson(queryUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database: database || 'postgres', sql }),
    });
    setSchema(j);
    setSchemaLoading(false);
  }, [queryUrl, server, database, family]);

  // ---- provision (SQL DB on existing server, or new PG flex server) ----
  const [provFamily, setProvFamily] = useState<'azure-sql' | 'postgres'>('azure-sql');
  const [provBusy, setProvBusy] = useState(false);
  const [provMsg, setProvMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // SQL DB fields
  const [newDbServer, setNewDbServer] = useState('');
  const [newDbName, setNewDbName] = useState('');
  const [newDbSku, setNewDbSku] = useState('GP_S_Gen5_2');
  const [newDbTier, setNewDbTier] = useState('GeneralPurpose');
  const [newDbSample, setNewDbSample] = useState(false);
  // PG fields
  const [pgName, setPgName] = useState('');
  const [pgRg, setPgRg] = useState('');
  const [pgLocation, setPgLocation] = useState('eastus2');
  const [pgAdmin, setPgAdmin] = useState('');
  const [pgPassword, setPgPassword] = useState('');
  const [pgSku, setPgSku] = useState('Standard_B1ms');
  const [pgTier, setPgTier] = useState('Burstable');
  const [pgVersion, setPgVersion] = useState('16');

  const provisionSqlDb = useCallback(async () => {
    setProvBusy(true); setProvMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/create-db`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server: newDbServer, name: newDbName, skuName: newDbSku, tier: newDbTier,
        sampleName: newDbSample ? 'AdventureWorksLT' : undefined,
      }),
    });
    setProvMsg(j.ok
      ? { ok: true, text: `Azure SQL database '${newDbName}' provisioning on ${newDbServer} (status: ${j.status || 'accepted'}). ARM continues async.` }
      : { ok: false, text: j.error || 'create failed' });
    if (j.ok) loadInventory();
    setProvBusy(false);
  }, [id, newDbServer, newDbName, newDbSku, newDbTier, newDbSample, loadInventory]);

  const provisionPg = useCallback(async () => {
    setProvBusy(true); setProvMsg(null);
    const j = await fetchJson('/api/items/postgres-flexible-server', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: pgName, resourceGroup: pgRg, location: pgLocation,
        administratorLogin: pgAdmin, administratorLoginPassword: pgPassword,
        skuName: pgSku, tier: pgTier, version: pgVersion,
      }),
    });
    setProvMsg(j.ok
      ? { ok: true, text: `PostgreSQL flexible server '${pgName}' provisioning in ${pgRg} (${j.provisioningState || 'accepted'}). ARM continues async.` }
      : { ok: false, text: j.error || 'create failed' });
    if (j.ok) loadInventory();
    setProvBusy(false);
  }, [pgName, pgRg, pgLocation, pgAdmin, pgPassword, pgSku, pgTier, pgVersion, loadInventory]);

  // ---- catalog register ----
  const [catBusy, setCatBusy] = useState(false);
  const [catMsg, setCatMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const registerCatalog = useCallback(async () => {
    setCatBusy(true); setCatMsg(null);
    const j = await fetchJson('/api/catalog/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'azure-database', family, fqdn: serverFqdn, database, displayName: database || server }),
    });
    setCatMsg(j.ok
      ? { ok: true, text: `Registered as Purview asset (${j.typeName}).`, link: j.purviewDeepLink }
      : { ok: false, text: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'register failed') });
    setCatBusy(false);
  }, [family, serverFqdn, database, server]);

  // Ctrl+S → Run on the query tab (SSMS muscle memory).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (tab === 'query' && !qLoading) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, qLoading, run]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Connection', actions: [
        { label: invLoading ? 'Refreshing…' : 'Refresh inventory', onClick: invLoading ? undefined : loadInventory, disabled: invLoading },
        { label: 'Bind connection', onClick: server ? bindConnection : undefined, disabled: !server, title: !server ? 'Pick a server first' : undefined },
      ]},
      { label: 'Query', actions: [
        { label: qLoading ? 'Running…' : 'Run', onClick: !qLoading ? () => run() : undefined, disabled: qLoading || !server },
      ]},
      { label: 'Schema', actions: [
        { label: 'Browse tables', onClick: server ? () => { setTab('schema'); loadSchema(); } : undefined, disabled: !server },
      ]},
      { label: 'Catalog', actions: [
        { label: 'Register in Purview', onClick: serverFqdn ? () => { setTab('catalog'); } : undefined, disabled: !serverFqdn },
      ]},
    ]},
  ], [invLoading, loadInventory, server, bindConnection, qLoading, run, serverFqdn, loadSchema]);

  const pgGate = inv?.postgres.error;
  const sqlGate = inv?.sql.error;
  const miGate = inv?.mi.error;

  return (
    <ItemEditorChrome
      item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2>Active connection</Subtitle2>
          <div className={s.formRow}>
            <Label>Family</Label>
            <select className={s.select} value={family} onChange={(e) => { const f = e.target.value as Family; setFamily(f); setServer(''); setDatabase(''); setDatabases([]); }}>
              <option value="azure-sql">Azure SQL Database</option>
              <option value="managed-instance">SQL Managed Instance</option>
              <option value="postgres">PostgreSQL Flexible Server</option>
            </select>
          </div>
          <div className={s.formRow}>
            <Label>Server / instance</Label>
            <select className={s.select} value={server} onChange={(e) => pickServer(family, e.target.value)} disabled={invLoading}>
              <option value="">{invLoading ? 'Loading…' : 'Select…'}</option>
              {family === 'azure-sql' && (inv?.sql.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
              {family === 'managed-instance' && (inv?.mi.instances || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
              {family === 'postgres' && (inv?.postgres.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
            </select>
          </div>
          {family !== 'managed-instance' && (
            <div className={s.formRow}>
              <Label>Database</Label>
              <select className={s.select} value={database} onChange={(e) => setDatabase(e.target.value)} disabled={!server || dbLoading}>
                <option value="">{dbLoading ? 'Loading…' : (server ? 'Select…' : 'Pick a server first')}</option>
                {databases.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {dbError && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Databases not reachable</MessageBarTitle>{dbError}</MessageBarBody></MessageBar>}
          {bindMsg && <Caption1>{bindMsg}</Caption1>}
          {serverFqdn && <Caption1>FQDN: <code>{serverFqdn}</code></Caption1>}
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="connect" icon={<PlugConnected20Regular />}>Connect</Tab>
            <Tab value="provision" icon={<Add20Regular />}>Provision</Tab>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="schema" icon={<Table20Regular />}>Schema</Tab>
            <Tab value="catalog" icon={<BookDatabase20Regular />}>Catalog</Tab>
          </TabList>

          {/* ---------------- Connect ---------------- */}
          {tab === 'connect' && (
            <>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand" icon={<Database20Regular />}>Azure database services</Badge>
                <Button size="small" appearance="outline" onClick={loadInventory} disabled={invLoading}>Refresh inventory</Button>
                {invLoading && <Spinner size="tiny" label="Querying ARM…" labelPosition="after" />}
              </div>
              {invError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Inventory failed</MessageBarTitle>{invError}</MessageBarBody></MessageBar>}

              <Subtitle2>Azure SQL servers ({inv?.sql.servers.length ?? 0})</Subtitle2>
              {sqlGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Azure SQL not reachable</MessageBarTitle>{sqlGate} · Grant the console UAMI <code>Reader</code> on the subscription (LOOM_SUBSCRIPTION_ID).</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Azure SQL servers">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.sql.servers || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: 11 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => { pickServer('azure-sql', x.name); setTab('query'); }}>Connect</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

              <Subtitle2 style={{ marginTop: 8 }}>SQL Managed Instances ({inv?.mi.instances.length ?? 0})</Subtitle2>
              {miGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>SQL MI not reachable</MessageBarTitle>{miGate}</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="SQL Managed Instances">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.mi.instances || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>{x.state}</TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: 11 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => pickServer('managed-instance', x.name)}>Select</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

              <Subtitle2 style={{ marginTop: 8 }}>PostgreSQL Flexible Servers ({inv?.postgres.servers.length ?? 0})</Subtitle2>
              {pgGate
                ? <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>PostgreSQL not reachable</MessageBarTitle>{pgGate} · Grant the console UAMI <code>Reader</code> on the subscription; the provider is <code>Microsoft.DBforPostgreSQL/flexibleServers</code>.</MessageBarBody></MessageBar>
                : (
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="PostgreSQL flexible servers">
                      <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>FQDN</TableHeaderCell><TableHeaderCell /></TableRow></TableHeader>
                      <TableBody>
                        {(inv?.postgres.servers || []).map((x) => (
                          <TableRow key={x.id}>
                            <TableCell><strong>{x.name}</strong></TableCell>
                            <TableCell>PG {x.version}</TableCell>
                            <TableCell>{x.location}</TableCell>
                            <TableCell><code style={{ fontSize: 11 }}>{x.fqdn}</code></TableCell>
                            <TableCell><Button size="small" appearance="subtle" onClick={() => { pickServer('postgres', x.name); setTab('query'); }}>Connect</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              <Caption1>Pick a server, then <strong>Bind connection</strong> (ribbon) to persist it to this item, or open the <strong>Query</strong> tab.</Caption1>
            </>
          )}

          {/* ---------------- Provision ---------------- */}
          {tab === 'provision' && (
            <>
              <div className={s.toolbar}>
                <Label>Resource type</Label>
                <select className={s.select} value={provFamily} onChange={(e) => setProvFamily(e.target.value as any)}>
                  <option value="azure-sql">Azure SQL database (on an existing server)</option>
                  <option value="postgres">PostgreSQL flexible server (new)</option>
                </select>
              </div>
              {provMsg && (
                <MessageBar intent={provMsg.ok ? 'success' : 'error'}>
                  <MessageBarBody><MessageBarTitle>{provMsg.ok ? 'Provisioning' : 'Create failed'}</MessageBarTitle>{provMsg.text}</MessageBarBody>
                </MessageBar>
              )}
              {provFamily === 'azure-sql' ? (
                <div className={s.card}>
                  <MessageBar intent="info"><MessageBarBody><MessageBarTitle>ARM PUT — Microsoft.Sql/servers/databases</MessageBarTitle>Creates a database on an existing logical server. Requires the console UAMI to hold <code>Contributor</code> (or SQL DB Contributor) on the server's resource group; otherwise ARM returns 403 and it surfaces here.</MessageBarBody></MessageBar>
                  <div className={s.formGrid}>
                    <Field label="Logical server" required>
                      <select className={s.select} value={newDbServer} onChange={(e) => setNewDbServer(e.target.value)}>
                        <option value="">Select a server…</option>
                        {(inv?.sql.servers || []).map((x) => <option key={x.id} value={x.name}>{x.name} · {x.location}</option>)}
                      </select>
                    </Field>
                    <Field label="Database name" required><Input value={newDbName} onChange={(_, d) => setNewDbName(d.value)} placeholder="loom_app_db" /></Field>
                    <Field label="SKU / service objective"><Input value={newDbSku} onChange={(_, d) => setNewDbSku(d.value)} placeholder="GP_S_Gen5_2 / S0 / Basic" /></Field>
                    <Field label="Tier"><Input value={newDbTier} onChange={(_, d) => setNewDbTier(d.value)} placeholder="GeneralPurpose" /></Field>
                  </div>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="checkbox" checked={newDbSample} onChange={(e) => setNewDbSample(e.target.checked)} />
                    <Caption1>Seed AdventureWorksLT sample schema</Caption1>
                  </label>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={provBusy || !newDbServer || !newDbName} onClick={provisionSqlDb}>
                    {provBusy ? 'Creating…' : 'Create Azure SQL database'}
                  </Button>
                </div>
              ) : (
                <div className={s.card}>
                  <MessageBar intent="info"><MessageBarBody><MessageBarTitle>ARM PUT — Microsoft.DBforPostgreSQL/flexibleServers</MessageBarTitle>Provisions a new PostgreSQL flexible server (long-running). Requires <code>Contributor</code> on the target resource group.</MessageBarBody></MessageBar>
                  <div className={s.formGrid}>
                    <Field label="Server name" required><Input value={pgName} onChange={(_, d) => setPgName(d.value)} placeholder="loom-pg-01" /></Field>
                    <Field label="Resource group" required><Input value={pgRg} onChange={(_, d) => setPgRg(d.value)} placeholder="rg-loom-data" /></Field>
                    <Field label="Region" required><Input value={pgLocation} onChange={(_, d) => setPgLocation(d.value)} placeholder="eastus2" /></Field>
                    <Field label="PG version"><Input value={pgVersion} onChange={(_, d) => setPgVersion(d.value)} placeholder="16" /></Field>
                    <Field label="Admin login" required><Input value={pgAdmin} onChange={(_, d) => setPgAdmin(d.value)} placeholder="pgadmin" /></Field>
                    <Field label="Admin password" required><Input type="password" value={pgPassword} onChange={(_, d) => setPgPassword(d.value)} /></Field>
                    <Field label="SKU"><Input value={pgSku} onChange={(_, d) => setPgSku(d.value)} placeholder="Standard_B1ms" /></Field>
                    <Field label="Tier"><Input value={pgTier} onChange={(_, d) => setPgTier(d.value)} placeholder="Burstable" /></Field>
                  </div>
                  <Button appearance="primary" icon={<Add20Regular />} disabled={provBusy || !pgName || !pgRg || !pgAdmin || !pgPassword} onClick={provisionPg}>
                    {provBusy ? 'Creating…' : 'Create PostgreSQL flexible server'}
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ---------------- Query ---------------- */}
          {tab === 'query' && (
            <>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand">{family === 'postgres' ? 'PostgreSQL' : family === 'managed-instance' ? 'SQL MI' : 'Azure SQL'}</Badge>
                <Caption1>server: <strong>{server || 'not set'}</strong>{family !== 'managed-instance' && <>, db: <strong>{database || 'not set'}</strong></>}</Caption1>
                <Button appearance="primary" icon={<Play20Regular />} disabled={qLoading || !server} onClick={() => run()} style={{ marginLeft: 'auto' }}>Run</Button>
              </div>
              {family === 'managed-instance' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>MI query requires a private endpoint in the MI subnet</MessageBarTitle>SQL MI has no public TDS gateway. Provision <code>Microsoft.Network/privateEndpoints</code> to the instance and grant the console UAMI <code>db_datareader</code>, then the same TDS path the Azure SQL editor uses applies. The route returns an honest 501 until then.</MessageBarBody></MessageBar>
              )}
              {family === 'postgres' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>PostgreSQL query path is gated</MessageBarTitle>Add the <code>pg</code> driver to apps/fiab-console and set <code>LOOM_POSTGRES_QUERY_LIVE=true</code> (with the console UAMI created as a PG AAD principal via <code>pgaadauth_create_principal</code>). ARM inventory, provisioning, databases, and firewall are fully live now.</MessageBarBody></MessageBar>
              )}
              <MonacoTextarea value={sqlText} onChange={setSqlText} language={dialect} height={240} minHeight={200} ariaLabel="SQL editor" />
              <ResultsPanel result={qResult} loading={qLoading} />
            </>
          )}

          {/* ---------------- Schema ---------------- */}
          {tab === 'schema' && (
            <>
              <div className={s.toolbar}>
                <Caption1>INFORMATION_SCHEMA.TABLES on <strong>{database || server || 'not set'}</strong></Caption1>
                <Button size="small" appearance="outline" onClick={loadSchema} disabled={schemaLoading || !server}>Refresh</Button>
              </div>
              <ResultsPanel result={schema} loading={schemaLoading} />
            </>
          )}

          {/* ---------------- Catalog ---------------- */}
          {tab === 'catalog' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>OneLake / Purview catalog</MessageBarTitle>
                  Register this Azure database as a governed catalog asset (Atlas entity) in Microsoft Purview, consistent with the Loom OneLake catalog. Requires <code>LOOM_PURVIEW_ACCOUNT</code> + the console UAMI as a Purview data-curator; otherwise the call returns a 501 with the exact hint.
                </MessageBarBody>
              </MessageBar>
              <div className={s.card}>
                <Caption1>Selected: <strong>{family}</strong> · <code>{serverFqdn || 'no server'}</code>{database && <> / <code>{database}</code></>}</Caption1>
                <Button appearance="primary" icon={<BookDatabase20Regular />} disabled={catBusy || !serverFqdn} onClick={registerCatalog}>
                  {catBusy ? 'Registering…' : 'Register in catalog'}
                </Button>
                {catMsg && (
                  <MessageBar intent={catMsg.ok ? 'success' : 'warning'}>
                    <MessageBarBody>
                      <MessageBarTitle>{catMsg.ok ? 'Registered' : 'Catalog gate'}</MessageBarTitle>
                      {catMsg.text}{catMsg.link && <> · <a href={catMsg.link} target="_blank" rel="noreferrer">Open in Purview</a></>}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </>
          )}
        </div>
      }
    />
  );
}
