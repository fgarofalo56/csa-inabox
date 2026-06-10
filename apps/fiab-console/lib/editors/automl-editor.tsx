'use client';

/**
 * AutoML editor — low-code automated-ML wizard + run monitoring over Azure
 * Machine Learning's control plane (no Fabric / Power BI dependency).
 *
 * Parity target: the Azure ML Studio "Automated ML" experience —
 *   1. Task picker  — Classification / Regression / Time-series forecasting.
 *   2. Dataset      — pick a registered MLTable data asset (or paste a URI) +
 *                     the target column; forecasting adds time column + horizon.
 *   3. Compute      — pick an AmlCompute cluster the trials run on.
 *   4. Settings     — primary metric, trial / concurrency caps, experiment
 *                     timeout, per-trial timeout, explainability, early stop.
 *   5. Review + run — submit the AutoML job (real ARM PUT).
 *   + Monitor       — a runs table of AutoML jobs with live status polling and
 *                     a Cancel action for in-flight jobs.
 *
 * Backends (all real ARM via lib/azure/aml-client.ts):
 *   GET    /api/aml/automl                 → listAutoMLJobs()
 *   POST   /api/aml/automl                 → submitAutoMLJob()
 *   GET    /api/aml/automl/[name]          → getAutoMLJob() (poll)
 *   DELETE /api/aml/automl/[name]          → cancelAmlJob()
 *   GET    /api/aml/data-assets            → listDataAssets()
 *   GET    /api/aml/computes               → listComputes() (filtered AmlCompute)
 *
 * Honest gate: when the AML workspace env (LOOM_AML_WORKSPACE + LOOM_AML_REGION
 * + LOOM_SUBSCRIPTION_ID, or LOOM_FOUNDRY_* fallback) isn't set, the routes
 * return { configured: false, hint } and this editor renders a Fluent
 * MessageBar naming the variable — the full wizard surface still renders.
 *
 * Azure-native default — works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Switch,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option, SpinButton,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  DataTrending24Regular, NumberSymbol24Regular, CalendarClock24Regular,
  ArrowClockwise16Regular, Play16Regular, Dismiss16Regular, CheckmarkCircle16Filled,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  taskGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
  taskCard: {
    cursor: 'pointer',
    border: `2px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    backgroundColor: tokens.colorNeutralBackground1,
    transition: 'border-color 120ms ease',
  },
  taskCardActive: { border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  stepBar: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  stepPill: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '4px 10px', borderRadius: '999px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, fontSize: '13px',
  },
  stepPillActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2, fontWeight: 600 },
  field2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
  footer: { display: 'flex', gap: '8px', justifyContent: 'space-between', flexWrap: 'wrap' },
  reviewRow: { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '4px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  mono: { fontFamily: 'monospace', fontSize: '12px' },
});

// ----- types from the BFF -----
type Task = 'Classification' | 'Regression' | 'Forecasting';
interface DataAsset { name: string; latestVersion?: string; description?: string }
interface ComputeRow { name: string; computeType?: string; vmSize?: string; state?: string; provisioningState?: string }
interface AmlJobRow { name: string; displayName?: string; status?: string; experimentName?: string; startTimeUtc?: string; endTimeUtc?: string }

const METRICS: Record<Task, string[]> = {
  Classification: ['AUCWeighted', 'Accuracy', 'NormMacroRecall', 'AveragePrecisionScoreWeighted', 'PrecisionScoreWeighted'],
  Regression: ['NormalizedRootMeanSquaredError', 'R2Score', 'SpearmanCorrelation', 'NormalizedMeanAbsoluteError'],
  Forecasting: ['NormalizedRootMeanSquaredError', 'R2Score', 'SpearmanCorrelation', 'NormalizedMeanAbsoluteError'],
};

const TASK_META: { task: Task; title: string; blurb: string; icon: ReactElement }[] = [
  { task: 'Classification', title: 'Classification', blurb: 'Predict a category — binary or multi-class (fraud, churn, defect).', icon: <DataTrending24Regular /> },
  { task: 'Regression', title: 'Regression', blurb: 'Predict a numeric value (price, demand, score).', icon: <NumberSymbol24Regular /> },
  { task: 'Forecasting', title: 'Time-series forecasting', blurb: 'Predict future values over time (sales, inventory, load).', icon: <CalendarClock24Regular /> },
];

const TERMINAL = ['Completed', 'Failed', 'Canceled', 'NotResponding'];
function isTerminal(s?: string) { return TERMINAL.includes(s || ''); }
function statusColor(s?: string): 'success' | 'danger' | 'warning' | 'informative' {
  if (s === 'Completed') return 'success';
  if (s === 'Failed' || s === 'NotResponding') return 'danger';
  if (s === 'Canceled') return 'warning';
  return 'informative';
}
function fmtTime(t?: string): string {
  if (!t) return '—';
  try { return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'); } catch { return t; }
}

type Step = 0 | 1 | 2 | 3 | 4;
const STEP_LABELS = ['Task type', 'Dataset', 'Compute', 'Settings', 'Review + run'];

/** Resolve a SpinButton onChange to a finite number (value field or typed text). */
function spinValue(value: number | null | undefined, displayValue: string | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(displayValue);
  return Number.isFinite(n) ? n : fallback;
}

export function AutoMLEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [view, setView] = useState<'wizard' | 'monitor'>('monitor');

  // gating + reference data
  const [configured, setConfigured] = useState(true);
  const [hint, setHint] = useState<string | null>(null);
  const [dataAssets, setDataAssets] = useState<DataAsset[]>([]);
  const [computes, setComputes] = useState<ComputeRow[]>([]);
  const [refLoading, setRefLoading] = useState(true);

  // wizard state
  const [step, setStep] = useState<Step>(0);
  const [task, setTask] = useState<Task>('Classification');
  const [displayName, setDisplayName] = useState('');
  const [experimentName, setExperimentName] = useState('loom-automl');
  const [datasetMode, setDatasetMode] = useState<'asset' | 'uri'>('asset');
  const [assetName, setAssetName] = useState('');
  const [assetVersion, setAssetVersion] = useState('');
  const [trainingUri, setTrainingUri] = useState('');
  const [validationUri, setValidationUri] = useState('');
  const [targetColumn, setTargetColumn] = useState('');
  const [timeColumn, setTimeColumn] = useState('');
  const [forecastHorizon, setForecastHorizon] = useState(7);
  const [computeName, setComputeName] = useState('');
  const [primaryMetric, setPrimaryMetric] = useState(METRICS.Classification[0]);
  const [maxTrials, setMaxTrials] = useState(20);
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [timeoutMin, setTimeoutMin] = useState(60);
  const [trialTimeoutMin, setTrialTimeoutMin] = useState(20);
  const [explain, setExplain] = useState(true);
  const [earlyStop, setEarlyStop] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);

  // monitor state
  const [jobs, setJobs] = useState<AmlJobRow[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const amlCompute = useMemo(() => computes.filter((c) => (c.computeType || '') === 'AmlCompute'), [computes]);

  // reset primary metric default when task changes
  useEffect(() => { setPrimaryMetric(METRICS[task][0]); }, [task]);

  const loadRef = useCallback(async () => {
    setRefLoading(true);
    try {
      const [dRes, cRes] = await Promise.all([
        fetch('/api/aml/data-assets').then((r) => r.json()),
        fetch('/api/aml/computes').then((r) => r.json()),
      ]);
      if (dRes?.configured === false) {
        setConfigured(false);
        setHint(dRes.hint || null);
      } else {
        setConfigured(true);
        setDataAssets(Array.isArray(dRes?.dataAssets) ? dRes.dataAssets : []);
      }
      if (cRes?.configured === false) {
        setConfigured(false);
        setHint((h) => h || cRes.hint || null);
      } else {
        setComputes(Array.isArray(cRes?.computes) ? cRes.computes : []);
      }
    } catch (e: any) {
      setJobsErr(e?.message || String(e));
    } finally {
      setRefLoading(false);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsErr(null);
    try {
      const r = await fetch('/api/aml/automl').then((x) => x.json());
      if (r?.configured === false) {
        setConfigured(false);
        setHint((h) => h || r.hint || null);
        setJobs([]);
      } else if (r?.ok) {
        setConfigured(true);
        setJobs(Array.isArray(r.jobs) ? r.jobs : []);
      } else {
        setJobsErr(r?.error || 'Failed to load AutoML jobs');
      }
    } catch (e: any) {
      setJobsErr(e?.message || String(e));
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => { loadRef(); loadJobs(); }, [loadRef, loadJobs]);

  // auto-poll while any job is non-terminal and the monitor is visible
  useEffect(() => {
    const anyRunning = jobs.some((j) => !isTerminal(j.status));
    if (view === 'monitor' && anyRunning) {
      if (!pollRef.current) pollRef.current = setInterval(loadJobs, 15000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [jobs, view, loadJobs]);

  const resolvedTrainingUri = useCallback((): string => {
    if (datasetMode === 'uri') return trainingUri.trim();
    if (assetName) return `azureml:${assetName}:${assetVersion || '1'}`;
    return '';
  }, [datasetMode, trainingUri, assetName, assetVersion]);

  const canSubmit = useMemo(() => {
    if (!resolvedTrainingUri()) return false;
    if (!targetColumn.trim()) return false;
    if (!computeName) return false;
    if (task === 'Forecasting' && !timeColumn.trim()) return false;
    return true;
  }, [resolvedTrainingUri, targetColumn, computeName, task, timeColumn]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitErr(null);
    setSubmitOk(null);
    try {
      const body: Record<string, unknown> = {
        task,
        trainingDataUri: resolvedTrainingUri(),
        validationDataUri: validationUri.trim() || undefined,
        targetColumnName: targetColumn.trim(),
        computeName,
        displayName: displayName.trim() || undefined,
        experimentName: experimentName.trim() || undefined,
        primaryMetric,
        maxTrials,
        maxConcurrentTrials: maxConcurrent,
        timeout: `PT${Math.max(1, timeoutMin)}M`,
        trialTimeout: `PT${Math.max(1, trialTimeoutMin)}M`,
        enableModelExplainability: explain,
        enableEarlyTermination: earlyStop,
      };
      if (task === 'Forecasting') {
        body.timeColumnName = timeColumn.trim();
        body.forecastHorizon = forecastHorizon;
      }
      const r = await fetch('/api/aml/automl', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((x) => x.json());
      if (r?.ok && r.job) {
        setSubmitOk(`Submitted ${r.job.name} (${r.job.status || 'NotStarted'})`);
        setView('monitor');
        loadJobs();
      } else if (r?.configured === false) {
        setConfigured(false);
        setHint(r.hint || null);
      } else {
        setSubmitErr(r?.error || 'AutoML submit failed');
      }
    } catch (e: any) {
      setSubmitErr(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }, [task, resolvedTrainingUri, validationUri, targetColumn, computeName, displayName, experimentName, primaryMetric, maxTrials, maxConcurrent, timeoutMin, trialTimeoutMin, explain, earlyStop, timeColumn, forecastHorizon, loadJobs]);

  const cancelJob = useCallback(async (name: string) => {
    try {
      await fetch(`/api/aml/automl/${encodeURIComponent(name)}`, { method: 'DELETE' });
      loadJobs();
    } catch { /* surfaced on next poll */ }
  }, [loadJobs]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'View', actions: [
        { label: 'Monitor runs', onClick: () => setView('monitor') },
        { label: 'New AutoML run', onClick: () => { setView('wizard'); setStep(0); } },
      ]},
      { label: 'Refresh', actions: [
        { label: jobsLoading ? 'Reloading…' : 'Reload', onClick: jobsLoading ? undefined : () => { loadJobs(); loadRef(); }, disabled: jobsLoading },
      ]},
    ]},
  ], [jobsLoading, loadJobs, loadRef]);

  const gateBar = !configured ? (
    <MessageBar intent="warning">
      <MessageBarBody>
        <MessageBarTitle>Azure Machine Learning workspace not configured</MessageBarTitle>
        {hint || 'AutoML requires an Azure ML workspace.'}
        <br />
        <Caption1>
          Set <code>LOOM_AML_WORKSPACE</code> + <code>LOOM_AML_REGION</code> + <code>LOOM_SUBSCRIPTION_ID</code>{' '}
          (or the <code>LOOM_FOUNDRY_*</code> equivalents), then grant the Console UAMI the{' '}
          <strong>AzureML Data Scientist</strong> role on the workspace. The full wizard still renders below.
        </Caption1>
      </MessageBarBody>
    </MessageBar>
  ) : null;

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      main={
        <div className={s.pad}>
          {gateBar}

          <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as 'wizard' | 'monitor')}>
            <Tab value="monitor">Monitor runs</Tab>
            <Tab value="wizard">New AutoML run</Tab>
          </TabList>

          {view === 'monitor' ? (
            <MonitorView
              s={s}
              jobs={jobs}
              loading={jobsLoading}
              error={jobsErr}
              onReload={loadJobs}
              onCancel={cancelJob}
              onStart={() => { setView('wizard'); setStep(0); }}
            />
          ) : (
            <WizardView
              s={s}
              step={step} setStep={setStep}
              task={task} setTask={setTask}
              displayName={displayName} setDisplayName={setDisplayName}
              experimentName={experimentName} setExperimentName={setExperimentName}
              datasetMode={datasetMode} setDatasetMode={setDatasetMode}
              dataAssets={dataAssets}
              assetName={assetName} setAssetName={setAssetName}
              assetVersion={assetVersion} setAssetVersion={setAssetVersion}
              trainingUri={trainingUri} setTrainingUri={setTrainingUri}
              validationUri={validationUri} setValidationUri={setValidationUri}
              targetColumn={targetColumn} setTargetColumn={setTargetColumn}
              timeColumn={timeColumn} setTimeColumn={setTimeColumn}
              forecastHorizon={forecastHorizon} setForecastHorizon={setForecastHorizon}
              amlCompute={amlCompute}
              computeName={computeName} setComputeName={setComputeName}
              primaryMetric={primaryMetric} setPrimaryMetric={setPrimaryMetric}
              maxTrials={maxTrials} setMaxTrials={setMaxTrials}
              maxConcurrent={maxConcurrent} setMaxConcurrent={setMaxConcurrent}
              timeoutMin={timeoutMin} setTimeoutMin={setTimeoutMin}
              trialTimeoutMin={trialTimeoutMin} setTrialTimeoutMin={setTrialTimeoutMin}
              explain={explain} setExplain={setExplain}
              earlyStop={earlyStop} setEarlyStop={setEarlyStop}
              refLoading={refLoading}
              resolvedTrainingUri={resolvedTrainingUri()}
              canSubmit={canSubmit}
              submitting={submitting}
              submitErr={submitErr}
              submitOk={submitOk}
              onSubmit={submit}
            />
          )}
        </div>
      }
    />
  );
}

// ============================================================
// Monitor view
// ============================================================
function MonitorView(props: {
  s: ReturnType<typeof useStyles>;
  jobs: AmlJobRow[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onCancel: (name: string) => void;
  onStart: () => void;
}) {
  const { s, jobs, loading, error, onReload, onCancel, onStart } = props;
  return (
    <div className={s.card}>
      <div className={s.footer}>
        <Subtitle2>AutoML runs</Subtitle2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button icon={<ArrowClockwise16Regular />} appearance="subtle" onClick={onReload} disabled={loading}>
            {loading ? 'Reloading…' : 'Reload'}
          </Button>
          <Button icon={<Play16Regular />} appearance="primary" onClick={onStart}>New AutoML run</Button>
        </div>
      </div>
      {error && (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
      )}
      {loading && jobs.length === 0 && <Spinner size="small" label="Loading AutoML jobs…" labelPosition="after" />}
      {!loading && jobs.length === 0 && !error && (
        <Body1>No AutoML jobs yet. Start one with <strong>New AutoML run</strong>.</Body1>
      )}
      {jobs.length > 0 && (
        <Table size="small" aria-label="AutoML runs">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Run</TableHeaderCell>
              <TableHeaderCell>Experiment</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
              <TableHeaderCell>Ended</TableHeaderCell>
              <TableHeaderCell>Action</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.name}>
                <TableCell>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span>{j.displayName || j.name}</span>
                    <Caption1 className={s.mono}>{j.name}</Caption1>
                  </div>
                </TableCell>
                <TableCell>{j.experimentName || '—'}</TableCell>
                <TableCell><Badge appearance="filled" color={statusColor(j.status)}>{j.status || 'Unknown'}</Badge></TableCell>
                <TableCell>{fmtTime(j.startTimeUtc)}</TableCell>
                <TableCell>{fmtTime(j.endTimeUtc)}</TableCell>
                <TableCell>
                  {!isTerminal(j.status) ? (
                    <Button size="small" icon={<Dismiss16Regular />} appearance="subtle" onClick={() => onCancel(j.name)}>Cancel</Button>
                  ) : (
                    <Caption1>—</Caption1>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {jobs.some((j) => !isTerminal(j.status)) && (
        <Caption1>Auto-refreshing every 15s while a run is in progress.</Caption1>
      )}
    </div>
  );
}

// ============================================================
// Wizard view
// ============================================================
interface WizardProps {
  s: ReturnType<typeof useStyles>;
  step: Step; setStep: (v: Step) => void;
  task: Task; setTask: (v: Task) => void;
  displayName: string; setDisplayName: (v: string) => void;
  experimentName: string; setExperimentName: (v: string) => void;
  datasetMode: 'asset' | 'uri'; setDatasetMode: (v: 'asset' | 'uri') => void;
  dataAssets: DataAsset[];
  assetName: string; setAssetName: (v: string) => void;
  assetVersion: string; setAssetVersion: (v: string) => void;
  trainingUri: string; setTrainingUri: (v: string) => void;
  validationUri: string; setValidationUri: (v: string) => void;
  targetColumn: string; setTargetColumn: (v: string) => void;
  timeColumn: string; setTimeColumn: (v: string) => void;
  forecastHorizon: number; setForecastHorizon: (v: number) => void;
  amlCompute: ComputeRow[];
  computeName: string; setComputeName: (v: string) => void;
  primaryMetric: string; setPrimaryMetric: (v: string) => void;
  maxTrials: number; setMaxTrials: (v: number) => void;
  maxConcurrent: number; setMaxConcurrent: (v: number) => void;
  timeoutMin: number; setTimeoutMin: (v: number) => void;
  trialTimeoutMin: number; setTrialTimeoutMin: (v: number) => void;
  explain: boolean; setExplain: (v: boolean) => void;
  earlyStop: boolean; setEarlyStop: (v: boolean) => void;
  refLoading: boolean;
  resolvedTrainingUri: string;
  canSubmit: boolean;
  submitting: boolean;
  submitErr: string | null;
  submitOk: string | null;
  onSubmit: () => void;
}

function WizardView(p: WizardProps) {
  const { s } = p;
  const next = () => p.setStep(Math.min(4, p.step + 1) as Step);
  const back = () => p.setStep(Math.max(0, p.step - 1) as Step);

  return (
    <>
      <div className={s.stepBar}>
        {STEP_LABELS.map((label, i) => (
          <span
            key={label}
            className={`${s.stepPill} ${i === p.step ? s.stepPillActive : ''}`}
            onClick={() => p.setStep(i as Step)}
            role="button"
          >
            {i < p.step ? <CheckmarkCircle16Filled /> : <span>{i + 1}</span>} {label}
          </span>
        ))}
      </div>

      {p.step === 0 && (
        <div className={s.card}>
          <Subtitle2>Select task type</Subtitle2>
          <Body1>What kind of prediction do you need? AutoML will train and tune many models and pick the best.</Body1>
          <div className={s.taskGrid}>
            {TASK_META.map((t) => (
              <div
                key={t.task}
                className={`${s.taskCard} ${p.task === t.task ? s.taskCardActive : ''}`}
                onClick={() => p.setTask(t.task)}
                role="button"
                aria-pressed={p.task === t.task}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {t.icon}
                  <Subtitle2>{t.title}</Subtitle2>
                </div>
                <Caption1>{t.blurb}</Caption1>
                {t.task === 'Classification' && <Badge appearance="outline" size="small">Binary + multi-class</Badge>}
              </div>
            ))}
          </div>
          <div className={s.field2}>
            <Field label="Display name">
              <Input value={p.displayName} onChange={(_, d) => p.setDisplayName(d.value)} placeholder={`AutoML ${p.task}`} />
            </Field>
            <Field label="Experiment name">
              <Input value={p.experimentName} onChange={(_, d) => p.setExperimentName(d.value)} placeholder="loom-automl" />
            </Field>
          </div>
        </div>
      )}

      {p.step === 1 && (
        <div className={s.card}>
          <Subtitle2>Select training data</Subtitle2>
          <Body1>AutoML trains on an MLTable. Choose a registered data asset or paste an MLTable URI.</Body1>
          <TabList selectedValue={p.datasetMode} onTabSelect={(_, d) => p.setDatasetMode(d.value as 'asset' | 'uri')}>
            <Tab value="asset">Registered data asset</Tab>
            <Tab value="uri">MLTable URI</Tab>
          </TabList>
          {p.datasetMode === 'asset' ? (
            <div className={s.field2}>
              <Field label="Data asset" hint={p.refLoading ? 'Loading…' : `${p.dataAssets.length} registered`}>
                <Dropdown
                  placeholder={p.dataAssets.length ? 'Select a data asset' : 'No data assets registered'}
                  value={p.assetName}
                  selectedOptions={p.assetName ? [p.assetName] : []}
                  onOptionSelect={(_, d) => {
                    p.setAssetName(d.optionValue || '');
                    const a = p.dataAssets.find((x) => x.name === d.optionValue);
                    p.setAssetVersion(a?.latestVersion || '1');
                  }}
                >
                  {p.dataAssets.map((a) => (
                    <Option key={a.name} value={a.name} text={a.name}>
                      {a.latestVersion ? `${a.name} (v${a.latestVersion})` : a.name}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Field label="Version">
                <Input value={p.assetVersion} onChange={(_, d) => p.setAssetVersion(d.value)} placeholder="latest version" />
              </Field>
            </div>
          ) : (
            <Field label="Training MLTable URI" hint="azureml://… , abfss://… , or azureml:<name>:<version>">
              <Input value={p.trainingUri} onChange={(_, d) => p.setTrainingUri(d.value)} placeholder="azureml://datastores/workspaceblobstore/paths/data/mltable/" />
            </Field>
          )}
          <Field label="Validation MLTable URI (optional)" hint="Leave blank to auto split / cross-validate">
            <Input value={p.validationUri} onChange={(_, d) => p.setValidationUri(d.value)} placeholder="optional" />
          </Field>
          <Field label="Target column" required hint="The label / value to predict">
            <Input value={p.targetColumn} onChange={(_, d) => p.setTargetColumn(d.value)} placeholder="e.g. label" />
          </Field>
          {p.task === 'Forecasting' && (
            <div className={s.field2}>
              <Field label="Time column" required>
                <Input value={p.timeColumn} onChange={(_, d) => p.setTimeColumn(d.value)} placeholder="e.g. timestamp" />
              </Field>
              <Field label="Forecast horizon (periods)">
                <SpinButton value={p.forecastHorizon} min={1} max={10000} onChange={(_, d) => p.setForecastHorizon(spinValue(d.value, d.displayValue, 7))} />
              </Field>
            </div>
          )}
        </div>
      )}

      {p.step === 2 && (
        <div className={s.card}>
          <Subtitle2>Select compute</Subtitle2>
          <Body1>AutoML trials run on an AmlCompute cluster.</Body1>
          {p.amlCompute.length === 0 && !p.refLoading && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No AmlCompute cluster found</MessageBarTitle>
                Create one with <code>az ml compute create --type amlcompute --name cpu-cluster --size Standard_DS3_v2 --min-instances 0 --max-instances 4</code>, then reload.
              </MessageBarBody>
            </MessageBar>
          )}
          <Field label="Compute cluster" required hint={p.refLoading ? 'Loading…' : `${p.amlCompute.length} cluster(s)`}>
            <Dropdown
              placeholder={p.amlCompute.length ? 'Select a cluster' : 'No clusters available'}
              value={p.computeName}
              selectedOptions={p.computeName ? [p.computeName] : []}
              onOptionSelect={(_, d) => p.setComputeName(d.optionValue || '')}
            >
              {p.amlCompute.map((c) => (
                <Option key={c.name} value={c.name} text={c.name}>
                  {`${c.name}${c.vmSize ? ` — ${c.vmSize}` : ''}${c.provisioningState ? ` (${c.provisioningState})` : ''}`}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </div>
      )}

      {p.step === 3 && (
        <div className={s.card}>
          <Subtitle2>Configure settings</Subtitle2>
          <div className={s.field2}>
            <Field label="Primary metric">
              <Dropdown
                value={p.primaryMetric}
                selectedOptions={[p.primaryMetric]}
                onOptionSelect={(_, d) => p.setPrimaryMetric(d.optionValue || METRICS[p.task][0])}
              >
                {METRICS[p.task].map((m) => <Option key={m} value={m}>{m}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Max trials">
              <SpinButton value={p.maxTrials} min={1} max={1000} onChange={(_, d) => p.setMaxTrials(spinValue(d.value, d.displayValue, 20))} />
            </Field>
            <Field label="Max concurrent trials">
              <SpinButton value={p.maxConcurrent} min={1} max={100} onChange={(_, d) => p.setMaxConcurrent(spinValue(d.value, d.displayValue, 4))} />
            </Field>
            <Field label="Experiment timeout (minutes)">
              <SpinButton value={p.timeoutMin} min={1} max={10080} onChange={(_, d) => p.setTimeoutMin(spinValue(d.value, d.displayValue, 60))} />
            </Field>
            <Field label="Per-trial timeout (minutes)">
              <SpinButton value={p.trialTimeoutMin} min={1} max={1440} onChange={(_, d) => p.setTrialTimeoutMin(spinValue(d.value, d.displayValue, 20))} />
            </Field>
          </div>
          <Switch checked={p.explain} onChange={(_, d) => p.setExplain(d.checked)} label="Enable model explainability (best model)" />
          <Switch checked={p.earlyStop} onChange={(_, d) => p.setEarlyStop(d.checked)} label="Enable early termination" />
        </div>
      )}

      {p.step === 4 && (
        <div className={s.card}>
          <Subtitle2>Review + run</Subtitle2>
          {p.submitErr && <MessageBar intent="error"><MessageBarBody>{p.submitErr}</MessageBarBody></MessageBar>}
          {p.submitOk && <MessageBar intent="success"><MessageBarBody>{p.submitOk}</MessageBarBody></MessageBar>}
          <ReviewRow s={s} k="Task" v={p.task} />
          <ReviewRow s={s} k="Display name" v={p.displayName || `AutoML ${p.task}`} />
          <ReviewRow s={s} k="Experiment" v={p.experimentName || 'loom-automl'} />
          <ReviewRow s={s} k="Training data" v={p.resolvedTrainingUri || '(not set)'} mono />
          {p.validationUri && <ReviewRow s={s} k="Validation data" v={p.validationUri} mono />}
          <ReviewRow s={s} k="Target column" v={p.targetColumn || '(not set)'} />
          {p.task === 'Forecasting' && <ReviewRow s={s} k="Time column" v={p.timeColumn || '(not set)'} />}
          {p.task === 'Forecasting' && <ReviewRow s={s} k="Forecast horizon" v={String(p.forecastHorizon)} />}
          <ReviewRow s={s} k="Compute" v={p.computeName || '(not set)'} />
          <ReviewRow s={s} k="Primary metric" v={p.primaryMetric} />
          <ReviewRow s={s} k="Limits" v={`${p.maxTrials} trials, ${p.maxConcurrent} concurrent, PT${p.timeoutMin}M total, PT${p.trialTimeoutMin}M/trial`} />
          <ReviewRow s={s} k="Explainability" v={p.explain ? 'On' : 'Off'} />
          <ReviewRow s={s} k="Early termination" v={p.earlyStop ? 'On' : 'Off'} />
        </div>
      )}

      <div className={s.footer}>
        <Button appearance="secondary" onClick={back} disabled={p.step === 0}>Back</Button>
        {p.step < 4 ? (
          <Button appearance="primary" onClick={next}>Next</Button>
        ) : (
          <Button
            appearance="primary"
            icon={<Play16Regular />}
            onClick={p.onSubmit}
            disabled={!p.canSubmit || p.submitting}
          >
            {p.submitting ? 'Submitting…' : 'Submit AutoML run'}
          </Button>
        )}
      </div>
    </>
  );
}

function ReviewRow({ s, k, v, mono }: { s: ReturnType<typeof useStyles>; k: string; v: string; mono?: boolean }) {
  return (
    <div className={s.reviewRow}>
      <Caption1>{k}</Caption1>
      <span className={mono ? s.mono : undefined}>{v}</span>
    </div>
  );
}
