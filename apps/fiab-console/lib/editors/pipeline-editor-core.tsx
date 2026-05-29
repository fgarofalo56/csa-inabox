'use client';

/**
 * Shared core for the ADF + Synapse pipeline editors (the Integrate experience).
 *
 * This fixes the confirmed 404 binding bug: a Loom pipeline item is a Cosmos
 * GUID, NOT an Azure pipeline name. The editor first resolves the item's
 * BINDING (state.pipelineName) via `/api/items/<slug>/<id>/bind`. When unbound,
 * it shows a picker — bind to an existing factory/workspace pipeline OR create
 * a new one — while still rendering the full editor surface (graph/JSON/runs/
 * triggers). All per-item operations target the GUID route; the BFF resolves
 * the bound pipeline name server-side.
 *
 * Both families share this component; only the slug, activity palette, and the
 * Validate affordance (ADF only) differ.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Field,
  Tab, TabList, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DocumentTable20Regular, Play20Regular, Server20Regular,
  ArrowSync20Regular, Save20Regular, Bug20Regular, Checkmark20Regular,
  Clock20Regular, Link20Regular, Add20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import { extractActivities, writeActivitiesToSpec, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import { PipelineDesigner } from '@/lib/components/pipeline/pipeline-designer';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { safePipelineJson } from './pipeline-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  gate: { padding: 16, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720 },
  row: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 4 },
});

export interface ActivityTemplate {
  label: string;
  build: (name: string) => PipelineActivity;
  prefix: string;
}

export interface PipelineEditorConfig {
  /** API slug: 'adf-pipeline' | 'synapse-pipeline'. */
  slug: string;
  /** Human label for the bound resource container. */
  containerLabel: string;   // "factory" | "workspace"
  /** Activity palette templates for the ribbon. */
  palette: ActivityTemplate[];
  /** ADF exposes a Validate action; Synapse doesn't. */
  supportsValidate: boolean;
}

interface PipelineRunDTO {
  runId: string;
  pipelineName: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
  invokedBy?: { name?: string; invokedByType?: string };
}

export function PipelineEditorCore({
  item, id, config,
}: { item: FabricItemType; id: string; config: PipelineEditorConfig }) {
  const s = useStyles();
  const apiBase = `/api/items/${config.slug}/${encodeURIComponent(id)}`;

  // ---- Binding state ----
  const [bindingLoading, setBindingLoading] = useState(true);
  const [bound, setBound] = useState<string | null>(null);
  const [available, setAvailable] = useState<Array<{ name: string }>>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [pickName, setPickName] = useState<string>('');     // bind-to-existing selection
  const [newName, setNewName] = useState<string>('');       // create-new input
  const [bindBusy, setBindBusy] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  // ---- Spec / run state ----
  const [spec, setSpec] = useState<string>('');
  const [origSpec, setOrigSpec] = useState<string>('');
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'graph' | 'json' | 'runs'>('graph');
  const [validation, setValidation] = useState<{ ok: boolean; message: string } | null>(null);

  const [runsAfterDays, setRunsAfterDays] = useState<number>(7);
  const [runsStatus, setRunsStatus] = useState<string>('');

  // ---- Triggers dialog state ----
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [triggersList, setTriggersList] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  const [triggersBusy, setTriggersBusy] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [newTriggerName, setNewTriggerName] = useState('');
  const [newTriggerHour, setNewTriggerHour] = useState(0);
  const [newTriggerMinute, setNewTriggerMinute] = useState(0);

  // ------------------------------------------------------------------
  // Binding
  // ------------------------------------------------------------------
  const loadBinding = useCallback(async () => {
    setBindingLoading(true); setBindError(null);
    try {
      const res = await fetch(`${apiBase}/bind`);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setBindError(e || 'failed to load binding'); return; }
      setBound(data.bound ?? null);
      setAvailable(Array.isArray(data.pipelines) ? data.pipelines : []);
      setListError(data.listError || null);
      if (data.bound && !pickName) setPickName(data.bound);
    } catch (e: any) {
      setBindError(e?.message || String(e));
    } finally {
      setBindingLoading(false);
    }
  }, [apiBase, pickName]);

  useEffect(() => { loadBinding(); }, [loadBinding]);

  const bindTo = useCallback(async (name: string, create: boolean) => {
    if (!name.trim()) return;
    setBindBusy(true); setBindError(null);
    try {
      const res = await fetch(`${apiBase}/bind`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pipelineName: name.trim(), create }),
      });
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setBindError(e || 'bind failed'); return; }
      setBound(data.bound);
      setNewName('');
      await loadBinding();
    } catch (e: any) {
      setBindError(e?.message || String(e));
    } finally {
      setBindBusy(false);
    }
  }, [apiBase, loadBinding]);

  // ------------------------------------------------------------------
  // Spec + runs (only meaningful once bound; routes 412 otherwise)
  // ------------------------------------------------------------------
  const loadPipeline = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(apiBase);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) {
        if (data?.code === 'unbound') return; // gate handles it
        setError(e || 'get failed'); return;
      }
      const txt = JSON.stringify(data.pipeline, null, 2);
      setSpec(txt); setOrigSpec(txt);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [apiBase]);

  const loadRuns = useCallback(async () => {
    try {
      const after = new Date(Date.now() - runsAfterDays * 24 * 60 * 60 * 1000).toISOString();
      const qs = new URLSearchParams({ after });
      if (runsStatus) qs.set('status', runsStatus);
      const res = await fetch(`${apiBase}/runs?${qs.toString()}`);
      const { ok, data } = await safePipelineJson(res);
      if (!ok || !data) { setRuns([]); return; }
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch { setRuns([]); }
  }, [apiBase, runsAfterDays, runsStatus]);

  useEffect(() => {
    if (bound) { loadPipeline(); loadRuns(); }
  }, [bound, loadPipeline, loadRuns]);

  const save = useCallback(async () => {
    if (!bound) return;
    setBusy(true); setError(null);
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      const parsed = JSON.parse(spec);
      const res = await fetch(apiBase, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || 'save failed');
      setOrigSpec(spec);
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: bound } })); } catch {}
      void data;
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [apiBase, bound, spec]);

  const dirty = spec !== origSpec;

  const kick = useCallback(async (action: 'run' | 'debug') => {
    if (!bound) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${apiBase}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || `${action} failed`);
      setTimeout(() => loadRuns(), 1500);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [apiBase, bound, loadRuns]);

  const validate = useCallback(async () => {
    if (!bound) return;
    setBusy(true); setError(null); setValidation(null);
    try {
      let parsed: any = undefined;
      try { parsed = JSON.parse(spec); } catch { /* validate persisted */ }
      const res = await fetch(`${apiBase}/validate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed ? { definition: parsed } : {}),
      });
      const { data } = await safePipelineJson(res);
      if (!data || data.ok === false) { setValidation({ ok: false, message: data?.error || 'validation failed' }); return; }
      const n = data.validation?.activities?.length ?? 0;
      setValidation({ ok: true, message: `Validation passed — accepts ${n} activit${n === 1 ? 'y' : 'ies'}.` });
    } catch (e: any) { setValidation({ ok: false, message: e?.message || String(e) }); }
    finally { setBusy(false); }
  }, [apiBase, bound, spec]);

  // ------------------------------------------------------------------
  // Triggers
  // ------------------------------------------------------------------
  const loadTriggers = useCallback(async () => {
    setTriggersError(null);
    try {
      const res = await fetch(`${apiBase}/triggers`);
      const { ok, data, error: e } = await safePipelineJson(res);
      if (!ok || !data) { setTriggersList([]); setTriggersError(e || 'list triggers failed'); return; }
      setTriggersList((data.triggers || []).map((t: any) => ({
        name: t.name,
        type: t.properties?.type || t.type,
        runtimeState: t.properties?.runtimeState || t.runtimeState,
      })));
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
  }, [apiBase]);

  const openTriggers = useCallback(() => { setTriggersOpen(true); if (bound) loadTriggers(); }, [bound, loadTriggers]);

  const triggerAction = useCallback(async (name: string, action: 'start' | 'stop' | 'delete') => {
    setTriggersBusy(true); setTriggersError(null);
    try {
      const res = await fetch(`${apiBase}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || `${action} failed`);
      await loadTriggers();
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [apiBase, loadTriggers]);

  const createTrigger = useCallback(async () => {
    if (!newTriggerName.trim()) return;
    setTriggersBusy(true); setTriggersError(null);
    try {
      const now = new Date(); now.setUTCSeconds(0, 0);
      const res = await fetch(`${apiBase}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newTriggerName.trim(),
          properties: {
            type: 'ScheduleTrigger',
            runtimeState: 'Stopped',
            typeProperties: {
              recurrence: {
                frequency: 'Day', interval: 1, startTime: now.toISOString(), timeZone: 'UTC',
                schedule: { hours: [newTriggerHour], minutes: [newTriggerMinute] },
              },
            },
          },
        }),
      });
      const { ok, error: e } = await safePipelineJson(res);
      if (!ok) throw new Error(e || 'create failed');
      setNewTriggerName('');
      await loadTriggers();
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [apiBase, newTriggerName, newTriggerHour, newTriggerMinute, loadTriggers]);

  // ------------------------------------------------------------------
  // Activity palette
  // ------------------------------------------------------------------
  const activities = extractActivities(spec);
  const activityCount = activities.length;

  const nextActivityName = useCallback((prefix: string): string => {
    let max = 0;
    for (const a of activities) {
      const name = a.name || '';
      if (!name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length);
      if (!/^\d+$/.test(tail)) continue;
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${max + 1}`;
  }, [activities]);

  const addActivity = useCallback((activity: PipelineActivity) => {
    setSpec((prev) => {
      let parsed: any;
      try { parsed = JSON.parse(prev || '{"properties":{}}'); } catch { return prev; }
      if (!parsed.properties || typeof parsed.properties !== 'object') parsed.properties = {};
      if (!Array.isArray(parsed.properties.activities)) parsed.properties.activities = [];
      parsed.properties.activities.push(activity);
      return JSON.stringify(parsed, null, 2);
    });
  }, []);

  // Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (bound && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bound, dirty, busy, save]);

  const ribbon: RibbonTab[] = useMemo(() => {
    const validateGroup: RibbonTab['groups'] = config.supportsValidate ? [{
      label: 'Validate', actions: [
        { label: busy ? 'Validating…' : 'Validate', onClick: !busy && bound ? validate : undefined, disabled: busy || !bound, title: !bound ? 'Bind a pipeline first' : undefined },
      ],
    }] : [];
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'Activities', actions: config.palette.map((t) => ({
          label: t.label,
          onClick: bound ? () => addActivity(t.build(nextActivityName(t.prefix))) : undefined,
          disabled: !bound,
          title: !bound ? 'Bind a pipeline first' : undefined,
        })) },
        ...validateGroup,
        { label: 'Run', actions: [
          { label: busy ? 'Running…' : 'Run', icon: <Play20Regular />, onClick: !busy && bound && !dirty ? () => kick('run') : undefined, disabled: busy || !bound || dirty, title: dirty ? 'Save the spec first' : (!bound ? 'Bind a pipeline first' : undefined) },
          { label: busy ? 'Debugging…' : 'Debug', onClick: !busy && bound && !dirty ? () => kick('debug') : undefined, disabled: busy || !bound || dirty, title: dirty ? 'Save the spec first' : (!bound ? 'Bind a pipeline first' : undefined) },
          { label: 'Triggers', onClick: bound ? openTriggers : undefined, disabled: !bound, title: !bound ? 'Bind a pipeline first' : undefined },
        ] },
      ] },
    ];
  }, [config.palette, config.supportsValidate, addActivity, nextActivityName, busy, bound, dirty, kick, validate, openTriggers]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  const bindGate = (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>This pipeline isn’t bound to a real Azure pipeline yet</MessageBarTitle>
        A Loom pipeline item is a handle — bind it to an existing {config.containerLabel} pipeline, or create a
        new one. Every action below (Run, Debug, Validate, Triggers, Save) targets the bound pipeline.
        {listError && (<><br /><strong>Listing pipelines failed:</strong> {listError}</>)}
      </MessageBarBody>
    </MessageBar>
  );

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="Pipelines" defaultOpenItems={['p']}>
            <TreeItem itemType="branch" value="p">
              <TreeItemLayout iconBefore={<Server20Regular />}>Pipelines ({available.length})</TreeItemLayout>
              <Tree>
                {available.map((p) => (
                  <TreeItem key={p.name} itemType="leaf" value={`pl-${p.name}`} onClick={() => bindTo(p.name, false)}>
                    <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{p.name} {bound === p.name && '·'}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
          <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
            Click a pipeline to bind this item to it.
          </Caption1>
        </div>
      }
      main={
        <div className={s.pad}>
          {bindingLoading ? (
            <div className={s.gate}><Spinner label="Resolving pipeline binding…" /></div>
          ) : !bound ? (
            <div className={s.gate}>
              {bindGate}
              <div>
                <Subtitle2>Bind to an existing pipeline</Subtitle2>
                <div className={s.row} style={{ marginTop: 8 }}>
                  <div className={s.field}>
                    <Field label={`Pipeline in this ${config.containerLabel}`}>
                      <Dropdown
                        placeholder={available.length ? 'Select a pipeline' : 'No pipelines found'}
                        value={pickName}
                        selectedOptions={pickName ? [pickName] : []}
                        onOptionSelect={(_, d) => setPickName(d.optionValue || '')}
                        disabled={!available.length || bindBusy}
                      >
                        {available.map((p) => (<Option key={p.name} value={p.name} text={p.name}>{p.name}</Option>))}
                      </Dropdown>
                    </Field>
                  </div>
                  <Button appearance="primary" icon={<Link20Regular />} disabled={!pickName || bindBusy} onClick={() => bindTo(pickName, false)}>
                    {bindBusy ? 'Binding…' : 'Bind'}
                  </Button>
                </div>
              </div>
              <div>
                <Subtitle2>Create a new pipeline</Subtitle2>
                <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                  Creates an empty pipeline in the {config.containerLabel} via the real REST API and binds this item to it.
                </Body1>
                <div className={s.row} style={{ marginTop: 8 }}>
                  <div className={s.field}>
                    <Field label="New pipeline name">
                      <Input value={newName} onChange={(_, d) => setNewName(d.value)} placeholder="ingest_orders" />
                    </Field>
                  </div>
                  <Button appearance="secondary" icon={<Add20Regular />} disabled={!newName.trim() || bindBusy} onClick={() => bindTo(newName, true)}>
                    {bindBusy ? 'Creating…' : 'Create & bind'}
                  </Button>
                </div>
              </div>
              {bindError && (
                <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Bind failed</MessageBarTitle>{bindError}</MessageBarBody></MessageBar>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge appearance="filled" color="brand">{bound}</Badge>
                <Badge appearance="outline">{activityCount} activities</Badge>
                {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
                {validation && <Badge appearance="filled" color={validation.ok ? 'success' : 'danger'}>{validation.ok ? 'Validated' : 'Invalid'}</Badge>}
                <Button appearance="outline" icon={<Save20Regular />} disabled={busy || !dirty} onClick={save}>Save</Button>
                {config.supportsValidate && (
                  <Button appearance="outline" icon={<Checkmark20Regular />} disabled={busy} onClick={validate}>Validate</Button>
                )}
                <Button appearance="primary" icon={<Play20Regular />} disabled={busy || dirty} onClick={() => kick('run')}>Run</Button>
                <Button appearance="outline" icon={<Bug20Regular />} disabled={busy || dirty} onClick={() => kick('debug')}>Debug</Button>
                <Button appearance="outline" icon={<Clock20Regular />} onClick={openTriggers}>Triggers</Button>
                <Button appearance="subtle" icon={<Link20Regular />} onClick={() => { setBound(null); loadBinding(); }}>Rebind</Button>
                <Button appearance="outline" onClick={() => { loadPipeline(); loadRuns(); }} style={{ marginLeft: 'auto' }}>Refresh</Button>
              </div>
              {error && (<BackendStateBar error={error} title="Pipeline API" />)}
              {validation && (
                <MessageBar intent={validation.ok ? 'success' : 'error'}><MessageBarBody>{validation.message}</MessageBarBody></MessageBar>
              )}
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'graph' | 'json' | 'runs')}>
                  <Tab value="graph">Graph ({activityCount} act{activityCount === 1 ? '' : 's'})</Tab>
                  <Tab value="json">Spec (JSON)</Tab>
                  <Tab value="runs">Run history ({runs.length})</Tab>
                </TabList>
              </div>
              {tab === 'graph' && (
                <PipelineDesigner
                  activities={activities as any}
                  onActivitiesChange={(next) => setSpec((prev) => writeActivitiesToSpec(prev || '{"properties":{}}', next as any))}
                />
              )}
              {tab === 'json' && (
                <MonacoTextarea value={spec} onChange={setSpec} language="json" height={400} minHeight={320} ariaLabel="Pipeline spec editor" />
              )}
              {tab === 'runs' && (
                <div style={{ overflow: 'auto' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 8 }}>
                    <Field label="Window">
                      <Dropdown
                        value={runsAfterDays === 1 ? 'Last 24 hours' : runsAfterDays === 14 ? 'Last 14 days' : runsAfterDays === 30 ? 'Last 30 days' : 'Last 7 days'}
                        selectedOptions={[String(runsAfterDays)]}
                        onOptionSelect={(_, d) => d.optionValue && setRunsAfterDays(Number(d.optionValue) || 7)}
                      >
                        <Option value="1" text="Last 24 hours">Last 24 hours</Option>
                        <Option value="7" text="Last 7 days">Last 7 days</Option>
                        <Option value="14" text="Last 14 days">Last 14 days</Option>
                        <Option value="30" text="Last 30 days">Last 30 days</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Status">
                      <Dropdown value={runsStatus || 'Any'} selectedOptions={[runsStatus]} onOptionSelect={(_, d) => setRunsStatus(d.optionValue || '')}>
                        <Option value="" text="Any">Any</Option>
                        <Option value="Succeeded" text="Succeeded">Succeeded</Option>
                        <Option value="Failed" text="Failed">Failed</Option>
                        <Option value="InProgress" text="In progress">In progress</Option>
                        <Option value="Cancelled" text="Cancelled">Cancelled</Option>
                        <Option value="Queued" text="Queued">Queued</Option>
                      </Dropdown>
                    </Field>
                    <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => loadRuns()}>Apply filter</Button>
                  </div>
                  <Table aria-label="Pipeline runs" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Run ID</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Start</TableHeaderCell>
                      <TableHeaderCell>Duration</TableHeaderCell>
                      <TableHeaderCell>Invoked by</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {runs.length === 0 && (<TableRow><TableCell colSpan={5}><Caption1>No runs in window.</Caption1></TableCell></TableRow>)}
                      {runs.map((r) => (
                        <TableRow key={r.runId}>
                          <TableCell><code style={{ fontSize: 11 }}>{r.runId.slice(0, 8)}…</code></TableCell>
                          <TableCell><Badge appearance="filled" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : r.status === 'InProgress' ? 'warning' : 'informative'}>{r.status || '—'}</Badge></TableCell>
                          <TableCell>{r.runStart ? new Date(r.runStart).toLocaleString() : '—'}</TableCell>
                          <TableCell>{r.durationInMs != null ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                          <TableCell>{r.invokedBy?.name || '—'} <Caption1>({r.invokedBy?.invokedByType || '—'})</Caption1></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <Dialog open={triggersOpen} onOpenChange={(_, d) => setTriggersOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '760px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Triggers — {bound}</DialogTitle>
                <DialogContent>
                  <Caption1>Schedule triggers that fire this pipeline. Start/stop or create a daily schedule trigger inline (real REST).</Caption1>
                  <div style={{ overflow: 'auto', marginTop: 8, marginBottom: 12 }}>
                    <Table aria-label="Triggers for pipeline" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {triggersList.length === 0 && (<TableRow><TableCell colSpan={4}><Caption1>No triggers wired to this pipeline.</Caption1></TableCell></TableRow>)}
                        {triggersList.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell><strong>{t.name}</strong></TableCell>
                            <TableCell><code>{t.type || '—'}</code></TableCell>
                            <TableCell><Badge appearance="filled" color={t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning'}>{t.runtimeState || '—'}</Badge></TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <Button size="small" disabled={triggersBusy || t.runtimeState === 'Started'} onClick={() => triggerAction(t.name, 'start')}>Start</Button>
                                <Button size="small" disabled={triggersBusy || t.runtimeState !== 'Started'} onClick={() => triggerAction(t.name, 'stop')}>Stop</Button>
                                <Button size="small" appearance="subtle" disabled={triggersBusy} onClick={() => triggerAction(t.name, 'delete')}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <Subtitle2>Create new daily schedule trigger</Subtitle2>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginTop: 8 }}>
                    <Field label="Name"><Input value={newTriggerName} onChange={(_, d) => setNewTriggerName(d.value)} placeholder="daily-orders" /></Field>
                    <Field label="UTC hour (0-23)"><Input type="number" min={0} max={23} value={String(newTriggerHour)} onChange={(_, d) => setNewTriggerHour(Math.max(0, Math.min(23, Number(d.value) || 0)))} /></Field>
                    <Field label="Minute (0-59)"><Input type="number" min={0} max={59} value={String(newTriggerMinute)} onChange={(_, d) => setNewTriggerMinute(Math.max(0, Math.min(59, Number(d.value) || 0)))} /></Field>
                  </div>
                  {triggersError && (<MessageBar intent="error" style={{ marginTop: 12 }}><MessageBarBody><MessageBarTitle>Trigger action failed</MessageBarTitle>{triggersError}</MessageBarBody></MessageBar>)}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setTriggersOpen(false)} disabled={triggersBusy}>Close</Button>
                  <Button appearance="primary" onClick={createTrigger} disabled={triggersBusy || !newTriggerName.trim()}>{triggersBusy ? 'Working…' : 'Create trigger'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
