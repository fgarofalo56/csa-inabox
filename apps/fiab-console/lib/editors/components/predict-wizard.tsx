'use client';

/**
 * PredictWizard — the ML-model PREDICT guided batch-scoring stepper (rel-T84),
 * the Azure-native 1:1 of Microsoft Fabric's PREDICT experience.
 *
 * Four steps, matching Fabric PREDICT:
 *   1. Model + version — the bound Azure ML registered MLflow model; pick the
 *      version to score with (real versions from the model registry).
 *   2. Input + mapping — pick the input Delta table (abfss path or registered
 *      table) and map its columns → the model's input features (seeded from the
 *      model's MLflow signature / bundle definition when available).
 *   3. Output + review — prediction column, result type, output Delta table +
 *      write mode; review the exact scoring PySpark that will run.
 *   4. Run — submit a REAL Spark job (mlflow.pyfunc.spark_udf on AML Serverless
 *      Spark or Synapse Spark), poll to completion, show the scored-table
 *      location + row count.
 *
 * Every control is real-backed: pickers via GET .../predict, submit via POST
 * .../predict, status via GET .../predict/status. When Spark compute isn't
 * configured the honest infra-gate MessageBar names the exact env var / role —
 * and the full wizard still renders. No Fabric dependency.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Button, Caption1, Card, Dropdown, Field, Input, Option, Spinner,
  Subtitle2, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow,
  MessageBar, MessageBarBody, MessageBarTitle, Link, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  BrainCircuit20Regular, TableSettings20Regular, DocumentBulletList20Regular,
  PlayCircle20Regular, Add16Regular, Delete16Regular, Open16Regular,
} from '@fluentui/react-icons';
import {
  buildPredictPySpark, validatePredictSpec, PREDICT_RESULT_TYPES,
  type PredictSpec, type FeatureMapping, type PredictResultType,
} from '@/lib/azure/predict-codegen';
import type { PredictHistoryEntry, PredictRunStatus } from '@/lib/azure/predict-history';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '860px' },
  steps: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  stepHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4,
  },
  rowWrap: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  mono: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre', overflow: 'auto', maxHeight: '340px', padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  summary: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  summaryRow: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalL },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, justifyContent: 'flex-end', flexWrap: 'wrap' },
  monoInline: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
});

interface DatastoreHint { name: string; abfssPath: string }
interface ComputeStatus { backend: 'aml' | 'synapse'; configured: boolean; missing?: string }
interface Pickers {
  features: string[];
  featureSource: 'signature' | 'bundle' | 'none';
  datastores: DatastoreHint[];
  compute: ComputeStatus;
  tracking: { configured: boolean };
}
interface RunState {
  runId: string;
  backend: string;
  status: string;
  phase?: string;
  outputRef?: string;
  done: boolean;
  ok?: boolean;
  rows?: number | null;
  errorText?: string;
  textPlain?: string;
}

/** Fluent Badge color per persisted run status. */
function runStatusColor(status: PredictRunStatus): 'success' | 'danger' | 'warning' | 'informative' {
  switch (status) {
    case 'succeeded': return 'success';
    case 'failed': return 'danger';
    case 'running': return 'warning';
    default: return 'informative';
  }
}

const RESULT_TYPE_LABELS: Record<PredictResultType, string> = {
  double: 'double (regression / probability)',
  float: 'float',
  integer: 'integer',
  long: 'long',
  string: 'string (class label)',
  boolean: 'boolean',
};

export interface PredictWizardProps {
  apiBase: string;               // /api/items/ml-model/<id>
  modelName: string;
  workspaceName?: string;
  versions: Array<{ version: string }>;
  defaultVersion?: string;
}

const TERMINAL_SYNAPSE = ['available', 'error', 'cancelled', 'dead', 'killed'];
const TERMINAL_AML = ['Completed', 'Failed', 'Canceled', 'NotResponding'];

export function PredictWizard({ apiBase, modelName, workspaceName, versions, defaultVersion }: PredictWizardProps) {
  const s = useStyles();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [version, setVersion] = useState<string>(defaultVersion || versions[0]?.version || '');

  // Step 2
  const [inputMode, setInputMode] = useState<'delta-path' | 'table'>('delta-path');
  const [inputRef, setInputRef] = useState('');
  const [inputFormat, setInputFormat] = useState<'delta' | 'parquet'>('delta');
  const [featureRows, setFeatureRows] = useState<FeatureMapping[]>([]);
  const [passthrough, setPassthrough] = useState('');

  // Step 3
  const [predictionColumn, setPredictionColumn] = useState('prediction');
  const [resultType, setResultType] = useState<PredictResultType>('double');
  const [outputMode, setOutputMode] = useState<'delta-path' | 'table'>('delta-path');
  const [outputRef, setOutputRef] = useState('');
  const [writeMode, setWriteMode] = useState<'overwrite' | 'append'>('overwrite');

  // Pickers (real-backed)
  const [pickers, setPickers] = useState<Pickers | null>(null);
  const [pickersLoading, setPickersLoading] = useState(false);
  const [pickersError, setPickersError] = useState<string | null>(null);

  // Run
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);

  // Run history (persisted on the item — FGC-18 "run history persisted").
  const [history, setHistory] = useState<PredictHistoryEntry[]>([]);
  const loadHistory = useCallback(async () => {
    try {
      const r = await clientFetch(`${apiBase}/predict/history`);
      const j = await r.json();
      if (j.ok && Array.isArray(j.runs)) setHistory(j.runs);
    } catch { /* non-critical — history is a convenience */ }
  }, [apiBase]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  // Load pickers when entering step 2 (or when the version changes there).
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    (async () => {
      setPickersLoading(true); setPickersError(null);
      try {
        const r = await clientFetch(`${apiBase}/predict?version=${encodeURIComponent(version)}`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) { setPickersError(j.error || `HTTP ${r.status}`); setPickers(null); return; }
        setPickers(j as Pickers);
        // Seed the feature mapping from the model signature / bundle definition once.
        setFeatureRows((prev) => {
          if (prev.length) return prev;
          const seed: string[] = Array.isArray(j.features) ? j.features : [];
          return seed.map((f: string) => ({ feature: f, column: f }));
        });
      } catch (e: any) {
        if (!cancelled) { setPickersError(e?.message || String(e)); setPickers(null); }
      } finally {
        if (!cancelled) setPickersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, apiBase, version]);

  const passthroughColumns = useMemo(
    () => passthrough.split(',').map((c) => c.trim()).filter(Boolean),
    [passthrough],
  );

  const spec: PredictSpec = useMemo(() => ({
    modelName, version,
    inputMode, inputRef, inputFormat,
    features: featureRows.map((f) => ({ feature: f.feature.trim(), column: (f.column || f.feature).trim() })).filter((f) => f.feature),
    passthroughColumns,
    predictionColumn, resultType,
    outputMode, outputRef, writeMode,
  }), [modelName, version, inputMode, inputRef, inputFormat, featureRows, passthroughColumns, predictionColumn, resultType, outputMode, outputRef, writeMode]);

  const specError = useMemo(() => validatePredictSpec(spec), [spec]);

  // Client-side preview of the exact scoring PySpark (codegen is pure; the
  // server bakes in the azureml:// tracking URI — noted in the review).
  const previewCode = useMemo(() => {
    try { return buildPredictPySpark(spec); } catch { return null; }
  }, [spec]);

  const addFeature = useCallback(() => setFeatureRows((r) => [...r, { feature: '', column: '' }]), []);
  const removeFeature = useCallback((i: number) => setFeatureRows((r) => r.filter((_, idx) => idx !== i)), []);
  const setFeatureAt = useCallback((i: number, patch: Partial<FeatureMapping>) => {
    setFeatureRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }, []);

  // ---- Submit + poll ----
  const pollOnce = useCallback(async (runId: string): Promise<void> => {
    const r = await clientFetch(`${apiBase}/predict/status?runId=${encodeURIComponent(runId)}`);
    const j = await r.json();
    if (!j.ok) { setRun((prev) => prev ? { ...prev, done: true, ok: false, errorText: j.error || `HTTP ${r.status}` } : prev); return; }
    const out = j.output;
    const terminal = out != null || TERMINAL_SYNAPSE.includes(String(j.status)) || TERMINAL_AML.includes(String(j.status));
    const nextRunId: string = j.runId || runId;
    if (out) {
      const ok = out.status === 'ok';
      setRun({
        runId: nextRunId, backend: j.backend, status: j.status, phase: j.phase, outputRef: j.outputRef,
        done: true, ok,
        rows: j.result?.rows ?? null,
        textPlain: ok ? out.textPlain : undefined,
        errorText: ok ? undefined : `${out.ename || 'Error'}: ${out.evalue || 'scoring job failed'}`,
      });
      void loadHistory(); // the status poll just stamped a terminal history entry
      return;
    }
    // Still running — update status/runId and schedule the next poll.
    setRun((prev) => ({ ...(prev || { done: false }), runId: nextRunId, backend: j.backend, status: j.status, phase: j.phase, outputRef: j.outputRef, done: false }));
    if (!terminal) {
      setTimeout(() => { void pollOnce(nextRunId); }, 3500);
    } else {
      // Terminal state without output — surface honestly.
      setRun((prev) => prev ? { ...prev, done: true, ok: false, errorText: `Job ended in state '${j.status}' with no output` } : prev);
    }
  }, [apiBase, loadHistory]);

  const submit = useCallback(async () => {
    setSubmitting(true); setSubmitError(null); setRun(null);
    try {
      const r = await clientFetch(`${apiBase}/predict`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version, inputMode, inputRef, inputFormat,
          features: spec.features, passthroughColumns,
          predictionColumn, resultType, outputMode, outputRef, writeMode,
        }),
      });
      const j = await r.json();
      if (!j.ok) { setSubmitError(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); setSubmitting(false); return; }
      setStep(4);
      setRun({ runId: j.runId, backend: j.backend, status: j.status, outputRef: j.outputRef, done: false });
      setSubmitting(false);
      void pollOnce(j.runId);
    } catch (e: any) {
      setSubmitError(e?.message || String(e)); setSubmitting(false);
    }
  }, [apiBase, version, inputMode, inputRef, inputFormat, spec.features, passthroughColumns, predictionColumn, resultType, outputMode, outputRef, writeMode, pollOnce]);

  const stepBadges: Array<[number, string]> = [
    [1, '1 · Model'], [2, '2 · Input & mapping'], [3, '3 · Output & review'], [4, '4 · Run'],
  ];

  return (
    <div className={s.root}>
      <div className={s.steps}>
        {stepBadges.map(([n, label], i) => (
          <span key={n} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
            <Badge appearance={step === n ? 'filled' : 'tint'} color="brand">{label}</Badge>
            {i < stepBadges.length - 1 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>→</Caption1>}
          </span>
        ))}
      </div>

      <Body1 style={{ color: tokens.colorNeutralForeground3 }}>
        Batch-score a Delta table with <strong>{modelName}</strong> (Azure ML registered MLflow model) on Spark —
        the Azure-native equivalent of Fabric PREDICT. The job loads the model with <code>mlflow.pyfunc.spark_udf</code> and writes a scored Delta table.
      </Body1>

      {/* ---- Step 1: model + version ---- */}
      {step === 1 && (
        <Card className={s.card}>
          <div className={s.stepHead}><BrainCircuit20Regular /><Subtitle2>Model &amp; version</Subtitle2></div>
          <div className={s.rowWrap}>
            <Field label="Registered model">
              <Input value={modelName} disabled />
            </Field>
            <Field label="Workspace">
              <Input value={workspaceName || 'Foundry hub'} disabled />
            </Field>
            <Field label="Version to score" required>
              <Dropdown
                placeholder={versions.length ? 'Select a version' : 'No registered versions'}
                value={version ? `v${version}` : ''}
                selectedOptions={version ? [version] : []}
                onOptionSelect={(_, d) => setVersion(d.optionValue || '')}
              >
                {versions.map((v) => <Option key={v.version} value={v.version}>{`v${v.version}`}</Option>)}
              </Dropdown>
            </Field>
          </div>
          {!versions.length && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No model versions</MessageBarTitle>
                Register a model version (Versions tab) before running a batch-scoring job.
              </MessageBarBody>
            </MessageBar>
          )}
        </Card>
      )}

      {/* ---- Step 2: input + feature mapping ---- */}
      {step === 2 && (
        <Card className={s.card}>
          <div className={s.stepHead}><TableSettings20Regular /><Subtitle2>Input table &amp; feature mapping</Subtitle2></div>

          {pickers && !pickers.compute.configured && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Spark compute not configured</MessageBarTitle>
                A batch-scoring job needs Spark compute. Set <code>{pickers.compute.missing}</code>.
                You can still build the job here; submitting will return the same guidance.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={s.rowWrap}>
            <Field label="Input source">
              <Dropdown
                value={inputMode === 'delta-path' ? 'Delta path (abfss://)' : 'Registered table'}
                selectedOptions={[inputMode]}
                onOptionSelect={(_, d) => setInputMode((d.optionValue as any) || 'delta-path')}
              >
                <Option value="delta-path">Delta path (abfss://)</Option>
                <Option value="table">Registered table</Option>
              </Dropdown>
            </Field>
            {inputMode === 'delta-path' && (
              <Field label="Reader format">
                <Dropdown value={inputFormat} selectedOptions={[inputFormat]} onOptionSelect={(_, d) => setInputFormat((d.optionValue as any) || 'delta')}>
                  <Option value="delta">delta</Option>
                  <Option value="parquet">parquet</Option>
                </Dropdown>
              </Field>
            )}
          </div>

          <Field
            label={inputMode === 'delta-path' ? 'Input Delta table path' : 'Input table name'}
            required
            hint={inputMode === 'delta-path' ? 'abfss://<container>@<account>.dfs.core.windows.net/…' : 'schema.table or table'}
          >
            <Input
              value={inputRef}
              onChange={(_, d) => setInputRef(d.value)}
              placeholder={inputMode === 'delta-path' ? 'abfss://silver@acct.dfs.core.windows.net/Tables/customers' : 'sales.customers'}
            />
          </Field>

          {inputMode === 'delta-path' && pickers?.datastores?.length ? (
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', alignItems: 'center' }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Datastore roots:</Caption1>
              {pickers.datastores.slice(0, 6).map((d) => (
                <Button key={d.name} size="small" appearance="subtle" onClick={() => setInputRef(d.abfssPath)}>{d.name}</Button>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
              <Subtitle2>Feature mapping</Subtitle2>
              {pickers?.featureSource === 'signature' && <Badge appearance="tint" color="success">from model signature</Badge>}
              {pickers?.featureSource === 'bundle' && <Badge appearance="tint" color="brand">from bundle definition</Badge>}
              {pickers?.featureSource === 'none' && <Badge appearance="tint" color="warning">map manually</Badge>}
            </div>
            <Button size="small" icon={<Add16Regular />} onClick={addFeature}>Add feature</Button>
          </div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            Map each model input feature to the input table column that supplies it. Column defaults to the feature name.
          </Caption1>

          {pickersLoading && <Spinner size="tiny" label="Loading model signature + datastores…" labelPosition="after" />}
          {pickersError && <MessageBar intent="warning"><MessageBarBody>{pickersError}</MessageBarBody></MessageBar>}

          <div style={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Feature mapping">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Model feature</TableHeaderCell>
                  <TableHeaderCell>Input column</TableHeaderCell>
                  <TableHeaderCell style={{ width: '48px' }}></TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {featureRows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Input size="small" value={row.feature} placeholder="feature_name" onChange={(_, d) => setFeatureAt(i, { feature: d.value })} />
                    </TableCell>
                    <TableCell>
                      <Input size="small" value={row.column} placeholder={row.feature || 'column'} onChange={(_, d) => setFeatureAt(i, { column: d.value })} />
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Remove feature" onClick={() => removeFeature(i)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {featureRows.length === 0 && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No features yet — add one, or they seed from the model signature.</Caption1>
          )}

          <Field label="Passthrough columns (optional, comma-separated)" hint="Ids / keys / labels carried straight into the scored output.">
            <Input value={passthrough} onChange={(_, d) => setPassthrough(d.value)} placeholder="customer_id, region" />
          </Field>
        </Card>
      )}

      {/* ---- Step 3: output + review ---- */}
      {step === 3 && (
        <Card className={s.card}>
          <div className={s.stepHead}><DocumentBulletList20Regular /><Subtitle2>Output &amp; review</Subtitle2></div>
          <div className={s.rowWrap}>
            <Field label="Prediction column" required>
              <Input value={predictionColumn} onChange={(_, d) => setPredictionColumn(d.value)} />
            </Field>
            <Field label="Prediction type">
              <Dropdown value={RESULT_TYPE_LABELS[resultType]} selectedOptions={[resultType]} onOptionSelect={(_, d) => setResultType((d.optionValue as PredictResultType) || 'double')}>
                {PREDICT_RESULT_TYPES.map((t) => <Option key={t} value={t}>{RESULT_TYPE_LABELS[t]}</Option>)}
              </Dropdown>
            </Field>
          </div>
          <div className={s.rowWrap}>
            <Field label="Output destination">
              <Dropdown value={outputMode === 'delta-path' ? 'Delta path (abfss://)' : 'saveAsTable'} selectedOptions={[outputMode]} onOptionSelect={(_, d) => setOutputMode((d.optionValue as any) || 'delta-path')}>
                <Option value="delta-path">Delta path (abfss://)</Option>
                <Option value="table">saveAsTable</Option>
              </Dropdown>
            </Field>
            <Field label="Write mode">
              <Dropdown value={writeMode === 'overwrite' ? 'Overwrite' : 'Append'} selectedOptions={[writeMode]} onOptionSelect={(_, d) => setWriteMode((d.optionValue as any) || 'overwrite')}>
                <Option value="overwrite">Overwrite</Option>
                <Option value="append">Append</Option>
              </Dropdown>
            </Field>
          </div>
          <Field label={outputMode === 'delta-path' ? 'Output Delta table path' : 'Output table name'} required>
            <Input value={outputRef} onChange={(_, d) => setOutputRef(d.value)} placeholder={outputMode === 'delta-path' ? 'abfss://gold@acct.dfs.core.windows.net/Tables/customers_scored' : 'sales.customers_scored'} />
          </Field>

          <Subtitle2>Scoring job (PySpark)</Subtitle2>
          {previewCode ? (
            <div className={s.mono}>{previewCode}</div>
          ) : (
            <MessageBar intent="warning"><MessageBarBody>{specError || 'Complete the previous steps to preview the job.'}</MessageBarBody></MessageBar>
          )}
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            The server also injects <code>mlflow.set_registry_uri(&quot;azureml://…&quot;)</code> for the bound workspace so <code>models:/</code> resolves on Synapse Spark.
          </Caption1>

          <div className={s.summary}>
            <div className={s.summaryRow}><Caption1>Model</Caption1><span className={s.monoInline}>models:/{modelName}/{version}</span></div>
            <div className={s.summaryRow}><Caption1>Input</Caption1><span className={s.monoInline}>{inputRef || '—'}</span></div>
            <div className={s.summaryRow}><Caption1>Features</Caption1><span>{spec.features.length} mapped</span></div>
            <div className={s.summaryRow}><Caption1>Output</Caption1><span className={s.monoInline}>{outputRef || '—'} ({writeMode})</span></div>
          </div>
        </Card>
      )}

      {/* ---- Step 4: run ---- */}
      {step === 4 && (
        <Card className={s.card}>
          <div className={s.stepHead}><PlayCircle20Regular /><Subtitle2>Run</Subtitle2></div>
          {!run && <Spinner label="Submitting scoring job…" />}
          {run && (
            <>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge appearance="tint" color="brand">{run.backend === 'aml' ? 'AML Serverless Spark' : 'Synapse Spark'}</Badge>
                <Badge appearance="tint" color={run.done ? (run.ok ? 'success' : 'danger') : 'warning'}>{run.done ? (run.ok ? 'Completed' : 'Failed') : (run.status || 'Running')}</Badge>
                {!run.done && <Spinner size="tiny" label={run.phase === 'session-starting' ? 'Spark session cold-starting (60-90s)…' : 'Scoring…'} labelPosition="after" />}
              </div>
              {run.done && run.ok && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Scored table written</MessageBarTitle>
                    {typeof run.rows === 'number' ? `${run.rows.toLocaleString()} rows scored → ` : 'Output → '}
                    <span className={s.monoInline}>{run.outputRef}</span>
                  </MessageBarBody>
                </MessageBar>
              )}
              {run.done && run.ok && run.outputRef && (
                <div>
                  <Link href={`/workspace/lakehouse`}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}><Open16Regular /> Open in Lakehouse</span>
                  </Link>
                </div>
              )}
              {run.done && !run.ok && (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>Scoring job failed</MessageBarTitle>{run.errorText}</MessageBarBody>
                </MessageBar>
              )}
              {run.textPlain && (
                <div className={s.mono} style={{ maxHeight: 200 }}>{run.textPlain}</div>
              )}
            </>
          )}
        </Card>
      )}

      {submitError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Submit failed</MessageBarTitle>{submitError}</MessageBarBody></MessageBar>}

      {/* ---- Wizard controls ---- */}
      {step < 4 && (
        <div className={s.actions}>
          {step > 1 && <Button appearance="secondary" onClick={() => setStep((step - 1) as 1 | 2 | 3)}>Back</Button>}
          {step === 1 && <Button appearance="primary" disabled={!version} onClick={() => setStep(2)}>Next</Button>}
          {step === 2 && <Button appearance="primary" disabled={!inputRef.trim() || spec.features.length === 0} onClick={() => setStep(3)}>Next</Button>}
          {step === 3 && (
            <Button appearance="primary" disabled={!!specError || submitting} onClick={submit}>
              {submitting ? 'Submitting…' : 'Run scoring job'}
            </Button>
          )}
        </div>
      )}
      {step === 4 && run?.done && (
        <div className={s.actions}>
          <Button appearance="secondary" onClick={() => { setStep(1); setRun(null); }}>New scoring job</Button>
        </div>
      )}

      {/* ---- Run history (persisted on the item) ---- */}
      {history.length > 0 && (
        <Card className={s.card}>
          <div className={s.stepHead}><DocumentBulletList20Regular /><Subtitle2>Run history ({history.length})</Subtitle2></div>
          <div style={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Batch-scoring run history">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Compute</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Rows</TableHeaderCell>
                  <TableHeaderCell>Output</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.runId}>
                    <TableCell>{new Date(h.startedAt).toLocaleString()}</TableCell>
                    <TableCell>v{h.version}</TableCell>
                    <TableCell>{h.backend === 'aml' ? 'AML Spark' : 'Synapse Spark'}</TableCell>
                    <TableCell><Badge appearance="tint" color={runStatusColor(h.status)}>{h.status}</Badge></TableCell>
                    <TableCell>{typeof h.rows === 'number' ? h.rows.toLocaleString() : '—'}</TableCell>
                    <TableCell><span className={s.monoInline}>{h.outputRef || '—'}</span>{h.error ? <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{h.error}</Caption1> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  );
}
