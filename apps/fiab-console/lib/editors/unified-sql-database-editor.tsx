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
 *   - Connect    : tenant inventory across all 3 families; pick + bind to item state
 *   - Provision  : create a new Azure SQL DB (ARM PUT) or PostgreSQL flex server (ARM PUT)
 *   - Query      : Monaco SQL editor → /query (TDS for SQL; honest 501 gate for MI/PG)
 *   - Schema     : rich sys.* object navigator (SqlDbTree over live TDS) +
 *                  INFORMATION_SCHEMA fallback grid
 *   - Server admin: firewall rules, Microsoft Entra admin, and active
 *                  geo-replication — all calling the existing azure-sql-database
 *                  [id]/firewall · /aad-admin · /replication ARM routes
 *   - Catalog    : register the DB as a Purview/OneLake catalog asset
 *
 * Every control calls a real BFF route; every fetch is content-type guarded.
 * The only non-functional states are honest Fluent MessageBar infra-gates
 * naming the exact env var / role to provision (per no-vaporware.md +
 * ui-parity.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Label, Field,
  Dropdown, Option, Tooltip, Checkbox,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  TabList, Tab, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Play20Regular, Add20Regular, PlugConnected20Regular,
  Table20Regular, BookDatabase20Regular, ShieldKeyhole20Regular,
  ArrowDownload20Regular, Delete20Regular, Copy20Regular, ChartMultiple20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { buildConnectionStrings, getSqlHostSuffix } from './components/connection-strings-builder';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { TsqlMonaco } from '@/lib/editors/components/tsql-monaco';
import { SqlDbTree } from '@/lib/components/sqldb/sqldb-tree';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { SqlPerformanceDashboard } from '@/lib/editors/components/sql-performance-dashboard';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// ── Real Azure database option sets (parity with the portal create blades) ──
const AZURE_REGIONS = [
  'eastus', 'eastus2', 'centralus', 'southcentralus', 'westus', 'westus2', 'westus3',
  'northcentralus', 'westcentralus', 'canadacentral', 'northeurope', 'westeurope',
  'uksouth', 'francecentral', 'germanywestcentral', 'switzerlandnorth', 'norwayeast',
  'swedencentral', 'eastasia', 'southeastasia', 'japaneast', 'australiaeast',
  'centralindia', 'koreacentral', 'brazilsouth', 'southafricanorth', 'uaenorth',
  'usgovvirginia', 'usgovarizona', 'usgovtexas', 'usdodeast', 'usdodcentral',
];
const SQL_DB_SKUS = [
  'Basic', 'S0', 'S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S9', 'S12',
  'P1', 'P2', 'P4', 'P6', 'P11', 'P15',
  'GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'GP_Gen5_16', 'GP_Gen5_32',
  'GP_S_Gen5_1', 'GP_S_Gen5_2', 'GP_S_Gen5_4', 'GP_S_Gen5_8',
  'BC_Gen5_2', 'BC_Gen5_4', 'BC_Gen5_8', 'BC_Gen5_16',
  'HS_Gen5_2', 'HS_Gen5_4', 'HS_Gen5_8', 'HS_Gen5_16',
];
const SQL_DB_TIERS = ['Basic', 'Standard', 'Premium', 'GeneralPurpose', 'BusinessCritical', 'Hyperscale'];
// SQL Server collations surfaced in the Azure portal Create Database blade.
// The full catalog has thousands; these are the portal-offered choices. The
// first entry is the ARM default applied when no collation is sent.
const SQL_COLLATIONS = [
  'SQL_Latin1_General_CP1_CI_AS',       // portal default — case-insensitive, accent-sensitive
  'SQL_Latin1_General_CP1_CS_AS',       // case-sensitive variant
  'Latin1_General_100_CI_AS_SC_UTF8',   // UTF-8 aware, SQL Server 2019+
  'Latin1_General_100_CS_AS_SC_UTF8',
  'Latin1_General_BIN2',                // binary sort (fastest, case-sensitive)
  'Latin1_General_CI_AS',
  'Latin1_General_CS_AS',
  'French_CI_AS',
  'German_PhoneBook_CI_AS',
  'Japanese_CI_AS',
  'Korean_Wansung_CI_AS',
  'Modern_Spanish_CI_AS',
  'SQL_Latin1_General_CP437_CI_AI',     // accent-insensitive variant
  'SQL_Latin1_General_CP850_CI_AS',
  'SQL_Latin1_General_CP1_CI_AI',
  'Traditional_Spanish_CI_AS',
  'Chinese_PRC_CI_AS',
] as const;
type SqlCollation = typeof SQL_COLLATIONS[number];
const DEFAULT_COLLATION: SqlCollation = 'SQL_Latin1_General_CP1_CI_AS';
// requestedBackupStorageRedundancy — ARM validates the choice against the
// region/tier; an incompatible pick surfaces verbatim in the result MessageBar.
const BACKUP_REDUNDANCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'Geo', label: 'Geo-redundant (default)' },
  { value: 'GeoZone', label: 'Geo-zone-redundant (requires AZ + paired region)' },
  { value: 'Zone', label: 'Zone-redundant (within region)' },
  { value: 'Local', label: 'Locally redundant (single region)' },
];
const PG_VERSIONS = ['11', '12', '13', '14', '15', '16'];
const PG_TIERS = ['Burstable', 'GeneralPurpose', 'MemoryOptimized'];
// Common PG flexible-server compute SKUs grouped by tier.
const PG_SKUS = [
  'Standard_B1ms', 'Standard_B2s', 'Standard_B2ms', 'Standard_B4ms',
  'Standard_D2s_v3', 'Standard_D4s_v3', 'Standard_D8s_v3', 'Standard_D16s_v3',
  'Standard_E2s_v3', 'Standard_E4s_v3', 'Standard_E8s_v3', 'Standard_E16s_v3',
];

// ── Results export (CSV / JSON) — client-side, no extra route ──
function downloadBlob(filename: string, mime: string, data: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function resultsToCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(csvEscape).join(','), ...rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(','))].join('\r\n');
}
function resultsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null]))), null, 2);
}

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 160 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
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
  fullWidth: { width: '100%' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: 4 },
  treeWrap: {
    flex: 1, minHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px', overflow: 'hidden',
  },
  ruleGrid: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '12px', alignItems: 'end' },
  connCard: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 },
  connCodeWrap: { position: 'relative', background: tokens.colorNeutralBackground3, borderRadius: 4, padding: 8 },
  connCode: { fontFamily: 'Consolas, monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, color: tokens.colorNeutralForeground1 },
  connCopyBtn: { position: 'absolute', top: 4, right: 4 },
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
        {rows.length > 0 && (
          <div className={s.resultActions}>
            <Tooltip content="Download results as CSV" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.csv`, 'text/csv', resultsToCsv(columns, rows))}>CSV</Button>
            </Tooltip>
            <Tooltip content="Download results as JSON" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.json`, 'application/json', resultsToJson(columns, rows))}>JSON</Button>
            </Tooltip>
          </div>
        )}
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

// ---- Server admin panel (Firewall + Entra admin + Geo-replication) -------
// Every control calls a real, pre-existing BFF route:
//   - Firewall    GET/POST/DELETE /api/items/azure-sql-database/[id]/firewall
//   - Entra admin GET/PUT         /api/items/azure-sql-database/[id]/aad-admin
//   - Geo-repl.   POST            /api/items/azure-sql-database/[id]/replication
// For PostgreSQL we honest-gate to the dedicated PG firewall route; SQL MI
// admin is an honest gate (no public ARM admin surface wired). No mocks.
interface FirewallRule { name: string; startIpAddress: string; endIpAddress: string }
interface AadAdminState { login: string; sid: string; tenantId?: string; azureADOnlyAuthentication?: boolean }

function SqlServerAdminPanel({
  id, family, server, database, servers,
}: {
  id: string; family: Family; server: string; database: string;
  servers: { name: string; location: string }[];
}) {
  const s = useStyles();

  // Firewall
  const [fwRules, setFwRules] = useState<FirewallRule[]>([]);
  const [fwBusy, setFwBusy] = useState(false);
  const [fwError, setFwError] = useState<string | null>(null);
  const [fwName, setFwName] = useState('');
  const [fwStart, setFwStart] = useState('');
  const [fwEnd, setFwEnd] = useState('');
  const [confirmDeleteRule, setConfirmDeleteRule] = useState<string | null>(null);

  // Entra (AAD) admin
  const [aad, setAad] = useState<AadAdminState | null>(null);
  const [aadLogin, setAadLogin] = useState('');
  const [aadSid, setAadSid] = useState('');
  const [aadTenantId, setAadTenantId] = useState('');
  const [aadBusy, setAadBusy] = useState(false);
  const [aadMsg, setAadMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Geo-replication
  const [replicaServer, setReplicaServer] = useState('');
  const [replicaDb, setReplicaDb] = useState('');
  const [replicaLocation, setReplicaLocation] = useState('eastus2');
  const [replicaSku, setReplicaSku] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoMsg, setGeoMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fwBase = family === 'postgres'
    ? `/api/items/postgres-flexible-server/${encodeURIComponent(id)}/firewall`
    : `/api/items/azure-sql-database/${encodeURIComponent(id)}/firewall`;

  const loadFirewall = useCallback(async () => {
    if (!server) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(`${fwBase}?server=${encodeURIComponent(server)}`);
    if (!j.ok) setFwError(j.error || 'firewall list failed');
    else setFwRules(j.rules || []);
    setFwBusy(false);
  }, [fwBase, server]);

  const addRule = useCallback(async () => {
    if (!server || !fwName.trim() || !fwStart.trim() || !fwEnd.trim()) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(fwBase, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, name: fwName.trim(), startIpAddress: fwStart.trim(), endIpAddress: fwEnd.trim() }),
    });
    if (!j.ok) setFwError(j.error || 'add rule failed');
    else { setFwName(''); setFwStart(''); setFwEnd(''); await loadFirewall(); }
    setFwBusy(false);
  }, [fwBase, server, fwName, fwStart, fwEnd, loadFirewall]);

  const deleteRule = useCallback(async (rule: string) => {
    if (!server) return;
    setFwBusy(true); setFwError(null);
    const j = await fetchJson(`${fwBase}?server=${encodeURIComponent(server)}&rule=${encodeURIComponent(rule)}`, { method: 'DELETE' });
    if (!j.ok) setFwError(j.error || 'delete rule failed');
    else await loadFirewall();
    setFwBusy(false);
  }, [fwBase, server, loadFirewall]);

  const loadAad = useCallback(async () => {
    if (!server || family !== 'azure-sql') return;
    setAadBusy(true); setAadMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin?server=${encodeURIComponent(server)}`);
    if (!j.ok) setAadMsg({ ok: false, text: j.error || 'load admin failed' });
    else {
      setAad(j.admin || null);
      if (j.admin) { setAadLogin(j.admin.login || ''); setAadSid(j.admin.sid || ''); setAadTenantId(j.admin.tenantId || ''); }
    }
    setAadBusy(false);
  }, [id, server, family]);

  const saveAad = useCallback(async () => {
    if (!server || !aadLogin.trim() || !aadSid.trim()) return;
    setAadBusy(true); setAadMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, login: aadLogin.trim(), sid: aadSid.trim(), tenantId: aadTenantId.trim() || undefined }),
    });
    if (!j.ok) setAadMsg({ ok: false, text: j.error || 'set admin failed' });
    else { setAad(j.admin || null); setAadMsg({ ok: true, text: `Microsoft Entra admin set to ${aadLogin.trim()}.` }); }
    setAadBusy(false);
  }, [id, server, aadLogin, aadSid, aadTenantId]);

  const submitGeo = useCallback(async () => {
    if (!server || !database) { setGeoMsg({ ok: false, text: 'select a server + database first' }); return; }
    if (!replicaServer || !replicaLocation) { setGeoMsg({ ok: false, text: 'replica server + region required' }); return; }
    setGeoBusy(true); setGeoMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/replication`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database, replicaServer, replicaDatabaseName: replicaDb || database, location: replicaLocation, skuName: replicaSku || undefined }),
    });
    setGeoMsg(j.ok
      ? { ok: true, text: `Geo-replica request accepted on ${replicaServer} / ${replicaDb || database}. ARM provisioning continues async.` }
      : { ok: false, text: j.error || 'geo-replication failed' });
    setGeoBusy(false);
  }, [id, server, database, replicaServer, replicaDb, replicaLocation, replicaSku]);

  useEffect(() => { if (server) { loadFirewall(); loadAad(); } }, [server, loadFirewall, loadAad]);

  if (family === 'managed-instance') {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Server admin is managed on the SQL MI resource</MessageBarTitle>
          SQL Managed Instance uses VNet-scoped networking (NSG / route table on the delegated subnet) and
          instance-level Microsoft Entra admin rather than the public <code>firewallRules</code> / server
          <code> administrators</code> ARM surfaces. Wire <code>Microsoft.Sql/managedInstances/administrators</code>
          + a private endpoint to manage these from Loom. Until then this is an honest gate, not a fake form.
        </MessageBarBody>
      </MessageBar>
    );
  }

  if (!server) {
    return <Caption1>Pick a server on the <strong>Connect</strong> tab (or in the left pane) to manage firewall, Microsoft Entra admin, and geo-replication.</Caption1>;
  }

  return (
    <>
      {/* Firewall rules — Microsoft.Sql/servers/firewallRules (or PG equivalent) */}
      <div className={s.card}>
        <Subtitle2><ShieldKeyhole20Regular style={{ verticalAlign: 'middle' }} /> Firewall rules — {server}</Subtitle2>
        <MessageBar intent="info"><MessageBarBody>
          <MessageBarTitle>{family === 'postgres' ? 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules' : 'Microsoft.Sql/servers/firewallRules'}</MessageBarTitle>
          Inline ARM upsert/delete of server firewall rules. Requires the console UAMI to hold <code>Contributor</code> (or SQL Server Contributor) on the server's resource group; otherwise ARM returns 403 and it surfaces here.
        </MessageBarBody></MessageBar>
        {fwError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Firewall API error</MessageBarTitle>{fwError}</MessageBarBody></MessageBar>}
        <div className={s.tableWrap}>
          <Table size="small" aria-label="Firewall rules">
            <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Start IP</TableHeaderCell><TableHeaderCell>End IP</TableHeaderCell><TableHeaderCell>Action</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {fwRules.length === 0 && <TableRow><TableCell colSpan={4}><Caption1>{fwBusy ? 'Loading…' : 'No firewall rules.'}</Caption1></TableCell></TableRow>}
              {fwRules.map((r) => (
                <TableRow key={r.name}>
                  <TableCell><strong>{r.name}</strong></TableCell>
                  <TableCell><code style={{ fontSize: 11 }}>{r.startIpAddress}</code></TableCell>
                  <TableCell><code style={{ fontSize: 11 }}>{r.endIpAddress}</code></TableCell>
                  <TableCell>
                    <Tooltip content={`Delete firewall rule ${r.name}`} relationship="label">
                      <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete firewall rule ${r.name}`} disabled={fwBusy} onClick={() => setConfirmDeleteRule(r.name)}>Delete</Button>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className={s.ruleGrid}>
          <Field label="Rule name"><Input value={fwName} onChange={(_, d) => setFwName(d.value)} placeholder="allow-corp-vpn" /></Field>
          <Field label="Start IP"><Input value={fwStart} onChange={(_, d) => setFwStart(d.value)} placeholder="0.0.0.0" /></Field>
          <Field label="End IP"><Input value={fwEnd} onChange={(_, d) => setFwEnd(d.value)} placeholder="0.0.0.0" /></Field>
          <Button appearance="primary" disabled={fwBusy || !fwName.trim() || !fwStart.trim() || !fwEnd.trim()} onClick={addRule}>{fwBusy ? 'Saving…' : 'Add rule'}</Button>
        </div>
      </div>

      {/* Microsoft Entra admin — Microsoft.Sql/servers/administrators (Azure SQL only) */}
      {family === 'azure-sql' ? (
        <div className={s.card}>
          <Subtitle2>Microsoft Entra admin — {server}</Subtitle2>
          <MessageBar intent="info"><MessageBarBody>
            <MessageBarTitle>Microsoft.Sql/servers/administrators</MessageBarTitle>
            Sets the server's Microsoft Entra (Azure AD) admin via ARM. The console UAMI itself must be the Entra admin (or a member of the admin group) for the TDS query path to authenticate.
          </MessageBarBody></MessageBar>
          {aad && <Caption1>Current: <strong>{aad.login}</strong>{aad.sid ? <> (<code>{aad.sid.slice(0, 8)}…</code>)</> : null}{aad.azureADOnlyAuthentication ? ' · Entra-only auth enabled' : ''}</Caption1>}
          <div className={s.formGrid}>
            <Field label="Login (UPN or group name)" required><Input value={aadLogin} onChange={(_, d) => setAadLogin(d.value)} placeholder="user@contoso.com" /></Field>
            <Field label="Object id (sid)" required><Input value={aadSid} onChange={(_, d) => setAadSid(d.value)} placeholder="11111111-2222-3333-4444-555555555555" /></Field>
            <Field label="Tenant id (optional)"><Input value={aadTenantId} onChange={(_, d) => setAadTenantId(d.value)} placeholder="leave blank for the server's tenant" /></Field>
          </div>
          {aadMsg && <MessageBar intent={aadMsg.ok ? 'success' : 'error'}><MessageBarBody><MessageBarTitle>{aadMsg.ok ? 'Entra admin updated' : 'Entra admin update failed'}</MessageBarTitle>{aadMsg.text}</MessageBarBody></MessageBar>}
          <Button appearance="primary" disabled={aadBusy || !aadLogin.trim() || !aadSid.trim()} onClick={saveAad}>{aadBusy ? 'Saving…' : 'Set Microsoft Entra admin'}</Button>
        </div>
      ) : (
        <div className={s.card}>
          <Subtitle2>Microsoft Entra admin</Subtitle2>
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>Entra auth on PostgreSQL is principal-based</MessageBarTitle>
            PostgreSQL flexible servers don't expose a single server-level <code>administrators</code> ARM resource; Entra principals are created in-engine via <code>pgaadauth_create_principal</code>. The Query tab runs over the real <code>pg</code> wire protocol with an Entra token — register the console identity once (<code>SELECT * FROM pgaadauth_create_principal('&lt;console-uami-name&gt;', false, false)</code>) and set <code>LOOM_POSTGRES_AAD_USER</code> to that name. Honest gate — not a fake form.
          </MessageBarBody></MessageBar>
        </div>
      )}

      {/* Geo-replication — createMode=Secondary (Azure SQL only) */}
      {family === 'azure-sql' ? (
        <div className={s.card}>
          <Subtitle2>Active geo-replication — {database || '(select a database)'}</Subtitle2>
          <MessageBar intent="info"><MessageBarBody>
            <MessageBarTitle>Microsoft.Sql/servers/databases · createMode=Secondary</MessageBarTitle>
            Creates a readable geo-secondary of the selected database on a replica server via ARM REST. Long-running; ARM continues async after acceptance.
          </MessageBarBody></MessageBar>
          <div className={s.formGrid}>
            <Field label="Replica server" required>
              <select className={s.select} value={replicaServer} onChange={(e) => setReplicaServer(e.target.value)}>
                <option value="">Select a replica server…</option>
                {servers.filter((x) => x.name !== server).map((x) => <option key={x.name} value={x.name}>{x.name} · {x.location}</option>)}
              </select>
            </Field>
            <Field label="Replica DB name"><Input value={replicaDb} onChange={(_, d) => setReplicaDb(d.value)} placeholder={database || 'same as primary'} /></Field>
            <Field label="Replica region" required>
              <Dropdown className={s.fullWidth} selectedOptions={replicaLocation ? [replicaLocation] : []} value={replicaLocation} onOptionSelect={(_, d) => setReplicaLocation(d.optionValue || '')} aria-label="Replica region">
                {AZURE_REGIONS.map((r) => <Option key={r} value={r}>{r}</Option>)}
              </Dropdown>
            </Field>
            <Field label="SKU (optional — blank matches primary)">
              <Dropdown className={s.fullWidth} selectedOptions={replicaSku ? [replicaSku] : []} value={replicaSku} placeholder="Match primary" onOptionSelect={(_, d) => setReplicaSku(d.optionValue || '')} aria-label="Replica SKU">
                <Option value="">Match primary</Option>
                {SQL_DB_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
              </Dropdown>
            </Field>
          </div>
          {geoMsg && <MessageBar intent={geoMsg.ok ? 'success' : 'error'}><MessageBarBody><MessageBarTitle>{geoMsg.ok ? 'Geo-replica accepted' : 'Geo-replication failed'}</MessageBarTitle>{geoMsg.text}</MessageBarBody></MessageBar>}
          <Button appearance="primary" icon={<Add20Regular />} disabled={geoBusy || !database || !replicaServer || !replicaLocation} onClick={submitGeo}>{geoBusy ? 'Creating…' : 'Create geo-replica'}</Button>
        </div>
      ) : (
        <div className={s.card}>
          <Subtitle2>Geo-replication</Subtitle2>
          <MessageBar intent="warning"><MessageBarBody>
            <MessageBarTitle>PostgreSQL read replicas use a distinct ARM surface</MessageBarTitle>
            PG flexible-server read replicas are created via <code>Microsoft.DBforPostgreSQL/flexibleServers</code> with <code>createMode=Replica</code> + <code>sourceServerResourceId</code>, not the Azure SQL secondary-database path. Wire a PG replica route to manage it here. Honest gate.
          </MessageBarBody></MessageBar>
        </div>
      )}

      {/* Destructive-op confirmation for firewall rule deletion. */}
      <Dialog open={!!confirmDeleteRule} onOpenChange={(_, d) => { if (!d.open) setConfirmDeleteRule(null); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete firewall rule?</DialogTitle>
            <DialogContent>
              <Body1>
                This removes <code>{confirmDeleteRule}</code> from <strong>{server}</strong> via ARM.
                Clients in that IP range lose access. This cannot be undone.
              </Body1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirmDeleteRule(null)} disabled={fwBusy}>Cancel</Button>
              <Button appearance="primary" disabled={fwBusy} onClick={async () => { const n = confirmDeleteRule; setConfirmDeleteRule(null); if (n) await deleteRule(n); }}>
                {fwBusy ? 'Deleting…' : 'Delete rule'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
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

  // ---- connection strings (Connect tab card) ----
  type ConnDriverKey = 'adonet' | 'jdbc' | 'odbc' | 'php' | 'go';
  const [connDriver, setConnDriver] = useState<ConnDriverKey>('adonet');
  const [connCopied, setConnCopied] = useState<ConnDriverKey | null>(null);
  const connStrings = useMemo(
    () => ((family === 'azure-sql' && serverFqdn && database)
      ? buildConnectionStrings({ fqdn: serverFqdn, database })
      : null),
    [family, serverFqdn, database],
  );
  const copyConnStr = useCallback(async (key: ConnDriverKey, value: string) => {
    await navigator.clipboard?.writeText(value);
    setConnCopied(key);
    setTimeout(() => setConnCopied(null), 2000);
  }, []);

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
  const [tab, setTab] = useState<'connect' | 'provision' | 'query' | 'schema' | 'admin' | 'security' | 'performance' | 'catalog' | 'mirroring'>('connect');
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

  // Load a statement from the object navigator into the Query tab (SELECT
  // TOP 1000, EXEC, CREATE templates) — matches the SSMS / portal flow.
  const openInQuery = useCallback((sql: string) => {
    setSqlText(sql);
    setTab('query');
  }, []);

  // Azure-native mirroring (change feed → ADLS Bronze Delta; no Fabric).
  const [mirror, setMirror] = useState<any>(null);
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const toggleMirror = useCallback(async () => {
    if (!server || !database) { setMirror({ ok: false, error: 'select a server + database first' }); return; }
    setMirrorBusy(true); setMirror(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/mirroring`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database }),
    });
    setMirror(j); setMirrorBusy(false);
  }, [server, database, id]);

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
  const [newDbZoneRedundant, setNewDbZoneRedundant] = useState(false);
  const [newDbCollation, setNewDbCollation] = useState<SqlCollation>(DEFAULT_COLLATION);
  const [newDbBackupRedundancy, setNewDbBackupRedundancy] = useState('');
  const [newDbMaintenanceWindow, setNewDbMaintenanceWindow] = useState('');
  const [maintenanceConfigs, setMaintenanceConfigs] = useState<{ id: string; name: string; displayName: string }[]>([]);
  const [maintLoading, setMaintLoading] = useState(false);
  // PG fields
  const [pgName, setPgName] = useState('');
  const [pgRg, setPgRg] = useState('');
  const [pgLocation, setPgLocation] = useState('eastus2');
  const [pgAdmin, setPgAdmin] = useState('');
  const [pgPassword, setPgPassword] = useState('');
  const [pgSku, setPgSku] = useState('Standard_B1ms');
  const [pgTier, setPgTier] = useState('Burstable');
  const [pgVersion, setPgVersion] = useState('16');

  const loadMaintenanceConfigs = useCallback(async (serverName: string) => {
    if (!serverName) { setMaintenanceConfigs([]); return; }
    const loc = inv?.sql.servers.find((srv) => srv.name === serverName)?.location;
    if (!loc) { setMaintenanceConfigs([]); return; }
    setMaintLoading(true);
    const j = await fetchJson(
      `/api/items/azure-sql-database/${encodeURIComponent(id)}/maintenance-configs?location=${encodeURIComponent(loc)}`,
    );
    setMaintenanceConfigs(j.ok ? (j.configs || []) : []);
    setMaintLoading(false);
  }, [id, inv]);

  // Discover the region's maintenance windows whenever a target server is picked.
  useEffect(() => {
    if (newDbServer) loadMaintenanceConfigs(newDbServer);
    else setMaintenanceConfigs([]);
    // Reset any prior selection — windows are region-specific.
    setNewDbMaintenanceWindow('');
  }, [newDbServer, loadMaintenanceConfigs]);

  const provisionSqlDb = useCallback(async () => {
    // Client-side collation guard — reject anything outside the enumerated list
    // before issuing the BFF call (the dropdown enforces this; this is a
    // defense-in-depth check that mirrors the route-level validation).
    if (!SQL_COLLATIONS.includes(newDbCollation)) {
      setProvMsg({ ok: false, text: `Collation '${newDbCollation}' is not in the supported list.` });
      return;
    }
    setProvBusy(true); setProvMsg(null);
    const j = await fetchJson(`/api/items/azure-sql-database/${encodeURIComponent(id)}/create-db`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server: newDbServer, name: newDbName, skuName: newDbSku, tier: newDbTier,
        sampleName: newDbSample ? 'AdventureWorksLT' : undefined,
        zoneRedundant: newDbZoneRedundant || undefined,
        collation: newDbCollation !== DEFAULT_COLLATION ? newDbCollation : undefined,
        requestedBackupStorageRedundancy: newDbBackupRedundancy || undefined,
        maintenanceConfigurationId: newDbMaintenanceWindow || undefined,
      }),
    });
    setProvMsg(j.ok
      ? { ok: true, text: `Azure SQL database '${newDbName}' provisioning on ${newDbServer} · collation ${newDbCollation}${newDbZoneRedundant ? ' · zone-redundant' : ''} (status: ${j.status || 'accepted'}). ARM continues async.` }
      : { ok: false, text: j.error || 'create failed' });
    if (j.ok) loadInventory();
    setProvBusy(false);
  }, [id, newDbServer, newDbName, newDbSku, newDbTier, newDbSample, newDbZoneRedundant, newDbCollation, newDbBackupRedundancy, newDbMaintenanceWindow, loadInventory]);

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
        { label: 'Browse objects', onClick: server ? () => { setTab('schema'); loadSchema(); } : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Open the sys.* object navigator' },
      ]},
      { label: 'Server admin', actions: [
        { label: 'Firewall', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Manage firewall rules' },
        { label: 'Entra admin', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Set the Microsoft Entra admin' },
        { label: 'Geo-replication', onClick: server ? () => setTab('admin') : undefined, disabled: !server, title: !server ? 'Pick a server first' : 'Create a geo-secondary' },
      ]},
      { label: 'Data security', actions: [
        { label: 'GRANT / RLS / masking', onClick: (server && database && family === 'azure-sql') ? () => setTab('security') : undefined, disabled: !(server && database && family === 'azure-sql'), title: family !== 'azure-sql' ? 'Azure SQL only' : !(server && database) ? 'Pick a server + database first' : 'Object/column GRANT, Row-Level Security, Dynamic Data Masking' },
      ]},
      { label: 'Performance', actions: [
        { label: 'Query Store / QPI', onClick: (server && database) ? () => setTab('performance') : undefined, disabled: !(server && database), title: !(server && database) ? 'Pick a server + database first' : 'Top-resource queries, runtime-stats time series + execution plans over Query Store' },
      ]},
      { label: 'Catalog', actions: [
        { label: 'Register in Purview', onClick: serverFqdn ? () => { setTab('catalog'); } : undefined, disabled: !serverFqdn },
      ]},
    ]},
  ], [invLoading, loadInventory, server, database, family, bindConnection, qLoading, run, serverFqdn, loadSchema]);

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
          {serverFqdn && (
            <Caption1>
              FQDN: <code>{serverFqdn}</code>
              <Tooltip content="Copy FQDN" relationship="label">
                <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy server FQDN"
                  onClick={() => navigator.clipboard?.writeText(serverFqdn)} style={{ marginLeft: 4 }} />
              </Tooltip>
            </Caption1>
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="connect" icon={<PlugConnected20Regular />}>Connect</Tab>
            <Tab value="provision" icon={<Add20Regular />}>Provision</Tab>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="schema" icon={<Table20Regular />}>Schema</Tab>
            <Tab value="admin" icon={<ShieldKeyhole20Regular />}>Server admin</Tab>
            {family === 'azure-sql' && <Tab value="security" icon={<ShieldKeyhole20Regular />}>SQL security</Tab>}
            {family === 'azure-sql' && <Tab value="performance" icon={<ChartMultiple20Regular />}>Performance</Tab>}
            <Tab value="catalog" icon={<BookDatabase20Regular />}>Catalog</Tab>
            {family === 'azure-sql' && <Tab value="mirroring" icon={<ShieldKeyhole20Regular />}>Mirroring</Tab>}
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

              {/* ---- Connection strings (ADO.NET / JDBC / ODBC / PHP / Go) ---- */}
              {family === 'azure-sql' && serverFqdn && (
                <div className={s.connCard}>
                  <Subtitle2>Connection strings</Subtitle2>
                  {!database ? (
                    <Caption1>Select a database (left pane or a <strong>Connect</strong> button above) to generate driver-ready strings.</Caption1>
                  ) : (
                    <>
                      <Caption1>
                        FQDN: <code>{serverFqdn}</code> · DB: <code>{database}</code> · Auth: Microsoft Entra Managed Identity (password-free)
                      </Caption1>
                      <TabList
                        size="small"
                        selectedValue={connDriver}
                        onTabSelect={(_, d) => setConnDriver(d.value as ConnDriverKey)}
                      >
                        <Tab value="adonet">ADO.NET</Tab>
                        <Tab value="jdbc">JDBC</Tab>
                        <Tab value="odbc">ODBC</Tab>
                        <Tab value="php">PHP</Tab>
                        <Tab value="go">Go</Tab>
                      </TabList>
                      {connStrings && (
                        <div className={s.connCodeWrap}>
                          <pre className={s.connCode}>{connStrings[connDriver]}</pre>
                          <Tooltip content={connCopied === connDriver ? 'Copied!' : 'Copy to clipboard'} relationship="label">
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Copy20Regular />}
                              aria-label={`Copy ${connDriver} connection string`}
                              className={s.connCopyBtn}
                              onClick={() => copyConnStr(connDriver, connStrings[connDriver])}
                            />
                          </Tooltip>
                        </div>
                      )}
                      <Caption1>
                        All strings use password-free Microsoft Entra authentication (Managed Identity / Default).
                        Grant the connecting identity <code>db_datareader</code> / <code>db_datawriter</code> in the database via{' '}
                        <code>CREATE USER [&lt;entra-principal&gt;] FROM EXTERNAL PROVIDER;</code>.
                        {getSqlHostSuffix(serverFqdn).includes('usgovcloudapi') && (
                          <> Gov cloud detected — endpoint suffix is <code>{getSqlHostSuffix(serverFqdn)}</code> (GCC-High / IL5 / DoD).</>
                        )}
                      </Caption1>
                    </>
                  )}
                </div>
              )}
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
                    <Field label="SKU / service objective">
                      <Dropdown className={s.fullWidth} selectedOptions={[newDbSku]} value={newDbSku} onOptionSelect={(_, d) => setNewDbSku(d.optionValue || newDbSku)} aria-label="SKU / service objective">
                        {SQL_DB_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Tier">
                      <Dropdown className={s.fullWidth} selectedOptions={[newDbTier]} value={newDbTier} onOptionSelect={(_, d) => setNewDbTier(d.optionValue || newDbTier)} aria-label="Service tier">
                        {SQL_DB_TIERS.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Collation" hint="Set at create time only — immutable after the database exists.">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={[newDbCollation]}
                        value={newDbCollation}
                        onOptionSelect={(_, d) => setNewDbCollation((d.optionValue as SqlCollation) || newDbCollation)}
                        aria-label="Database collation"
                      >
                        {SQL_COLLATIONS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Backup storage redundancy">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={newDbBackupRedundancy ? [newDbBackupRedundancy] : []}
                        value={newDbBackupRedundancy ? (BACKUP_REDUNDANCY_OPTIONS.find((o) => o.value === newDbBackupRedundancy)?.label || newDbBackupRedundancy) : ''}
                        placeholder="Geo-redundant (default)"
                        onOptionSelect={(_, d) => setNewDbBackupRedundancy(d.optionValue || '')}
                        aria-label="Backup storage redundancy"
                      >
                        {BACKUP_REDUNDANCY_OPTIONS.map((o) => <Option key={o.value} value={o.value}>{o.label}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label={`Maintenance window${maintLoading ? ' (loading…)' : ''}`} hint="vCore tiers only. System default applies any time outside business hours.">
                      <Dropdown
                        className={s.fullWidth}
                        selectedOptions={[newDbMaintenanceWindow]}
                        value={newDbMaintenanceWindow ? (maintenanceConfigs.find((c) => c.id === newDbMaintenanceWindow)?.displayName || newDbMaintenanceWindow) : 'System default (any time)'}
                        disabled={maintLoading || !newDbServer}
                        onOptionSelect={(_, d) => setNewDbMaintenanceWindow(d.optionValue || '')}
                        aria-label="Maintenance window"
                      >
                        <Option value="">System default (any time)</Option>
                        {maintenanceConfigs.map((c) => <Option key={c.id} value={c.id}>{c.displayName}</Option>)}
                      </Dropdown>
                    </Field>
                  </div>
                  <Checkbox checked={newDbSample} onChange={(_, d) => setNewDbSample(!!d.checked)} label="Seed AdventureWorksLT sample schema" />
                  <Checkbox checked={newDbZoneRedundant} onChange={(_, d) => setNewDbZoneRedundant(!!d.checked)}
                    label="Zone-redundant (vCore tiers only: GeneralPurpose / BusinessCritical / Hyperscale)" />
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
                    <Field label="Region" required>
                      <Dropdown className={s.fullWidth} selectedOptions={[pgLocation]} value={pgLocation} onOptionSelect={(_, d) => setPgLocation(d.optionValue || pgLocation)} aria-label="Region">
                        {AZURE_REGIONS.map((r) => <Option key={r} value={r}>{r}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="PG version">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgVersion]} value={pgVersion} onOptionSelect={(_, d) => setPgVersion(d.optionValue || pgVersion)} aria-label="PostgreSQL version">
                        {PG_VERSIONS.map((v) => <Option key={v} value={v}>{v}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Admin login" required><Input value={pgAdmin} onChange={(_, d) => setPgAdmin(d.value)} placeholder="pgadmin" /></Field>
                    <Field label="Admin password" required><Input type="password" value={pgPassword} onChange={(_, d) => setPgPassword(d.value)} /></Field>
                    <Field label="Tier">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgTier]} value={pgTier} onOptionSelect={(_, d) => setPgTier(d.optionValue || pgTier)} aria-label="Compute tier">
                        {PG_TIERS.map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="SKU">
                      <Dropdown className={s.fullWidth} selectedOptions={[pgSku]} value={pgSku} onOptionSelect={(_, d) => setPgSku(d.optionValue || pgSku)} aria-label="Compute SKU">
                        {PG_SKUS.map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
                      </Dropdown>
                    </Field>
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
              </div>
              {family === 'managed-instance' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>MI query requires a private endpoint in the MI subnet</MessageBarTitle>SQL MI has no public TDS gateway. Provision <code>Microsoft.Network/privateEndpoints</code> to the instance and grant the console UAMI <code>db_datareader</code>, then the same TDS path the Azure SQL editor uses applies. The route returns an honest 501 until then.</MessageBarBody></MessageBar>
              )}
              {family === 'postgres' && (
                <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>PostgreSQL query path is gated</MessageBarTitle>Add the <code>pg</code> driver to apps/fiab-console and set <code>LOOM_POSTGRES_QUERY_LIVE=true</code> (with the console UAMI created as a PG AAD principal via <code>pgaadauth_create_principal</code>). ARM inventory, provisioning, databases, and firewall are fully live now.</MessageBarBody></MessageBar>
              )}
              {family === 'postgres' ? (
                // PostgreSQL: the sys.*-fed IntelliSense + T-SQL templates are
                // T-SQL-specific, so the PG path keeps the plain Monaco surface
                // until a pg-catalog provider lands. Run still posts the script.
                <>
                  <div className={s.toolbar}>
                    <Button appearance="primary" icon={<Play20Regular />} disabled={qLoading || !server} onClick={() => run()} style={{ marginLeft: 'auto' }}>Run</Button>
                  </div>
                  <MonacoTextarea value={sqlText} onChange={setSqlText} language={dialect} height={240} minHeight={200} ariaLabel="SQL editor" />
                </>
              ) : (
                <TsqlMonaco
                  value={sqlText}
                  onChange={setSqlText}
                  onRun={(sql) => run(sql)}
                  server={server}
                  database={database}
                  itemId={id}
                  height={240}
                  readOnly={family === 'managed-instance'}
                  busy={qLoading}
                />
              )}
              <ResultsPanel result={qResult} loading={qLoading} />
            </>
          )}

          {/* ---------------- Schema (rich sys.* object navigator) ---------------- */}
          {tab === 'schema' && (
            <>
              {!server ? (
                <Caption1>Pick a server on the <strong>Connect</strong> tab (or left pane) to browse database objects.</Caption1>
              ) : family === 'azure-sql' ? (
                <>
                  <div className={s.toolbar}>
                    <Badge appearance="filled" color="brand" icon={<Database20Regular />}>sys.* object navigator</Badge>
                    <Caption1>Tables, views, procedures, functions, table types, schemas over live TDS · double-click an action to load it into the Query tab.</Caption1>
                  </div>
                  {/* Real SqlDbTree wired to the SAME sys.*-over-TDS backend the
                      Fabric SQL editor uses, targeting the user-selected Azure
                      SQL server/database via the new server/database override. */}
                  <div className={s.treeWrap}>
                    <SqlDbTree
                      // No Fabric workspace here — the explicit server/database
                      // override drives resolution, so workspaceId is unused.
                      workspaceId=""
                      itemId={id}
                      server={server}
                      database={database}
                      onOpenQuery={openInQuery}
                    />
                  </div>
                </>
              ) : family === 'postgres' ? (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>PostgreSQL object navigator is gated</MessageBarTitle>
                  The sys.* navigator is T-SQL-specific. The PostgreSQL catalog browser (information_schema / pg_catalog over the <code>pg</code> wire protocol) lights up once the <code>pg</code> driver is added and <code>LOOM_POSTGRES_QUERY_LIVE=true</code>. Use the INFORMATION_SCHEMA query below in the meantime.
                </MessageBarBody></MessageBar>
              ) : (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>SQL MI object navigator requires a private endpoint</MessageBarTitle>
                  SQL Managed Instance has no public TDS gateway; provision <code>Microsoft.Network/privateEndpoints</code> into the MI subnet and grant the console UAMI <code>db_datareader</code>, then the same sys.* navigator the Azure SQL surface uses applies.
                </MessageBarBody></MessageBar>
              )}
              {/* INFORMATION_SCHEMA fallback grid (works for any reachable engine via the query path). */}
              {server && (
                <>
                  <div className={s.toolbar} style={{ marginTop: 8 }}>
                    <Caption1>INFORMATION_SCHEMA.TABLES on <strong>{database || server || 'not set'}</strong></Caption1>
                    <Button size="small" appearance="outline" onClick={loadSchema} disabled={schemaLoading || !server}>Refresh</Button>
                  </div>
                  <ResultsPanel result={schema} loading={schemaLoading} />
                </>
              )}
            </>
          )}

          {/* ---------------- Server admin (firewall / Entra / geo-replication) ---------------- */}
          {tab === 'admin' && (
            <SqlServerAdminPanel
              id={id}
              family={family}
              server={server}
              database={database}
              servers={(inv?.sql.servers || []).map((x) => ({ name: x.name, location: x.location }))}
            />
          )}

          {/* ---------------- SQL granular security (F11) ---------------- */}
          {tab === 'security' && (
            family === 'azure-sql'
              ? (server && database
                  ? <SqlSecurityPanel itemType="azure-sql-database" itemId={id} server={server} database={database} />
                  : <Caption1>Pick a server + database on the <strong>Connect</strong> tab to manage object/column GRANT, Row-Level Security and Dynamic Data Masking.</Caption1>)
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>T-SQL security wizards apply to Azure SQL</MessageBarTitle>
                    Object/column GRANT, Row-Level Security and Dynamic Data Masking are T-SQL features. Select an Azure SQL database to use them; PostgreSQL uses its own role/RLS model.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* ---------------- Performance (Query Store / QPI) ---------------- */}
          {tab === 'performance' && (
            family === 'azure-sql'
              ? <SqlPerformanceDashboard id={id} server={server} database={database} />
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Query Store performance applies to Azure SQL</MessageBarTitle>
                    The Query Store dashboard reads the T-SQL <code>sys.query_store_*</code> catalog views. Select an Azure SQL database to use it; PostgreSQL exposes performance via <code>pg_stat_statements</code> instead.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* ---------------- Catalog ---------------- */}
          {tab === 'catalog' && (            <>
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

          {tab === 'mirroring' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Mirroring — Azure-native CDC (no Microsoft Fabric)</MessageBarTitle>
                  Enables the database <strong>change feed</strong> via the real{' '}
                  <code>sys.sp_change_feed_enable_db</code>. Stream the captured changes to ADLS{' '}
                  <strong>Bronze Delta</strong> with an ADF CDC pipeline / Synapse Link copy or the Loom
                  mirroring engine. The console identity must be <code>db_owner</code> on this database; a
                  permission / tier error is shown verbatim (no Fabric workspace required).
                </MessageBarBody>
              </MessageBar>
              <div className={s.card}>
                <Caption1>Selected: <code>{serverFqdn || 'no server'}</code>{database && <> / <code>{database}</code></>}</Caption1>
                <Button appearance="primary" icon={<ShieldKeyhole20Regular />} disabled={mirrorBusy || !server || !database} onClick={toggleMirror}>
                  {mirrorBusy ? 'Enabling…' : 'Enable / refresh mirroring'}
                </Button>
                {mirror && (
                  <MessageBar intent={mirror.ok && mirror.config?.state !== 'Error' ? 'success' : 'warning'}>
                    <MessageBarBody>
                      <MessageBarTitle>
                        {mirror.ok ? `Change feed: ${mirror.config?.state || 'updated'}` : 'Could not enable'}
                      </MessageBarTitle>
                      {mirror.ok
                        ? (mirror.config?.lastError || mirror.config?.note || 'Change feed enabled.')
                        : (mirror.error || 'request failed')}
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
