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
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Pause20Regular, ArrowSync20Regular, Save20Regular, Beaker20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { AsaTransformInspector } from '@/lib/components/eventstream/visual-designer';
import { compileToSaql, type TransformNode, type SourceNode, type SinkNode } from '@/lib/azure/asa-query-compiler';

// (Ribbon defined inside StreamAnalyticsJobEditor via useMemo so onClick handlers
// can reference inline setState / save / loadList / setTab state.)

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
  functions?: AsaFunction[];
  query?: string;
}
interface AsaInput { name: string; type: string; serialization?: string; }
interface AsaOutput { name: string; type: string; }
interface AsaFunction { name: string; type?: string; binding?: string; }

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

  // Ribbon — Start / Stop / Refresh / Save wire to inline handlers; topology
  // entries switch the local `tab` state to the corresponding pane.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: 'Start', onClick: !busy && selected && !/Started/i.test(jobState) ? () => setState('start') : undefined, disabled: busy || !selected || /Started/i.test(jobState), title: /Started/i.test(jobState) ? 'Job already started' : (!selected ? 'Select a job first' : undefined) },
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
  ], [busy, selected, jobState, setState, loadList, loadDetail, dirty, save]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
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
              <Tab value="builder">Query Builder</Tab>
              <Tab value="test">Test</Tab>
              <Tab value="inputs">Inputs ({job?.inputs?.length ?? 0})</Tab>
              <Tab value="outputs">Outputs ({job?.outputs?.length ?? 0})</Tab>
              <Tab value="functions">Functions ({job?.functions?.length ?? 0})</Tab>
              <Tab value="monitoring">Monitoring</Tab>
            </TabList>
          </div>

          {tab === 'query' && (
            <>
              <Caption1>SAQL — Stream Analytics Query Language. Reference inputs/outputs by their alias in square brackets, e.g. <code>FROM [input-eventhub]</code>.</Caption1>
              <MonacoTextarea value={query} onChange={setQuery} language="sql" height={280} minHeight={200} ariaLabel="ASA query" />
            </>
          )}

          {tab === 'builder' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Subtitle2>Guided transform builder</Subtitle2>
                <Caption1>
                  Configure a filter / aggregate / window / join through guided fields. The
                  generated SAQL compiles to this job&apos;s transformation — no hand-written query.
                </Caption1>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Field label="Source alias (FROM)" style={{ flex: 1 }}>
                    <Input value={builderSource} onChange={(_, d) => setBuilderSource(d.value)} aria-label="Builder source alias" />
                  </Field>
                  <Field label="Destination alias (INTO)" style={{ flex: 1 }}>
                    <Input value={builderSink} onChange={(_, d) => setBuilderSink(d.value)} aria-label="Builder sink alias" />
                  </Field>
                </div>
                <Divider />
                <Subtitle2>Generated SAQL</Subtitle2>
                <MonacoTextarea value={builderSaql} onChange={() => {}} language="sql" height={220} readOnly ariaLabel="Builder generated SAQL" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
              <div style={{ borderLeft: `1px solid ${tokens.colorNeutralStroke2}`, paddingLeft: 16, maxHeight: 560, overflowY: 'auto' }}>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Subtitle2>Test query with sample data</Subtitle2>
              <Caption1>
                <strong>Compile</strong> validates the current Query against ASA (no infra needed).
                <strong> Run test</strong> streams the sample events below through ASA and returns the
                produced output rows.
              </Caption1>
              <Field label="Sample events (JSON array)">
                <MonacoTextarea value={sampleText} onChange={setSampleText} language="json" height={160} ariaLabel="Sample events JSON" />
              </Field>
              <div style={{ display: 'flex', gap: 8 }}>
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
                      {testResult.outputUri && <><br /><Caption1>Output written to: {String(testResult.outputUri).slice(0, 120)}</Caption1></>}
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
