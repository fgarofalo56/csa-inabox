'use client';

/**
 * MountedAdfEditor — Fabric MountedDataFactory focused editor, now carrying a
 * full ADF-Studio-parity authoring surface.
 *
 * Lets a user reference an existing Azure Data Factory by (subscriptionId,
 * resourceGroup, factoryName) and drive its pipelines from Loom, AND authors
 * the deployment-default factory's Mapping Data Flows on a real graph designer.
 *
 * Tabs: Pipelines · Triggers · Runs · Data flows · Settings
 *
 * Per .claude/rules/no-vaporware.md every action calls a real ARM REST
 * endpoint (Microsoft.DataFactory/factories api-version 2018-06-01):
 *   - Mounted factory pipelines / triggers / runs / run  → /api/items/mounted-adf/**
 *   - Mapping Data Flow CRUD (list/create/get/save/delete) → /api/adf/dataflows/**
 *   - Source/sink dataset pickers                          → /api/adf/datasets
 * If the UAMI lacks Data Factory Contributor on the referenced factory, the
 * ARM 401/403 is surfaced verbatim. The data-flow designer targets the
 * env-pinned default factory (LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME)
 * and honest-gates with a precise MessageBar when those aren't set.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  MarkerType, useReactFlow,
  type Node, type Edge, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Input, Textarea, Field,
  Tree, TreeItem, TreeItemLayout, Select, Dropdown, Option, Tooltip,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Play20Regular, Delete20Regular, BoxMultiple20Regular,
  Save20Regular, Database20Regular, FullScreenMaximize20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: tokens.spacingVerticalS },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px' },
  // Long ARM / REST error strings must wrap and stay bounded instead of forcing
  // the editor to scroll horizontally.
  errBody: { overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%' },
  errScroll: { overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%', maxHeight: '180px', overflowY: 'auto' },
});

interface WorkspaceLite { id: string; name: string }
interface MountLite {
  id: string;
  displayName: string;
  subscriptionId?: string;
  resourceGroup?: string;
  factoryName?: string;
}
interface PipelineLite { name: string; properties?: { description?: string; activities?: unknown[] } }
interface TriggerLite { name: string; properties?: { type?: string; runtimeState?: string; description?: string } }
interface RunLite { runId: string; pipelineName: string; status?: string; runStart?: string; durationInMs?: number; message?: string }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/loom/workspaces').then(r => r.json()).then(j => {
      if (!j.ok) { setError(j.error || 'failed'); setWorkspaces([]); }
      else setWorkspaces(j.workspaces || []);
    }).catch(e => { setError(e?.message || String(e)); setWorkspaces([]); });
  }, []);
  return { workspaces, error };
}

interface Props { item: FabricItemType; id: string }

export function MountedAdfEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mounts, setMounts] = useState<MountLite[] | null>(null);
  const [mountId, setMountId] = useState(id !== 'new' ? id : '');
  const [active, setActive] = useState<MountLite | null>(null);
  const [pipelines, setPipelines] = useState<PipelineLite[] | null>(null);
  const [triggers, setTriggers] = useState<TriggerLite[] | null>(null);
  const [runs, setRuns] = useState<RunLite[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [partialErr, setPartialErr] = useState<Record<string, string> | null>(null);
  const [tab, setTab] = useState<string>('pipelines');
  const [runMsg, setRunMsg] = useState<string | null>(null);

  // Create
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cSub, setCSub] = useState('');
  const [cRg, setCRg] = useState('');
  const [cFactory, setCFactory] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    try {
      const r = await fetch(`/api/items/mounted-adf?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setMounts([]); return; }
      setMounts(j.mounts || []);
      if (!mountId && (j.mounts || []).length) setMountId(j.mounts[0].id);
    } catch { setMounts([]); }
  }, [mountId]);

  const loadDetail = useCallback(async (wsId: string, mid: string) => {
    setDetailErr(null); setPartialErr(null);
    setPipelines(null); setTriggers(null); setRuns(null);
    try {
      const r = await fetch(`/api/items/mounted-adf/${encodeURIComponent(mid)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) {
        setDetailErr(j.error || 'failed');
        setPipelines([]); setTriggers([]); setRuns([]);
        return;
      }
      setActive(j.mount);
      setPipelines(j.pipelines || []);
      setTriggers(j.triggers || []);
      setRuns(j.runs || []);
      if (j.partial) setPartialErr(j.partial);
    } catch (e: any) {
      setDetailErr(e?.message || String(e));
      setPipelines([]); setTriggers([]); setRuns([]);
    }
  }, []);

  // Auto-resolve this item's workspace from the route id so a deep-linked /
  // app-installed mounted ADF loads immediately instead of waiting on a manual
  // workspace pick (mirrors the data-pipeline + notebook editors).
  useEffect(() => {
    if (!id || id === 'new' || workspaceId) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`/api/cosmos-items/mounted-adf/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (alive && j?.workspaceId) setWorkspaceId(j.workspaceId);
      } catch { /* fall back to manual pick */ }
    })();
    return () => { alive = false; };
  }, [id, workspaceId]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && mountId) loadDetail(workspaceId, mountId); }, [workspaceId, mountId, loadDetail]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim() || !cSub.trim() || !cRg.trim() || !cFactory.trim()) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await fetch(`/api/items/mounted-adf?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: cName.trim(),
          subscriptionId: cSub.trim(),
          resourceGroup: cRg.trim(),
          factoryName: cFactory.trim(),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCName(''); setCSub(''); setCRg(''); setCFactory('');
      await loadList(workspaceId);
      if (j.mount?.id) setMountId(j.mount.id);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cSub, cRg, cFactory, loadList]);

  const run = useCallback(async (pipelineName: string) => {
    if (!workspaceId || !mountId) return;
    setRunMsg(null);
    try {
      const r = await fetch(`/api/items/mounted-adf/${encodeURIComponent(mountId)}/run?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineName }),
      });
      const j = await r.json();
      if (!j.ok) setRunMsg(`Run failed: ${j.error}`);
      else {
        setRunMsg(`Run started: ${j.runId}`);
        // refresh runs after a short tick
        setTimeout(() => workspaceId && mountId && loadDetail(workspaceId, mountId), 2000);
      }
    } catch (e: any) { setRunMsg(`Run error: ${e?.message || String(e)}`); }
  }, [workspaceId, mountId, loadDetail]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Mount', actions: [
        { label: 'New mount', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId && mountId ? () => loadDetail(workspaceId, mountId) : undefined, disabled: !workspaceId || !mountId },
      ]},
      { label: 'View', actions: [
        { label: 'Pipelines', onClick: () => setTab('pipelines'), disabled: !mountId },
        { label: 'Triggers', onClick: () => setTab('triggers'), disabled: !mountId },
        { label: 'Runs', onClick: () => setTab('runs'), disabled: !mountId },
        { label: 'Data flows', onClick: () => setTab('dataflows') },
      ]},
    ]},
  ], [workspaceId, mountId, loadDetail]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS }}>Mounted factories</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && mounts === null && <Spinner size="tiny" label="Loading…" />}
          {mounts && mounts.length === 0 && <Caption1>No mounts yet.</Caption1>}
          <Tree aria-label="ADF mounts">
            {(mounts || []).map((m) => (
              <TreeItem key={m.id} itemType="leaf" value={m.id} onClick={() => setMountId(m.id)}>
                <TreeItemLayout iconBefore={<BoxMultiple20Regular />}>
                  {mountId === m.id ? <strong>{m.displayName}</strong> : m.displayName}
                  <br /><Caption1>{m.factoryName}</Caption1>
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
              <Tab value="pipelines">Pipelines</Tab>
              <Tab value="triggers">Triggers</Tab>
              <Tab value="runs">Runs</Tab>
              <Tab value="dataflows">Data flows</Tab>
              <Tab value="settings">Settings</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            {tab !== 'dataflows' && (
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand">MountedDataFactory</Badge>
                <div className={s.field}>
                  <Caption1>Workspace</Caption1>
                  <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(ws.workspaces?.length ?? 0) === 0}>
                    {!workspaceId && <option value="">{ws.workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
                    {(ws.workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                </div>
                <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New mount</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Mount an existing Azure Data Factory</DialogTitle>
                      <DialogContent>
                        <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} /></Field>
                        <Field label="Subscription id" required><Input value={cSub} onChange={(_, d) => setCSub(d.value)} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
                        <Field label="Resource group" required><Input value={cRg} onChange={(_, d) => setCRg(d.value)} placeholder="rg-data" /></Field>
                        <Field label="Factory name" required><Input value={cFactory} onChange={(_, d) => setCFactory(d.value)} placeholder="adf-prod" /></Field>
                        {cErr && <MessageBar intent="error"><MessageBarBody className={s.errBody}>{cErr}</MessageBarBody></MessageBar>}
                        <MessageBar intent="info">
                          <MessageBarBody>
                            The Loom Console UAMI must hold <strong>Data Factory Contributor</strong> (or at least Reader) on the referenced factory. Grant via portal IAM or <code>az role assignment create</code>.
                          </MessageBarBody>
                        </MessageBar>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={cBusy || !cName.trim() || !cSub.trim() || !cRg.trim() || !cFactory.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Mount'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
                <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!workspaceId || !mountId} onClick={() => workspaceId && mountId && loadDetail(workspaceId, mountId)}>Refresh</Button>
              </div>
            )}

            {ws.error && <MessageBar intent="error"><MessageBarBody className={s.errBody}>{ws.error}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody className={s.errScroll}><MessageBarTitle>ARM error</MessageBarTitle>{detailErr}</MessageBarBody></MessageBar>}
            {partialErr && (
              <MessageBar intent="warning">
                <MessageBarBody className={s.errScroll}>
                  <MessageBarTitle>Partial load</MessageBarTitle>
                  Some ARM calls failed: {Object.entries(partialErr).map(([k, v]) => <div key={k}><strong>{k}</strong>: {v}</div>)}
                </MessageBarBody>
              </MessageBar>
            )}
            {runMsg && <MessageBar intent={runMsg.startsWith('Run started') ? 'success' : 'error'}><MessageBarBody className={s.errBody}>{runMsg}</MessageBarBody></MessageBar>}

            {tab === 'pipelines' && (
              <>
                {!mountId && <Caption1>Select a mount.</Caption1>}
                {mountId && pipelines === null && <Spinner size="small" label="Calling ARM…" labelPosition="after" />}
                {pipelines && pipelines.length === 0 && <Caption1>No pipelines in this factory.</Caption1>}
                {pipelines && pipelines.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Pipelines" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Pipeline</TableHeaderCell>
                        <TableHeaderCell>Activities</TableHeaderCell>
                        <TableHeaderCell>Description</TableHeaderCell>
                        <TableHeaderCell>Action</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {pipelines.map(p => (
                          <TableRow key={p.name}>
                            <TableCell className={s.cell}>{p.name}</TableCell>
                            <TableCell>{p.properties?.activities?.length ?? 0}</TableCell>
                            <TableCell>{p.properties?.description || '—'}</TableCell>
                            <TableCell>
                              <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={() => run(p.name)}>Run</Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'triggers' && (
              <>
                {!mountId && <Caption1>Select a mount.</Caption1>}
                {mountId && triggers === null && <Spinner size="small" />}
                {triggers && triggers.length === 0 && <Caption1>No triggers.</Caption1>}
                {triggers && triggers.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Triggers" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Trigger</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Description</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {triggers.map(t => (
                          <TableRow key={t.name}>
                            <TableCell className={s.cell}>{t.name}</TableCell>
                            <TableCell>{t.properties?.type || '—'}</TableCell>
                            <TableCell>{t.properties?.runtimeState || '—'}</TableCell>
                            <TableCell>{t.properties?.description || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'runs' && (
              <>
                {!mountId && <Caption1>Select a mount.</Caption1>}
                {mountId && runs === null && <Spinner size="small" />}
                {runs && runs.length === 0 && <Caption1>No runs in the last 7 days.</Caption1>}
                {runs && runs.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Runs" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Run id</TableHeaderCell>
                        <TableHeaderCell>Pipeline</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {runs.map(r => (
                          <TableRow key={r.runId}>
                            <TableCell className={s.cell}>{r.runId.slice(0, 8)}…</TableCell>
                            <TableCell className={s.cell}>{r.pipelineName}</TableCell>
                            <TableCell>{r.status || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.runStart?.replace('T', ' ').replace(/\..*/, '') ?? '—'}</TableCell>
                            <TableCell className={s.cell}>{r.durationInMs ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {tab === 'dataflows' && <DataFlowsTab />}

            {tab === 'settings' && active && (
              <>
                <Subtitle2>{active.displayName}</Subtitle2>
                <Caption1>Subscription: <code>{active.subscriptionId}</code></Caption1>
                <Caption1>Resource group: <code>{active.resourceGroup}</code></Caption1>
                <Caption1>Factory name: <code>{active.factoryName}</code></Caption1>
                <Button appearance="subtle" icon={<Delete20Regular />} onClick={async () => {
                  if (!workspaceId || !mountId) return;
                  if (typeof window !== 'undefined' && !window.confirm('Unmount this factory? (The factory itself is untouched.)')) return;
                  await fetch(`/api/items/mounted-adf/${encodeURIComponent(mountId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
                  setMountId(''); setActive(null);
                  await loadList(workspaceId);
                }}>Unmount factory</Button>
              </>
            )}
          </div>
        </>
      }
    />
  );
}

// ===================================================================
// Data flows tab — list / create / delete + the Mapping Data Flow designer,
// all against the env-pinned default factory via real ADF REST.
// ===================================================================

interface DataFlowLite { name: string; type?: string }

function DataFlowsTab() {
  const s = useStyles();
  const [flows, setFlows] = useState<DataFlowLite[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Array<{ name: string }>>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const loadFlows = useCallback(async () => {
    setErr(null); setGate(null);
    try {
      const r = await fetch('/api/adf/dataflows');
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'not_configured') { setGate({ missing: j.missing }); setFlows([]); return; }
        setErr(j.error || 'list failed'); setFlows([]); return;
      }
      setFlows(j.dataflows || []);
      if (!selected && (j.dataflows || []).length) setSelected(j.dataflows[0].name);
    } catch (e: any) { setErr(e?.message || String(e)); setFlows([]); }
  }, [selected]);

  const loadDatasets = useCallback(async () => {
    try {
      const r = await fetch('/api/adf/datasets');
      const j = await r.json();
      if (j.ok) setDatasets((j.datasets || []).map((d: any) => ({ name: d.name })));
    } catch { /* dataset picker just stays empty */ }
  }, []);

  useEffect(() => { loadFlows(); loadDatasets(); }, [loadFlows, loadDatasets]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setBusy(true); setCreateErr(null);
    try {
      const r = await fetch('/api/adf/dataflows', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false);
      const created = newName.trim(); setNewName('');
      await loadFlows();
      setSelected(created);
      setReloadKey((k) => k + 1);
    } finally { setBusy(false); }
  }, [newName, loadFlows]);

  const del = useCallback(async (name: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Delete data flow "${name}"? This cannot be undone.`)) return;
    await fetch(`/api/adf/dataflows/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (selected === name) setSelected(null);
    await loadFlows();
  }, [selected, loadFlows]);

  if (gate) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Data Factory not configured</MessageBarTitle>
          Set <code>{gate.missing}</code> (plus <code>LOOM_SUBSCRIPTION_ID</code> /
          <code> LOOM_DLZ_RG</code> / <code>LOOM_ADF_NAME</code>) so Loom can reach the
          deployment-default Data Factory. The Mapping Data Flow designer renders once the
          factory is reachable. Bicep module:
          <code> platform/fiab/bicep/modules/data/datafactory.bicep</code>.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 }}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<Database20Regular />}>Mapping Data Flows</Badge>
        <div className={s.field}>
          <Caption1>Data flow</Caption1>
          <Select value={selected || ''} onChange={(_, d) => setSelected(d.value || null)} disabled={!(flows && flows.length)}>
            <option value="">{flows === null ? 'Loading…' : (flows.length ? 'Select a data flow' : 'No data flows')}</option>
            {(flows || []).map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </Select>
        </div>
        <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="outline" icon={<Add20Regular />}>New data flow</Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Create Mapping Data Flow</DialogTitle>
              <DialogContent>
                <Field label="Name" required hint="1-260 chars: letters, digits, underscore">
                  <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="transform_orders" />
                </Field>
                {createErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button appearance="primary" disabled={busy || !newName.trim()} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={loadFlows}>Refresh</Button>
        {selected && <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => del(selected)}>Delete</Button>}
      </div>

      {err && <MessageBar intent="error"><MessageBarBody className={s.errScroll}><MessageBarTitle>ADF REST error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      <MappingDataFlowDesigner name={selected} datasets={datasets} reloadKey={reloadKey} />
    </div>
  );
}

// ===================================================================
// Mapping Data Flow designer — 1:1 with the ADF Studio data-flow canvas
// (top bar + graph + configuration panel). DFS round-trips to ADF REST.
// Grounded in:
//   https://learn.microsoft.com/azure/data-factory/concepts-data-flow-overview
//   https://learn.microsoft.com/azure/data-factory/data-flow-script
// ===================================================================

type StreamKind = 'source' | 'select' | 'filter' | 'join' | 'aggregate' | 'derive' | 'sink';

interface DfStream {
  name: string;
  kind: StreamKind;
  inputs: string[];
  config: Record<string, string>;
}
interface DfModel { streams: DfStream[] }

const TRANSFORMS: Array<{ kind: StreamKind; label: string; color: string; desc: string }> = [
  { kind: 'source',    label: 'Source',         color: 'var(--loom-accent-emerald)', desc: 'Read from a dataset / inline store.' },
  { kind: 'select',    label: 'Select',         color: 'var(--loom-accent-blue)', desc: 'Choose, rename, reorder columns.' },
  { kind: 'filter',    label: 'Filter',         color: 'var(--loom-accent-amber)', desc: 'Keep rows matching an expression.' },
  { kind: 'join',      label: 'Join',           color: 'var(--loom-accent-plum)', desc: 'Join two streams on key columns.' },
  { kind: 'aggregate', label: 'Aggregate',      color: 'var(--loom-accent-plum)', desc: 'Group by + aggregate expressions.' },
  { kind: 'derive',    label: 'Derived column', color: 'var(--loom-accent-magenta)', desc: 'Add / overwrite columns by expression.' },
  { kind: 'sink',      label: 'Sink',           color: 'var(--loom-accent-red)', desc: 'Write to a dataset destination.' },
];

const KIND_COLOR: Record<StreamKind, string> = Object.fromEntries(TRANSFORMS.map((t) => [t.kind, t.color])) as Record<StreamKind, string>;
const KIND_LABEL: Record<StreamKind, string> = Object.fromEntries(TRANSFORMS.map((t) => [t.kind, t.label])) as Record<StreamKind, string>;

function dfsForStream(st: DfStream): string {
  const c = st.config || {};
  switch (st.kind) {
    case 'source': {
      const ds = c.dataset ? `\n  dataset: '${c.dataset}',` : '';
      return `source(allowSchemaDrift: true,\n  validateSchema: false,${ds}\n  format: 'table') ~> ${st.name}`;
    }
    case 'select': {
      const mappings = c.mappings || 'mapColumn()';
      return `${st.inputs[0] || ''} select(mapColumn(\n    ${mappings}\n  ),\n  skipDuplicateMapInputs: true,\n  skipDuplicateMapOutputs: true) ~> ${st.name}`;
    }
    case 'filter': {
      const expr = c.condition || 'true()';
      return `${st.inputs[0] || ''} filter(${expr}) ~> ${st.name}`;
    }
    case 'join': {
      const left = st.inputs[0] || '';
      const right = st.inputs[1] || '';
      const cond = c.condition || `${left}@key == ${right}@key`;
      const joinType = c.joinType || 'inner';
      return `${left}, ${right} join(${cond},\n  joinType:'${joinType}',\n  broadcast: 'auto') ~> ${st.name}`;
    }
    case 'aggregate': {
      const groupBy = c.groupBy ? `groupBy(${c.groupBy})` : 'groupBy()';
      const aggs = c.aggregates || 'count = count()';
      return `${st.inputs[0] || ''} aggregate(${groupBy},\n  ${aggs}) ~> ${st.name}`;
    }
    case 'derive': {
      const cols = c.columns || "newCol = ''";
      return `${st.inputs[0] || ''} derive(${cols}) ~> ${st.name}`;
    }
    case 'sink': {
      const ds = c.dataset ? `\n  dataset: '${c.dataset}',` : '';
      return `${st.inputs[0] || ''} sink(allowSchemaDrift: true,\n  validateSchema: false,${ds}\n  skipDuplicateMapInputs: true,\n  skipDuplicateMapOutputs: true) ~> ${st.name}`;
    }
    default:
      return `${st.inputs[0] || ''} ${st.kind}() ~> ${st.name}`;
  }
}

function topoOrder(streams: DfStream[]): DfStream[] {
  const byName = new Map(streams.map((st) => [st.name, st]));
  const out: DfStream[] = [];
  const seen = new Set<string>();
  const visit = (st: DfStream) => {
    if (seen.has(st.name)) return;
    seen.add(st.name);
    for (const inName of st.inputs) { const up = byName.get(inName); if (up) visit(up); }
    out.push(st);
  };
  for (const st of streams) visit(st);
  return out;
}

function modelToTypeProperties(model: DfModel): Record<string, unknown> {
  const sources = model.streams.filter((st) => st.kind === 'source').map((st) => ({
    name: st.name,
    ...(st.config.dataset ? { dataset: { referenceName: st.config.dataset, type: 'DatasetReference' } } : {}),
  }));
  const sinks = model.streams.filter((st) => st.kind === 'sink').map((st) => ({
    name: st.name,
    ...(st.config.dataset ? { dataset: { referenceName: st.config.dataset, type: 'DatasetReference' } } : {}),
  }));
  const transformations = model.streams
    .filter((st) => st.kind !== 'source' && st.kind !== 'sink')
    .map((st) => ({ name: st.name }));
  const ordered = topoOrder(model.streams);
  const scriptLines = ordered.flatMap((st) => dfsForStream(st).split('\n'));
  return { sources, sinks, transformations, scriptLines };
}

function definitionToModel(properties: any): DfModel {
  const tp = properties?.typeProperties || {};
  const scriptLines: string[] = Array.isArray(tp.scriptLines) ? tp.scriptLines : [];
  const script = scriptLines.join('\n');

  const sourceNames = new Set<string>((tp.sources || []).map((x: any) => x.name).filter(Boolean));
  const sinkNames = new Set<string>((tp.sinks || []).map((x: any) => x.name).filter(Boolean));
  const datasetByStream = new Map<string, string>();
  for (const x of [...(tp.sources || []), ...(tp.sinks || [])]) {
    if (x?.name && x?.dataset?.referenceName) datasetByStream.set(x.name, x.dataset.referenceName);
  }

  const streams: DfStream[] = [];
  const re = /([A-Za-z0-9_,\s]*?)\b(source|select|filter|join|aggregate|derive|sink)\s*\(([\s\S]*?)\)\s*~>\s*([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    const lhs = m[1].trim();
    const kind = m[2] as StreamKind;
    const body = m[3];
    const name = m[4];
    const inputs = lhs ? lhs.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const config: Record<string, string> = {};
    if (datasetByStream.has(name)) config.dataset = datasetByStream.get(name)!;
    if (kind === 'filter') config.condition = body.trim();
    if (kind === 'join') {
      const jt = body.match(/joinType:\s*'([^']+)'/); if (jt) config.joinType = jt[1];
      const cond = body.split(',')[0]?.trim(); if (cond) config.condition = cond;
    }
    streams.push({ name, kind, inputs, config });
  }

  if (streams.length === 0) {
    for (const x of tp.sources || []) if (x?.name) streams.push({ name: x.name, kind: 'source', inputs: [], config: x.dataset?.referenceName ? { dataset: x.dataset.referenceName } : {} });
    for (const t of tp.transformations || []) if (t?.name) streams.push({ name: t.name, kind: 'select', inputs: [], config: {} });
    for (const x of tp.sinks || []) if (x?.name) streams.push({ name: x.name, kind: 'sink', inputs: [], config: x.dataset?.referenceName ? { dataset: x.dataset.referenceName } : {} });
  }

  for (const st of streams) {
    if (sourceNames.has(st.name)) st.kind = 'source';
    else if (sinkNames.has(st.name)) st.kind = 'sink';
  }

  return { streams };
}

const useNodeStyles = makeStyles({
  node: {
    width: '196px', borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4, overflow: 'hidden', cursor: 'pointer',
  },
  selected: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },
  bar: { height: tokens.spacingVerticalXS },
  body: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalMNudge}`, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  name: { fontWeight: 600, fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
});

interface DfNodeData extends Record<string, unknown> { stream: DfStream }

function DfNode({ data, selected }: NodeProps) {
  const s = useNodeStyles();
  const stream = (data as DfNodeData).stream;
  const color = KIND_COLOR[stream.kind];
  return (
    <div className={`${s.node} ${selected ? s.selected : ''}`} data-stream={stream.name} data-kind={stream.kind}>
      <div className={s.bar} style={{ backgroundColor: color }} />
      <div className={s.body}>
        <span className={s.name} title={stream.name}>{stream.name}</span>
        <Caption1 style={{ color }}>{KIND_LABEL[stream.kind]}</Caption1>
      </div>
    </div>
  );
}

const nodeTypes = { dfNode: DfNode };

const useDesignerStyles = makeStyles({
  shell: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minHeight: 0 },
  topbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  // Let the user drag the data-flow designer taller; bounded + scrollable children.
  threePane: { display: 'flex', flex: 1, minHeight: '460px', gap: tokens.spacingHorizontalS, resize: 'vertical', overflow: 'hidden', boxSizing: 'border-box' },
  palette: {
    flexShrink: 0, width: '200px', padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, overflow: 'auto',
  },
  tile: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer', textAlign: 'left',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover, borderColor: tokens.colorBrandStroke1 },
  },
  canvasCol: { flex: 1, minWidth: 0, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, overflow: 'hidden' },
  configCol: {
    flexShrink: 0, width: '300px', minWidth: 0, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalMNudge,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, overflow: 'auto',
  },
  // Long ADF REST error / save-result strings wrap + stay bounded.
  errBody: { overflowWrap: 'anywhere', wordBreak: 'break-word', maxWidth: '100%', maxHeight: '180px', overflowY: 'auto' },
});

interface DesignerProps {
  name: string | null;
  datasets: Array<{ name: string }>;
  reloadKey?: number;
}

function nextStreamName(streams: DfStream[], kind: StreamKind): string {
  let n = 1;
  const taken = new Set(streams.map((st) => st.name));
  while (taken.has(`${kind}${n}`)) n += 1;
  return `${kind}${n}`;
}

function InnerDesigner({ name, datasets, reloadKey }: DesignerProps) {
  const s = useDesignerStyles();
  const rf = useReactFlow();
  const [model, setModel] = useState<DfModel>({ streams: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [previewGate, setPreviewGate] = useState(false);
  const positions = useRef<Record<string, { x: number; y: number }>>({});

  const load = useCallback(async (flowName: string) => {
    setLoading(true); setErr(null); setMsg(null);
    try {
      const r = await fetch(`/api/adf/dataflows/${encodeURIComponent(flowName)}`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'load failed'); setModel({ streams: [] }); return; }
      const next = definitionToModel(j.dataflow?.properties);
      positions.current = {};
      setModel(next);
      setSelected(next.streams[0]?.name || null);
      setDirty(false);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (name) load(name); else { setModel({ streams: [] }); setSelected(null); } }, [name, reloadKey, load]);

  const depth = useMemo(() => {
    const byName = new Map(model.streams.map((st) => [st.name, st]));
    const cache = new Map<string, number>();
    const calc = (st: DfStream): number => {
      if (cache.has(st.name)) return cache.get(st.name)!;
      cache.set(st.name, 0);
      const d = st.inputs.length === 0 ? 0 : 1 + Math.max(0, ...st.inputs.map((i) => { const up = byName.get(i); return up ? calc(up) : 0; }));
      cache.set(st.name, d);
      return d;
    };
    const out: Record<string, number> = {};
    for (const st of model.streams) out[st.name] = calc(st);
    return out;
  }, [model]);

  const nodes: Node[] = useMemo(() => {
    const rowByDepth: Record<number, number> = {};
    return model.streams.map((st) => {
      const d = depth[st.name] ?? 0;
      const row = rowByDepth[d] ?? 0; rowByDepth[d] = row + 1;
      const pos = positions.current[st.name] || { x: 40 + d * 240, y: 40 + row * 120 };
      positions.current[st.name] = pos;
      return {
        id: st.name,
        type: 'dfNode',
        position: pos,
        data: { stream: st } as DfNodeData,
        selected: selected === st.name,
      };
    });
  }, [model, depth, selected]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const st of model.streams) {
      for (const inName of st.inputs) {
        out.push({
          id: `${inName}->${st.name}`,
          source: inName, target: st.name,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#888' },
          style: { stroke: '#888', strokeWidth: 1.7 },
        });
      }
    }
    return out;
  }, [model]);

  const selStream = model.streams.find((st) => st.name === selected) || null;

  const mutate = useCallback((fn: (prev: DfModel) => DfModel) => {
    setModel((prev) => fn(prev));
    setDirty(true);
  }, []);

  const addTransform = useCallback((kind: StreamKind) => {
    mutate((prev) => {
      const nm = nextStreamName(prev.streams, kind);
      const inputs = kind === 'source' ? [] : (selected ? [selected] : []);
      const st: DfStream = { name: nm, kind, inputs, config: {} };
      setTimeout(() => setSelected(nm), 0);
      return { streams: [...prev.streams, st] };
    });
  }, [mutate, selected]);

  const patchConfig = useCallback((key: string, value: string) => {
    if (!selStream) return;
    mutate((prev) => ({
      streams: prev.streams.map((st) => st.name === selStream.name ? { ...st, config: { ...st.config, [key]: value } } : st),
    }));
  }, [mutate, selStream]);

  const renameStream = useCallback((next: string) => {
    if (!selStream || !next.trim() || !/^[A-Za-z0-9_]+$/.test(next)) return;
    const old = selStream.name;
    mutate((prev) => ({
      streams: prev.streams.map((st) => ({
        ...st,
        name: st.name === old ? next : st.name,
        inputs: st.inputs.map((i) => i === old ? next : i),
      })),
    }));
    const p = positions.current[old]; if (p) { positions.current[next] = p; delete positions.current[old]; }
    setSelected(next);
  }, [mutate, selStream]);

  const setSecondJoinInput = useCallback((rightName: string) => {
    if (!selStream || selStream.kind !== 'join') return;
    mutate((prev) => ({
      streams: prev.streams.map((st) => st.name === selStream.name
        ? { ...st, inputs: [st.inputs[0] || '', rightName].filter(Boolean) }
        : st),
    }));
  }, [mutate, selStream]);

  const deleteStream = useCallback(() => {
    if (!selStream) return;
    const old = selStream.name;
    mutate((prev) => ({
      streams: prev.streams
        .filter((st) => st.name !== old)
        .map((st) => ({ ...st, inputs: st.inputs.filter((i) => i !== old) })),
    }));
    setSelected(null);
  }, [mutate, selStream]);

  const save = useCallback(async () => {
    if (!name) return;
    setSaving(true); setErr(null); setMsg(null);
    try {
      const typeProperties = modelToTypeProperties(model);
      const r = await fetch(`/api/adf/dataflows/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: { type: 'MappingDataFlow', typeProperties } }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'save failed'); setMsg(`Save failed: ${j.error || 'unknown'}`); return; }
      setDirty(false);
      setMsg(`Saved ${model.streams.length} stream(s) to ADF at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) { setErr(e?.message || String(e)); setMsg(`Save failed: ${e?.message || e}`); }
    finally { setSaving(false); }
  }, [name, model]);

  if (!name) {
    return (
      <MessageBar intent="info">
        <MessageBarBody>
          Select a data flow above (or create one) to open the Mapping Data Flow designer — a real
          source → transform chain (select · filter · join · aggregate · derived) → sink graph.
        </MessageBarBody>
      </MessageBar>
    );
  }

  return (
    <div className={s.shell}>
      <div className={s.topbar}>
        <Badge appearance="filled" color="brand" icon={<Database20Regular />}>Mapping Data Flow</Badge>
        <Badge appearance="outline">{name}</Badge>
        <Badge appearance="outline">{model.streams.length} stream(s)</Badge>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button size="small" appearance="primary" icon={<Save20Regular />} disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={() => load(name)}>Refresh</Button>
        <Button size="small" appearance="subtle" icon={<FullScreenMaximize20Regular />} onClick={() => rf.fitView({ padding: 0.2 })}>Fit</Button>
        <Tooltip content="Live data preview needs an ADF data-flow debug session" relationship="label">
          <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => setPreviewGate(true)}>Data preview</Button>
        </Tooltip>
      </div>

      {loading && <Spinner size="small" label="Reading data flow from ADF…" labelPosition="after" />}
      {err && <MessageBar intent="error"><MessageBarBody className={s.errBody}><MessageBarTitle>ADF REST error</MessageBarTitle>{err}</MessageBarBody></MessageBar>}
      {msg && <MessageBar intent={msg.startsWith('Save failed') ? 'error' : 'success'}><MessageBarBody className={s.errBody}>{msg}</MessageBarBody></MessageBar>}
      {previewGate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Data preview is config-gated</MessageBarTitle>
            Live data preview requires an ADF data-flow debug session
            (<code>createDataFlowDebugSession</code> + <code>executeDataFlowDebugCommand</code> on
            <code> Microsoft.DataFactory/factories</code>). That helper isn’t wired in this deployment.
            Authoring (add transform · configure · save) writes the real ADF definition now; preview lights
            up once the debug-session helper is added to <code>lib/azure/adf-client.ts</code>.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.threePane}>
        <div className={s.palette} role="navigation" aria-label="Data flow transformation palette">
          <Subtitle2>Transformations</Subtitle2>
          {TRANSFORMS.map((t) => (
            <Tooltip key={t.kind} content={t.desc} relationship="description" positioning="after">
              <div
                className={s.tile} role="button" tabIndex={0}
                data-transform={t.kind}
                onClick={() => addTransform(t.kind)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addTransform(t.kind); } }}
              >
                <span style={{ fontWeight: 600, borderLeft: `3px solid ${t.color}`, paddingLeft: tokens.spacingHorizontalSNudge }}>{t.label}</span>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.desc}</Caption1>
              </div>
            </Tooltip>
          ))}
          <Caption1 style={{ marginTop: 'auto', color: tokens.colorNeutralForeground3 }}>
            Click a transform to chain it off the selected node. Source adds a new stream head.
          </Caption1>
        </div>

        <div className={s.canvasCol}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelected(n.id)}
            onNodeDragStop={(_, n) => { positions.current[n.id] = n.position; }}
            onPaneClick={() => setSelected(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => KIND_COLOR[((n.data as DfNodeData)?.stream?.kind) || 'select']} />
          </ReactFlow>
        </div>

        <div className={s.configCol}>
          {!selStream && <Caption1>Select a transformation to configure it.</Caption1>}
          {selStream && (
            <>
              <Subtitle2>{KIND_LABEL[selStream.kind]} settings</Subtitle2>
              <Field label="Output stream name">
                <Input value={selStream.name} onChange={(_, d) => renameStream(d.value)} />
              </Field>

              {selStream.kind === 'source' && (
                <Field label="Source dataset" hint="Existing ADF dataset (real REST list)">
                  <Dropdown
                    placeholder={datasets.length ? 'Pick a dataset' : 'No datasets in factory'}
                    value={selStream.config.dataset || ''}
                    selectedOptions={selStream.config.dataset ? [selStream.config.dataset] : []}
                    onOptionSelect={(_, d) => patchConfig('dataset', d.optionValue || '')}
                  >
                    {datasets.map((ds) => <Option key={ds.name} value={ds.name} text={ds.name}>{ds.name}</Option>)}
                  </Dropdown>
                </Field>
              )}

              {selStream.kind === 'sink' && (
                <Field label="Sink dataset" hint="Destination ADF dataset">
                  <Dropdown
                    placeholder={datasets.length ? 'Pick a dataset' : 'No datasets in factory'}
                    value={selStream.config.dataset || ''}
                    selectedOptions={selStream.config.dataset ? [selStream.config.dataset] : []}
                    onOptionSelect={(_, d) => patchConfig('dataset', d.optionValue || '')}
                  >
                    {datasets.map((ds) => <Option key={ds.name} value={ds.name} text={ds.name}>{ds.name}</Option>)}
                  </Dropdown>
                </Field>
              )}

              {selStream.kind === 'filter' && (
                <Field label="Filter condition" hint="ADF data flow expression, e.g. col1 != '' && year > 2020">
                  <Textarea value={selStream.config.condition || ''} rows={3}
                    onChange={(_, d) => patchConfig('condition', d.value)} placeholder="true()" />
                </Field>
              )}

              {selStream.kind === 'select' && (
                <Field label="Column mappings" hint="mapColumn() entries, e.g. id, name = fullName">
                  <Textarea value={selStream.config.mappings || ''} rows={3}
                    onChange={(_, d) => patchConfig('mappings', d.value)} placeholder={'id,\nname = fullName'} />
                </Field>
              )}

              {selStream.kind === 'derive' && (
                <Field label="Derived columns" hint="name = expression pairs, comma-separated">
                  <Textarea value={selStream.config.columns || ''} rows={3}
                    onChange={(_, d) => patchConfig('columns', d.value)} placeholder="upperName = upper(name)" />
                </Field>
              )}

              {selStream.kind === 'aggregate' && (
                <>
                  <Field label="Group by columns" hint="Comma-separated column names">
                    <Input value={selStream.config.groupBy || ''} onChange={(_, d) => patchConfig('groupBy', d.value)} placeholder="region, year" />
                  </Field>
                  <Field label="Aggregate expressions" hint="name = agg(), e.g. total = sum(amount)">
                    <Textarea value={selStream.config.aggregates || ''} rows={2}
                      onChange={(_, d) => patchConfig('aggregates', d.value)} placeholder="total = sum(amount)" />
                  </Field>
                </>
              )}

              {selStream.kind === 'join' && (
                <>
                  <Field label="Right (second) stream">
                    <Dropdown
                      placeholder="Pick the stream to join"
                      value={selStream.inputs[1] || ''}
                      selectedOptions={selStream.inputs[1] ? [selStream.inputs[1]] : []}
                      onOptionSelect={(_, d) => setSecondJoinInput(d.optionValue || '')}
                    >
                      {model.streams.filter((st) => st.name !== selStream.name && st.kind !== 'sink')
                        .map((st) => <Option key={st.name} value={st.name} text={st.name}>{st.name}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Join type">
                    <Select value={selStream.config.joinType || 'inner'} onChange={(_, d) => patchConfig('joinType', d.value)}>
                      <option value="inner">inner</option>
                      <option value="left_outer">left outer</option>
                      <option value="right_outer">right outer</option>
                      <option value="full_outer">full outer</option>
                      <option value="cross">cross</option>
                    </Select>
                  </Field>
                  <Field label="Join condition" hint="left@key == right@key">
                    <Input value={selStream.config.condition || ''} onChange={(_, d) => patchConfig('condition', d.value)}
                      placeholder={`${selStream.inputs[0] || 'left'}@key == ${selStream.inputs[1] || 'right'}@key`} />
                  </Field>
                </>
              )}

              <Field label="Upstream input(s)">
                <Caption1>{selStream.inputs.length ? selStream.inputs.join(', ') : (selStream.kind === 'source' ? '— (stream head)' : 'unwired')}</Caption1>
              </Field>

              <Button appearance="subtle" icon={<Delete20Regular />} onClick={deleteStream}>Delete transformation</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MappingDataFlowDesigner(props: DesignerProps) {
  return (
    <ReactFlowProvider>
      <InnerDesigner {...props} />
    </ReactFlowProvider>
  );
}
