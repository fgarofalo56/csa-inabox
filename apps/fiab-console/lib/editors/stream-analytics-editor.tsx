'use client';

/**
 * StreamAnalyticsJobEditor — Azure Stream Analytics (ASA) job authoring.
 *
 * Replaces the prior UsqlJobEditor (ADLA is retired). ASA is the actual
 * Azure-native streaming-analytics surface — continuous SQL-style queries
 * over Event Hubs / IoT Hub / Blob inputs, writing to Blob / Azure SQL /
 * Power BI / Event Hub / ADX / Cosmos outputs.
 *
 * Scope of this editor (per parity-validation-standard memory):
 *   - List ASA jobs via ARM (subscription-scoped via UAMI)
 *   - Show job state (Starting/Started/Stopping/Stopped) + last output time
 *   - Edit the streaming query (Stream Analytics Query Language — SQL-like)
 *   - Inputs / outputs / functions listed live from ARM ($expand); the
 *     stream-analytics-client also exposes createOrUpdateInput/Output for
 *     full CRUD wiring
 *   - Start / Stop the job
 *
 * Honest gating:
 *   - If no ASA job(s) exist in the configured scope, MessageBar shows the
 *     bicep module + env vars needed (LOOM_ASA_RG, LOOM_ASA_SUB).
 *   - Query persists to ARM via PUT /streamingjobs/{name}/transformations.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Field, Input, Divider,
  Tab, TabList, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Select,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Pause20Regular, ArrowSync20Regular, Save20Regular, Beaker20Regular, Add20Regular, Delete20Regular,
  Code20Regular, ArrowImport20Regular, ArrowExportLtr20Regular, MathFormula20Regular,
  ChartMultiple20Regular, Flow20Regular, DataUsage20Regular, Filter20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { AsaTransformInspector } from '@/lib/components/eventstream/visual-designer';
import { compileToSaql, type TransformNode, type SourceNode, type SinkNode } from '@/lib/azure/asa-query-compiler';
import { MetricChart } from '@/lib/components/monitor/metric-chart';

// (Ribbon defined inside StreamAnalyticsJobEditor via useMemo so onClick handlers
// can reference inline setState / save / loadList / setTab state.)

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  queryArea: {
    width: '100%', minHeight: '360px',
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300, padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4 },
  // Icon + heading row used by section/tab headers so each pane reads as the
  // same polished product (matches sibling editors' section affordance).
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    color: tokens.colorBrandForeground1,
  },
  // Job-summary block: an elevated card (shadow4 → shadow16 on hover) with a
  // large radius so the monitoring summary isn't a flat bare div.
  summaryCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease-in-out',
    ':hover': { boxShadow: tokens.shadow16 },
  },
});

interface AsaJob {
  name: string;
  id: string;
  location: string;
  state?: string;
  jobState?: string;
  sku?: string;
  streamingUnits?: number;
  lastOutputEventTime?: string;
  inputs?: AsaInput[];
  outputs?: AsaOutput[];
  functions?: AsaFunction[];
  query?: string;
}
interface AsaInput { name: string; type: string; serialization?: string; }
interface AsaOutput { name: string; type: string; }
interface AsaFunction { name: string; type?: string; binding?: string; }

interface AsaMetricSeries {
  name: string;
  unit?: string;
  aggregation?: string;
  points: { timeStamp: string; value: number | null }[];
}

// REST metric name → display label + tile unit. Mirrors the Azure Monitor
// supported-metrics catalog for Microsoft.StreamAnalytics/streamingjobs and
// the METRIC_CATALOG entry in monitor-client.ts.
const METRIC_META: Record<string, { label: string; unit: string }> = {
  ResourceUtilization: { label: 'SU % Utilization', unit: '%' },
  OutputWatermarkDelaySeconds: { label: 'Watermark Delay', unit: 's' },
  InputEventsSourcesBacklogged: { label: 'Backlogged Events', unit: '' },
  InputEvents: { label: 'Input Events', unit: '' },
  OutputEvents: { label: 'Output Events', unit: '' },
};
function metricLabel(name: string) { return METRIC_META[name]?.label || name; }
function metricUnit(name: string) { return METRIC_META[name]?.unit ?? ''; }

const STARTER_QUERY = `-- Stream Analytics Query (SAQL — SQL-like over time-windowed streams)
-- Tumbling-window average per device, every 30 seconds.

SELECT
  deviceId,
  System.Timestamp() AS windowEnd,
  AVG(temperature) AS avgTemp,
  COUNT(*) AS sampleCount
INTO [output-blob]
FROM [input-eventhub] TIMESTAMP BY eventTime
GROUP BY deviceId, TumblingWindow(second, 30)
HAVING AVG(temperature) > 30
`;

export function StreamAnalyticsJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [jobs, setJobs] = useState<AsaJob[] | null>(null);
  const [selected, setSelected] = useState<string>(id !== 'new' ? id : '');
  const [tab, setTab] = useState<'query' | 'builder' | 'test' | 'inputs' | 'outputs' | 'functions' | 'monitoring'>('query');
  const [job, setJob] = useState<AsaJob | null>(null);
  const [query, setQuery] = useState(STARTER_QUERY);
  const [origQuery, setOrigQuery] = useState(STARTER_QUERY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // ── Transform builder (guided) state ──────────────────────────────
  const [builderSource, setBuilderSource] = useState('input');
  const [builderSink, setBuilderSink] = useState('output');
  const [builderTransform, setBuilderTransform] = useState<TransformNode>({
    kind: 'filter', name: 'transform-1', expression: '',
  });
  // ── Test-with-sample-data state ───────────────────────────────────
  const [sampleText, setSampleText] = useState(
    '[\n  { "deviceId": "sensor-A", "temperature": 42, "eventTime": "2026-06-07T00:00:00Z" },\n  { "deviceId": "sensor-B", "temperature": 18, "eventTime": "2026-06-07T00:00:05Z" }\n]',
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testHint, setTestHint] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<AsaMetricSeries[] | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  // Track dirty state via ref so async loadDetail callbacks (triggered by
  // refresh / setState polling) don't clobber user edits made between the
  // request firing and the response arriving. Mirrors the notebook patchCell
  // pattern landed 2026-05-27 — async writes must check current state, not
  // the snapshot captured when the call started.
  const dirtyRef = useRef(false);

  const loadList = useCallback(async () => {
    setError(null); setHint(null);
    try {
      const r = await fetch('/api/items/stream-analytics-job');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Failed to list'); setHint(j.hint); setJobs([]); return; }
      setJobs(j.jobs || []);
      if ((j.jobs || []).length && !selected) setSelected(j.jobs[0].name);
    } catch (e: any) { setError(e?.message || String(e)); setJobs([]); }
  }, [selected]);

  const loadDetail = useCallback(async (name: string, opts?: { force?: boolean }) => {
    if (!name) return;
    setError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error); setHint(j.hint); return; }
      setJob(j.job);
      const q = j.job?.query || STARTER_QUERY;
      // Only overwrite the editor buffer when the user has no unsaved
      // edits, OR when caller explicitly forces (e.g. selecting a
      // different job in the list). Always update origQuery so dirty
      // calculation reflects the server-side truth.
      setOrigQuery(q);
      if (opts?.force || !dirtyRef.current) {
        setQuery(q);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  // When switching jobs, force-load (user expects buffer to reset to that
  // job's persisted query). On other refreshes we respect dirty edits.
  useEffect(() => { if (selected) loadDetail(selected, { force: true }); }, [selected, loadDetail]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setStatus(null); setError(null);
    // Phase 4.5 — snapshot via functional setter so the PUT body and the
    // origQuery we land on success match exactly the bytes we sent, even
    // if the user keeps typing while the request is in flight. Mirrors the
    // notebook-editor.tsx patchCell fix landed 2026-05-27.
    let snapshot = query;
    setQuery((prev) => { snapshot = prev; return prev; });
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/query`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Save failed'); return; }
      setStatus(`Query saved at ${new Date().toLocaleTimeString()}`);
      setOrigQuery(snapshot);
    } finally { setBusy(false); }
  }, [selected, query]);

  const loadMetrics = useCallback(async (name: string) => {
    if (!name) return;
    setMetricsLoading(true); setMetricsError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(name)}/metrics`);
      const j = await r.json();
      if (!j.ok) { setMetricsError(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'Failed to load metrics')); setMetrics(null); return; }
      setMetrics(j.metrics || []);
    } catch (e: any) { setMetricsError(e?.message || String(e)); setMetrics(null); }
    finally { setMetricsLoading(false); }
  }, []);

  // Auto-load live metrics when the Monitoring tab is opened for a job.
  // Declared after loadMetrics so the dependency reference is initialized.
  useEffect(() => { if (tab === 'monitoring' && selected) loadMetrics(selected); }, [tab, selected, loadMetrics]);

  // ASA start/stop is async on the ARM side — the POST returns 202 immediately
  // but the job state transitions over 60–180s. Poll getJob until it reaches
  // the target state (or we exhaust attempts), updating the status receipt and
  // the live metric tiles as it lands. Mirrors the Azure portal "Starting…"
  // → "Running" transition.
  const pollJobState = useCallback(async (name: string, target: RegExp, maxAttempts = 24) => {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((res) => setTimeout(res, 8000)); // 8s between polls
      try {
        const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(name)}`);
        const j = await r.json();
        if (!j.ok) return;
        setJob(j.job);
        const st = j.job?.jobState || j.job?.state || '';
        if (target.test(st)) {
          setStatus(`Job is now ${st} at ${new Date().toLocaleTimeString()}`);
          // Refresh tiles once the job is Running so real SU%/backlog appear.
          if (/Running|Started/i.test(st)) loadMetrics(name);
          return;
        }
      } catch { /* transient; keep polling */ }
    }
  }, [loadMetrics]);

  const setState = useCallback(async (action: 'start' | 'stop') => {
    if (!selected) return;
    setBusy(true); setStatus(null); setError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `${action} failed`); setHint(j.hint || null); return; }
      setStatus(`${action === 'start' ? 'Starting' : 'Stopping'}… (ARM accepted; polling for state)`);
      // Reflect the transitional state immediately, then poll to the target.
      await loadDetail(selected);
      const target = action === 'start' ? /Running|Started/i : /Stopped/i;
      void pollJobState(selected, target);
    } finally { setBusy(false); }
  }, [selected, loadDetail, pollJobState]);

  // ── Guided builder: compile the configured transform to SAQL ──────
  const builderSaql = useMemo(() => {
    const src: SourceNode[] = [{ kind: 'eventhub', name: builderSource || 'input' }];
    const snk: SinkNode[] = [{ kind: 'kusto', name: builderSink || 'output' }];
    return compileToSaql(src, [builderTransform], snk);
  }, [builderSource, builderSink, builderTransform]);

  // Persist an explicit query string to ASA (used by "Apply to job"). Mirrors
  // save() but takes the bytes to write directly.
  const applyQuery = useCallback(async (q: string) => {
    if (!selected) { setError('Select a job first'); return; }
    setBusy(true); setStatus(null); setError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/query`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'Apply failed'); setHint(j.hint || null); return; }
      setQuery(q); setOrigQuery(q);
      setStatus(`Transform applied to ${selected} at ${new Date().toLocaleTimeString()}`);
    } finally { setBusy(false); }
  }, [selected]);

  // ── Test the query: 'compile' (validate via ASA) or 'run' (sample output)
  const runTest = useCallback(async (mode: 'compile' | 'run') => {
    if (!selected) { setTestError('Select a job first'); return; }
    setTestBusy(true); setTestError(null); setTestHint(null); setTestResult(null);
    // The query under test is whatever's in the Query buffer (which Builder
    // can populate via "Copy to Query"/"Apply").
    const q = query;
    let sampleInput: { inputAlias: string; events: any[] }[] = [];
    if (mode === 'run') {
      try {
        const events = JSON.parse(sampleText);
        if (!Array.isArray(events)) throw new Error('Sample data must be a JSON array of events.');
        const alias = (job?.inputs && job.inputs[0]?.name) || builderSource || 'input';
        sampleInput = [{ inputAlias: alias, events }];
      } catch (e: any) {
        setTestError(`Invalid sample JSON: ${e?.message || String(e)}`); setTestBusy(false); return;
      }
    }
    const inputNames = (job?.inputs || []).map((i) => i.name);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, mode, sampleInput, inputNames }),
      });
      const j = await r.json();
      if (!j.ok) { setTestError(j.error || 'Test failed'); setTestHint(j.hint || null); return; }
      setTestResult(j);
    } catch (e: any) {
      setTestError(e?.message || String(e));
    } finally { setTestBusy(false); }
  }, [selected, query, sampleText, job, builderSource]);

  const dirty = query !== origQuery;
  // Keep ref in sync so async callbacks see the latest dirty state.
  dirtyRef.current = dirty;

  // ── Add-output wizard ──────────────────────────────────────────────────
  // Direct ASA-side destination authoring (the Eventstream editor offers a
  // higher-level "Push to ASA" that maps designer sinks to these same specs).
  type OutKind = 'kusto' | 'blob' | 'eventhub';
  const [outOpen, setOutOpen] = useState(false);
  const [outBusy, setOutBusy] = useState(false);
  const [outErr, setOutErr] = useState<string | null>(null);
  const [outKind, setOutKind] = useState<OutKind>('kusto');
  const [outForm, setOutForm] = useState<Record<string, string>>({ name: 'output1' });
  const setOF = (k: string, v: string) => setOutForm((p) => ({ ...p, [k]: v }));

  const openAddOutput = useCallback(() => {
    setOutErr(null);
    setOutKind('kusto');
    setOutForm({ name: 'output1', database: 'loomdb-default' });
    setOutOpen(true);
  }, []);

  const submitOutput = useCallback(async () => {
    if (!selected) { setOutErr('Select a job first.'); return; }
    const f = outForm;
    if (!f.name?.trim()) { setOutErr('Output alias is required.'); return; }
    let spec: Record<string, any> = { name: f.name.trim() };
    if (outKind === 'kusto') {
      if (!f.table?.trim()) { setOutErr('Table is required.'); return; }
      spec = {
        ...spec,
        datasourceType: 'Microsoft.Kusto/clusters/databases',
        authenticationMode: 'Msi',
        kustoClusterUrl: f.cluster?.trim() || '',
        kustoDatabase: f.database?.trim() || 'loomdb-default',
        kustoTable: f.table.trim(),
      };
      if (!spec.kustoClusterUrl) { setOutErr('Cluster URL is required.'); return; }
    } else if (outKind === 'blob') {
      if (!f.storageAccount?.trim()) { setOutErr('Storage account is required.'); return; }
      if (!f.container?.trim()) { setOutErr('Container is required.'); return; }
      spec = {
        ...spec,
        datasourceType: 'Microsoft.Storage/Blob',
        authenticationMode: f.storageAccountKey ? 'ConnectionString' : 'Msi',
        storageAccount: f.storageAccount.trim(),
        storageAccountKey: f.storageAccountKey || undefined,
        container: f.container.trim(),
        pathPattern: f.pathPattern?.trim() || 'events/{date}/{time}',
        serialization: 'Json',
      };
    } else {
      if (!f.namespace?.trim()) { setOutErr('Event Hubs namespace is required.'); return; }
      if (!f.eventHubName?.trim()) { setOutErr('Event Hub name is required.'); return; }
      spec = {
        ...spec,
        datasourceType: 'Microsoft.EventHub/EventHub',
        authenticationMode: f.sharedAccessPolicyKey ? 'ConnectionString' : 'Msi',
        namespace: f.namespace.trim(),
        eventHubName: f.eventHubName.trim(),
        sharedAccessPolicyName: f.sharedAccessPolicyName || undefined,
        sharedAccessPolicyKey: f.sharedAccessPolicyKey || undefined,
        serialization: 'Json',
      };
    }
    setOutBusy(true); setOutErr(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/outputs`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
      });
      const j = await r.json();
      if (!j.ok) { setOutErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'Create failed')); return; }
      setOutOpen(false);
      setStatus(`Output "${spec.name}" created at ${new Date().toLocaleTimeString()}`);
      loadDetail(selected, { force: false });
    } catch (e: any) { setOutErr(e?.message || String(e)); }
    finally { setOutBusy(false); }
  }, [selected, outForm, outKind, loadDetail]);

  const deleteOutput = useCallback(async (outputName: string) => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/outputs?outputName=${encodeURIComponent(outputName)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setError(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'Delete failed')); return; }
      setStatus(`Output "${outputName}" deleted.`);
      loadDetail(selected, { force: false });
    } finally { setBusy(false); }
  }, [selected, loadDetail]);

  // Ctrl/Cmd+S to save query when dirty + not busy. Matches notebook editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selected && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, dirty, busy, save]);

  const jobState = job?.jobState || job?.state || '—';
  // ASA's running state is reported as "Running" (older API flavors say
  // "Started"); accept both so the badge turns green and Start disables.
  const isRunning = /Running|Started/i.test(jobState);
  const stateColor: 'success' | 'warning' | 'danger' | 'subtle' =
    isRunning ? 'success' :
    /Starting|Stopping|Restarting|Scaling/i.test(jobState) ? 'warning' :
    /Failed|Degraded/i.test(jobState) ? 'danger' : 'subtle';

  // Ribbon — Start / Stop / Refresh / Save wire to inline handlers; topology
  // entries switch the local `tab` state to the corresponding pane.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: 'Start', onClick: !busy && selected && !isRunning ? () => setState('start') : undefined, disabled: busy || !selected || isRunning, title: isRunning ? 'Job already running' : (!selected ? 'Select a job first' : undefined) },
        { label: 'Stop', onClick: !busy && selected && !/Stopped/i.test(jobState) ? () => setState('stop') : undefined, disabled: busy || !selected || /Stopped/i.test(jobState), title: /Stopped/i.test(jobState) ? 'Job already stopped' : (!selected ? 'Select a job first' : undefined) },
        { label: 'Refresh', onClick: () => { loadList(); if (selected) loadDetail(selected); } },
      ]},
      { label: 'Query', actions: [
        { label: busy ? 'Saving…' : 'Save', onClick: !busy && selected && dirty ? save : undefined, disabled: busy || !selected || !dirty, title: !dirty ? 'No unsaved changes' : (!selected ? 'Select a job first' : undefined) },
        { label: 'Test selection', onClick: () => setTab('query') },
      ]},
      { label: 'Build', actions: [
        { label: 'Query Builder', onClick: () => setTab('builder') },
        { label: 'Test with sample', onClick: () => setTab('test') },
      ]},
      { label: 'Topology', actions: [
        { label: 'Inputs', onClick: () => setTab('inputs') },
        { label: 'Outputs', onClick: () => setTab('outputs') },
        { label: 'Functions', onClick: () => setTab('functions') },
      ]},
    ]},
  ], [busy, selected, jobState, isRunning, setState, loadList, loadDetail, dirty, save]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.pad}>
          <Subtitle2>ASA jobs ({jobs?.length ?? '…'})</Subtitle2>
          {jobs === null && <Spinner size="tiny" label="Loading…" />}
          {jobs && jobs.length === 0 && !error && (
            <EmptyState
              icon={<Flow20Regular />}
              title="No Stream Analytics jobs"
              body="No Stream Analytics jobs exist in the configured scope. Provision an ASA job, then refresh to author its query, inputs, and outputs."
              primaryAction={{ label: 'Refresh', appearance: 'outline', onClick: () => loadList() }}
            />
          )}
          {(jobs || []).map(j => (
            <Button key={j.name} appearance={selected === j.name ? 'primary' : 'subtle'} onClick={() => setSelected(j.name)}>
              {j.name}
            </Button>
          ))}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Azure Stream Analytics</Badge>
            {selected && <Badge appearance="outline">{selected}</Badge>}
            {job && <Badge appearance="filled" color={stateColor}>{jobState}</Badge>}
            {job?.streamingUnits != null && <Badge appearance="outline">{job.streamingUnits} SU</Badge>}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => { loadList(); if (selected) loadDetail(selected); }}>Refresh</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={busy || !selected || isRunning} onClick={() => setState('start')}>Start</Button>
            <Button appearance="outline" icon={<Pause20Regular />} disabled={busy || !selected || /Stopped/i.test(jobState)} onClick={() => setState('stop')}>Stop</Button>
            <Button appearance="outline" icon={<Save20Regular />} disabled={busy || !selected || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save query'}</Button>
          </div>

          {error && (
            <MessageBar intent={hint ? 'warning' : 'error'}>
              <MessageBarBody>
                <MessageBarTitle>{hint ? 'Stream Analytics not configured' : 'Error'}</MessageBarTitle>
                {error}
                {hint && <><br /><Caption1>{hint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {status && <MessageBar intent="success"><MessageBarBody>{status}</MessageBarBody></MessageBar>}

          <Dialog open={outOpen} onOpenChange={(_, d) => setOutOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add output</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                    <Field label="Output alias" required hint="Reference this in your SAQL as INTO [alias].">
                      <Input value={outForm.name || ''} onChange={(_, d) => setOF('name', d.value)} />
                    </Field>
                    <Field label="Destination type" required>
                      <Select value={outKind} onChange={(_, d) => setOutKind(d.value as OutKind)}>
                        <option value="kusto">KQL Database / ADX (Microsoft.Kusto)</option>
                        <option value="blob">Lakehouse / ADLS Gen2 (Microsoft.Storage/Blob)</option>
                        <option value="eventhub">Event Hub (Microsoft.EventHub)</option>
                      </Select>
                    </Field>
                    {outKind === 'kusto' && (
                      <>
                        <Field label="Cluster URL" required>
                          <Input value={outForm.cluster || ''} placeholder="https://adx-csa-loom-shared.eastus2.kusto.windows.net" onChange={(_, d) => setOF('cluster', d.value)} />
                        </Field>
                        <Field label="Database" required>
                          <Input value={outForm.database || ''} placeholder="loomdb-default" onChange={(_, d) => setOF('database', d.value)} />
                        </Field>
                        <Field label="Table" required hint="Must exist; schema must match query output columns. Auth: ASA managed identity (AllDatabasesIngestor).">
                          <Input value={outForm.table || ''} placeholder="raw_events" onChange={(_, d) => setOF('table', d.value)} />
                        </Field>
                      </>
                    )}
                    {outKind === 'blob' && (
                      <>
                        <Field label="Storage account (ADLS Gen2)" required>
                          <Input value={outForm.storageAccount || ''} placeholder="loomdatalake01" onChange={(_, d) => setOF('storageAccount', d.value)} />
                        </Field>
                        <Field label="Container / filesystem" required>
                          <Input value={outForm.container || ''} placeholder="bronze" onChange={(_, d) => setOF('container', d.value)} />
                        </Field>
                        <Field label="Path pattern" hint="Files land under account/container/pathPattern.">
                          <Input value={outForm.pathPattern || ''} placeholder="events/{date}/{time}" onChange={(_, d) => setOF('pathPattern', d.value)} />
                        </Field>
                        <Field label="Account key" hint="Leave blank to use the ASA managed identity (Storage Blob Data Contributor).">
                          <Input type="password" value={outForm.storageAccountKey || ''} onChange={(_, d) => setOF('storageAccountKey', d.value)} />
                        </Field>
                      </>
                    )}
                    {outKind === 'eventhub' && (
                      <>
                        <Field label="Namespace" required>
                          <Input value={outForm.namespace || ''} placeholder="loom-eventhub-ns" onChange={(_, d) => setOF('namespace', d.value)} />
                        </Field>
                        <Field label="Event Hub name" required>
                          <Input value={outForm.eventHubName || ''} placeholder="transformed-events" onChange={(_, d) => setOF('eventHubName', d.value)} />
                        </Field>
                        <Field label="Shared access policy name" hint="Leave SAS blank to use the ASA managed identity (Event Hubs Data Sender).">
                          <Input value={outForm.sharedAccessPolicyName || ''} onChange={(_, d) => setOF('sharedAccessPolicyName', d.value)} />
                        </Field>
                        <Field label="Shared access key">
                          <Input type="password" value={outForm.sharedAccessPolicyKey || ''} onChange={(_, d) => setOF('sharedAccessPolicyKey', d.value)} />
                        </Field>
                      </>
                    )}
                    {outErr && <MessageBar intent="error"><MessageBarBody>{outErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setOutOpen(false)} disabled={outBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitOutput} disabled={outBusy}>{outBusy ? 'Creating…' : 'Create output'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>


          <div className={s.tabBar}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
              <Tab value="query" icon={<Code20Regular />}>Query</Tab>
              <Tab value="builder" icon={<Filter20Regular />}>Query Builder</Tab>
              <Tab value="test" icon={<Beaker20Regular />}>Test</Tab>
              <Tab value="inputs" icon={<ArrowImport20Regular />}>Inputs ({job?.inputs?.length ?? 0})</Tab>
              <Tab value="outputs" icon={<ArrowExportLtr20Regular />}>Outputs ({job?.outputs?.length ?? 0})</Tab>
              <Tab value="functions" icon={<MathFormula20Regular />}>Functions ({job?.functions?.length ?? 0})</Tab>
              <Tab value="monitoring" icon={<ChartMultiple20Regular />}>Monitoring</Tab>
            </TabList>
          </div>

          {tab === 'query' && (
            <>
              <Caption1>SAQL — Stream Analytics Query Language. Reference inputs/outputs by their alias in square brackets, e.g. <code>FROM [input-eventhub]</code>.</Caption1>
              <MonacoTextarea value={query} onChange={setQuery} language="sql" height={280} minHeight={200} ariaLabel="ASA query" />
            </>
          )}

          {tab === 'builder' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 360px)', gap: tokens.spacingHorizontalL }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 }}>
                <div className={s.sectionHead}><Filter20Regular /><Subtitle2>Guided transform builder</Subtitle2></div>
                <Caption1>
                  Configure a filter / aggregate / window / join through guided fields. The
                  generated SAQL compiles to this job&apos;s transformation — no hand-written query.
                </Caption1>
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Field label="Source alias (FROM)" style={{ flex: 1, minWidth: 0 }}>
                    <Input value={builderSource} onChange={(_, d) => setBuilderSource(d.value)} aria-label="Builder source alias" />
                  </Field>
                  <Field label="Destination alias (INTO)" style={{ flex: 1, minWidth: 0 }}>
                    <Input value={builderSink} onChange={(_, d) => setBuilderSink(d.value)} aria-label="Builder sink alias" />
                  </Field>
                </div>
                <Divider />
                <div className={s.sectionHead}><Code20Regular /><Subtitle2>Generated SAQL</Subtitle2></div>
                <MonacoTextarea value={builderSaql} onChange={() => {}} language="sql" height={220} readOnly ariaLabel="Builder generated SAQL" />
                <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
                  <Button appearance="outline" icon={<Save20Regular />} onClick={() => { setQuery(builderSaql); setTab('query'); }}>
                    Copy to Query tab
                  </Button>
                  <Button appearance="primary" icon={<Save20Regular />} disabled={busy || !selected} onClick={() => applyQuery(builderSaql)}>
                    {busy ? 'Applying…' : 'Apply to ASA job'}
                  </Button>
                  <Button appearance="outline" icon={<Beaker20Regular />} disabled={!selected} onClick={() => { setQuery(builderSaql); setTab('test'); }}>
                    Test with sample data
                  </Button>
                </div>
              </div>
              <div style={{ borderLeft: `1px solid ${tokens.colorNeutralStroke2}`, paddingLeft: tokens.spacingHorizontalL, maxHeight: 560, overflowY: 'auto', minWidth: 0 }}>
                <AsaTransformInspector
                  value={builderTransform}
                  sources={[{ kind: 'eventhub', name: builderSource || 'input' }]}
                  onChange={(p) => setBuilderTransform((cur) => ({ ...cur, ...p }))}
                  onDelete={() => setBuilderTransform({ kind: 'filter', name: 'transform-1', expression: '' })}
                />
              </div>
            </div>
          )}

          {tab === 'test' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.sectionHead}><Beaker20Regular /><Subtitle2>Test query with sample data</Subtitle2></div>
              <Caption1>
                <strong>Compile</strong> validates the current Query against ASA (no infra needed).
                <strong> Run test</strong> streams the sample events below through ASA and returns the
                produced output rows.
              </Caption1>
              <Field label="Sample events (JSON array)">
                <MonacoTextarea value={sampleText} onChange={setSampleText} language="json" height={160} ariaLabel="Sample events JSON" />
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                <Button appearance="outline" disabled={testBusy || !selected} onClick={() => runTest('compile')}>
                  {testBusy ? 'Working…' : 'Compile query'}
                </Button>
                <Button appearance="primary" icon={<Beaker20Regular />} disabled={testBusy || !selected} onClick={() => runTest('run')}>
                  {testBusy ? 'Working…' : 'Run test'}
                </Button>
              </div>

              {testError && (
                <MessageBar intent={testHint ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{testHint ? 'Test not available' : 'Test error'}</MessageBarTitle>
                    {testError}
                    {testHint && <><br /><Caption1>{testHint}</Caption1></>}
                  </MessageBarBody>
                </MessageBar>
              )}

              {testResult?.mode === 'compile' && (
                <>
                  <MessageBar intent={testResult.valid ? 'success' : 'error'}>
                    <MessageBarBody>
                      {testResult.valid
                        ? `Query compiled successfully at ${new Date().toLocaleTimeString()} — ${testResult.inputs?.length || 0} input(s), ${testResult.outputs?.length || 0} output(s) resolved.`
                        : `Query has ${testResult.errors?.length || 0} compilation error(s).`}
                    </MessageBarBody>
                  </MessageBar>
                  {(testResult.errors || []).length > 0 && (
                    <div className={s.tableWrap}>
                      <Table size="small">
                        <TableHeader><TableRow><TableHeaderCell>Line</TableHeaderCell><TableHeaderCell>Message</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {testResult.errors.map((e: any, i: number) => (
                            <TableRow key={i}><TableCell>{e.startLine ?? '—'}</TableCell><TableCell>{e.message}</TableCell></TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {(testResult.warnings || []).map((w: string, i: number) => (
                    <Caption1 key={i}>⚠ {w}</Caption1>
                  ))}
                </>
              )}

              {testResult?.mode === 'run' && (
                <>
                  <MessageBar intent={/succeeded|success/i.test(testResult.status) ? 'success' : 'warning'}>
                    <MessageBarBody>
                      <MessageBarTitle>Test {testResult.status}</MessageBarTitle>
                      {`${(testResult.rows || []).length} output row(s) returned at ${new Date().toLocaleTimeString()}.`}
                      {testResult.outputUri && <><br /><Caption1 style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>Output written to: {String(testResult.outputUri).slice(0, 120)}</Caption1></>}
                    </MessageBarBody>
                  </MessageBar>
                  {(testResult.rows || []).length > 0 && (
                    <div className={s.tableWrap}>
                      <Table size="small">
                        <TableHeader>
                          <TableRow>
                            {Object.keys(testResult.rows[0]).map((c) => (
                              <TableHeaderCell key={c}>{c}</TableHeaderCell>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {testResult.rows.slice(0, 50).map((row: any, i: number) => (
                            <TableRow key={i}>
                              {Object.keys(testResult.rows[0]).map((c) => (
                                <TableCell key={c}>{typeof row[c] === 'object' ? JSON.stringify(row[c]) : String(row[c] ?? '')}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === 'inputs' && (
            <div className={s.tableWrap}>
              <Table size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Alias</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Serialization</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {(job?.inputs || []).map(i => (
                    <TableRow key={i.name}><TableCell>{i.name}</TableCell><TableCell>{i.type}</TableCell><TableCell>{i.serialization || '—'}</TableCell></TableRow>
                  ))}
                  {(!job?.inputs || job.inputs.length === 0) && <TableRow><TableCell colSpan={3}>No inputs defined.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          )}

          {tab === 'outputs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
              <div className={s.toolbar}>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!selected} onClick={openAddOutput}>
                  Add output
                </Button>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  KQL Database (ADX), Lakehouse (ADLS Gen2), and Event Hub destinations — created via real ARM.
                </Caption1>
              </div>
              <div className={s.tableWrap}>
                <Table size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Alias</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {(job?.outputs || []).map(o => (
                      <TableRow key={o.name}>
                        <TableCell>{o.name}</TableCell>
                        <TableCell>{o.type}</TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => deleteOutput(o.name)}>
                            Delete
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!job?.outputs || job.outputs.length === 0) && <TableRow><TableCell colSpan={3}>No outputs defined. Click “Add output” to create a destination.</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {tab === 'functions' && (
            <div className={s.tableWrap}>
              <Table size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Binding</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {(job?.functions || []).map(f => (
                    <TableRow key={f.name}><TableCell>{f.name}</TableCell><TableCell>{f.type || '—'}</TableCell><TableCell>{f.binding || '—'}</TableCell></TableRow>
                  ))}
                  {(!job?.functions || job.functions.length === 0) && <TableRow><TableCell colSpan={3}>No functions defined. Reference UDFs / JavaScript / Azure ML endpoints in your SAQL once defined on the job.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          )}

          {tab === 'monitoring' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <div className={s.sectionHead}><DataUsage20Regular /><Subtitle2>Job summary</Subtitle2></div>
              <div className={s.summaryCard}>
                <Caption1 style={{ display: 'block' }}>State: <strong>{jobState}</strong></Caption1>
                <Caption1 style={{ display: 'block' }}>Last output event time: {job?.lastOutputEventTime || '—'}</Caption1>
                <Caption1 style={{ display: 'block' }}>SKU: {job?.sku || '—'}</Caption1>
                <Caption1 style={{ display: 'block' }}>Streaming Units: {job?.streamingUnits ?? '—'}</Caption1>
              </div>

              {!/Running|Started/i.test(jobState) && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    Azure Monitor only emits Stream Analytics metrics while the job is in the
                    Running state. Start the job to see live SU %, watermark delay, and event counts.
                  </MessageBarBody>
                </MessageBar>
              )}

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                <div className={s.sectionHead}><ChartMultiple20Regular /><Subtitle2>Live metrics (last 1 hour, 5-minute grain)</Subtitle2></div>
                <Button size="small" appearance="outline" icon={<ArrowSync20Regular />}
                  onClick={() => loadMetrics(selected)} disabled={metricsLoading || !selected}>
                  {metricsLoading ? 'Loading…' : 'Refresh'}
                </Button>
              </div>

              {metricsError && (
                <MessageBar intent="error"><MessageBarBody>{metricsError}</MessageBarBody></MessageBar>
              )}
              {metricsLoading && !metrics && <Spinner size="tiny" label="Loading metrics…" />}

              {metrics && metrics.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: tokens.spacingVerticalM }}>
                  {metrics.map((m) => (
                    <MetricChart key={m.name} title={metricLabel(m.name)} unit={metricUnit(m.name) || m.unit} points={m.points} />
                  ))}
                </div>
              )}
              {metrics && metrics.length === 0 && !metricsError && (
                <EmptyState
                  icon={<ChartMultiple20Regular />}
                  title="No metrics in this window"
                  body="Azure Monitor returned no metric series for this job in the selected window. Metrics appear once the job is Running and emitting events — refresh after it warms up."
                  primaryAction={{ label: 'Refresh', appearance: 'outline', onClick: () => loadMetrics(selected) }}
                />
              )}
            </div>
          )}
        </div>
      }
    />
  );
}
