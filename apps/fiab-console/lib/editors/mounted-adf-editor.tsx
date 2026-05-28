'use client';

/**
 * MountedAdfEditor — Fabric MountedDataFactory focused editor.
 *
 * Lets a user reference an existing Azure Data Factory by (subscriptionId,
 * resourceGroup, factoryName) and drive its pipelines from Loom.
 *
 * Tabs: Pipelines · Triggers · Runs · Settings
 *
 * Per .claude/rules/no-vaporware.md every action calls a real ARM REST
 * endpoint (Microsoft.DataFactory/factories api-version 2018-06-01) via
 * the Loom Console UAMI. If the UAMI lacks Data Factory Contributor on
 * the referenced factory, the ARM 401/403 is surfaced verbatim.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Add20Regular, ArrowSync20Regular, Play20Regular, Delete20Regular, BoxMultiple20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 8px 0' },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 },
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
      ]},
    ]},
  ], [workspaceId, mountId, loadDetail]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Mounted factories</Subtitle2>
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
              <Tab value="settings">Settings</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
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
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
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

            {ws.error && <MessageBar intent="error"><MessageBarBody>{ws.error}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>ARM error</MessageBarTitle>{detailErr}</MessageBarBody></MessageBar>}
            {partialErr && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Partial load</MessageBarTitle>
                  Some ARM calls failed: {Object.entries(partialErr).map(([k, v]) => <div key={k}><strong>{k}</strong>: {v}</div>)}
                </MessageBarBody>
              </MessageBar>
            )}
            {runMsg && <MessageBar intent={runMsg.startsWith('Run started') ? 'success' : 'error'}><MessageBarBody>{runMsg}</MessageBarBody></MessageBar>}

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
