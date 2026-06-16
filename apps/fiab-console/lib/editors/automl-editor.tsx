'use client';

/**
 * AutoML editor — the low-code Automated ML wizard over Azure Machine Learning
 * AutoML (Fabric Build 2026 #37; there is no Fabric "AutoML" item, so this is
 * the Azure-native default surface, no Fabric / Power BI dependency — works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset, per no-fabric-dependency.md).
 *
 * Parity target: the Azure ML Studio "Automated ML → New Automated ML job"
 * wizard:
 *   1. Task picker     — Classification (binary + multi-class) / Regression / Forecasting
 *   2. Dataset         — pick a datastore + MLTable folder + target column
 *   3. Compute         — pick an AmlCompute cluster
 *   4. Settings        — primary metric, limits (timeout / trials / concurrency),
 *                        cross-validation, and (forecasting) time column + horizon
 *   5. Review + submit — fires a real AutoML job
 * plus a Runs tab that monitors submitted jobs live (status, cancel, Studio link).
 *
 * All controls are dropdowns / numeric spinners / a stepper — no raw JSON
 * (per loom_no_freeform_config). Every control calls a real BFF route that
 * issues real ARM REST (per no-vaporware.md):
 *   GET    /api/items/automl/options        → compute clusters + datastores
 *   POST   /api/items/automl/submit         → PUT AutoML job
 *   GET    /api/items/automl/jobs           → list AutoML runs
 *   GET    /api/items/automl/jobs/[name]    → poll one run
 *   DELETE /api/items/automl/jobs/[name]    → cancel a run
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option, SpinButton, Link,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, Dismiss16Regular, Open16Regular,
  CheckmarkCircle16Filled, ErrorCircle16Filled, Clock16Regular,
  Checkmark12Filled, Sparkle24Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

// Task taxonomy mirrored from lib/azure/aml-automl-client.ts (kept in this client
// module so the editor has no server-only import; the server validates again).
type TaskType = 'Classification' | 'Regression' | 'Forecasting';

const TASKS: { task: TaskType; title: string; description: string }[] = [
  {
    task: 'Classification',
    title: 'Classification',
    description:
      'Predict a category. Binary (two classes) and multi-class (3+ classes) are both handled — AutoML detects the class count from the label column.',
  },
  { task: 'Regression', title: 'Regression', description: 'Predict a continuous numeric value (price, demand, score).' },
  {
    task: 'Forecasting',
    title: 'Forecasting',
    description: 'Predict future time-series values from history. Requires a time column.',
  },
];

const PRIMARY_METRICS: Record<TaskType, string[]> = {
  Classification: ['AUCWeighted', 'Accuracy', 'NormMacroRecall', 'AveragePrecisionScoreWeighted', 'PrecisionScoreWeighted'],
  Regression: ['NormalizedRootMeanSquaredError', 'R2Score', 'NormalizedMeanAbsoluteError', 'SpearmanCorrelation'],
  Forecasting: ['NormalizedRootMeanSquaredError', 'R2Score', 'NormalizedMeanAbsoluteError', 'SpearmanCorrelation'],
};

const useStyles = makeStyles({
  pad: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' },
  tabBar: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, paddingBottom: '4px' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '14px',
    background: tokens.colorNeutralBackground1,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    boxShadow: tokens.shadow2,
  },
  taskGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px' },
  taskTile: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    background: tokens.colorNeutralBackground1,
    transitionProperty: 'background, border-color, box-shadow',
    transitionDuration: tokens.durationFaster,
    ':hover': { background: tokens.colorNeutralBackground1Hover, borderColor: tokens.colorNeutralStroke1 },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },
  },
  taskTileSelected: {
    borderColor: tokens.colorBrandStroke1,
    boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}`,
    background: tokens.colorNeutralBackground1Selected,
  },
  // ── Stepper ──────────────────────────────────────────────────────
  stepper: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', paddingBottom: '2px' },
  stepItem: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    background: 'transparent', border: 'none', padding: '4px 6px',
    borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
    color: tokens.colorNeutralForeground1, font: 'inherit',
    ':disabled': { cursor: 'not-allowed', opacity: 0.55 },
    ':hover:enabled': { background: tokens.colorNeutralBackground1Hover },
    ':focus-visible': { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '1px' },
  },
  stepDot: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', height: '24px', borderRadius: '50%',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: '12px', fontWeight: 600, flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  stepDotActive: {
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    borderColor: tokens.colorBrandBackground,
  },
  stepDotDone: {
    background: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground1,
    borderColor: tokens.colorPaletteGreenBorder1,
  },
  stepConnector: { width: '20px', height: '2px', background: tokens.colorNeutralStroke2, flexShrink: 0 },
  stepConnectorDone: { background: tokens.colorPaletteGreenBorder1 },
  fieldRow: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  navRow: { display: 'flex', gap: '8px', justifyContent: 'space-between', marginTop: '8px' },
  reviewGrid: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', fontSize: '13px' },
  statusCell: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  uriHint: {
    fontFamily: tokens.fontFamilyMonospace,
    background: tokens.colorNeutralBackground3,
    padding: '6px 8px', borderRadius: tokens.borderRadiusSmall,
    wordBreak: 'break-all',
  },
  runsToolbar: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  runsSpacer: { flex: 1 },
  emptyState: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
    padding: '28px 12px', textAlign: 'center', color: tokens.colorNeutralForeground3,
  },
  actionCell: { display: 'flex', gap: '4px' },
});

interface ClusterLite { name: string; vmSize?: string; state?: string; provisioningState?: string; maxNodeCount?: number }
interface DatastoreLite { name: string; datastoreType?: string; isDefault?: boolean; path?: string | null }
interface AutoMlJobLite {
  name: string; displayName?: string; experimentName?: string; taskType?: string;
  status?: string; primaryMetric?: string; createdAt?: string; studioUrl?: string;
}

const STEPS = ['Task', 'Dataset', 'Compute', 'Settings', 'Review'] as const;
type StepName = typeof STEPS[number];

function statusIcon(status?: string) {
  const s = status || '';
  if (['Completed'].includes(s)) return <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
  if (['Failed', 'Canceled', 'NotResponding'].includes(s)) return <ErrorCircle16Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
  return <Clock16Regular style={{ color: tokens.colorNeutralForeground3 }} />;
}

export function AutoMlEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const [tab, setTab] = useState<'wizard' | 'runs'>('wizard');

  // ---- Wizard state ----
  const [step, setStep] = useState<StepName>('Task');
  const [task, setTask] = useState<TaskType>('Classification');
  const [datastore, setDatastore] = useState<string>('');
  const [mltableFolder, setMltableFolder] = useState<string>('');
  const [targetColumn, setTargetColumn] = useState<string>('');
  const [computeName, setComputeName] = useState<string>('');
  const [primaryMetric, setPrimaryMetric] = useState<string>(PRIMARY_METRICS.Classification[0]);
  const [experimentTimeoutMinutes, setExperimentTimeoutMinutes] = useState<number>(60);
  const [maxTrials, setMaxTrials] = useState<number>(20);
  const [maxConcurrentTrials, setMaxConcurrentTrials] = useState<number>(4);
  const [nCrossValidations, setNCrossValidations] = useState<number>(5);
  const [experimentName, setExperimentName] = useState<string>('loom-automl');
  const [displayName, setDisplayName] = useState<string>('');
  // Forecasting-only
  const [timeColumn, setTimeColumn] = useState<string>('');
  const [forecastHorizon, setForecastHorizon] = useState<number>(7);
  const [timeSeriesIds, setTimeSeriesIds] = useState<string>('');

  // ---- Options (compute + datastores) ----
  const [clusters, setClusters] = useState<ClusterLite[]>([]);
  const [datastores, setDatastores] = useState<DatastoreLite[]>([]);
  const [configured, setConfigured] = useState(true);
  const [gateHint, setGateHint] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);

  // ---- Submit + runs state ----
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);
  const [jobs, setJobs] = useState<AutoMlJobLite[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [cancelingName, setCancelingName] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('All');

  const isNew = id === 'new';

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    try {
      const r = await fetch('/api/items/automl/options');
      const j = await r.json();
      if (j.configured === false) {
        setConfigured(false);
        setGateHint(j.hint || null);
        setClusters([]); setDatastores([]);
        return;
      }
      setConfigured(true); setGateHint(null);
      setClusters(Array.isArray(j.clusters) ? j.clusters : []);
      setDatastores(Array.isArray(j.datastores) ? j.datastores : []);
      // Default selections to the first cluster / default datastore.
      if (!computeName && j.clusters?.[0]?.name) setComputeName(j.clusters[0].name);
      if (!datastore) {
        const def = (j.datastores || []).find((d: DatastoreLite) => d.isDefault) || j.datastores?.[0];
        if (def?.name) setDatastore(def.name);
      }
    } catch {
      // Network failure — surface in the wizard, not a crash.
      setConfigured(true);
    } finally {
      setOptionsLoading(false);
    }
  }, [computeName, datastore]);

  // Max concurrent trials cannot exceed the SELECTED cluster's max node count —
  // AML rejects the job with a hard 400 ("max concurrent iterations is larger
  // than max node of compute") otherwise. Derive the ceiling from the cluster
  // the user picked (undefined maxNodeCount → fall back to the static 100 cap so
  // we never block when the value is unknown).
  const selectedClusterMaxNodes = useMemo<number | undefined>(() => {
    const c = clusters.find((x) => x.name === computeName);
    return typeof c?.maxNodeCount === 'number' && c.maxNodeCount > 0 ? c.maxNodeCount : undefined;
  }, [clusters, computeName]);

  const concurrencyCeiling = selectedClusterMaxNodes ?? 100;
  const concurrencyExceedsCluster =
    selectedClusterMaxNodes !== undefined && maxConcurrentTrials > selectedClusterMaxNodes;

  // Clamp max-concurrent-trials down to the selected cluster's node count when
  // the user switches to a smaller cluster (so the default 4 can't silently
  // produce the AML 400 against a 2-node cluster). Only clamps DOWN — never
  // raises the user's chosen value.
  useEffect(() => {
    if (selectedClusterMaxNodes !== undefined && maxConcurrentTrials > selectedClusterMaxNodes) {
      setMaxConcurrentTrials(selectedClusterMaxNodes);
    }
  }, [selectedClusterMaxNodes, maxConcurrentTrials]);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const r = await fetch('/api/items/automl/jobs?maxResults=100');
      const j = await r.json();
      if (j.configured === false) {
        setConfigured(false);
        setGateHint(j.hint || null);
        setJobs([]);
        return;
      }
      setJobs(Array.isArray(j.jobs) ? j.jobs : []);
    } catch {
      /* keep prior list */
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isNew) return;
    loadOptions();
    loadJobs();
  }, [isNew, loadOptions, loadJobs]);

  // Keep primary metric valid when the task changes.
  useEffect(() => {
    setPrimaryMetric(PRIMARY_METRICS[task][0]);
  }, [task]);

  const selectedDatastore = useMemo(
    () => datastores.find((d) => d.name === datastore),
    [datastores, datastore],
  );

  // Compose the MLTable training-data URI from the chosen datastore path + folder.
  const trainingDataUri = useMemo(() => {
    const base = selectedDatastore?.path;
    if (!base) return '';
    const folder = mltableFolder.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    return folder ? `${base.replace(/\/+$/, '')}/${folder}/` : base;
  }, [selectedDatastore, mltableFolder]);

  // Status facets for the Runs filter, derived from the live job list.
  const statusFacets = useMemo(() => {
    const set = new Set<string>();
    jobs.forEach((j) => { if (j.status) set.add(j.status); });
    return ['All', ...Array.from(set).sort()];
  }, [jobs]);

  const filteredJobs = useMemo(
    () => (statusFilter === 'All' ? jobs : jobs.filter((j) => (j.status || '') === statusFilter)),
    [jobs, statusFilter],
  );

  const stepIndex = STEPS.indexOf(step);

  const stepValid = useCallback((s: StepName): boolean => {
    switch (s) {
      case 'Task': return !!task;
      case 'Dataset': return !!datastore && !!trainingDataUri && !!targetColumn.trim() &&
        (task !== 'Forecasting' || !!timeColumn.trim());
      case 'Compute': return !!computeName;
      case 'Settings': return !!primaryMetric && experimentTimeoutMinutes >= 15 && maxTrials >= 1 &&
        !concurrencyExceedsCluster;
      case 'Review': return true;
    }
  }, [task, datastore, trainingDataUri, targetColumn, timeColumn, computeName, primaryMetric, experimentTimeoutMinutes, maxTrials, concurrencyExceedsCluster]);

  const canSubmit = configured && !submitting &&
    stepValid('Task') && stepValid('Dataset') && stepValid('Compute') && stepValid('Settings');

  const submit = useCallback(async () => {
    setSubmitting(true); setSubmitError(null); setSubmitOk(null);
    try {
      const payload: Record<string, unknown> = {
        task,
        trainingDataUri,
        targetColumnName: targetColumn.trim(),
        computeName,
        primaryMetric,
        experimentTimeoutMinutes,
        maxTrials,
        maxConcurrentTrials,
        nCrossValidations: task === 'Forecasting' ? undefined : nCrossValidations,
        experimentName: experimentName.trim() || undefined,
        displayName: displayName.trim() || undefined,
      };
      if (task === 'Forecasting') {
        payload.forecastingSettings = {
          timeColumnName: timeColumn.trim(),
          forecastHorizon,
          timeSeriesIdColumnNames: timeSeriesIds
            .split(',').map((s) => s.trim()).filter(Boolean),
        };
      }
      const r = await fetch('/api/items/automl/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.configured === false) { setConfigured(false); setGateHint(j.hint || null); return; }
      if (!j.ok) throw new Error(j.error || 'submit failed');
      setSubmitOk(j.job?.name || 'submitted');
      setTab('runs');
      setTimeout(loadJobs, 1500);
    } catch (e: any) {
      setSubmitError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }, [task, trainingDataUri, targetColumn, computeName, primaryMetric, experimentTimeoutMinutes,
      maxTrials, maxConcurrentTrials, nCrossValidations, experimentName, displayName,
      timeColumn, forecastHorizon, timeSeriesIds, loadJobs]);

  const cancelJob = useCallback(async (name: string) => {
    setCancelingName(name);
    try {
      const r = await fetch(`/api/items/automl/jobs/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.ok) setTimeout(loadJobs, 1200);
    } finally {
      setCancelingName(null);
    }
  }, [loadJobs]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'AutoML job', actions: [
        { label: 'New AutoML job', onClick: () => { setTab('wizard'); setStep('Task'); }, disabled: submitting },
        { label: submitting ? 'Submitting…' : 'Submit', onClick: canSubmit ? submit : undefined, disabled: !canSubmit },
      ]},
      { label: 'Runs', actions: [
        { label: 'View runs', onClick: () => { setTab('runs'); loadJobs(); } },
        { label: 'Refresh', onClick: () => { loadOptions(); loadJobs(); }, disabled: optionsLoading || jobsLoading },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [submitting, canSubmit, submit, optionsLoading, jobsLoading]);

  if (isNew) {
    return (
      <NewItemCreateGate
        item={item}
        createLabel="Create AutoML job"
        intro="AutoML runs a low-code sweep over Azure Machine Learning to find the best model for your data. Pick a task (classification, regression, or forecasting), point at a dataset and target column, choose a compute cluster, and AutoML trains and ranks candidate models for you. Create it, then use the wizard to configure and submit a real AML AutoML job."
      />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={styles.pad}>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => { const v = d.value as 'wizard' | 'runs'; setTab(v); if (v === 'runs') loadJobs(); }}>
            <Tab value="wizard">New AutoML job</Tab>
            <Tab value="runs">Runs</Tab>
          </TabList>
        </div>

        {!configured && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Azure ML workspace not configured</MessageBarTitle>
              {gateHint || 'Set LOOM_AML_WORKSPACE + LOOM_AML_REGION (or the AI Foundry hub env) so AutoML jobs can run against the workspace. ml-workspace.bicep deploys the workspace and grants the Console UAMI the AzureML Data Scientist role.'}
            </MessageBarBody>
          </MessageBar>
        )}

        {tab === 'wizard' && (
          <>
            {/* Stepper — accessible progress nav: completed steps show a check,
                the active step is brand-filled, future steps are reachable only
                when the prior step validates. */}
            <nav className={styles.stepper} aria-label="AutoML wizard steps">
              {STEPS.map((s, i) => {
                const done = i < stepIndex;
                const active = i === stepIndex;
                const reachable = i <= stepIndex || stepValid(STEPS[i - 1] || 'Task');
                return (
                  <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className={styles.stepItem}
                      disabled={!reachable}
                      aria-current={active ? 'step' : undefined}
                      onClick={() => { if (reachable) setStep(s); }}
                    >
                      <span className={`${styles.stepDot} ${active ? styles.stepDotActive : done ? styles.stepDotDone : ''}`}>
                        {done ? <Checkmark12Filled /> : i + 1}
                      </span>
                      <Caption1 style={{ fontWeight: active ? 600 : 400 }}>{s}</Caption1>
                    </button>
                    {i < STEPS.length - 1 && (
                      <span className={`${styles.stepConnector} ${done ? styles.stepConnectorDone : ''}`} aria-hidden />
                    )}
                  </span>
                );
              })}
            </nav>

            {submitError && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Submit failed</MessageBarTitle>{submitError}</MessageBarBody></MessageBar>
            )}
            {submitOk && (
              <MessageBar intent="success"><MessageBarBody><MessageBarTitle>AutoML job submitted</MessageBarTitle>Run {submitOk} is queued. Watch it on the Runs tab.</MessageBarBody></MessageBar>
            )}

            {/* Step: Task */}
            {step === 'Task' && (
              <div className={styles.card}>
                <Subtitle2>Select a task type</Subtitle2>
                <div className={styles.taskGrid}>
                  {TASKS.map((t) => (
                    <div
                      key={t.task}
                      className={`${styles.taskTile} ${task === t.task ? styles.taskTileSelected : ''}`}
                      onClick={() => setTask(t.task)}
                      role="button"
                      aria-pressed={task === t.task}
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTask(t.task); } }}
                    >
                      <Body1 style={{ fontWeight: 600 }}>{t.title}</Body1>
                      <Caption1>{t.description}</Caption1>
                      {t.task === 'Classification' && <Badge appearance="tint" color="brand">Binary + multi-class</Badge>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step: Dataset */}
            {step === 'Dataset' && (
              <div className={styles.card}>
                <Subtitle2>Dataset</Subtitle2>
                <Caption1>AutoML reads tabular data as an MLTable. Pick the datastore and the folder that holds the MLTable, then name the target (label) column.</Caption1>
                <div className={styles.fieldRow}>
                  <Field label="Datastore" required style={{ minWidth: 240 }}>
                    <Dropdown
                      selectedOptions={datastore ? [datastore] : []}
                      value={selectedDatastore ? `${selectedDatastore.name}${selectedDatastore.isDefault ? ' (default)' : ''}` : ''}
                      onOptionSelect={(_, d) => setDatastore(d.optionValue || '')}
                      placeholder={optionsLoading ? 'Loading…' : 'Select a datastore'}
                    >
                      {datastores.map((d) => (
                        <Option key={d.name} value={d.name} text={d.name}>
                          {d.name}{d.isDefault ? ' (default)' : ''} — {d.datastoreType}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label="MLTable folder (path under the datastore)" style={{ minWidth: 280 }}
                    hint="e.g. datasets/titanic/mltable — leave blank to use the datastore root">
                    <Input value={mltableFolder} onChange={(_, d) => setMltableFolder(d.value)} placeholder="datasets/<name>/mltable" />
                  </Field>
                </div>
                {trainingDataUri && (
                  <Caption1 className={styles.uriHint}>Training data URI: {trainingDataUri}</Caption1>
                )}
                <div className={styles.fieldRow}>
                  <Field label="Target column" required style={{ minWidth: 220 }}
                    hint="The label column AutoML learns to predict">
                    <Input value={targetColumn} onChange={(_, d) => setTargetColumn(d.value)} placeholder="e.g. Survived" />
                  </Field>
                  {task === 'Forecasting' && (
                    <>
                      <Field label="Time column" required style={{ minWidth: 200 }}
                        hint="The datetime column defining the series time axis">
                        <Input value={timeColumn} onChange={(_, d) => setTimeColumn(d.value)} placeholder="e.g. date" />
                      </Field>
                      <Field label="Time-series ID columns" style={{ minWidth: 220 }}
                        hint="Comma-separated columns that identify each series (optional)">
                        <Input value={timeSeriesIds} onChange={(_, d) => setTimeSeriesIds(d.value)} placeholder="store_id, item_id" />
                      </Field>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Step: Compute */}
            {step === 'Compute' && (
              <div className={styles.card}>
                <Subtitle2>Compute</Subtitle2>
                <Caption1>AutoML sweeps run on an AmlCompute cluster. Pick one from the workspace.</Caption1>
                {clusters.length === 0 && !optionsLoading && (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>No compute clusters found</MessageBarTitle>
                      Create an AmlCompute cluster in the workspace (Azure ML Studio → Compute → Compute clusters), then refresh.
                    </MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Compute cluster" required style={{ minWidth: 280 }}>
                  <Dropdown
                    selectedOptions={computeName ? [computeName] : []}
                    value={computeName}
                    onOptionSelect={(_, d) => setComputeName(d.optionValue || '')}
                    placeholder={optionsLoading ? 'Loading…' : 'Select a cluster'}
                  >
                    {clusters.map((c) => (
                      <Option key={c.name} value={c.name} text={c.name}>
                        {c.name}{c.vmSize ? ` — ${c.vmSize}` : ''}{c.state ? ` (${c.state})` : ''}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            )}

            {/* Step: Settings */}
            {step === 'Settings' && (
              <div className={styles.card}>
                <Subtitle2>Settings &amp; limits</Subtitle2>
                <div className={styles.fieldRow}>
                  <Field label="Primary metric" required style={{ minWidth: 280 }}
                    hint="The metric AutoML optimizes for when ranking models">
                    <Dropdown
                      selectedOptions={[primaryMetric]}
                      value={primaryMetric}
                      onOptionSelect={(_, d) => setPrimaryMetric(d.optionValue || primaryMetric)}
                    >
                      {PRIMARY_METRICS[task].map((m) => <Option key={m} value={m} text={m}>{m}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Experiment name" style={{ minWidth: 200 }}>
                    <Input value={experimentName} onChange={(_, d) => setExperimentName(d.value)} />
                  </Field>
                  <Field label="Run display name (optional)" style={{ minWidth: 200 }}>
                    <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder={`AutoML ${task} run`} />
                  </Field>
                </div>
                <div className={styles.fieldRow}>
                  <Field label="Experiment timeout (minutes)" hint="Min 15">
                    <SpinButton value={experimentTimeoutMinutes} min={15} max={10080} step={15}
                      onChange={(_, d) => setExperimentTimeoutMinutes(Number(d.value ?? d.displayValue) || 60)} />
                  </Field>
                  <Field label="Max trials (models)">
                    <SpinButton value={maxTrials} min={1} max={1000} step={1}
                      onChange={(_, d) => setMaxTrials(Number(d.value ?? d.displayValue) || 20)} />
                  </Field>
                  <Field
                    label="Max concurrent trials"
                    hint={selectedClusterMaxNodes !== undefined
                      ? `Capped at the '${computeName}' cluster's ${selectedClusterMaxNodes} node${selectedClusterMaxNodes === 1 ? '' : 's'}`
                      : 'Cannot exceed the selected compute cluster’s node count'}
                    validationState={concurrencyExceedsCluster ? 'error' : 'none'}
                    validationMessage={concurrencyExceedsCluster
                      ? `Exceeds the cluster's ${selectedClusterMaxNodes} nodes — AML rejects this with a 400. Lower it to ${selectedClusterMaxNodes} or pick a larger cluster.`
                      : undefined}
                  >
                    <SpinButton value={maxConcurrentTrials} min={1} max={concurrencyCeiling} step={1}
                      onChange={(_, d) => {
                        const n = Number(d.value ?? d.displayValue) || 4;
                        // Clamp to [1, cluster max nodes] so the control can't be
                        // driven past what the selected cluster can run.
                        setMaxConcurrentTrials(Math.max(1, Math.min(n, concurrencyCeiling)));
                      }} />
                  </Field>
                  {task !== 'Forecasting' && (
                    <Field label="Cross-validation folds" hint="Used when no validation split is provided">
                      <SpinButton value={nCrossValidations} min={2} max={20} step={1}
                        onChange={(_, d) => setNCrossValidations(Number(d.value ?? d.displayValue) || 5)} />
                    </Field>
                  )}
                  {task === 'Forecasting' && (
                    <Field label="Forecast horizon (periods)">
                      <SpinButton value={forecastHorizon} min={1} max={10000} step={1}
                        onChange={(_, d) => setForecastHorizon(Number(d.value ?? d.displayValue) || 7)} />
                    </Field>
                  )}
                </div>
              </div>
            )}

            {/* Step: Review */}
            {step === 'Review' && (
              <div className={styles.card}>
                <Subtitle2>Review &amp; submit</Subtitle2>
                <div className={styles.reviewGrid}>
                  <Caption1>Task</Caption1><Body1>{task}</Body1>
                  <Caption1>Datastore</Caption1><Body1>{datastore || '—'}</Body1>
                  <Caption1>Training data URI</Caption1><Body1 style={{ fontFamily: 'monospace', fontSize: 12 }}>{trainingDataUri || '—'}</Body1>
                  <Caption1>Target column</Caption1><Body1>{targetColumn || '—'}</Body1>
                  {task === 'Forecasting' && (<><Caption1>Time column</Caption1><Body1>{timeColumn || '—'}</Body1></>)}
                  {task === 'Forecasting' && timeSeriesIds.trim() && (<><Caption1>Series IDs</Caption1><Body1>{timeSeriesIds}</Body1></>)}
                  {task === 'Forecasting' && (<><Caption1>Forecast horizon</Caption1><Body1>{forecastHorizon}</Body1></>)}
                  <Caption1>Compute cluster</Caption1><Body1>{computeName || '—'}</Body1>
                  <Caption1>Primary metric</Caption1><Body1>{primaryMetric}</Body1>
                  <Caption1>Limits</Caption1><Body1>{experimentTimeoutMinutes} min · {maxTrials} trials · {maxConcurrentTrials} concurrent</Body1>
                  {task !== 'Forecasting' && (<><Caption1>CV folds</Caption1><Body1>{nCrossValidations}</Body1></>)}
                  <Caption1>Experiment</Caption1><Body1>{experimentName || 'loom-automl'}</Body1>
                </div>
                <Button appearance="primary" disabled={!canSubmit} onClick={submit}>
                  {submitting ? 'Submitting…' : 'Submit AutoML job'}
                </Button>
              </div>
            )}

            {/* Wizard navigation */}
            <div className={styles.navRow}>
              <Button
                disabled={stepIndex === 0}
                onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)])}
              >Back</Button>
              {step !== 'Review' ? (
                <Button
                  appearance="primary"
                  disabled={!stepValid(step)}
                  onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, stepIndex + 1)])}
                >Next</Button>
              ) : (
                <Button appearance="primary" disabled={!canSubmit} onClick={submit}>
                  {submitting ? 'Submitting…' : 'Submit AutoML job'}
                </Button>
              )}
            </div>
          </>
        )}

        {tab === 'runs' && (
          <div className={styles.card}>
            <div className={styles.runsToolbar}>
              <Subtitle2>AutoML runs</Subtitle2>
              {jobs.length > 0 && (
                <Badge appearance="tint" color="informative">{filteredJobs.length} of {jobs.length}</Badge>
              )}
              <span className={styles.runsSpacer} />
              {jobs.length > 0 && (
                <Field label="Status" orientation="horizontal">
                  <Dropdown
                    size="small"
                    style={{ minWidth: 140 }}
                    selectedOptions={[statusFilter]}
                    value={statusFilter}
                    onOptionSelect={(_, d) => setStatusFilter(d.optionValue || 'All')}
                  >
                    {statusFacets.map((s) => <Option key={s} value={s} text={s}>{s}</Option>)}
                  </Dropdown>
                </Field>
              )}
              <Button size="small" icon={<ArrowClockwise16Regular />} onClick={loadJobs} disabled={jobsLoading}>Refresh</Button>
              {jobsLoading && <Spinner size="extra-tiny" />}
            </div>
            {configured && jobs.length === 0 && !jobsLoading && (
              <div className={styles.emptyState}>
                <Sparkle24Regular />
                <Body1 style={{ fontWeight: 600 }}>No AutoML runs yet</Body1>
                <Caption1>Submit a job from the New AutoML job tab and it will appear here with live status.</Caption1>
                <Button appearance="primary" onClick={() => { setTab('wizard'); setStep('Task'); }}>New AutoML job</Button>
              </div>
            )}
            {configured && jobs.length > 0 && filteredJobs.length === 0 && (
              <div className={styles.emptyState}>
                <Body1>No runs match the “{statusFilter}” filter.</Body1>
                <Button size="small" appearance="subtle" onClick={() => setStatusFilter('All')}>Clear filter</Button>
              </div>
            )}
            {filteredJobs.length > 0 && (
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Display name</TableHeaderCell>
                    <TableHeaderCell>Task</TableHeaderCell>
                    <TableHeaderCell>Metric</TableHeaderCell>
                    <TableHeaderCell>Experiment</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredJobs.map((jb) => {
                    const terminal = ['Completed', 'Failed', 'Canceled', 'NotResponding'].includes(jb.status || '');
                    return (
                      <TableRow key={jb.name}>
                        <TableCell>
                          <span className={styles.statusCell}>{statusIcon(jb.status)}{jb.status || 'Unknown'}</span>
                        </TableCell>
                        <TableCell>{jb.displayName || jb.name}</TableCell>
                        <TableCell>{jb.taskType || '—'}</TableCell>
                        <TableCell>{jb.primaryMetric || '—'}</TableCell>
                        <TableCell>{jb.experimentName || '—'}</TableCell>
                        <TableCell>{jb.createdAt ? new Date(jb.createdAt).toLocaleString() : '—'}</TableCell>
                        <TableCell>
                          <div className={styles.actionCell}>
                            {jb.studioUrl && (
                              <Link href={jb.studioUrl} target="_blank" rel="noreferrer">
                                <Button size="small" icon={<Open16Regular />} appearance="subtle">Studio</Button>
                              </Link>
                            )}
                            {!terminal && (
                              <Button size="small" icon={<Dismiss16Regular />} appearance="subtle"
                                disabled={cancelingName === jb.name}
                                onClick={() => cancelJob(jb.name)}>
                                {cancelingName === jb.name ? 'Canceling…' : 'Cancel'}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>
    } />
  );
}
