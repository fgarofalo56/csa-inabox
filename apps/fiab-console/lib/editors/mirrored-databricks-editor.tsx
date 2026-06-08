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
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { OneLakeSecurityTab } from './components/onelake-security-tab';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 8px 0' },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240 },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean }
interface MirrorLite { id: string; displayName: string; catalogName?: string; hostname?: string }
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
  const [cHostname, setCHostname] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

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
  }, [tab, workspaceId, mirrorId, schemas, tables, schemaName, loadSchemas, loadTables]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim() || !cCatalog.trim()) return;
    setCBusy(true); setCErr(null);
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
      setCreateOpen(false); setCName(''); setCCatalog(''); setCHostname(''); setCDesc('');
      await loadList(workspaceId);
      if (j.mirror?.id) setMirrorId(j.mirror.id);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cCatalog, cHostname, cDesc, loadList]);

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
          <Subtitle2 style={{ marginBottom: 8 }}>Mirrored Databricks</Subtitle2>
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
              <Tab value="overview">Overview</Tab>
              <Tab value="catalog">Catalog</Tab>
              <Tab value="tables">Tables</Tab>
              <Tab value="security">Security</Tab>
              <Tab value="settings">Settings</Tab>
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
                      <Field label="Unity Catalog name" required hint="The UC catalog to mirror, e.g. main / sales / lakehouse_silver">
                        <Input value={cCatalog} onChange={(_, d) => setCCatalog(d.value)} placeholder="main" />
                      </Field>
                      <Field label="Databricks hostname (optional override)" hint="Defaults to LOOM_DATABRICKS_HOSTNAME">
                        <Input value={cHostname} onChange={(_, d) => setCHostname(d.value)} placeholder="adb-xxxx.azuredatabricks.net" />
                      </Field>
                      <Field label="Description"><Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} /></Field>
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                      <Button appearance="primary" disabled={cBusy || !cName.trim() || !cCatalog.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create mirror'}</Button>
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
                {!active && <Caption1>Pick a mirror from the left panel, or click "New mirror".</Caption1>}
                {active && (
                  <>
                    <Subtitle2>{active.displayName}</Subtitle2>
                    <Caption1>Catalog: <code>{active.catalogName || '—'}</code></Caption1>
                    <Caption1>Hostname: <code>{active.hostname || process.env.NEXT_PUBLIC_LOOM_DATABRICKS_HOSTNAME || '(uses LOOM_DATABRICKS_HOSTNAME)'}</code></Caption1>
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
                {!mirrorId && <Caption1>Select a mirror first.</Caption1>}
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
                {schemas && schemas.length === 0 && !schemasErr && <Caption1>No schemas found in this catalog.</Caption1>}
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
                            <TableCell>{sc.comment || '—'}</TableCell>
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
                {!mirrorId && <Caption1>Select a mirror first.</Caption1>}
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
                        style={{ minWidth: 200 }}
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
                {tables && tables.length === 0 && !tablesErr && schemaName && <Caption1>Schema <code>{schemaName}</code> has no tables.</Caption1>}
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
                            <TableCell>{t.comment || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'settings' && (
              <>
                {!active && <Caption1>Select a mirror first.</Caption1>}
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
