'use client';

/**
 * MirroredDatabricksEditor — Fabric MirroredAzureDatabricksCatalog focused
 * editor. Lets a user mount a Databricks Unity Catalog as a read-only
 * mirror in OneLake. Loom stores the mount config in Cosmos and pulls
 * live UC metadata from Databricks REST.
 *
 * Tabs: Overview · Catalog · Tables · Settings
 *
 * Per .claude/rules/no-vaporware.md every action either:
 *   - calls a real Cosmos or Databricks REST endpoint (Overview list/create,
 *     UC schemas/tables listing), or
 *   - surfaces an honest MessageBar with the env var the operator must set
 *     (LOOM_DATABRICKS_HOSTNAME / Console UAMI as workspace user).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Textarea, Tooltip,
  Tree, TreeItem, TreeItemLayout, Dropdown, Option, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Database20Regular, Delete20Regular, Save20Regular,
  Info20Regular, BookDatabase20Regular, TableSimple20Regular, PlugConnected20Regular,
  Settings20Regular, ShieldKeyhole20Regular, DatabaseSearch24Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { OneLakeSecurityTab } from './components/onelake-security-tab';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { useSharedEditorStyles } from './shared-styles';

const useLocalStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  commentCell: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '240px' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  schemaSelect: { minWidth: '200px' },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean }
interface MirrorLite { id: string; displayName: string; catalogName?: string; hostname?: string; sqlItemId?: string; sqlDatabase?: string; sqlEndpoint?: string; viewCount?: string }
interface PairingResult { ok?: boolean; code?: string; gate?: string; error?: string; status?: string; steps?: string[]; tablesResolved?: number; tablesSkipped?: number }
interface SqlEndpointInfo { ok: boolean; provisioned: boolean; sqlItemId?: string | null; endpoint?: string | null; database?: string | null; viewCount?: string | null; catalogName?: string | null; error?: string }
interface UcSchemaLite { name: string; full_name?: string; comment?: string }
interface UcTableLite { name: string; full_name?: string; table_type?: string; data_source_format?: string; comment?: string }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setWorkspaces([]); return; }
      setWorkspaces(j.workspaces || []);
    } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { workspaces, error };
}

interface Props { item: FabricItemType; id: string }

export function MirroredDatabricksEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mirrors, setMirrors] = useState<MirrorLite[] | null>(null);
  const [mirrorId, setMirrorId] = useState(id !== 'new' ? id : '');
  const [active, setActive] = useState<MirrorLite | null>(null);
  const [tab, setTab] = useState<string>('overview');
  const [listErr, setListErr] = useState<string | null>(null);

  // UC catalog state
  const [schemas, setSchemas] = useState<UcSchemaLite[] | null>(null);
  const [schemasErr, setSchemasErr] = useState<{ error: string; code?: string; hint?: string } | null>(null);
  const [schemaName, setSchemaName] = useState('');
  const [tables, setTables] = useState<UcTableLite[] | null>(null);
  const [tablesErr, setTablesErr] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cCatalog, setCCatalog] = useState('');
  // Real Unity Catalog list for the picker (empty → honest freeform fallback).
  const [ucCatalogs, setUcCatalogs] = useState<string[]>([]);
  useEffect(() => {
    if (!createOpen) return;
    let live = true;
    (async () => {
      try {
        const r = await fetch('/api/items/mirrored-databricks/catalogs');
        const j = await r.json();
        if (live && j.ok && Array.isArray(j.catalogs)) setUcCatalogs(j.catalogs);
      } catch { /* keep freeform fallback */ }
    })();
    return () => { live = false; };
  }, [createOpen]);
  const [cHostname, setCHostname] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);
  const [cPairing, setCPairing] = useState<PairingResult | null>(null);

  // SQL endpoint tab (the paired Synapse Serverless endpoint over UC Delta tables)
  const [sqlInfo, setSqlInfo] = useState<SqlEndpointInfo | null>(null);
  const [sqlBusy, setSqlBusy] = useState(false);

  // Settings tab
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);
  const [editCatalog, setEditCatalog] = useState('');
  const [editHostname, setEditHostname] = useState('');

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setMirrors([]); setListErr(j.error || 'failed'); return; }
      setMirrors(j.mirrors || []);
      if (!mirrorId && (j.mirrors || []).length) setMirrorId(j.mirrors[0].id);
    } catch (e: any) { setMirrors([]); setListErr(e?.message || String(e)); }
  }, [mirrorId]);

  const loadDetail = useCallback(async (wsId: string, mid: string) => {
    try {
      const r = await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mid)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActive(null); return; }
      setActive(j.mirror);
      setEditCatalog(j.mirror?.catalogName || '');
      setEditHostname(j.mirror?.hostname || '');
    } catch { setActive(null); }
  }, []);

  const loadSchemas = useCallback(async (wsId: string, mid: string) => {
    setSchemas(null); setSchemasErr(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mid)}/catalog?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setSchemasErr({ error: j.error, code: j.code, hint: j.hint }); setSchemas([]); return; }
      setSchemas(j.schemas || []);
    } catch (e: any) { setSchemasErr({ error: e?.message || String(e) }); setSchemas([]); }
  }, []);

  const loadTables = useCallback(async (wsId: string, mid: string, schema: string) => {
    setTables(null); setTablesErr(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mid)}/catalog?workspaceId=${encodeURIComponent(wsId)}&schema=${encodeURIComponent(schema)}`);
      const j = await r.json();
      if (!j.ok) { setTablesErr(j.error || 'failed'); setTables([]); return; }
      setTables(j.tables || []);
    } catch (e: any) { setTablesErr(e?.message || String(e)); setTables([]); }
  }, []);

  const loadSqlEndpoint = useCallback(async (wsId: string, mid: string) => {
    setSqlBusy(true); setSqlInfo(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mid)}/sql-endpoint?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      setSqlInfo(j as SqlEndpointInfo);
    } catch (e: any) {
      setSqlInfo({ ok: false, provisioned: false, error: e?.message || String(e) });
    } finally { setSqlBusy(false); }
  }, []);

  // Default to the first deployed workspace (rule 4: bind to the deployed
  // instance, never a blank required picker). User can still switch.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [ws.workspaces, workspaceId]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && mirrorId) loadDetail(workspaceId, mirrorId); }, [workspaceId, mirrorId, loadDetail]);
  useEffect(() => {
    if (!workspaceId || !mirrorId) return;
    if ((tab === 'catalog' || tab === 'tables') && schemas === null) loadSchemas(workspaceId, mirrorId);
    if (tab === 'tables' && schemaName && tables === null) loadTables(workspaceId, mirrorId, schemaName);
    if (tab === 'sql' && sqlInfo === null && !sqlBusy) loadSqlEndpoint(workspaceId, mirrorId);
  }, [tab, workspaceId, mirrorId, schemas, tables, schemaName, sqlInfo, sqlBusy, loadSchemas, loadTables, loadSqlEndpoint]);

  // Reset SQL-endpoint info when switching mirrors so it re-resolves.
  useEffect(() => { setSqlInfo(null); }, [mirrorId]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim() || !cCatalog.trim()) return;
    setCBusy(true); setCErr(null); setCPairing(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: cName.trim(),
          catalogName: cCatalog.trim(),
          hostname: cHostname.trim() || undefined,
          description: cDesc.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      // Surface the real pairing outcome (endpoint paired vs honest gate). Keep
      // the dialog open so the operator sees whether the catalog is queryable.
      setCPairing((j.pairing as PairingResult) || null);
      await loadList(workspaceId);
      if (j.mirror?.id) {
        setMirrorId(j.mirror.id);
        // Refresh the SQL-endpoint view if the user is on that tab.
        void loadSqlEndpoint(workspaceId, j.mirror.id);
      }
      // Only auto-close + reset when the pairing fully succeeded; otherwise the
      // operator reads the gate and decides what to fix.
      if (j.pairing?.ok) {
        setCreateOpen(false); setCName(''); setCCatalog(''); setCHostname(''); setCDesc(''); setCPairing(null);
      }
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cCatalog, cHostname, cDesc, loadList, loadSqlEndpoint]);

  const saveSettings = useCallback(async () => {
    if (!workspaceId || !mirrorId) return;
    setSettingsBusy(true); setSettingsErr(null); setSettingsMsg(null);
    try {
      const r = await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalogName: editCatalog, hostname: editHostname || null }),
      });
      const j = await r.json();
      if (!j.ok) { setSettingsErr(j.error || 'save failed'); return; }
      setSettingsMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      setSchemas(null); setTables(null); setSchemaName('');
      await loadDetail(workspaceId, mirrorId);
    } catch (e: any) { setSettingsErr(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [workspaceId, mirrorId, editCatalog, editHostname, loadDetail]);

  const refresh = useCallback(() => {
    if (!workspaceId || !mirrorId) return;
    setSchemas(null); setTables(null);
    if (tab === 'catalog') loadSchemas(workspaceId, mirrorId);
    if (tab === 'tables' && schemaName) loadTables(workspaceId, mirrorId, schemaName);
  }, [workspaceId, mirrorId, tab, schemaName, loadSchemas, loadTables]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'New mirror', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
      { label: 'View', actions: [
        { label: 'Overview', onClick: () => setTab('overview') },
        { label: 'Catalog', onClick: () => setTab('catalog'), disabled: !mirrorId },
        { label: 'Tables', onClick: () => setTab('tables'), disabled: !mirrorId },
        { label: 'SQL endpoint', onClick: () => setTab('sql'), disabled: !mirrorId },
      ]},
      { label: 'Catalog', actions: [
        { label: 'Refresh metadata', onClick: mirrorId ? refresh : undefined, disabled: !mirrorId },
      ]},
    ]},
  ], [workspaceId, mirrorId, loadList, refresh]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS }}>Mirrored Databricks</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && mirrors === null && <Spinner size="tiny" label="Loading…" />}
          {mirrors && mirrors.length === 0 && !listErr && <Caption1>No mirrors yet.</Caption1>}
          <Tree aria-label="Databricks mirrors">
            {(mirrors || []).map((m) => (
              <TreeItem key={m.id} itemType="leaf" value={m.id} onClick={() => setMirrorId(m.id)}>
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  {mirrorId === m.id ? <strong>{m.displayName}</strong> : m.displayName}
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
              <Tab value="overview" icon={<Info20Regular />}>Overview</Tab>
              <Tab value="catalog" icon={<BookDatabase20Regular />}>Catalog</Tab>
              <Tab value="tables" icon={<TableSimple20Regular />}>Tables</Tab>
              <Tab value="sql" icon={<PlugConnected20Regular />}>SQL endpoint</Tab>
              <Tab value="security" icon={<ShieldKeyhole20Regular />}>Security</Tab>
              <Tab value="settings" icon={<Settings20Regular />}>Settings</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {tab === 'security' && (
              <OneLakeSecurityTab itemId={id} itemType="mirrored-catalog" container="bronze" workspaceId={workspaceId || undefined} fabricItemId={mirrorId || undefined} />
            )}
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">MirroredAzureDatabricksCatalog</Badge>
              <div className={s.field}>
                <Caption1 id="mirror-ws-label">Workspace</Caption1>
                <Dropdown
                  aria-labelledby="mirror-ws-label"
                  placeholder={ws.workspaces === null ? 'Loading…' : 'Select a workspace'}
                  value={ws.workspaces?.find((w) => w.id === workspaceId)?.name || ''}
                  selectedOptions={workspaceId ? [workspaceId] : []}
                  onOptionSelect={(_, d) => { if (d.optionValue) setWorkspaceId(d.optionValue); }}
                  disabled={(ws.workspaces?.length ?? 0) === 0}
                >
                  {(ws.workspaces || []).map((w) => (
                    <Option key={w.id} value={w.id} text={w.name}>{w.name}</Option>
                  ))}
                </Dropdown>
              </div>
              <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New mirror</Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Mount a Databricks Unity Catalog</DialogTitle>
                    <DialogContent>
                      <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} /></Field>
                      <Field label="Unity Catalog name" required hint={ucCatalogs.length > 0 ? 'Pick the Unity Catalog to mirror.' : 'The UC catalog to mirror, e.g. main / sales / lakehouse_silver'}>
                        {ucCatalogs.length > 0 ? (
                          <Dropdown placeholder="Select a catalog…" value={cCatalog}
                            selectedOptions={cCatalog ? [cCatalog] : []}
                            onOptionSelect={(_, d) => { if (d.optionValue) setCCatalog(d.optionValue); }}>
                            {ucCatalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                          </Dropdown>
                        ) : (
                          <Input value={cCatalog} onChange={(_, d) => setCCatalog(d.value)} placeholder="main" />
                        )}
                      </Field>
                      <Field label="Databricks hostname (optional override)" hint="Defaults to LOOM_DATABRICKS_HOSTNAME">
                        <Input value={cHostname} onChange={(_, d) => setCHostname(d.value)} placeholder="adb-xxxx.azuredatabricks.net" />
                      </Field>
                      <Field label="Description"><Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} /></Field>
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                      {cPairing && (
                        <MessageBar intent={cPairing.ok ? 'success' : 'warning'}>
                          <MessageBarBody>
                            <MessageBarTitle>
                              {cPairing.ok ? 'Catalog mounted & queryable' : 'Mirror created — endpoint not yet queryable'}
                            </MessageBarTitle>
                            {cPairing.ok ? (
                              <>
                                Paired a Synapse Serverless SQL endpoint over {cPairing.tablesResolved ?? 0} Delta table(s)
                                {typeof cPairing.tablesSkipped === 'number' && cPairing.tablesSkipped > 0 ? ` (${cPairing.tablesSkipped} skipped)` : ''}.
                                Open the <strong>SQL endpoint</strong> tab to query them. You can close this dialog.
                              </>
                            ) : (
                              <>{cPairing.gate || cPairing.error || 'The catalog could not be paired to a SQL endpoint.'}</>
                            )}
                          </MessageBarBody>
                        </MessageBar>
                      )}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => { setCreateOpen(false); setCPairing(null); }}>{cPairing ? 'Close' : 'Cancel'}</Button>
                      <Button appearance="primary" disabled={cBusy || !cName.trim() || !cCatalog.trim()} onClick={create}>{cBusy ? 'Creating & pairing…' : 'Create mirror'}</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            </div>

            {ws.error && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Workspaces unavailable</MessageBarTitle>{ws.error}</MessageBarBody></MessageBar>
            )}
            {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}

            {tab === 'overview' && (
              <>
                {!active && (
                  <EmptyState
                    icon={<DatabaseSearch24Regular />}
                    title="No mirror selected"
                    body="Pick a mirrored Databricks catalog from the left panel, or create one to mount a Unity Catalog as a read-only OneLake mirror."
                    primaryAction={workspaceId ? { label: 'New mirror', onClick: () => setCreateOpen(true) } : undefined}
                  />
                )}
                {active && (
                  <>
                    <div className={s.sectionHead}>
                      <Database20Regular />
                      <Subtitle2>{active.displayName}</Subtitle2>
                    </div>
                    <Caption1>Catalog: <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{active.catalogName || '—'}</code></Caption1>
                    <Caption1>Hostname: <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{active.hostname || process.env.NEXT_PUBLIC_LOOM_DATABRICKS_HOSTNAME || '(uses LOOM_DATABRICKS_HOSTNAME)'}</code></Caption1>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>How Loom drives this</MessageBarTitle>
                        Loom calls Databricks Unity Catalog REST <code>/api/2.1/unity-catalog/schemas</code> + <code>/tables</code> on the Console UAMI's behalf.
                        Switch to the <strong>Catalog</strong> tab to browse schemas, or <strong>Tables</strong> to inspect a specific schema.
                      </MessageBarBody>
                    </MessageBar>
                  </>
                )}
              </>
            )}

            {tab === 'catalog' && (
              <>
                {!mirrorId && (
                  <EmptyState
                    icon={<BookDatabase20Regular />}
                    title="Select a mirror"
                    body="Choose a mirrored Databricks catalog from the left panel to browse its Unity Catalog schemas."
                  />
                )}
                {mirrorId && schemas === null && <Spinner size="small" label="Calling Unity Catalog…" labelPosition="after" />}
                {schemasErr && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>{schemasErr.code === 'NO_DATABRICKS' ? 'Databricks not configured' : 'Unity Catalog error'}</MessageBarTitle>
                      {schemasErr.error}
                      {schemasErr.hint && <><br /><Caption1>{schemasErr.hint}</Caption1></>}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {schemas && schemas.length === 0 && !schemasErr && (
                  <EmptyState
                    icon={<BookDatabase20Regular />}
                    title="No schemas found"
                    body="This Unity Catalog has no schemas, or none are visible to the Console identity. Verify the catalog name and USE CATALOG grant, then refresh."
                    primaryAction={mirrorId ? { label: 'Refresh', onClick: refresh, appearance: 'outline' } : undefined}
                  />
                )}
                {schemas && schemas.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="UC schemas" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Schema</TableHeaderCell>
                        <TableHeaderCell>Full name</TableHeaderCell>
                        <TableHeaderCell>Comment</TableHeaderCell>
                        <TableHeaderCell>Action</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {schemas.map((sc) => (
                          <TableRow key={sc.full_name || sc.name}>
                            <TableCell className={s.cell}>{sc.name}</TableCell>
                            <TableCell className={s.cell}>{sc.full_name || '—'}</TableCell>
                            <TableCell className={s.commentCell}>{sc.comment || '—'}</TableCell>
                            <TableCell>
                              <Button size="small" appearance="primary" onClick={() => { setSchemaName(sc.name); setTables(null); setTab('tables'); }}>Browse tables</Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'tables' && (
              <>
                {!mirrorId && (
                  <EmptyState
                    icon={<TableSimple20Regular />}
                    title="Select a mirror"
                    body="Choose a mirrored Databricks catalog from the left panel, then pick a schema to inspect its Unity Catalog tables."
                  />
                )}
                {mirrorId && (
                  <div className={s.toolbar}>
                    <Caption1 id="mirror-schema-label">Schema</Caption1>
                    {schemas && schemas.length > 0 ? (
                      <Dropdown
                        aria-labelledby="mirror-schema-label"
                        placeholder="Select a schema"
                        value={schemaName}
                        selectedOptions={schemaName ? [schemaName] : []}
                        onOptionSelect={(_, d) => { if (d.optionValue) { setSchemaName(d.optionValue); setTables(null); } }}
                        className={s.schemaSelect}
                      >
                        {schemas.map((sc) => <Option key={sc.full_name || sc.name} value={sc.name} text={sc.name}>{sc.name}</Option>)}
                      </Dropdown>
                    ) : (
                      <Input aria-labelledby="mirror-schema-label" value={schemaName}
                        onChange={(_, d) => { setSchemaName(d.value); setTables(null); }} placeholder="default" />
                    )}
                    <Tooltip content={!schemaName ? 'Pick or type a schema first' : 'List tables in this schema (Unity Catalog REST)'} relationship="label">
                      <Button appearance="primary" disabled={!schemaName} onClick={() => mirrorId && schemaName && loadTables(workspaceId, mirrorId, schemaName)}>List tables</Button>
                    </Tooltip>
                  </div>
                )}
                {tables === null && schemaName && <Spinner size="small" label="Loading tables…" labelPosition="after" />}
                {tablesErr && <MessageBar intent="error"><MessageBarBody>{tablesErr}</MessageBarBody></MessageBar>}
                {tables && tables.length === 0 && !tablesErr && schemaName && (
                  <EmptyState
                    icon={<TableSimple20Regular />}
                    title="No tables in this schema"
                    body={`Schema "${schemaName}" has no tables, or none are visible to the Console identity. Pick another schema or refresh the catalog metadata.`}
                    primaryAction={mirrorId ? { label: 'List tables', onClick: () => mirrorId && schemaName && loadTables(workspaceId, mirrorId, schemaName), appearance: 'outline' } : undefined}
                  />
                )}
                {tables && tables.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="UC tables" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Table</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Format</TableHeaderCell>
                        <TableHeaderCell>Comment</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {tables.map((t) => (
                          <TableRow key={t.full_name || t.name}>
                            <TableCell className={s.cell}>{t.name}</TableCell>
                            <TableCell>{t.table_type || '—'}</TableCell>
                            <TableCell>{t.data_source_format || '—'}</TableCell>
                            <TableCell className={s.commentCell}>{t.comment || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'sql' && (
              <>
                {!mirrorId && (
                  <EmptyState
                    icon={<PlugConnected20Regular />}
                    title="Select a mirror"
                    body="Choose a mirrored Databricks catalog from the left panel to see its paired Synapse Serverless SQL analytics endpoint."
                  />
                )}
                {mirrorId && (
                  <div className={s.toolbar}>
                    <span className={s.sectionHead}><PlugConnected20Regular /><Subtitle2>SQL analytics endpoint</Subtitle2></span>
                    <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} disabled={sqlBusy}
                      onClick={() => loadSqlEndpoint(workspaceId, mirrorId)}>Refresh</Button>
                  </div>
                )}
                {mirrorId && sqlBusy && <Spinner size="small" label="Resolving endpoint…" labelPosition="after" />}
                {mirrorId && sqlInfo && !sqlBusy && (
                  sqlInfo.provisioned ? (
                    <>
                      <MessageBar intent="success">
                        <MessageBarBody>
                          <MessageBarTitle>Catalog is queryable in Loom</MessageBarTitle>
                          The mounted Unity Catalog{sqlInfo.catalogName ? <> <code>{sqlInfo.catalogName}</code></> : ''} is paired
                          to a Synapse Serverless SQL endpoint{sqlInfo.viewCount ? <> with <strong>{sqlInfo.viewCount}</strong> Delta view(s)</> : ''}.
                        </MessageBarBody>
                      </MessageBar>
                      <Caption1>Endpoint: <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sqlInfo.endpoint || '(set LOOM_SYNAPSE_WORKSPACE)'}</code></Caption1>
                      <Caption1>Database: <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{sqlInfo.database || '—'}</code></Caption1>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          <MessageBarTitle>Query it</MessageBarTitle>
                          Connect any T-SQL client to the endpoint above and run e.g.
                          <code style={{ display: 'block', marginTop: tokens.spacingVerticalXS, fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%' }}>
                            USE [{sqlInfo.database || 'loom_dbxmirror_…'}]; SELECT TOP 100 * FROM [dbo].[&lt;schema&gt;_&lt;table&gt;];
                          </code>
                          Each view reads the UC table&apos;s Delta files directly (OPENROWSET FORMAT=&apos;delta&apos;) over ADLS Gen2 — Azure-native, no Fabric.
                        </MessageBarBody>
                      </MessageBar>
                    </>
                  ) : (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Not yet queryable</MessageBarTitle>
                        {sqlInfo.error
                          || 'This mirror has no paired SQL endpoint. Re-create the mirror after the prerequisites are met '
                          + '(LOOM_DATABRICKS_HOSTNAME + USE CATALOG for UC, LOOM_SYNAPSE_WORKSPACE + Synapse SQL admin for the endpoint), '
                          + 'or ensure the catalog has at least one Delta table with a resolvable ADLS storage location.'}
                      </MessageBarBody>
                    </MessageBar>
                  )
                )}
              </>
            )}

            {tab === 'settings' && (
              <>
                {!active && (
                  <EmptyState
                    icon={<Settings20Regular />}
                    title="Select a mirror"
                    body="Choose a mirrored Databricks catalog from the left panel to edit its catalog name and Databricks hostname override."
                  />
                )}
                {active && (
                  <>
                    <Field label="Unity Catalog name"><Input value={editCatalog} onChange={(_, d) => setEditCatalog(d.value)} /></Field>
                    <Field label="Databricks hostname override"><Input value={editHostname} onChange={(_, d) => setEditHostname(d.value)} placeholder={process.env.NEXT_PUBLIC_LOOM_DATABRICKS_HOSTNAME || 'adb-xxxx.azuredatabricks.net'} /></Field>
                    {settingsErr && <MessageBar intent="error"><MessageBarBody>{settingsErr}</MessageBarBody></MessageBar>}
                    {settingsMsg && <MessageBar intent="success"><MessageBarBody>{settingsMsg}</MessageBarBody></MessageBar>}
                    <div className={s.toolbar}>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={settingsBusy} onClick={saveSettings}>
                        {settingsBusy ? 'Saving…' : 'Save settings'}
                      </Button>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={async () => {
                        if (!workspaceId || !mirrorId) return;
                        if (typeof window !== 'undefined' && !window.confirm('Delete this mirror? (Cosmos record removed; UC catalog itself unchanged.)')) return;
                        await fetch(`/api/items/mirrored-databricks/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
                        setMirrorId(''); setActive(null);
                        await loadList(workspaceId);
                      }}>Delete mirror</Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </>
      }
    />
  );
}
