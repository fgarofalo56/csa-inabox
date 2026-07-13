'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * BatchPoolEditor (SVC-5) — ADF-Studio-style navigator over the
 * deployment-pinned Azure Batch account (LOOM_BATCH_ACCOUNT). Pools list/create/
 * delete over the ARM management plane; jobs + tasks over the Batch data plane.
 * Real REST via /api/items/batch-pool[/jobs|/tasks] (batch-client). Honest 503
 * gate when the account env vars are unset. Azure-native — no Fabric.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Body1, Badge, Button, Spinner, Input, Field, Dropdown, Option, Switch, Textarea,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Server20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { VM_SIZE_PRESETS, AUTOSCALE_PRESETS, autoScaleFormulaFor, classifyBatchGate } from '@/lib/azure/batch-presets';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto' },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS} 0` },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, alignItems: 'center', maxWidth: '720px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
  tableWrap: { overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  dlgFields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  formula: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, minHeight: '96px' },
});

interface AccountProps { name?: string; location?: string; poolAllocationMode?: string; provisioningState?: string; dedicatedCoreQuota?: number; lowPriorityCoreQuota?: number; poolQuota?: number; accountEndpoint?: string }
interface PoolEntity { name: string; vmSize?: string; allocationState?: string; provisioningState?: string; currentDedicatedNodes?: number; currentLowPriorityNodes?: number; targetDedicatedNodes?: number; targetLowPriorityNodes?: number; enableAutoScale?: boolean }
interface JobEntity { id: string; displayName?: string; state?: string; poolId?: string; priority?: number }
interface TaskEntity { id: string; displayName?: string; state?: string; commandLine?: string; exitCode?: number }
interface Props { item: FabricItemType; id: string }

export function BatchPoolEditor({ item, id }: Props) {
  const s = useStyles();
  const [tab, setTab] = useState('pools');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ error: string; hint?: string; missing?: string; bicep?: string; kind: 'not_configured' | 'forbidden' } | null>(null);
  const [account, setAccount] = useState<AccountProps | null>(null);
  const [pools, setPools] = useState<PoolEntity[]>([]);
  const [msg, setMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Create-pool dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cVmSize, setCVmSize] = useState(VM_SIZE_PRESETS[1]?.value || 'standard_d2s_v3');
  const [cDedicated, setCDedicated] = useState('1');
  const [cLowPri, setCLowPri] = useState('0');
  const [cAutoScale, setCAutoScale] = useState(false);
  const [cAutoPreset, setCAutoPreset] = useState(AUTOSCALE_PRESETS[0]?.value || '');
  const [cBusy, setCBusy] = useState(false);

  // Jobs
  const [jobs, setJobs] = useState<JobEntity[] | null>(null);
  const [jId, setJId] = useState('');
  const [jPool, setJPool] = useState('');
  const [jBusy, setJBusy] = useState(false);

  // Tasks (drill-in from a job)
  const [taskJob, setTaskJob] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskEntity[] | null>(null);
  const [tId, setTId] = useState('');
  const [tCmd, setTCmd] = useState('');
  const [tBusy, setTBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setGate(null);
    try {
      const r = await clientFetch('/api/items/batch-pool');
      const j = await r.json();
      if (!j.ok) {
        // A 403 (DLZ-admin authorization) is a DIFFERENT gate than a missing
        // account (503 not_configured) — render them distinctly so a non-admin
        // sees "admins only", not a misleading "not configured".
        setGate(classifyBatchGate(r.status, j));
        setAccount(null); setPools([]); return;
      }
      setAccount(j.account || null);
      setPools(Array.isArray(j.pools) ? j.pools : []);
    } catch (e: any) { setGate({ error: e?.message || String(e), kind: 'not_configured' }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadJobs = useCallback(async () => {
    setJobs(null);
    try {
      const r = await clientFetch('/api/items/batch-pool/jobs');
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'load jobs failed' }); setJobs([]); return; }
      setJobs(Array.isArray(j.jobs) ? j.jobs : []);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); setJobs([]); }
  }, []);

  const loadTasks = useCallback(async (jobId: string) => {
    setTaskJob(jobId); setTasks(null);
    try {
      const r = await clientFetch(`/api/items/batch-pool/tasks?job=${encodeURIComponent(jobId)}`);
      const j = await r.json();
      setTasks(j.ok ? (j.tasks || []) : []);
      if (!j.ok) setMsg({ intent: 'error', text: j.error || 'load tasks failed' });
    } catch (e: any) { setTasks([]); setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, []);

  const createPool = useCallback(async () => {
    if (!cName.trim()) return;
    setCBusy(true); setMsg(null);
    try {
      const r = await clientFetch('/api/items/batch-pool', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create-pool', name: cName.trim(), vmSize: cVmSize,
          targetDedicatedNodes: Number(cDedicated) || 0,
          targetLowPriorityNodes: Number(cLowPri) || 0,
          enableAutoScale: cAutoScale,
          autoScaleFormula: cAutoScale ? autoScaleFormulaFor(cAutoPreset) : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setMsg({ intent: 'success', text: `Created pool "${cName.trim()}".` });
      setCreateOpen(false); setCName('');
      await load();
    } finally { setCBusy(false); }
  }, [cName, cVmSize, cDedicated, cLowPri, cAutoScale, cAutoPreset, load]);

  const deletePool = useCallback(async (name: string) => {
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/batch-pool?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      setMsg({ intent: 'success', text: `Deleted pool "${name}".` });
      await load();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [load]);

  const createJob = useCallback(async () => {
    if (!jId.trim() || !jPool.trim()) return;
    setJBusy(true); setMsg(null);
    try {
      const r = await clientFetch('/api/items/batch-pool/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: jId.trim(), poolId: jPool.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setJId('');
      await loadJobs();
    } finally { setJBusy(false); }
  }, [jId, jPool, loadJobs]);

  const deleteJob = useCallback(async (jobId: string) => {
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/batch-pool/jobs?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      if (taskJob === jobId) { setTaskJob(null); setTasks(null); }
      await loadJobs();
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [taskJob, loadJobs]);

  const createTask = useCallback(async () => {
    if (!taskJob || !tId.trim() || !tCmd.trim()) return;
    setTBusy(true); setMsg(null);
    try {
      const r = await clientFetch('/api/items/batch-pool/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: taskJob, id: tId.trim(), commandLine: tCmd.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'create failed' }); return; }
      setTId(''); setTCmd('');
      await loadTasks(taskJob);
    } finally { setTBusy(false); }
  }, [taskJob, tId, tCmd, loadTasks]);

  const deleteTask = useCallback(async (taskId: string) => {
    if (!taskJob) return;
    setMsg(null);
    try {
      const r = await clientFetch(`/api/items/batch-pool/tasks?job=${encodeURIComponent(taskJob)}&id=${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setMsg({ intent: 'error', text: j.error || 'delete failed' }); return; }
      await loadTasks(taskJob);
    } catch (e: any) { setMsg({ intent: 'error', text: e?.message || String(e) }); }
  }, [taskJob, loadTasks]);

  const onTab = useCallback((v: string) => {
    setTab(v);
    if (v === 'jobs' && jobs === null && !gate) void loadJobs();
  }, [jobs, gate, loadJobs]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Account', actions: [{ label: 'Refresh', onClick: () => void load() }] },
      { label: 'Pools', actions: [{ label: 'New pool', onClick: gate ? undefined : () => setCreateOpen(true), disabled: !!gate }] },
      { label: 'View', actions: [
        { label: 'Pools', onClick: () => onTab('pools') },
        { label: 'Jobs', onClick: () => onTab('jobs') },
        { label: 'Overview', onClick: () => onTab('overview') },
      ]},
    ]},
  ], [gate, load, onTab]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={s.tabs}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => onTab(d.value as string)}>
            <Tab value="pools">Pools</Tab>
            <Tab value="jobs">Jobs &amp; tasks</Tab>
            <Tab value="overview">Overview</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Server20Regular />}>Azure Batch</Badge>
            {account?.name && <Caption1 className={s.mono}>{account.name}{account.location ? ` · ${account.location}` : ''}{account.poolAllocationMode ? ` · ${account.poolAllocationMode}` : ''}</Caption1>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void load()}>Refresh</Button>
          </div>

          {loading && <Spinner size="small" label="Loading Batch account…" labelPosition="after" />}

          {gate && gate.kind === 'forbidden' && (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Access required</MessageBarTitle>
                {gate.error}
              </MessageBarBody>
            </MessageBar>
          )}

          {gate && gate.kind === 'not_configured' && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Azure Batch account not configured</MessageBarTitle>
                {gate.error}{gate.hint ? ` ${gate.hint}` : ''}
                {gate.missing ? <> Set <code className={s.mono}>{gate.missing}</code>.</> : null}
                {gate.bicep ? <> Deploy it with <code className={s.mono}>{gate.bicep}</code> (opt-in per <code className={s.mono}>batchEnabled</code>).</> : null}
              </MessageBarBody>
            </MessageBar>
          )}

          {msg && <MessageBar intent={msg.intent}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}

          {!loading && !gate && tab === 'pools' && (
            <>
              <div className={s.toolbar}>
                <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button appearance="primary" icon={<Add20Regular />}>New pool</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Create Batch pool</DialogTitle>
                      <DialogContent>
                        <div className={s.dlgFields}>
                          <Field label="Pool ID" required><Input value={cName} onChange={(_, d) => setCName(d.value)} placeholder="scoring-pool" /></Field>
                          <Field label="VM size" required>
                            <Dropdown value={VM_SIZE_PRESETS.find((v) => v.value === cVmSize)?.label || cVmSize} selectedOptions={[cVmSize]} onOptionSelect={(_, d) => setCVmSize(d.optionValue || cVmSize)}>
                              {VM_SIZE_PRESETS.map((v) => <Option key={v.value} value={v.value} text={v.label}>{v.label}</Option>)}
                            </Dropdown>
                          </Field>
                          <Field label="Autoscale">
                            <Switch checked={cAutoScale} onChange={(_, d) => setCAutoScale(d.checked)} label={cAutoScale ? 'Formula-driven autoscale' : 'Fixed node count'} />
                          </Field>
                          {!cAutoScale ? (
                            <>
                              <Field label="Dedicated nodes"><Input type="number" value={cDedicated} onChange={(_, d) => setCDedicated(d.value)} /></Field>
                              <Field label="Low-priority (Spot) nodes"><Input type="number" value={cLowPri} onChange={(_, d) => setCLowPri(d.value)} /></Field>
                            </>
                          ) : (
                            <>
                              <Field label="Autoscale formula" hint="Choose a preset — the resolved Batch autoscale formula is sent verbatim.">
                                <Dropdown value={AUTOSCALE_PRESETS.find((p) => p.value === cAutoPreset)?.label || ''} selectedOptions={[cAutoPreset]} onOptionSelect={(_, d) => setCAutoPreset(d.optionValue || cAutoPreset)}>
                                  {AUTOSCALE_PRESETS.map((p) => <Option key={p.value} value={p.value} text={p.label}>{p.label}</Option>)}
                                </Dropdown>
                              </Field>
                              <Textarea readOnly value={autoScaleFormulaFor(cAutoPreset)} textarea={{ className: s.formula }} resize="vertical" />
                            </>
                          )}
                        </div>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={createPool}>{cBusy ? 'Creating…' : 'Create'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {pools.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No pools yet. Click <strong>New pool</strong> to allocate compute for bulk parallel / AI fan-out tasks.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Batch pools" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Pool</TableHeaderCell>
                      <TableHeaderCell>VM size</TableHeaderCell>
                      <TableHeaderCell>Dedicated</TableHeaderCell>
                      <TableHeaderCell>Spot</TableHeaderCell>
                      <TableHeaderCell>Scaling</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {pools.map((p) => (
                        <TableRow key={p.name}>
                          <TableCell className={s.mono}>{p.name}</TableCell>
                          <TableCell className={s.mono}>{p.vmSize || '—'}</TableCell>
                          <TableCell>{p.currentDedicatedNodes ?? p.targetDedicatedNodes ?? '—'}</TableCell>
                          <TableCell>{p.currentLowPriorityNodes ?? p.targetLowPriorityNodes ?? '—'}</TableCell>
                          <TableCell><Badge appearance="tint" color={p.enableAutoScale ? 'brand' : 'informative'}>{p.enableAutoScale ? 'autoscale' : 'fixed'}</Badge></TableCell>
                          <TableCell><Badge appearance="tint" color={p.allocationState === 'steady' ? 'success' : 'warning'}>{p.allocationState || p.provisioningState || '—'}</Badge></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deletePool(p.name)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'jobs' && (
            <>
              <div className={s.toolbar}>
                <Input value={jId} onChange={(_, d) => setJId(d.value)} placeholder="job id" aria-label="job id" />
                <Dropdown placeholder="pool" value={jPool} selectedOptions={jPool ? [jPool] : []} onOptionSelect={(_, d) => setJPool(d.optionValue || '')} aria-label="pool">
                  {pools.map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}</Option>)}
                </Dropdown>
                <Button appearance="primary" icon={<Add20Regular />} disabled={jBusy || !jId.trim() || !jPool.trim()} onClick={createJob}>{jBusy ? 'Adding…' : 'New job'}</Button>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => void loadJobs()}>Refresh jobs</Button>
              </div>
              {jobs === null ? <Spinner size="small" label="Loading jobs…" labelPosition="after" /> : jobs.length === 0 ? (
                <MessageBar intent="info"><MessageBarBody>No jobs. Create a job against a pool, then add tasks to fan work across its nodes.</MessageBarBody></MessageBar>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Batch jobs" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Job</TableHeaderCell><TableHeaderCell>Pool</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {jobs.map((j) => (
                        <TableRow key={j.id}>
                          <TableCell className={s.mono}>{j.id}</TableCell>
                          <TableCell className={s.mono}>{j.poolId || '—'}</TableCell>
                          <TableCell><Badge appearance="tint" color={j.state === 'active' ? 'success' : 'informative'}>{j.state || '—'}</Badge></TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" onClick={() => loadTasks(j.id)}>Tasks</Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteJob(j.id)}>Delete</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {taskJob && (
                <div className={s.field}>
                  <Subtitle2>Tasks · {taskJob}</Subtitle2>
                  <div className={s.toolbar}>
                    <Input value={tId} onChange={(_, d) => setTId(d.value)} placeholder="task id" aria-label="task id" />
                    <Input value={tCmd} onChange={(_, d) => setTCmd(d.value)} placeholder='/bin/bash -c "echo hi"' aria-label="command line" style={{ minWidth: '280px' }} />
                    <Button appearance="outline" icon={<Add20Regular />} disabled={tBusy || !tId.trim() || !tCmd.trim()} onClick={createTask}>{tBusy ? 'Adding…' : 'Add task'}</Button>
                  </div>
                  {tasks === null ? <Spinner size="tiny" label="Loading…" /> : tasks.length === 0 ? <Caption1>No tasks in this job yet.</Caption1> : (
                    <div className={s.tableWrap}>
                      <Table aria-label="Batch tasks" size="small">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Task</TableHeaderCell><TableHeaderCell>Command</TableHeaderCell>
                          <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Exit</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {tasks.map((t) => (
                            <TableRow key={t.id}>
                              <TableCell className={s.mono}>{t.id}</TableCell>
                              <TableCell className={s.mono}>{t.commandLine || '—'}</TableCell>
                              <TableCell><Badge appearance="tint" color={t.state === 'completed' ? 'success' : 'informative'}>{t.state || '—'}</Badge></TableCell>
                              <TableCell>{t.exitCode ?? '—'}</TableCell>
                              <TableCell><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTask(t.id)}>Delete</Button></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {!loading && !gate && tab === 'overview' && account && (
            <div className={s.grid}>
              <Caption1>Account</Caption1><code className={s.mono}>{account.name}</code>
              <Caption1>Location</Caption1><code className={s.mono}>{account.location || '—'}</code>
              <Caption1>Pool allocation</Caption1><code className={s.mono}>{account.poolAllocationMode || '—'}</code>
              <Caption1>Provisioning</Caption1><code className={s.mono}>{account.provisioningState || '—'}</code>
              <Caption1>Dedicated core quota</Caption1><code className={s.mono}>{account.dedicatedCoreQuota ?? '—'}</code>
              <Caption1>Low-priority core quota</Caption1><code className={s.mono}>{account.lowPriorityCoreQuota ?? '—'}</code>
              <Caption1>Pool quota</Caption1><code className={s.mono}>{account.poolQuota ?? '—'}</code>
            </div>
          )}
          {!loading && !gate && tab === 'overview' && !account && <Body1>Account properties unavailable.</Body1>}
        </div>
      </>
    } />
  );
}
