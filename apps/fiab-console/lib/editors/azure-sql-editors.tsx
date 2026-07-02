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
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Skeleton, SkeletonItem, Input, Label,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Field, Dropdown, Option, Tooltip,
  TabList, Tab, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Server20Regular, Play20Regular, Add20Regular,
  ShieldKeyhole20Regular, Globe20Regular, Sparkle20Regular,
  ArrowDownload20Regular, Delete20Regular, Copy20Regular, Stop20Regular,
  ArrowSync20Regular, Dismiss20Regular, DocumentSearch20Regular,
  TableSimple20Regular, DatabaseMultiple20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import { SqlDbTree } from '@/lib/components/sqldb/sqldb-tree';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { FullTextSearchPanel, VectorIndexPanel } from './components/sql-search-management';
import { useJobsStore } from '@/lib/state/jobs-store';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useSharedEditorStyles } from './shared-styles';

// ── Azure SQL real option sets (parity with the portal create/scale blades) ──
const AZURE_REGIONS = [
  'eastus', 'eastus2', 'centralus', 'southcentralus', 'westus', 'westus2', 'westus3',
  'northcentralus', 'westcentralus', 'canadacentral', 'northeurope', 'westeurope',
  'uksouth', 'ukwest', 'francecentral', 'germanywestcentral', 'switzerlandnorth',
  'norwayeast', 'swedencentral', 'eastasia', 'southeastasia', 'japaneast', 'japanwest',
  'australiaeast', 'australiasoutheast', 'centralindia', 'southindia', 'koreacentral',
  'brazilsouth', 'southafricanorth', 'uaenorth',
  // US Government regions
  'usgovvirginia', 'usgovarizona', 'usgovtexas', 'usdodeast', 'usdodcentral',
];

// Service-objective (skuName) families — the real Azure SQL DB option set.
const SQL_DB_SKUS = [
  { group: 'Basic / DTU', skus: ['Basic', 'S0', 'S1', 'S2', 'S3', 'S4', 'S6', 'S7', 'S9', 'S12'] },
  { group: 'Premium / DTU', skus: ['P1', 'P2', 'P4', 'P6', 'P11', 'P15'] },
  { group: 'General Purpose (vCore)', skus: ['GP_Gen5_2', 'GP_Gen5_4', 'GP_Gen5_8', 'GP_Gen5_16', 'GP_Gen5_32', 'GP_Gen5_40'] },
  { group: 'General Purpose serverless', skus: ['GP_S_Gen5_1', 'GP_S_Gen5_2', 'GP_S_Gen5_4', 'GP_S_Gen5_8', 'GP_S_Gen5_16'] },
  { group: 'Business Critical (vCore)', skus: ['BC_Gen5_2', 'BC_Gen5_4', 'BC_Gen5_8', 'BC_Gen5_16', 'BC_Gen5_32'] },
  { group: 'Hyperscale (vCore)', skus: ['HS_Gen5_2', 'HS_Gen5_4', 'HS_Gen5_8', 'HS_Gen5_16', 'HS_Gen5_32'] },
];

const SQL_DB_TIERS = ['Basic', 'Standard', 'Premium', 'GeneralPurpose', 'BusinessCritical', 'Hyperscale'];

const VECTOR_METRICS = ['cosine', 'euclidean', 'dot'] as const;
const VECTOR_DIMS = [256, 384, 512, 768, 1024, 1536, 2048, 3072];

// ── Results export (CSV / JSON) — client-side download, no extra route ──
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
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function resultsToCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map(csvEscape).join(',');
  const body = rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(',')).join('\r\n');
  return `${head}\r\n${body}`;
}
function resultsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null]))), null, 2);
}

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: '200px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '200px' },
  resultMeta: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalS, flexWrap: 'wrap' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS },
  tableWrap: {
    overflow: 'auto', maxHeight: '360px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  // Icon + title section header (e.g. "Databases", "Managed Instances").
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground1,
  },
  sectionHeaderIcon: { color: tokens.colorBrandForeground1, display: 'flex' },
  formRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalM },
  fullWidth: { width: '100%' },
  // SQL database schema-object browser (left pane)
  sqlLeftPane: {
    padding: tokens.spacingVerticalS,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    height: '100%',
    minHeight: 0,
  },
  schemaHint: { color: tokens.colorNeutralForeground3 },
  schemaBrowserHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  schemaBrowserTitle: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    marginRight: 'auto',
  },
  schemaBrowserBox: {
    flex: 1,
    minHeight: '360px',
    display: 'flex',
    flexDirection: 'column',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  // Databases master table — clickable rows that drive the schema browser.
  dbTableToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  dbSearch: { minWidth: '220px', maxWidth: '320px' },
  dbCount: { marginLeft: 'auto', color: tokens.colorNeutralForeground3 },
  sortHeader: {
    cursor: 'pointer',
    userSelect: 'none',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  dbRow: {
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  dbRowSelected: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Selected },
  },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

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
  if (loading) return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Spinner size="tiny" label="Executing T-SQL…" labelPosition="after" />
      </div>
      <Skeleton aria-label="Executing query…">
        <SkeletonItem size={16} style={{ width: '40%' }} />
        <SkeletonItem size={12} />
        <SkeletonItem size={12} style={{ width: '90%' }} />
        <SkeletonItem size={12} style={{ width: '75%' }} />
      </Skeleton>
    </div>
  );
  if (!result) return (
    <div className={s.resultBox}>
      <EmptyState
        icon={<Play20Regular />}
        title="No results yet"
        body="Write T-SQL above, then click Run to execute it over AAD-authenticated TDS and see the rows here."
      />
    </div>
  );
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
                onClick={() => downloadBlob(`query-results-${stamp}.csv`, 'text/csv', resultsToCsv(columns, rows))}>
                CSV
              </Button>
            </Tooltip>
            <Tooltip content="Download results as JSON" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.json`, 'application/json', resultsToJson(columns, rows))}>
                JSON
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={<TableSimple20Regular />}
          title="Query returned no rows"
          body="The statement executed successfully but produced an empty result set."
        />
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

interface FirewallRule { name: string; startIpAddress: string; endIpAddress: string }
interface AadAdminState { login: string; sid: string; tenantId?: string; azureADOnlyAuthentication?: boolean }

export function AzureSqlServerEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selected, setSelected] = useState<ServerInfo | null>(null);
  const [databases, setDatabases] = useState<Array<{ name: string; status?: string; sku?: any }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Server → database → schema/table browser sub-panel. Selecting a database
  // node mounts the live `SqlDbTree` object navigator (real sys.* over TDS),
  // opening a separate connection to that database (Azure SQL DB has no
  // cross-database query, so each db is browsed on its own connection).
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);
  // Databases master-table filter + sort (client-side over the ARM list).
  const [dbFilter, setDbFilter] = useState('');
  const [dbSort, setDbSort] = useState<{ col: 'name' | 'status' | 'sku'; dir: 'asc' | 'desc' }>({ col: 'name', dir: 'asc' });

  // Firewall dialog
  const [fwOpen, setFwOpen] = useState(false);
  const [fwRules, setFwRules] = useState<FirewallRule[]>([]);
  const [fwError, setFwError] = useState<string | null>(null);
  const [fwBusy, setFwBusy] = useState(false);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleStart, setNewRuleStart] = useState('');
  const [newRuleEnd, setNewRuleEnd] = useState('');
  const [confirmDeleteRule, setConfirmDeleteRule] = useState<string | null>(null);

  // AAD admin dialog
  const [aadOpen, setAadOpen] = useState(false);
  const [aadCurrent, setAadCurrent] = useState<AadAdminState | null>(null);
  const [aadLogin, setAadLogin] = useState('');
  const [aadSid, setAadSid] = useState('');
  const [aadTenantId, setAadTenantId] = useState('');
  const [aadError, setAadError] = useState<string | null>(null);
  const [aadBusy, setAadBusy] = useState(false);

  const loadFirewall = useCallback(async () => {
    if (!selected) return;
    setFwBusy(true); setFwError(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/firewall?server=${encodeURIComponent(selected.name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setFwRules(j.rules || []);
    } catch (e: any) { setFwError(e?.message || String(e)); }
    finally { setFwBusy(false); }
  }, [id, selected]);

  const addRule = useCallback(async () => {
    if (!selected || !newRuleName.trim() || !newRuleStart.trim() || !newRuleEnd.trim()) return;
    setFwBusy(true); setFwError(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/firewall`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server: selected.name, name: newRuleName.trim(), startIpAddress: newRuleStart.trim(), endIpAddress: newRuleEnd.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setNewRuleName(''); setNewRuleStart(''); setNewRuleEnd('');
      await loadFirewall();
    } catch (e: any) { setFwError(e?.message || String(e)); }
    finally { setFwBusy(false); }
  }, [id, selected, newRuleName, newRuleStart, newRuleEnd, loadFirewall]);

  const deleteRule = useCallback(async (ruleName: string) => {
    if (!selected) return;
    setFwBusy(true); setFwError(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/firewall?server=${encodeURIComponent(selected.name)}&rule=${encodeURIComponent(ruleName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      await loadFirewall();
    } catch (e: any) { setFwError(e?.message || String(e)); }
    finally { setFwBusy(false); }
  }, [id, selected, loadFirewall]);

  const openFw = useCallback(() => {
    setFwOpen(true);
    loadFirewall();
  }, [loadFirewall]);

  const loadAad = useCallback(async () => {
    if (!selected) return;
    setAadBusy(true); setAadError(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin?server=${encodeURIComponent(selected.name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setAadCurrent(j.admin || null);
      if (j.admin) {
        setAadLogin(j.admin.login || '');
        setAadSid(j.admin.sid || '');
        setAadTenantId(j.admin.tenantId || '');
      }
    } catch (e: any) { setAadError(e?.message || String(e)); }
    finally { setAadBusy(false); }
  }, [id, selected]);

  const openAad = useCallback(() => {
    setAadOpen(true);
    loadAad();
  }, [loadAad]);

  const saveAad = useCallback(async () => {
    if (!selected || !aadLogin.trim() || !aadSid.trim()) return;
    setAadBusy(true); setAadError(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/aad-admin`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server: selected.name, login: aadLogin.trim(), sid: aadSid.trim(), tenantId: aadTenantId.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setAadCurrent(j.admin || null);
    } catch (e: any) { setAadError(e?.message || String(e)); }
    finally { setAadBusy(false); }
  }, [id, selected, aadLogin, aadSid, aadTenantId]);

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
    setSelectedDb(null);
    try {
      const r = await fetch(`/api/items/azure-sql-server/${id}/databases?server=${encodeURIComponent(sv.name)}`);
      const j = await r.json();
      if (j.ok) setDatabases(j.databases || []);
      else setError(j.error);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [id]);

  // Client-side filter + sort over the ARM database list.
  const visibleDatabases = useMemo(() => {
    const q = dbFilter.trim().toLowerCase();
    const filtered = q
      ? databases.filter((d) =>
          d.name.toLowerCase().includes(q) ||
          (d.status || '').toLowerCase().includes(q) ||
          (d.sku?.name || '').toLowerCase().includes(q))
      : databases;
    const val = (d: typeof databases[number]) =>
      dbSort.col === 'name' ? d.name : dbSort.col === 'status' ? (d.status || '') : (d.sku?.name || '');
    const sorted = [...filtered].sort((a, b) =>
      val(a).localeCompare(val(b), undefined, { sensitivity: 'base', numeric: true }));
    return dbSort.dir === 'desc' ? sorted.reverse() : sorted;
  }, [databases, dbFilter, dbSort]);

  const toggleSort = useCallback((col: 'name' | 'status' | 'sku') => {
    setDbSort((prev) => prev.col === col
      ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { col, dir: 'asc' });
  }, []);

  const openDb = useCallback((name: string) => {
    setSelectedDb(name);
    setBrowserRefreshKey((k) => k + 1);
  }, []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Databases', actions: [
        { label: loading ? 'Refreshing…' : 'Refresh list', onClick: loading ? undefined : refresh, disabled: loading },
      ]},
      { label: 'Security', actions: [
        { label: 'Firewall', onClick: selected ? openFw : undefined, disabled: !selected, title: !selected ? 'Pick a server on the left first' : undefined },
        { label: 'AAD admin', onClick: selected ? openAad : undefined, disabled: !selected, title: !selected ? 'Pick a server on the left first' : undefined },
      ]},
    ]},
  ], [loading, refresh, selected, openFw, openAad]);

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
                {servers.map((sv) => {
                  const isSelected = selected?.id === sv.id;
                  return (
                    <TreeItem key={sv.id} itemType="branch" value={sv.id} open={isSelected ? true : undefined}>
                      <TreeItemLayout
                        iconBefore={<Server20Regular />}
                        onClick={() => pickServer(sv)}
                      >
                        {sv.name}
                      </TreeItemLayout>
                      <Tree>
                        {isSelected && !loading && databases.length === 0 && (
                          <TreeItem itemType="leaf" value={`${sv.id}::nodb`}>
                            <TreeItemLayout><Caption1>No databases on this server</Caption1></TreeItemLayout>
                          </TreeItem>
                        )}
                        {isSelected && loading && (
                          <TreeItem itemType="leaf" value={`${sv.id}::loading`}>
                            <TreeItemLayout><Spinner size="tiny" label="Loading databases…" labelPosition="after" /></TreeItemLayout>
                          </TreeItem>
                        )}
                        {isSelected && databases.map((d) => (
                          <TreeItem
                            key={`${sv.id}::${d.name}`}
                            itemType="leaf"
                            value={`${sv.id}::${d.name}`}
                            aria-selected={d.name === selectedDb}
                            onClick={() => openDb(d.name)}
                          >
                            <TreeItemLayout iconBefore={<Database20Regular />}>{d.name}</TreeItemLayout>
                          </TreeItem>
                        ))}
                        {!isSelected && (
                          <TreeItem itemType="leaf" value={`${sv.id}::hint`}>
                            <TreeItemLayout><Caption1>Select to list databases</Caption1></TreeItemLayout>
                          </TreeItem>
                        )}
                      </Tree>
                    </TreeItem>
                  );
                })}
              </Tree>
            </TreeItem>
          </Tree>
          {/* Server → database → schema/table browser sub-panel. Mounts the live
              SqlDbTree object navigator against the selected database's FQDN,
              opening a dedicated TDS connection (Azure SQL DB has no cross-db
              query). The navigator surfaces the real connection/auth error
              honestly (per no-vaporware.md) if the console UAMI is not the
              server's Microsoft Entra admin. */}
          {selected && selectedDb && (
            <>
              <div className={s.schemaBrowserHeader}>
                <Caption1 className={s.schemaBrowserTitle}>{selected.name} / {selectedDb}</Caption1>
                <Tooltip content="Reload objects from sys.* catalog" relationship="label">
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<ArrowSync20Regular />}
                    onClick={() => setBrowserRefreshKey((k) => k + 1)}
                    aria-label="Refresh schema browser"
                  />
                </Tooltip>
                <Tooltip content="Close schema browser" relationship="label">
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<Dismiss20Regular />}
                    onClick={() => setSelectedDb(null)}
                    aria-label="Close schema browser"
                  />
                </Tooltip>
              </div>
              <div className={s.schemaBrowserBox}>
                <SqlDbTree
                  workspaceId=""
                  itemId="new"
                  server={selected.fqdn}
                  database={selectedDb}
                  refreshKey={browserRefreshKey}
                />
              </div>
            </>
          )}
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
            loading ? (
              <Skeleton aria-label="Loading SQL servers…">
                <SkeletonItem size={16} style={{ width: '32%' }} />
                <SkeletonItem size={12} />
                <SkeletonItem size={12} style={{ width: '85%' }} />
              </Skeleton>
            ) : (
              <EmptyState
                icon={<Server20Regular />}
                title="Select a SQL server"
                body="Pick a server in the left tree to inspect its databases, firewall rules, and Microsoft Entra admin over live ARM."
              />
            )
          ) : (
            <>
              <Subtitle2 className={s.sectionHeader}>
                <span className={s.sectionHeaderIcon}><Server20Regular /></span>
                {selected.name}
              </Subtitle2>
              <div className={s.toolbar}>
                <Badge appearance="filled" color={selected.state === 'Ready' ? 'success' : 'informative'}>{selected.state || 'Unknown'}</Badge>
                <Badge appearance="outline">{selected.location}</Badge>
                <Badge appearance="outline">v{selected.version || '?'}</Badge>
                <Badge appearance="outline" color={selected.publicNetworkAccess === 'Disabled' ? 'success' : 'warning'}>
                  Public access: {selected.publicNetworkAccess || 'Unknown'}
                </Badge>
              </div>
              <Body1>
                FQDN: <code>{selected.fqdn}</code>
                <Tooltip content="Copy FQDN" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Copy20Regular />} aria-label="Copy server FQDN"
                    onClick={() => navigator.clipboard?.writeText(selected.fqdn)} style={{ marginLeft: tokens.spacingHorizontalXXS }} />
                </Tooltip>
              </Body1>
              <Body1>AAD admin login: <code>{selected.administratorLogin || '— set via Microsoft.Sql/servers/administrators —'}</code></Body1>

              <div className={s.dbTableToolbar} style={{ marginTop: tokens.spacingVerticalM }}>
                <Subtitle2 className={s.sectionHeader}>
                  <span className={s.sectionHeaderIcon}><DatabaseMultiple20Regular /></span>
                  Databases
                </Subtitle2>
                <Input
                  size="small"
                  className={s.dbSearch}
                  placeholder="Filter databases…"
                  value={dbFilter}
                  onChange={(_, d) => setDbFilter(d.value)}
                  contentBefore={<DocumentSearch20Regular />}
                  contentAfter={dbFilter
                    ? <Button size="small" appearance="transparent" icon={<Dismiss20Regular />} aria-label="Clear filter" onClick={() => setDbFilter('')} />
                    : undefined}
                  aria-label="Filter databases"
                />
                <Caption1 className={s.dbCount}>
                  {dbFilter ? `${visibleDatabases.length} of ${databases.length}` : `${databases.length}`} database{databases.length === 1 ? '' : 's'}
                </Caption1>
              </div>
              {loading ? (
                <div className={s.tableWrap}>
                  <Skeleton aria-label="Loading databases…" style={{ padding: tokens.spacingVerticalXL }}>
                    <SkeletonItem size={16} style={{ width: '30%' }} />
                    <SkeletonItem size={12} />
                    <SkeletonItem size={12} style={{ width: '90%' }} />
                    <SkeletonItem size={12} style={{ width: '70%' }} />
                  </Skeleton>
                </div>
              ) : databases.length === 0 ? (
                <EmptyState
                  icon={<Database20Regular />}
                  title={`No databases on ${selected.name}`}
                  body="Create one with `az sql db create` or in the Azure portal, then Refresh to see it listed here."
                />
              ) : visibleDatabases.length === 0 ? (
                <EmptyState
                  icon={<DocumentSearch20Regular />}
                  title={`No databases match “${dbFilter}”`}
                  body="No database on this server matches the current filter. Clear it to see them all."
                  primaryAction={{ label: 'Clear filter', appearance: 'secondary', onClick: () => setDbFilter('') }}
                />
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Databases" size="small" sortable>
                    <TableHeader><TableRow>
                      <TableHeaderCell
                        className={s.sortHeader}
                        sortDirection={dbSort.col === 'name' ? (dbSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        onClick={() => toggleSort('name')}
                      >Name</TableHeaderCell>
                      <TableHeaderCell
                        className={s.sortHeader}
                        sortDirection={dbSort.col === 'status' ? (dbSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        onClick={() => toggleSort('status')}
                      >Status</TableHeaderCell>
                      <TableHeaderCell
                        className={s.sortHeader}
                        sortDirection={dbSort.col === 'sku' ? (dbSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        onClick={() => toggleSort('sku')}
                      >SKU</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {visibleDatabases.map((d) => {
                        const isSel = d.name === selectedDb;
                        return (
                          <TableRow
                            key={d.name}
                            role="button"
                            tabIndex={0}
                            aria-selected={isSel}
                            aria-label={`Browse schema of ${d.name}`}
                            className={mergeClasses(s.dbRow, isSel && s.dbRowSelected)}
                            onClick={() => openDb(d.name)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDb(d.name); } }}
                          >
                            <TableCell><strong>{d.name}</strong></TableCell>
                            <TableCell>{d.status || '—'}</TableCell>
                            <TableCell>{d.sku?.name || '—'}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Caption1 className={s.schemaHint}>
                Select a database (here or in the left tree) to browse its schemas, tables, views,
                stored procedures, and functions over live TDS (<code>sys.*</code>) — opened on a
                dedicated connection to that database. The console UAMI must be the server's
                Microsoft Entra admin (or have <code>db_datareader</code> + <code>VIEW DEFINITION</code>);
                the navigator surfaces the real connection error otherwise.
              </Caption1>
              <Caption1>
                Use the <strong>Firewall</strong> and <strong>AAD admin</strong> ribbon buttons above to
                manage <code>Microsoft.Sql/servers/firewallRules</code> and
                <code> Microsoft.Sql/servers/administrators</code> inline via ARM.
              </Caption1>
            </>
          )}

          <Dialog open={fwOpen} onOpenChange={(_, d) => setFwOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '760px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Firewall rules — {selected?.name}</DialogTitle>
                <DialogContent>
                  {fwBusy && <Spinner size="tiny" label="Calling ARM…" labelPosition="after" />}
                  {fwError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Firewall API error</MessageBarTitle>{fwError}</MessageBarBody></MessageBar>
                  )}
                  <div style={{ overflow: 'auto', marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM }}>
                    <Table aria-label="Firewall rules" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Start IP</TableHeaderCell>
                        <TableHeaderCell>End IP</TableHeaderCell>
                        <TableHeaderCell>Action</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {fwRules.length === 0 && (
                          <TableRow><TableCell colSpan={4}><Caption1>No firewall rules.</Caption1></TableCell></TableRow>
                        )}
                        {fwRules.map((r) => (
                          <TableRow key={r.name}>
                            <TableCell><strong>{r.name}</strong></TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.startIpAddress}</code></TableCell>
                            <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{r.endIpAddress}</code></TableCell>
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
                  <Subtitle2>Add rule</Subtitle2>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS }}>
                    <Field label="Name"><Input value={newRuleName} onChange={(_, d) => setNewRuleName(d.value)} placeholder="allow-corp-vpn" /></Field>
                    <Field label="Start IP"><Input value={newRuleStart} onChange={(_, d) => setNewRuleStart(d.value)} placeholder="0.0.0.0" /></Field>
                    <Field label="End IP"><Input value={newRuleEnd} onChange={(_, d) => setNewRuleEnd(d.value)} placeholder="0.0.0.0" /></Field>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setFwOpen(false)} disabled={fwBusy}>Close</Button>
                  <Button appearance="primary" onClick={addRule} disabled={fwBusy || !newRuleName.trim() || !newRuleStart.trim() || !newRuleEnd.trim()}>
                    {fwBusy ? 'Saving…' : 'Add rule'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Destructive-op confirmation for firewall rule deletion. */}
          <Dialog open={!!confirmDeleteRule} onOpenChange={(_, d) => { if (!d.open) setConfirmDeleteRule(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Delete firewall rule?</DialogTitle>
                <DialogContent>
                  <Body1>
                    This removes <code>{confirmDeleteRule}</code> from <strong>{selected?.name}</strong> via ARM.
                    Clients in that IP range will lose access. This cannot be undone.
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

          <Dialog open={aadOpen} onOpenChange={(_, d) => setAadOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>AAD admin — {selected?.name}</DialogTitle>
                <DialogContent>
                  {aadBusy && <Spinner size="tiny" label="Calling ARM…" labelPosition="after" />}
                  {aadCurrent && (
                    <Caption1>
                      Current: <strong>{aadCurrent.login}</strong> (<code>{aadCurrent.sid?.slice(0, 8)}…</code>)
                      {aadCurrent.azureADOnlyAuthentication ? ' · AAD-only auth enabled' : ''}
                    </Caption1>
                  )}
                  <Field label="Login (UPN or group name)" required>
                    <Input value={aadLogin} onChange={(_, d) => setAadLogin(d.value)} placeholder="user@contoso.com" />
                  </Field>
                  <Field label="Object id (sid)" required>
                    <Input value={aadSid} onChange={(_, d) => setAadSid(d.value)} placeholder="11111111-2222-3333-4444-555555555555" />
                  </Field>
                  <Field label="Tenant id (optional)">
                    <Input value={aadTenantId} onChange={(_, d) => setAadTenantId(d.value)} placeholder="leave blank to use the server's tenant" />
                  </Field>
                  {aadError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>AAD admin update failed</MessageBarTitle>{aadError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setAadOpen(false)} disabled={aadBusy}>Close</Button>
                  <Button appearance="primary" onClick={saveAad} disabled={aadBusy || !aadLogin.trim() || !aadSid.trim()}>
                    {aadBusy ? 'Saving…' : 'Set AAD admin'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
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
  const [tab, setTab] = useState<'query' | 'fts' | 'vector' | 'mirroring' | 'replication' | 'sql2025'>('query');
  const [sqlText, setSqlText] = useState<string>(
    `-- Azure SQL database — TDS over AAD MI from the Loom Console BFF.\nSELECT 1 AS smoke, DB_NAME() AS db, SUSER_NAME() AS upn, @@VERSION AS version;`,
  );
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Background-job continuity + TDS cancel token (see jobs-store.startSqlQuery).
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const startSqlQuery = useJobsStore((st) => st.startSqlQuery);
  const jobs = useJobsStore((st) => st.jobs);
  const [mirrorState, setMirrorState] = useState<any>(null);
  const [sql2025State, setSql2025State] = useState<any>(null);

  // Left-pane schema-object browser (live sys.* over TDS via SqlDbTree).
  const [schemaTab, setSchemaTab] = useState<'none' | 'browser'>('none');
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);

  // Geo-replica dialog
  const [geoOpen, setGeoOpen] = useState(false);
  const [replicaServer, setReplicaServer] = useState('');
  const [replicaLocation, setReplicaLocation] = useState('eastus2');
  const [replicaDb, setReplicaDb] = useState('');
  const [replicaSku, setReplicaSku] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoOk, setGeoOk] = useState<string | null>(null);

  const openGeo = useCallback(() => {
    setGeoError(null); setGeoOk(null);
    // Default replica db name to the primary; user can change.
    setReplicaDb(database || '');
    setGeoOpen(true);
  }, [database]);

  const submitGeo = useCallback(async () => {
    if (!server || !database) { setGeoError('server + database required'); return; }
    if (!replicaServer || !replicaLocation) { setGeoError('replica server + location required'); return; }
    setGeoBusy(true); setGeoError(null); setGeoOk(null);
    try {
      const r = await fetch(`/api/items/azure-sql-database/${id}/replication`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          server, database,
          replicaServer,
          replicaDatabaseName: replicaDb || database,
          location: replicaLocation,
          skuName: replicaSku || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setGeoOk(`Geo-replica request accepted (${replicaServer} / ${replicaDb}). ARM provisioning continues async.`);
    } catch (e: any) { setGeoError(e?.message || String(e)); }
    finally { setGeoBusy(false); }
  }, [id, server, database, replicaServer, replicaDb, replicaLocation, replicaSku]);

  const run = useCallback(() => {
    if (!server || !database) { setResult({ ok: false, error: 'server + database required' }); return; }
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setActiveRequestId(reqId);
    setLoading(true); setResult(null);
    // Runs in the module-scope jobs-store so it survives this editor unmounting
    // (tab switch / close); a backgrounded query raises a completion toast.
    const jobId = startSqlQuery({
      databaseName: database,
      server,
      sqlLabel: sqlText.slice(0, 80),
      sqlText,
      queryUrl: `/api/items/azure-sql-database/${encodeURIComponent(id)}/query`,
      requestId: reqId,
      onDone: ({ ok, queryResult, error, code }) => {
        setLoading(false); setActiveJobId(null); setActiveRequestId(null);
        setResult(ok && queryResult
          ? { ok: true, ...queryResult }
          : { ok: false, error: error || 'query failed', code });
      },
    });
    setActiveJobId(jobId);
  }, [id, server, database, sqlText, startSqlQuery]);

  // Cancel via a real TDS ATTENTION packet (not an AbortController) — the server
  // stops the query and the jobs-store fetch resolves with code 'ECANCEL'.
  const cancelQuery = useCallback(async () => {
    if (!activeRequestId) return;
    try {
      await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/query/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: activeRequestId }),
      });
    } catch { /* best-effort; the query promise still settles */ }
  }, [id, activeRequestId]);

  // Recover a result for a query that finished while this editor was unmounted.
  useEffect(() => {
    if (!activeJobId) return;
    const job = jobs.find((j) => j.id === activeJobId);
    if (!job || job.status === 'running') return;
    setLoading(false);
    setResult(job.status === 'success' && job.queryResult
      ? { ok: true, ...job.queryResult }
      : { ok: false, error: job.error || 'query failed' });
    setActiveJobId(null);
    setActiveRequestId(null);
  }, [jobs, activeJobId]);

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
      { label: 'Search', actions: [
        { label: 'Full-text search', onClick: canRun ? () => setTab('fts') : undefined, disabled: !canRun, title: !canRun ? 'pick server + database' : 'Manage full-text catalogs + indexes' },
        { label: 'Vector indexes', onClick: canRun ? () => setTab('vector') : undefined, disabled: !canRun, title: !canRun ? 'pick server + database' : 'Manage SQL 2025 vector indexes' },
      ]},
      { label: 'Mirroring', actions: [
        { label: 'Toggle Fabric mirror', onClick: canRun ? toggleMirror : undefined, disabled: !canRun },
      ]},
      { label: 'Replication', actions: [
        { label: 'Add geo-replica', onClick: canRun ? openGeo : undefined, disabled: !canRun, title: !canRun ? 'pick server + database' : undefined },
      ]},
      { label: '2025', actions: [
        { label: 'Probe engine', onClick: canRun ? probe2025 : undefined, disabled: !canRun },
      ]},
      { label: 'Schema', actions: [
        { label: 'Browse objects', onClick: canRun ? () => setSchemaTab((t) => (t === 'none' ? 'browser' : 'none')) : undefined, disabled: !canRun, title: !canRun ? 'pick server + database first' : 'Toggle the sys.* object browser in the left pane' },
      ]},
    ]},
  ], [canRun, loading, run, toggleMirror, probe2025, newTsql, openGeo]);

  return (
    <ItemEditorChrome
      item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.sqlLeftPane}>
          <div className={s.formRow}>
            <Label>Server</Label>
            <select
              value={server}
              onChange={(e) => { setServer(e.target.value); setDatabase(''); }}
              disabled={srv.loading || (srv.servers?.length ?? 0) === 0}
              style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
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
              style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
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
          <Caption1 className={s.schemaHint}>
            The console UAMI must be the Microsoft Entra admin on the server (or a member of the Entra
            admin group). Select a server and database above to browse tables, views, and schemas over live TDS.
          </Caption1>
          {server && database && (
            schemaTab === 'none' ? (
              <Button
                size="small"
                appearance="outline"
                icon={<Database20Regular />}
                onClick={() => setSchemaTab('browser')}
              >
                Browse objects
              </Button>
            ) : (
              <>
                <div className={s.schemaBrowserHeader}>
                  <Caption1 className={s.schemaBrowserTitle}>Schema browser</Caption1>
                  <Tooltip content="Reload objects from sys.* catalog" relationship="label">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ArrowSync20Regular />}
                      onClick={() => setBrowserRefreshKey((k) => k + 1)}
                      aria-label="Refresh schema browser"
                    />
                  </Tooltip>
                  <Tooltip content="Close schema browser" relationship="label">
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<Dismiss20Regular />}
                      onClick={() => setSchemaTab('none')}
                      aria-label="Close schema browser"
                    />
                  </Tooltip>
                </div>
                <div className={s.schemaBrowserBox}>
                  <SqlDbTree
                    workspaceId=""
                    itemId={id}
                    server={server}
                    database={database}
                    refreshKey={browserRefreshKey}
                    onOpenQuery={(sql) => {
                      setSqlText(sql);
                      setTab('query');
                    }}
                  />
                </div>
              </>
            )
          )}
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="fts" icon={<DocumentSearch20Regular />}>Full-text search</Tab>
            <Tab value="vector" icon={<Sparkle20Regular />}>Vector indexes</Tab>
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
                {loading && (
                  <Button appearance="secondary" icon={<Stop20Regular />} onClick={cancelQuery} disabled={!activeRequestId} title="Send a TDS ATTENTION packet — cancels the running query on the server">Cancel</Button>
                )}
              </div>
              {loading && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  Running in background — switch tabs or close this editor freely; a toast fires when the query completes.
                </Caption1>
              )}
              <MonacoTextarea value={sqlText} onChange={setSqlText} language="tsql" height={240} minHeight={200} ariaLabel="T-SQL editor" />
              <ResultsPanel result={result} loading={loading} />
            </>
          )}
          {tab === 'fts' && (
            <FullTextSearchPanel id={id} server={server} database={database} />
          )}
          {tab === 'vector' && (
            <VectorIndexPanel id={id} server={server} database={database} />
          )}
          {tab === 'mirroring' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Mirroring (Azure-native CDC)</MessageBarTitle>
                  Enables the database <strong>change feed</strong> via the real{' '}
                  <code>sys.sp_change_feed_enable_db</code> — Azure-native, no Microsoft Fabric. Stream the
                  captured changes to ADLS <strong>Bronze Delta</strong> with an ADF CDC pipeline / Synapse Link
                  copy or the Loom mirroring engine. The console identity must be <code>db_owner</code> on this
                  database; a permission/tier error is shown verbatim.
                </MessageBarBody>
              </MessageBar>
              <Button onClick={toggleMirror} icon={<ShieldKeyhole20Regular />}>Enable / Refresh mirror</Button>
              {mirrorState && <pre style={{ fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, maxWidth: '100%', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', boxSizing: 'border-box', margin: 0 }}>{JSON.stringify(mirrorState, null, 2)}</pre>}
            </>
          )}
          {tab === 'replication' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Geo-replication</MessageBarTitle>
                  Use <strong>Add geo-replica</strong> in the ribbon to create a Secondary database on a replica server via
                  ARM REST.
                </MessageBarBody>
              </MessageBar>
              <Button onClick={openGeo} icon={<Globe20Regular />} disabled={!canRun}>Add geo-replica…</Button>
              {geoOk && (
                <MessageBar intent="success"><MessageBarBody><MessageBarTitle>Geo-replica accepted</MessageBarTitle>{geoOk}</MessageBarBody></MessageBar>
              )}
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
              {sql2025State && <pre style={{ fontSize: tokens.fontSizeBase200, background: tokens.colorNeutralBackground3, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, maxWidth: '100%', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', boxSizing: 'border-box', margin: 0 }}>{JSON.stringify(sql2025State, null, 2)}</pre>}
            </>
          )}

          <Dialog open={geoOpen} onOpenChange={(_, d) => setGeoOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add geo-replica — {database}</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Creates a Secondary database on the replica server via ARM REST
                    (<code>Microsoft.Sql/servers/databases</code> with <code>createMode=Secondary</code>).
                  </Caption1>
                  <Field label="Replica server" required>
                    <select
                      value={replicaServer}
                      onChange={(e) => setReplicaServer(e.target.value)}
                      style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
                    >
                      <option value="">Select a replica server</option>
                      {(srv.servers || []).filter((sv) => sv.name !== server).map((sv) => (
                        <option key={sv.name} value={sv.name}>{sv.name}{sv.location ? ` · ${sv.location}` : ''}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Replica DB name">
                    <Input value={replicaDb} onChange={(_, d) => setReplicaDb(d.value)} placeholder={database} />
                  </Field>
                  <Field label="Replica region" required>
                    <Dropdown
                      className={s.fullWidth}
                      selectedOptions={replicaLocation ? [replicaLocation] : []}
                      value={replicaLocation}
                      onOptionSelect={(_, d) => setReplicaLocation(d.optionValue || '')}
                      aria-label="Replica region"
                    >
                      {AZURE_REGIONS.map((r) => <Option key={r} value={r}>{r}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="SKU (optional — blank matches primary)">
                    <Dropdown
                      className={s.fullWidth}
                      selectedOptions={replicaSku ? [replicaSku] : []}
                      value={replicaSku}
                      placeholder="Match primary"
                      onOptionSelect={(_, d) => setReplicaSku(d.optionValue || '')}
                      aria-label="Replica SKU"
                    >
                      <Option value="">Match primary</Option>
                      {SQL_DB_SKUS.flatMap((g) => g.skus).map((sku) => <Option key={sku} value={sku}>{sku}</Option>)}
                    </Dropdown>
                  </Field>
                  {geoError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Geo-replica failed</MessageBarTitle>{geoError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setGeoOpen(false)} disabled={geoBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitGeo} disabled={geoBusy || !replicaServer || !replicaLocation}>
                    {geoBusy ? 'Creating…' : 'Create geo-replica'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// Managed Instance editor — registry + live T-SQL query execution
// ============================================================
// Lists managed instances (ARM) AND runs live T-SQL over the SELECTED
// instance's private-endpoint FQDN. Query execution reuses the exact same
// TDS path the Azure SQL Database editor uses: the jobs-store startSqlQuery →
// POST /api/items/azure-sql-database/[id]/query → executeQueryBatch (AAD-token
// TDS). getPool uses the FQDN as-is (MI FQDNs contain dots), so the MI's
// `<mi>.<zone>.database.<suffix>` connection works without a Fabric dependency.
// The left-pane SqlDbTree gives the real sys.* schema navigator against the
// same connection. If the Console cannot reach the instance over its private
// endpoint, the real TDS connection error surfaces (honest gate, no fake data).
export function SqlManagedInstanceEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [instances, setInstances] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Selected instance → drives the schema navigator + live TDS query editor.
  const [selectedFqdn, setSelectedFqdn] = useState('');
  const [navDb, setNavDb] = useState('master');
  const [tab, setTab] = useState<'instances' | 'query'>('instances');
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);

  // ── Live T-SQL query surface (same execution path as the Azure SQL DB editor) ──
  const [sqlText, setSqlText] = useState<string>(
    `-- Azure SQL Managed Instance — TDS over AAD MI from the Loom Console BFF.\n`
    + `-- Same execution path as the Azure SQL Database editor, pointed at the\n`
    + `-- selected instance's private-endpoint FQDN.\n`
    + `SELECT @@VERSION AS version, DB_NAME() AS db, SUSER_SNAME() AS login_name;`,
  );
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [running, setRunning] = useState(false);
  // Background-job continuity + TDS cancel token (see jobs-store.startSqlQuery).
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const startSqlQuery = useJobsStore((st) => st.startSqlQuery);
  const jobs = useJobsStore((st) => st.jobs);

  const refresh = useCallback(() => {
    setLoading(true); setErr(null);
    fetch(`/api/items/azure-sql-managed-instance`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setInstances(j.instances || []); else setErr(j.error); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const selectInstance = useCallback((fqdn: string) => {
    if (!fqdn) return;
    setSelectedFqdn(fqdn);
    setResult(null);
    setTab('query');
  }, []);

  // Run T-SQL over the selected instance's FQDN, reusing the Azure SQL DB
  // /query route (executeQueryBatch). The route resolves the connection purely
  // from the body server/database, so pointing `server` at the MI FQDN reuses
  // the identical TDS backend — no MI-specific backend needed.
  const run = useCallback(() => {
    if (!selectedFqdn) { setResult({ ok: false, error: 'select a managed instance first' }); return; }
    if (!navDb.trim()) { setResult({ ok: false, error: 'database is required' }); return; }
    const reqId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setActiveRequestId(reqId);
    setRunning(true); setResult(null);
    const jobId = startSqlQuery({
      databaseName: navDb.trim(),
      server: selectedFqdn,
      sqlLabel: sqlText.slice(0, 80),
      sqlText,
      queryUrl: `/api/items/azure-sql-database/${encodeURIComponent(id)}/query`,
      requestId: reqId,
      onDone: ({ ok, queryResult, error, code }) => {
        setRunning(false); setActiveJobId(null); setActiveRequestId(null);
        setResult(ok && queryResult
          ? { ok: true, ...queryResult }
          : { ok: false, error: error || 'query failed', code });
      },
    });
    setActiveJobId(jobId);
  }, [id, selectedFqdn, navDb, sqlText, startSqlQuery]);

  // Cancel via a real TDS ATTENTION packet (same cancel route as Azure SQL DB).
  const cancelQuery = useCallback(async () => {
    if (!activeRequestId) return;
    try {
      await fetch(`/api/items/azure-sql-database/${encodeURIComponent(id)}/query/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: activeRequestId }),
      });
    } catch { /* best-effort; the query promise still settles */ }
  }, [id, activeRequestId]);

  // Recover a result for a query that finished while this editor was unmounted.
  useEffect(() => {
    if (!activeJobId) return;
    const job = jobs.find((j) => j.id === activeJobId);
    if (!job || job.status === 'running') return;
    setRunning(false);
    setResult(job.status === 'success' && job.queryResult
      ? { ok: true, ...job.queryResult }
      : { ok: false, error: job.error || 'query failed' });
    setActiveJobId(null);
    setActiveRequestId(null);
  }, [jobs, activeJobId]);

  const newTsql = useCallback(() => {
    setSqlText('-- New T-SQL.\nSELECT 1;');
    setResult(null);
    setTab('query');
  }, []);

  const canRun = !!selectedFqdn && !!navDb.trim() && !running;

  // Ctrl+S / Cmd+S = Run on the Query tab (SSMS / Azure Data Studio muscle memory).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (tab === 'query' && canRun) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, canRun, run]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Instances', actions: [
        { label: loading ? 'Refreshing…' : 'Refresh list', onClick: loading ? undefined : refresh, disabled: loading },
      ]},
      { label: 'Query', actions: [
        { label: 'New T-SQL', onClick: newTsql },
        { label: running ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun, title: !selectedFqdn ? 'Select a managed instance first' : undefined },
      ]},
    ]},
  ], [loading, refresh, running, canRun, run, newTsql, selectedFqdn]);

  return (
    <ItemEditorChrome
      item={item} id={id}
      ribbon={ribbon}
      leftPanel={
        selectedFqdn
          ? (
            <div className={s.sqlLeftPane}>
              <div className={s.schemaBrowserHeader}>
                <Caption1 className={s.schemaBrowserTitle}>Schema · <code>{selectedFqdn}</code></Caption1>
                <Tooltip content="Reload objects from sys.* catalog" relationship="label">
                  <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={() => setBrowserRefreshKey((k) => k + 1)} aria-label="Refresh schema browser" />
                </Tooltip>
                <Tooltip content="Clear the selected instance" relationship="label">
                  <Button size="small" appearance="subtle" icon={<Dismiss20Regular />} onClick={() => setSelectedFqdn('')} aria-label="Clear selected instance" />
                </Tooltip>
              </div>
              <div className={s.formRow}>
                <Label htmlFor="mi-nav-db">Database</Label>
                <Input id="mi-nav-db" size="small" value={navDb} onChange={(_, d) => setNavDb(d.value || 'master')} placeholder="master" />
              </div>
              <div className={s.schemaBrowserBox}>
                <SqlDbTree
                  workspaceId="" itemId={id}
                  server={selectedFqdn} database={navDb}
                  refreshKey={browserRefreshKey}
                  onOpenQuery={(sql) => { setSqlText(sql); setTab('query'); }}
                />
              </div>
            </div>
          )
          : (
            <div className={s.treePad}>
              <EmptyState
                icon={<Database20Regular />}
                title="No instance selected"
                body="Select a managed instance to browse its schemas, tables, and views and run live T-SQL over the private endpoint."
              />
            </div>
          )
      }
      main={
        <div className={s.pad}>
          {id === 'new' && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Managed Instances are provisioned out-of-band</MessageBarTitle>
                Create via bicep <code>Microsoft.Sql/managedInstances</code> (45+ min deploy) or the Azure portal, then
                select the instance here to browse its schema and run T-SQL.
              </MessageBarBody>
            </MessageBar>
          )}
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
            <Tab value="instances" icon={<DatabaseMultiple20Regular />}>Instances</Tab>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
          </TabList>

          {tab === 'instances' && (
            <>
              {/* Honest gate: schema reads + queries run over the PE; this names
                  the infra/role they need (per no-vaporware.md — the real TDS
                  error surfaces if the PE isn't reachable). */}
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Select an instance to browse its schema and run T-SQL</MessageBarTitle>
                  Selecting an instance loads its schemas/tables/views in the navigator and enables the
                  <strong> Query</strong> tab — real <code>sys.*</code> reads and live T-SQL over TDS, the same
                  execution path the Azure SQL Database editor uses. The Console must reach the instance over a
                  private endpoint in the MI delegated subnet and the UAMI must be a
                  <strong> Microsoft Entra admin</strong> on the instance (or have <code>db_datareader</code> +
                  <code> VIEW DEFINITION</code>); the connection error is shown verbatim otherwise.
                </MessageBarBody>
              </MessageBar>
              <div className={s.toolbar}>
                <Button size="small" appearance="outline" onClick={refresh} disabled={loading}>Refresh list</Button>
                {selectedFqdn && (
                  <>
                    <Caption1>Selected: <strong>{selectedFqdn}</strong></Caption1>
                    <Button size="small" appearance="subtle" onClick={() => setTab('query')}>Open Query</Button>
                    <Button size="small" appearance="subtle" onClick={() => setSelectedFqdn('')}>Clear</Button>
                  </>
                )}
                {loading && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
              </div>
              {err && <BackendStateBar error={err} title="Azure SQL" />}
              <Subtitle2 className={s.sectionHeader}>
                <span className={s.sectionHeaderIcon}><DatabaseMultiple20Regular /></span>
                Managed Instances ({instances.length})
              </Subtitle2>
              {loading ? (
                <div className={s.tableWrap}>
                  <Skeleton aria-label="Loading managed instances…" style={{ padding: tokens.spacingVerticalXL }}>
                    <SkeletonItem size={16} style={{ width: '30%' }} />
                    <SkeletonItem size={12} />
                    <SkeletonItem size={12} style={{ width: '90%' }} />
                    <SkeletonItem size={12} style={{ width: '70%' }} />
                  </Skeleton>
                </div>
              ) : instances.length === 0 && !err ? (
                <EmptyState
                  icon={<Database20Regular />}
                  title="No managed instances found"
                  body="Provision one with `Microsoft.Sql/managedInstances` via bicep or the Azure portal, then Refresh to see it listed here."
                />
              ) : (
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
                        <TableRow key={i.id}
                          onClick={() => i.fqdn && selectInstance(i.fqdn)}
                          style={{ cursor: i.fqdn ? 'pointer' : 'default', background: i.fqdn && i.fqdn === selectedFqdn ? tokens.colorNeutralBackground1Selected : undefined }}>
                          <TableCell><strong>{i.name}</strong></TableCell>
                          <TableCell>{i.state}</TableCell>
                          <TableCell>{i.location}</TableCell>
                          <TableCell>{i.sku?.name}</TableCell>
                          <TableCell><code style={{ fontSize: tokens.fontSizeBase100 }}>{i.fqdn}</code></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {tab === 'query' && (
            !selectedFqdn ? (
              <EmptyState
                icon={<Play20Regular />}
                title="No instance selected"
                body="Pick a managed instance on the Instances tab, then write T-SQL here and Run it over AAD-authenticated TDS."
              />
            ) : (
              <>
                <div className={s.toolbar}>
                  <Badge appearance="filled" color="brand">SQL MI</Badge>
                  <Caption1>instance: <strong>{selectedFqdn}</strong>, db: <strong>{navDb || 'not set'}</strong></Caption1>
                  <Label htmlFor="mi-query-db">DB</Label>
                  <Input id="mi-query-db" size="small" value={navDb} onChange={(_, d) => setNavDb(d.value || 'master')} style={{ width: '160px' }} />
                  <Button appearance="primary" icon={<Play20Regular />} disabled={!canRun} onClick={run} style={{ marginLeft: 'auto' }}>Run</Button>
                  {running && (
                    <Button appearance="secondary" icon={<Stop20Regular />} onClick={cancelQuery} disabled={!activeRequestId} title="Send a TDS ATTENTION packet — cancels the running query on the server">Cancel</Button>
                  )}
                </div>
                {running && (
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Running in background — switch tabs or close this editor freely; a toast fires when the query completes.
                  </Caption1>
                )}
                <MonacoTextarea value={sqlText} onChange={setSqlText} language="tsql" height={240} minHeight={200} ariaLabel="T-SQL editor" />
                <ResultsPanel result={result} loading={running} />
              </>
            )
          )}
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

  // Real similarity probe — VECTOR_DISTANCE ANN search executed via the same
  // wired azure-sql /query TDS path (SQL Server 2025 native vector search).
  const testSimilarity = useCallback(async () => {
    if (!server || !database) { setResult({ ok: false, error: 'server + database required' }); return; }
    setLoading(true); setResult(null);
    const probe = `-- Approximate nearest-neighbour search over the vector index (SQL 2025).\n`
      + `DECLARE @q VECTOR(${dim}) = CAST('[' + REPLICATE('0.0,', ${dim} - 1) + '0.0]' AS VECTOR(${dim}));\n`
      + `SELECT TOP 10 id,\n`
      + `       VECTOR_DISTANCE('${metric.toLowerCase()}', ${column}, @q) AS distance\n`
      + `FROM dbo.${table}\n`
      + `ORDER BY distance ASC;`;
    const r = await fetch(`/api/items/azure-sql-database/${id}/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server, database, sql: probe }),
    });
    setResult(await r.json());
    setLoading(false);
  }, [id, server, database, dim, metric, column, table]);

  const canCreate = !!server && !!database && !loading;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Index', actions: [
        { label: loading ? 'Creating…' : 'Create', onClick: canCreate ? runDdl : undefined, disabled: !canCreate },
        { label: 'Test similarity', onClick: canCreate ? testSimilarity : undefined, disabled: !canCreate, title: !server || !database ? 'Select a server + database first' : 'Run a VECTOR_DISTANCE ANN probe' },
      ]},
    ]},
  ], [canCreate, loading, runDdl, testSimilarity, server, database]);

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
              style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
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
              style={{ padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}
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
          <Field label="Table" className={s.formRow}><Input value={table} onChange={(_, d) => setTable(d.value)} placeholder="docs" /></Field>
          <Field label="Vector column" className={s.formRow}><Input value={column} onChange={(_, d) => setColumn(d.value)} placeholder="embedding" /></Field>
          <Field label="Dimensions" className={s.formRow}>
            <Dropdown
              className={s.fullWidth}
              selectedOptions={[String(dim)]}
              value={String(dim)}
              onOptionSelect={(_, d) => setDim(Number(d.optionValue || '1536'))}
              aria-label="Vector dimensions"
            >
              {VECTOR_DIMS.map((n) => <Option key={n} value={String(n)}>{String(n)}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Metric" className={s.formRow}>
            <Dropdown
              className={s.fullWidth}
              selectedOptions={[metric]}
              value={metric}
              onOptionSelect={(_, d) => setMetric((d.optionValue as any) || 'cosine')}
              aria-label="Distance metric"
            >
              {VECTOR_METRICS.map((m) => <Option key={m} value={m}>{m}</Option>)}
            </Dropdown>
          </Field>
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
