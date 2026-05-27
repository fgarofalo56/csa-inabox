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
 *   - Manage inputs / outputs (references — full create flow deferred to v2)
 *   - Start / Stop the job
 *
 * Honest gating:
 *   - If no ASA job(s) exist in the configured scope, MessageBar shows the
 *     bicep module + env vars needed (LOOM_ASA_RG, LOOM_ASA_SUB).
 *   - Query persists to ARM via PUT /streamingjobs/{name}/transformations.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner,
  Tab, TabList, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Pause20Regular, ArrowSync20Regular, Save20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Job', actions: [{ label: 'Start' }, { label: 'Stop' }, { label: 'Refresh' }] },
    { label: 'Query', actions: [{ label: 'Save' }, { label: 'Test selection' }] },
    { label: 'Topology', actions: [{ label: 'Inputs' }, { label: 'Outputs' }, { label: 'Functions' }] },
  ]},
];

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  queryArea: {
    width: '100%', minHeight: 360,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
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
  query?: string;
}
interface AsaInput { name: string; type: string; serialization?: string; }
interface AsaOutput { name: string; type: string; }

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
  const [tab, setTab] = useState<'query' | 'inputs' | 'outputs' | 'monitoring'>('query');
  const [job, setJob] = useState<AsaJob | null>(null);
  const [query, setQuery] = useState(STARTER_QUERY);
  const [origQuery, setOrigQuery] = useState(STARTER_QUERY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
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

  const setState = useCallback(async (action: 'start' | 'stop') => {
    if (!selected) return;
    setBusy(true); setStatus(null); setError(null);
    try {
      const r = await fetch(`/api/items/stream-analytics-job/${encodeURIComponent(selected)}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) { setError(j.error || `${action} failed`); return; }
      setStatus(`${action === 'start' ? 'Starting' : 'Stopping'}…`);
      setTimeout(() => loadDetail(selected), 3000);
    } finally { setBusy(false); }
  }, [selected, loadDetail]);

  const dirty = query !== origQuery;
  // Keep ref in sync so async callbacks see the latest dirty state.
  dirtyRef.current = dirty;

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
  const stateColor: 'success' | 'warning' | 'danger' | 'subtle' =
    /Started/i.test(jobState) ? 'success' :
    /Starting|Stopping/i.test(jobState) ? 'warning' :
    /Failed|Degraded/i.test(jobState) ? 'danger' : 'subtle';

  return (
    <ItemEditorChrome item={item} id={id} ribbon={RIBBON}
      leftPanel={
        <div className={s.pad}>
          <Subtitle2>ASA jobs ({jobs?.length ?? '…'})</Subtitle2>
          {jobs === null && <Spinner size="tiny" label="Loading…" />}
          {jobs && jobs.length === 0 && !error && <Caption1>No Stream Analytics jobs in the configured scope.</Caption1>}
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
            <Button appearance="primary" icon={<Play20Regular />} disabled={busy || !selected || /Started/i.test(jobState)} onClick={() => setState('start')}>Start</Button>
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

          <div className={s.tabBar}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
              <Tab value="query">Query</Tab>
              <Tab value="inputs">Inputs ({job?.inputs?.length ?? 0})</Tab>
              <Tab value="outputs">Outputs ({job?.outputs?.length ?? 0})</Tab>
              <Tab value="monitoring">Monitoring</Tab>
            </TabList>
          </div>

          {tab === 'query' && (
            <>
              <Caption1>SAQL — Stream Analytics Query Language. Reference inputs/outputs by their alias in square brackets, e.g. <code>FROM [input-eventhub]</code>.</Caption1>
              <MonacoTextarea value={query} onChange={setQuery} language="sql" height={280} minHeight={200} ariaLabel="ASA query" />
            </>
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
            <div className={s.tableWrap}>
              <Table size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Alias</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {(job?.outputs || []).map(o => (
                    <TableRow key={o.name}><TableCell>{o.name}</TableCell><TableCell>{o.type}</TableCell></TableRow>
                  ))}
                  {(!job?.outputs || job.outputs.length === 0) && <TableRow><TableCell colSpan={2}>No outputs defined.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          )}

          {tab === 'monitoring' && (
            <div>
              <Subtitle2>Job summary</Subtitle2>
              <Caption1 style={{ display: 'block', marginTop: 4 }}>State: <strong>{jobState}</strong></Caption1>
              <Caption1 style={{ display: 'block' }}>Last output event time: {job?.lastOutputEventTime || '—'}</Caption1>
              <Caption1 style={{ display: 'block' }}>SKU: {job?.sku || '—'}</Caption1>
              <Caption1 style={{ display: 'block' }}>Streaming Units: {job?.streamingUnits ?? '—'}</Caption1>
            </div>
          )}
        </div>
      }
    />
  );
}
