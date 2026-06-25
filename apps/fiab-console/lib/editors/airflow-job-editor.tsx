'use client';

/**
 * AirflowJobEditor — Apache Airflow Job (Fabric) focused editor.
 *
 * Tabs: DAGs · Runs · Connections · Settings
 *
 * Loom stores the Airflow webserver URL per item in Cosmos and proxies
 * REST calls to /api/v1/dags through the Loom BFF. Authentication uses
 * the optional LOOM_AIRFLOW_BEARER env var or AAD ingress token (see
 * docs/fiab/v3-tenant-bootstrap.md).
 *
 * Per .claude/rules/no-vaporware.md: if no webserver URL is configured
 * the DAGs tab surfaces an honest MessageBar with a form to save the URL.
 * No mock DAG arrays.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, SkeletonItem, Input, Textarea, Field,
  Tree, TreeItem, TreeItemLayout, Select,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Save20Regular, FlowchartCircle20Regular,
  History20Regular, PlugConnected20Regular, Settings20Regular, Apps20Regular,
  Play16Regular, Pause16Regular, Play16Filled, DocumentText16Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: tokens.spacingVerticalS },
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS, paddingBottom: 0 },
  tableWrap: { overflow: 'auto', maxHeight: '360px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '240px' },
  skeletonStack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4 },
  runsPickerRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', marginBottom: tokens.spacingVerticalM, flexWrap: 'wrap' },
  runsDagField: { minWidth: '280px', flex: 1 },
});

function TableSkeleton({ rows = 4 }: { rows?: number }) {
  const s = useStyles();
  return (
    <div className={s.skeletonStack} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonItem key={i} size={24} />
      ))}
    </div>
  );
}

interface WorkspaceLite { id: string; name: string }
interface JobLite { id: string; displayName: string; webserverUrl?: string | null; gitRepo?: string | null }
interface DagLite {
  dag_id: string;
  is_paused?: boolean;
  is_active?: boolean;
  owners?: string[];
  description?: string;
  schedule_interval?: string;
  next_dagrun?: string;
}

interface DagRunLite {
  dag_run_id: string;
  state?: string;
  run_type?: string;
  logical_date?: string;
  start_date?: string;
  end_date?: string;
}

interface Props { item: FabricItemType; id: string }

export function AirflowJobEditor({ item, id }: Props) {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [jobs, setJobs] = useState<JobLite[] | null>(null);
  const [jobId, setJobId] = useState(id !== 'new' ? id : '');
  const [active, setActive] = useState<JobLite | null>(null);
  const [tab, setTab] = useState<string>('dags');
  const [dags, setDags] = useState<DagLite[] | null>(null);
  const [dagsErr, setDagsErr] = useState<{ error: string; code?: string; hint?: string } | null>(null);

  // Runs tab
  const [runsDagId, setRunsDagId] = useState('');
  const [runs, setRuns] = useState<DagRunLite[] | null>(null);
  const [runsErr, setRunsErr] = useState<{ error: string; code?: string; hint?: string } | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [cUrl, setCUrl] = useState('');
  const [cGit, setCGit] = useState('');
  const [cBusy, setCBusy] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  // Settings tab
  const [editUrl, setEditUrl] = useState('');
  const [editGit, setEditGit] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [settingsErr, setSettingsErr] = useState<string | null>(null);

  // DAG actions (trigger / pause-unpause)
  const [busyDag, setBusyDag] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'error'; text: string } | null>(null);

  // Logs dialog
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsRun, setLogsRun] = useState<DagRunLite | null>(null);
  const [logsTasks, setLogsTasks] = useState<any[] | null>(null);
  const [logsErr, setLogsErr] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);
  const [logTaskId, setLogTaskId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/loom/workspaces').then(r => r.json()).then(j => {
      if (j.ok) setWorkspaces(j.workspaces || []);
      else setWorkspaces([]);
    }).catch(() => setWorkspaces([]));
  }, []);

  const loadList = useCallback(async (wsId: string) => {
    try {
      const r = await fetch(`/api/items/airflow-job?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setJobs([]); return; }
      setJobs(j.jobs || []);
      if (!jobId && (j.jobs || []).length) setJobId(j.jobs[0].id);
    } catch { setJobs([]); }
  }, [jobId]);

  const loadDetail = useCallback(async (wsId: string, jid: string) => {
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jid)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActive(null); return; }
      setActive(j.job);
      setEditUrl(j.job?.webserverUrl || '');
      setEditGit(j.job?.gitRepo || '');
    } catch { setActive(null); }
  }, []);

  const loadDags = useCallback(async (wsId: string, jid: string) => {
    setDags(null); setDagsErr(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jid)}/dags?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDagsErr({ error: j.error, code: j.code, hint: j.hint }); setDags([]); return; }
      setDags(j.dags || []);
    } catch (e: any) { setDagsErr({ error: e?.message || String(e) }); setDags([]); }
  }, []);

  const loadRuns = useCallback(async (wsId: string, jid: string, dagId: string) => {
    setRuns(null); setRunsErr(null); setRunsLoading(true);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jid)}/dag-runs?workspaceId=${encodeURIComponent(wsId)}&dagId=${encodeURIComponent(dagId)}`);
      const j = await r.json();
      if (!j.ok) { setRunsErr({ error: j.error, code: j.code, hint: j.hint }); setRuns([]); return; }
      setRuns(j.runs || []);
    } catch (e: any) { setRunsErr({ error: e?.message || String(e) }); setRuns([]); }
    finally { setRunsLoading(false); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && jobId) loadDetail(workspaceId, jobId); }, [workspaceId, jobId, loadDetail]);
  useEffect(() => {
    // DAGs power both the DAGs tab and the Runs-tab DAG picker.
    if ((tab === 'dags' || tab === 'runs') && workspaceId && jobId && active && dags === null) loadDags(workspaceId, jobId);
  }, [tab, workspaceId, jobId, active, dags, loadDags]);
  // Default the Runs DAG picker to the first DAG once the list arrives.
  useEffect(() => {
    if (tab === 'runs' && !runsDagId && dags && dags.length) setRunsDagId(dags[0].dag_id);
  }, [tab, runsDagId, dags]);
  // Load runs whenever the selected DAG changes (within the Runs tab).
  useEffect(() => {
    if (tab === 'runs' && workspaceId && jobId && runsDagId) loadRuns(workspaceId, jobId, runsDagId);
  }, [tab, workspaceId, jobId, runsDagId, loadRuns]);

  const create = useCallback(async () => {
    if (!workspaceId || !cName.trim()) return;
    setCBusy(true); setCErr(null);
    try {
      const r = await fetch(`/api/items/airflow-job?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          displayName: cName.trim(),
          description: cDesc.trim() || undefined,
          webserverUrl: cUrl.trim() || undefined,
          gitRepo: cGit.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setCErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCName(''); setCDesc(''); setCUrl(''); setCGit('');
      await loadList(workspaceId);
      if (j.job?.id) setJobId(j.job.id);
    } finally { setCBusy(false); }
  }, [workspaceId, cName, cDesc, cUrl, cGit, loadList]);

  const saveConnection = useCallback(async () => {
    if (!workspaceId || !jobId || !editUrl.trim()) return;
    setSettingsBusy(true); setSettingsErr(null); setSettingsMsg(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jobId)}/connection?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ webserverUrl: editUrl.trim(), gitRepo: editGit.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setSettingsErr(j.error); return; }
      setSettingsMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      setDags(null);
      await loadDetail(workspaceId, jobId);
    } catch (e: any) { setSettingsErr(e?.message || String(e)); }
    finally { setSettingsBusy(false); }
  }, [workspaceId, jobId, editUrl, editGit, loadDetail]);

  const triggerRun = useCallback(async (dagId: string) => {
    if (!workspaceId || !jobId) return;
    setBusyDag(dagId); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jobId)}/dag-runs?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dagId }),
      });
      const j = await r.json();
      if (!j.ok) { setActionMsg({ intent: 'error', text: j.error || 'trigger failed' }); return; }
      setActionMsg({ intent: 'success', text: `Triggered ${dagId} — run ${j.run?.dag_run_id || ''} (${j.run?.state || 'queued'})` });
      if (tab === 'runs' && runsDagId === dagId) loadRuns(workspaceId, jobId, dagId);
    } catch (e: any) { setActionMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusyDag(null); }
  }, [workspaceId, jobId, tab, runsDagId, loadRuns]);

  const togglePause = useCallback(async (dagId: string, isPaused: boolean) => {
    if (!workspaceId || !jobId) return;
    setBusyDag(dagId); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jobId)}/dags?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dagId, isPaused }),
      });
      const j = await r.json();
      if (!j.ok) { setActionMsg({ intent: 'error', text: j.error || 'pause toggle failed' }); return; }
      setActionMsg({ intent: 'success', text: `${dagId} ${j.is_paused ? 'paused' : 'unpaused'}` });
      setDags((cur) => (cur || []).map((d) => d.dag_id === dagId ? { ...d, is_paused: j.is_paused } : d));
    } catch (e: any) { setActionMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setBusyDag(null); }
  }, [workspaceId, jobId]);

  const openLogs = useCallback(async (run: DagRunLite) => {
    if (!workspaceId || !jobId || !runsDagId) return;
    setLogsOpen(true); setLogsRun(run); setLogsTasks(null); setLogsErr(null); setLogText(null); setLogTaskId(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jobId)}/task-logs?workspaceId=${encodeURIComponent(workspaceId)}&dagId=${encodeURIComponent(runsDagId)}&runId=${encodeURIComponent(run.dag_run_id)}`);
      const j = await r.json();
      if (!j.ok) { setLogsErr(j.error || 'failed to load task instances'); setLogsTasks([]); return; }
      setLogsTasks(j.tasks || []);
    } catch (e: any) { setLogsErr(e?.message || String(e)); setLogsTasks([]); }
  }, [workspaceId, jobId, runsDagId]);

  const fetchTaskLog = useCallback(async (taskId: string, tryNumber?: number) => {
    if (!workspaceId || !jobId || !runsDagId || !logsRun) return;
    setLogTaskId(taskId); setLogText(null);
    try {
      const r = await fetch(`/api/items/airflow-job/${encodeURIComponent(jobId)}/task-logs?workspaceId=${encodeURIComponent(workspaceId)}&dagId=${encodeURIComponent(runsDagId)}&runId=${encodeURIComponent(logsRun.dag_run_id)}&taskId=${encodeURIComponent(taskId)}&tryNumber=${encodeURIComponent(String(tryNumber || 1))}`);
      const j = await r.json();
      setLogText(j.ok ? (j.log || '(empty log)') : (j.error || 'failed to load log'));
    } catch (e: any) { setLogText(e?.message || String(e)); }
  }, [workspaceId, jobId, runsDagId, logsRun]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: 'New job', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId },
        { label: 'Refresh', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
      { label: 'DAGs', actions: [
        { label: 'Refresh DAGs', onClick: workspaceId && jobId ? () => loadDags(workspaceId, jobId) : undefined, disabled: !workspaceId || !jobId },
      ]},
      { label: 'View', actions: [
        { label: 'DAGs', onClick: () => setTab('dags') },
        { label: 'Runs', onClick: () => setTab('runs'), disabled: !jobId },
        { label: 'Connections', onClick: () => setTab('connections'), disabled: !jobId },
      ]},
    ]},
  ], [workspaceId, jobId, loadList, loadDags]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS }}>Airflow jobs</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && jobs === null && <Spinner size="tiny" label="Loading…" />}
          {jobs && jobs.length === 0 && (
            <EmptyState
              icon={<Apps20Regular />}
              title="No Airflow jobs yet"
              body="Create an Apache Airflow job to orchestrate DAGs against your webserver."
              primaryAction={{ label: 'New job', onClick: () => setCreateOpen(true) }}
            />
          )}
          <Tree aria-label="Airflow jobs">
            {(jobs || []).map(j => (
              <TreeItem key={j.id} itemType="leaf" value={j.id} onClick={() => setJobId(j.id)}>
                <TreeItemLayout iconBefore={<FlowchartCircle20Regular />}>
                  {jobId === j.id ? <strong>{j.displayName}</strong> : j.displayName}
                  <br /><Caption1>{j.webserverUrl ? 'connected' : 'not configured'}</Caption1>
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
              <Tab value="dags" icon={<FlowchartCircle20Regular />}>DAGs</Tab>
              <Tab value="runs" icon={<History20Regular />}>Runs</Tab>
              <Tab value="connections" icon={<PlugConnected20Regular />}>Connections</Tab>
              <Tab value="settings" icon={<Settings20Regular />}>Settings</Tab>
            </TabList>
          </div>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">ApacheAirflowJob</Badge>
              <Badge appearance="outline" color="warning">Preview</Badge>
              <div className={s.field}>
                <Caption1>Workspace</Caption1>
                <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={(workspaces?.length ?? 0) === 0}>
                  {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
                  {(workspaces || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </div>
              <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New job</Button>
                </DialogTrigger>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Create Airflow job</DialogTitle>
                    <DialogContent>
                      <Field label="Display name" required><Input value={cName} onChange={(_, d) => setCName(d.value)} /></Field>
                      <Field label="Description"><Textarea value={cDesc} onChange={(_, d) => setCDesc(d.value)} /></Field>
                      <Field label="Airflow webserver URL (optional now, required for DAG listing)" hint="e.g. https://airflow.contoso.com">
                        <Input value={cUrl} onChange={(_, d) => setCUrl(d.value)} />
                      </Field>
                      <Field label="Git repo (optional)" hint="DAG source repo URL">
                        <Input value={cGit} onChange={(_, d) => setCGit(d.value)} placeholder="https://dev.azure.com/.../_git/dags" />
                      </Field>
                      {cErr && <MessageBar intent="error"><MessageBarBody>{cErr}</MessageBarBody></MessageBar>}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                      <Button appearance="primary" disabled={cBusy || !cName.trim()} onClick={create}>{cBusy ? 'Creating…' : 'Create'}</Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>
              <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!workspaceId || !jobId} onClick={() => workspaceId && jobId && loadDags(workspaceId, jobId)}>Refresh DAGs</Button>
            </div>

            {tab === 'dags' && (
              <>
                {!jobId && (
                  <EmptyState
                    icon={<FlowchartCircle20Regular />}
                    title="No job selected"
                    body="Pick an Airflow job from the left panel to list its DAGs, or create a new one."
                    primaryAction={workspaceId ? { label: 'New job', onClick: () => setCreateOpen(true) } : undefined}
                  />
                )}
                {jobId && !active?.webserverUrl && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>Connect an Airflow webserver</MessageBarTitle>
                      No webserver URL is configured for this job. Open the <strong>Settings</strong> tab and paste the Airflow webserver URL (e.g. <code>https://airflow.contoso.com</code>).
                      See <a href="/docs/fiab/v3-tenant-bootstrap.md">docs/fiab/v3-tenant-bootstrap.md</a> for the AAD ingress + bearer-token bootstrap.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {jobId && active?.webserverUrl && dags === null && (
                  <>
                    <Spinner size="small" label="Calling Airflow REST…" labelPosition="after" />
                    <TableSkeleton rows={4} />
                  </>
                )}
                {dagsErr && (
                  <MessageBar intent={dagsErr.code === 'NO_WEBSERVER' ? 'warning' : 'error'}>
                    <MessageBarBody>
                      <MessageBarTitle>{dagsErr.code === 'NO_WEBSERVER' ? 'Webserver not configured' : 'Airflow error'}</MessageBarTitle>
                      {dagsErr.error}
                      {dagsErr.hint && <><br /><Caption1>{dagsErr.hint}</Caption1></>}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {dags && dags.length === 0 && !dagsErr && (
                  <EmptyState
                    icon={<FlowchartCircle20Regular />}
                    title="No DAGs on this webserver"
                    body="The Airflow webserver responded with no DAGs. Sync your DAG source repo or refresh once DAGs are deployed."
                    primaryAction={{ label: 'Refresh DAGs', onClick: () => workspaceId && jobId && loadDags(workspaceId, jobId) }}
                  />
                )}
                {actionMsg && (
                  <MessageBar intent={actionMsg.intent}><MessageBarBody>{actionMsg.text}</MessageBarBody></MessageBar>
                )}
                {dags && dags.length > 0 && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Airflow DAGs" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>DAG id</TableHeaderCell>
                        <TableHeaderCell>Active</TableHeaderCell>
                        <TableHeaderCell>Paused</TableHeaderCell>
                        <TableHeaderCell>Schedule</TableHeaderCell>
                        <TableHeaderCell>Next run</TableHeaderCell>
                        <TableHeaderCell>Owners</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {dags.map(d => (
                          <TableRow key={d.dag_id}>
                            <TableCell className={s.cell}>{d.dag_id}</TableCell>
                            <TableCell>{d.is_active ? '✓' : '—'}</TableCell>
                            <TableCell>{d.is_paused ? '⏸' : '▶'}</TableCell>
                            <TableCell className={s.cell}>{d.schedule_interval || '—'}</TableCell>
                            <TableCell className={s.cell}>{d.next_dagrun?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                            <TableCell>{(d.owners || []).join(', ') || '—'}</TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }}>
                                <Button size="small" appearance="primary" icon={<Play16Filled />}
                                  disabled={busyDag === d.dag_id} onClick={() => triggerRun(d.dag_id)}>
                                  {busyDag === d.dag_id ? '…' : 'Trigger'}
                                </Button>
                                <Button size="small" appearance="outline"
                                  icon={d.is_paused ? <Play16Regular /> : <Pause16Regular />}
                                  disabled={busyDag === d.dag_id} onClick={() => togglePause(d.dag_id, !d.is_paused)}>
                                  {d.is_paused ? 'Unpause' : 'Pause'}
                                </Button>
                              </div>
                            </TableCell>
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
                {!active && (
                  <EmptyState
                    icon={<History20Regular />}
                    title="No job selected"
                    body="Select an Airflow job from the left panel to browse its DAG run history."
                  />
                )}
                {active && (
                  <>
                    <div className={s.runsPickerRow}>
                      <Field label="DAG" className={s.runsDagField}>
                        <Select value={runsDagId} onChange={(_, d) => setRunsDagId(d.value)} disabled={!dags || !dags.length}>
                          {(dags || []).map((d) => <option key={d.dag_id} value={d.dag_id}>{d.dag_id}</option>)}
                          {dags && !dags.length && <option value="">No DAGs found</option>}
                        </Select>
                      </Field>
                      <Button appearance="secondary" disabled={!runsDagId || runsLoading}
                        onClick={() => runsDagId && loadRuns(workspaceId, jobId, runsDagId)}>
                        {runsLoading ? 'Refreshing…' : 'Refresh'}
                      </Button>
                    </div>
                    {runsErr && (
                      <MessageBar intent={runsErr.code === 'NO_WEBSERVER' ? 'warning' : 'error'}>
                        <MessageBarBody>
                          <MessageBarTitle>{runsErr.code === 'NO_WEBSERVER' ? 'Webserver not configured' : 'Could not load runs'}</MessageBarTitle>
                          {runsErr.error}{runsErr.hint ? ` — ${runsErr.hint}` : ''}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {runs === null && runsLoading && (
                      <>
                        <Spinner size="small" label="Loading runs…" />
                        <TableSkeleton rows={4} />
                      </>
                    )}
                    {runs && !runs.length && !runsErr && (
                      <EmptyState
                        icon={<History20Regular />}
                        title="No runs yet for this DAG"
                        body="This DAG has no run history yet. Trigger a run from the Airflow webserver, then refresh."
                        primaryAction={{ label: 'Refresh', onClick: () => runsDagId && loadRuns(workspaceId, jobId, runsDagId) }}
                      />
                    )}
                    {runs && runs.length > 0 && (
                      <div className={s.tableWrap}>
                        <Table size="small">
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>State</TableHeaderCell>
                              <TableHeaderCell>Run ID</TableHeaderCell>
                              <TableHeaderCell>Type</TableHeaderCell>
                              <TableHeaderCell>Started</TableHeaderCell>
                              <TableHeaderCell>Ended</TableHeaderCell>
                              <TableHeaderCell>Tasks</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {runs.map((r) => (
                              <TableRow key={r.dag_run_id}>
                                <TableCell>
                                  <Badge appearance="filled" color={
                                    r.state === 'success' ? 'success'
                                      : r.state === 'failed' ? 'danger'
                                      : r.state === 'running' ? 'brand'
                                      : 'informative'
                                  }>{r.state || 'unknown'}</Badge>
                                </TableCell>
                                <TableCell>{r.dag_run_id}</TableCell>
                                <TableCell>{r.run_type || '—'}</TableCell>
                                <TableCell>{r.start_date?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                                <TableCell>{r.end_date?.replace('T', ' ').replace(/\..*/, '') || '—'}</TableCell>
                                <TableCell>
                                  <Button size="small" appearance="outline" icon={<DocumentText16Regular />} onClick={() => openLogs(r)}>
                                    Tasks &amp; logs
                                  </Button>
                                </TableCell>
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

            {tab === 'connections' && (
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Airflow connections</MessageBarTitle>
                  Connections (HTTP, AWS, Azure, etc.) are an Airflow-native construct, managed in the Airflow webserver Admin UI. Open <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{active?.webserverUrl || '(configure URL)'}/connection/list/</code> with the webserver admin role to add or edit them.
                </MessageBarBody>
              </MessageBar>
            )}

            {tab === 'settings' && (
              <>
                {!active && (
                  <EmptyState
                    icon={<Settings20Regular />}
                    title="No job selected"
                    body="Select an Airflow job from the left panel to configure its webserver URL and DAG source repo."
                  />
                )}
                {active && (
                  <>
                    <Field label="Airflow webserver URL" required hint="The URL the BFF will hit /api/v1/dags against.">
                      <Input value={editUrl} onChange={(_, d) => setEditUrl(d.value)} placeholder="https://airflow.contoso.com" />
                    </Field>
                    <Field label="Git repo (DAG source)" hint="Optional. Used by the DAG sync worker (preview).">
                      <Input value={editGit} onChange={(_, d) => setEditGit(d.value)} placeholder="https://dev.azure.com/.../_git/dags" />
                    </Field>
                    {settingsErr && <MessageBar intent="error"><MessageBarBody>{settingsErr}</MessageBarBody></MessageBar>}
                    {settingsMsg && <MessageBar intent="success"><MessageBarBody>{settingsMsg}</MessageBarBody></MessageBar>}
                    <Button appearance="primary" icon={<Save20Regular />} disabled={settingsBusy || !editUrl.trim()} onClick={saveConnection}>
                      {settingsBusy ? 'Saving…' : 'Save connection'}
                    </Button>
                  </>
                )}
              </>
            )}

            <Dialog open={logsOpen} onOpenChange={(_, d) => setLogsOpen(d.open)}>
              <DialogSurface style={{ maxWidth: '90vw', width: 820 }}>
                <DialogBody>
                  <DialogTitle>Run {logsRun?.dag_run_id} — task instances &amp; logs</DialogTitle>
                  <DialogContent>
                    {logsErr && <MessageBar intent="error"><MessageBarBody>{logsErr}</MessageBarBody></MessageBar>}
                    {!logsErr && logsTasks === null && <Spinner size="tiny" label="Loading task instances…" />}
                    {logsTasks && logsTasks.length === 0 && !logsErr && <Caption1>No task instances for this run.</Caption1>}
                    {logsTasks && logsTasks.length > 0 && (
                      <Table size="small" aria-label="Task instances">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Task</TableHeaderCell>
                          <TableHeaderCell>State</TableHeaderCell>
                          <TableHeaderCell>Operator</TableHeaderCell>
                          <TableHeaderCell>Log</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {logsTasks.map((t: any) => (
                            <TableRow key={t.task_id}>
                              <TableCell className={s.cell}>{t.task_id}</TableCell>
                              <TableCell>
                                <Badge appearance="filled" color={
                                  t.state === 'success' ? 'success' : t.state === 'failed' ? 'danger' : t.state === 'running' ? 'brand' : 'informative'
                                }>{t.state || 'none'}</Badge>
                              </TableCell>
                              <TableCell className={s.cell}>{t.operator || '—'}</TableCell>
                              <TableCell>
                                <Button size="small" appearance="outline" onClick={() => fetchTaskLog(t.task_id, t.try_number)}>View</Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                    {logTaskId && (
                      <>
                        <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS }}>Log — {logTaskId}</Caption1>
                        <div style={{
                          fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
                          overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`,
                          borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingHorizontalS, background: tokens.colorNeutralBackground3,
                        }}>{logText ?? 'Loading…'}</div>
                      </>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setLogsOpen(false)}>Close</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
        </>
      }
    />
  );
}
