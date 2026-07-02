'use client';

/**
 * LoadToTableWizard — no-code, multi-step wizard to load a CSV / Parquet /
 * JSON (and ORC / Avro / text) file from a Lakehouse container into a managed
 * Delta table via a Synapse Spark (Livy) job.
 *
 * Mirrors the Fabric "Load to Tables" experience: pick the source file →
 * name the table + choose compute → set write mode → run, with a job toast
 * linking to Monitor. Azure-native (Synapse Spark), no Fabric dependency.
 *
 * Backend: POST /api/lakehouse/load-to-table (real Livy submission). Compute
 * is picked from GET /api/loom/compute-targets (no freeform pool input).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  DocumentTable20Regular,
  DocumentArrowRight20Regular,
  TableSettings20Regular,
  PlayCircle20Regular,
} from '@fluentui/react-icons';
import { detectSparkFormat } from '@/lib/azure/spark-format-detect';
import {
  SUPPORTED_LOAD_FORMATS,
  type LoadFormat,
  suggestTableName,
  validateLoadTableName,
} from '@/lib/azure/load-to-table-codegen';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '480px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  titleIcon: { display: 'inline-flex', color: tokens.colorBrandForeground1 },
  steps: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', marginBottom: tokens.spacingVerticalXS },
  stepHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  detect: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  summary: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalL },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalXXL },
});

interface ComputeTarget { id: string; name: string; kind: string; state?: string }

export interface LoadToTableWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Container the file lives in (bronze|silver|gold|landing). */
  container: string;
  /** Path within the container, e.g. "Files/sales.csv". */
  path: string;
  /** Called after the Spark job is accepted; receives the Livy job id + table. */
  onJobSubmitted?: (info: { jobId: string; tableName: string; rowCount: number | null }) => void;
}

const FORMAT_LABELS: Record<LoadFormat, string> = {
  csv: 'CSV', parquet: 'Parquet', json: 'JSON', orc: 'ORC', avro: 'Avro', text: 'Text',
};

export function LoadToTableWizard(props: LoadToTableWizardProps) {
  const s = useStyles();
  const { open, onOpenChange, container, path } = props;

  const hint = useMemo(() => detectSparkFormat(path), [path]);
  const detectedFormat = useMemo<LoadFormat | null>(() => {
    const f = hint.format.toLowerCase();
    return (SUPPORTED_LOAD_FORMATS as readonly string[]).includes(f) ? (f as LoadFormat) : null;
  }, [hint]);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [tableName, setTableName] = useState('');
  const [writeMode, setWriteMode] = useState<'overwrite' | 'append'>('overwrite');
  const [format, setFormat] = useState<LoadFormat>('csv');
  const [poolName, setPoolName] = useState('');

  const [pools, setPools] = useState<ComputeTarget[] | null>(null);
  const [poolsError, setPoolsError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset / seed state whenever the wizard opens for a (new) file.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setTableName(suggestTableName(path));
    setWriteMode('overwrite');
    setFormat(detectedFormat ?? 'csv');
    setPoolName('');
    setSubmitting(false);
    setSubmitError(null);
  }, [open, path, detectedFormat]);

  // Load Spark pools when entering step 2.
  useEffect(() => {
    if (!open || step !== 2 || pools !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/loom/compute-targets');
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) { setPoolsError(j.error || `HTTP ${r.status}`); setPools([]); return; }
        const spark = (j.computes as ComputeTarget[]).filter((c) => c.kind === 'synapse-spark');
        setPools(spark);
        if (spark.length && !poolName) setPoolName(spark[0].name.replace(/ \(Synapse Spark\)$/, ''));
      } catch (e: any) {
        if (!cancelled) { setPoolsError(e?.message || String(e)); setPools([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, step, pools, poolName]);

  const nameErr = validateLoadTableName(tableName);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch('/api/lakehouse/load-to-table', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ container, path, tableName, writeMode, poolName, format }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json')
        ? await r.json()
        : { ok: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
      if (!j.ok) { setSubmitError(j.error || `HTTP ${r.status}`); setSubmitting(false); return; }
      props.onJobSubmitted?.({ jobId: j.job.id, tableName, rowCount: j.job.rowCount ?? null });
      onOpenChange(false);
    } catch (e: any) {
      setSubmitError(e?.message || String(e));
    } finally {
      setSubmitting(false);
    }
  }, [container, path, tableName, writeMode, poolName, format, props, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!submitting) onOpenChange(d.open); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <span className={s.titleRow}>
              <span className={s.titleIcon}><DocumentTable20Regular /></span>
              Load to table — {path.split('/').pop()}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <div className={s.steps}>
                <Badge appearance={step === 1 ? 'filled' : 'tint'} color="brand">1 · Source</Badge>
                <Caption1>→</Caption1>
                <Badge appearance={step === 2 ? 'filled' : 'tint'} color="brand">2 · Table &amp; compute</Badge>
                <Caption1>→</Caption1>
                <Badge appearance={step === 3 ? 'filled' : 'tint'} color="brand">3 · Run</Badge>
              </div>

              {submitting && (
                <div className={s.center}>
                  <Spinner label="Submitting to Synapse Spark (Livy)…" />
                  <Caption1>Cold-starting an auto-paused pool can take 60-90s. Keep this open.</Caption1>
                </div>
              )}

              {/* ---- Step 1: source ---- */}
              {!submitting && step === 1 && (
                <>
                  <div className={s.stepHead}><DocumentArrowRight20Regular /><Subtitle2>Source file</Subtitle2></div>
                  <Field label="Source file">
                    <div className={s.mono}>{container}/{path}</div>
                  </Field>
                  <div className={s.detect}>
                    <Caption1>Detected format:</Caption1>
                    <Badge appearance="tint" color={detectedFormat ? 'brand' : 'warning'}>{hint.label}</Badge>
                    {detectedFormat ? (
                      <Badge appearance="tint" color="success">Spark native</Badge>
                    ) : (
                      <Badge appearance="tint" color="warning">override in step 2</Badge>
                    )}
                  </div>
                  {!detectedFormat && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Format not directly loadable</MessageBarTitle>
                        The no-code wizard loads CSV, Parquet, JSON, ORC, Avro and text. Pick one in
                        the next step if this file is one of those; otherwise use a notebook.
                      </MessageBarBody>
                    </MessageBar>
                  )}
                  <Body1>
                    This creates a managed Delta table under <code>{container}/Tables/</code> by
                    running a Spark job. It will appear in the Tables tab and be queryable from a
                    notebook.
                  </Body1>
                </>
              )}

              {/* ---- Step 2: table + compute ---- */}
              {!submitting && step === 2 && (
                <>
                  <div className={s.stepHead}><TableSettings20Regular /><Subtitle2>Table &amp; compute</Subtitle2></div>
                  <Field
                    label="Table name"
                    validationState={nameErr ? 'error' : 'none'}
                    validationMessage={nameErr || 'Lowercase letters, digits and underscores; starts with a letter.'}
                  >
                    <Input value={tableName} onChange={(_, d) => setTableName(d.value)} />
                  </Field>

                  <Field label="Source format">
                    <Dropdown
                      selectedOptions={[format]}
                      value={FORMAT_LABELS[format]}
                      onOptionSelect={(_, d) => d.optionValue && setFormat(d.optionValue as LoadFormat)}
                    >
                      {SUPPORTED_LOAD_FORMATS.map((f) => (
                        <Option key={f} value={f}>{FORMAT_LABELS[f]}</Option>
                      ))}
                    </Dropdown>
                  </Field>

                  <Field label="Spark pool (compute)">
                    {pools === null ? (
                      <Spinner size="tiny" label="Discovering Spark pools…" labelPosition="after" />
                    ) : pools.length === 0 ? (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>No Spark pools found</MessageBarTitle>
                          {poolsError
                            ? poolsError
                            : 'Deploy the loompool Synapse Spark pool (platform/fiab/bicep/modules/landing-zone/synapse.bicep, deploySparkPool=true).'}
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <Dropdown
                        selectedOptions={poolName ? [poolName] : []}
                        value={poolName}
                        placeholder="Select a Spark pool"
                        onOptionSelect={(_, d) => d.optionValue && setPoolName(d.optionValue)}
                      >
                        {pools.map((p) => {
                          const name = p.name.replace(/ \(Synapse Spark\)$/, '');
                          return <Option key={p.id} value={name}>{name}</Option>;
                        })}
                      </Dropdown>
                    )}
                  </Field>
                  <Caption1>
                    Schema is inferred on first read. Add a notebook afterwards to apply explicit types.
                  </Caption1>
                </>
              )}

              {/* ---- Step 3: write mode + summary ---- */}
              {!submitting && step === 3 && (
                <>
                  <div className={s.stepHead}><PlayCircle20Regular /><Subtitle2>Write mode &amp; run</Subtitle2></div>
                  <Field label="Write mode">
                    <Dropdown
                      selectedOptions={[writeMode]}
                      value={writeMode === 'overwrite' ? 'Overwrite (replace table data)' : 'Append (add rows)'}
                      onOptionSelect={(_, d) => d.optionValue && setWriteMode(d.optionValue as 'overwrite' | 'append')}
                    >
                      <Option value="overwrite">Overwrite (replace table data)</Option>
                      <Option value="append">Append (add rows)</Option>
                    </Dropdown>
                  </Field>
                  <div className={s.summary}>
                    <div className={s.row}><Caption1>Source</Caption1><span className={s.mono}>{container}/{path}</span></div>
                    <div className={s.row}><Caption1>Target table</Caption1><span className={s.mono}>{tableName} (Delta)</span></div>
                    <div className={s.row}><Caption1>Format</Caption1><span>{FORMAT_LABELS[format]}</span></div>
                    <div className={s.row}><Caption1>Spark pool</Caption1><span>{poolName}</span></div>
                    <div className={s.row}><Caption1>Mode</Caption1><span>{writeMode === 'overwrite' ? 'Overwrite' : 'Append'}</span></div>
                  </div>
                  <Caption1>The Spark pool may cold-start (60-90s) if auto-paused.</Caption1>
                </>
              )}

              {submitError && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Load failed</MessageBarTitle>
                    {submitError}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</Button>
            {step > 1 && (
              <Button appearance="secondary" disabled={submitting} onClick={() => setStep((step - 1) as 1 | 2 | 3)}>Back</Button>
            )}
            {step < 3 && (
              <Button
                appearance="primary"
                disabled={submitting || (step === 2 && (!!nameErr || !poolName))}
                onClick={() => setStep((step + 1) as 1 | 2 | 3)}
              >
                Next
              </Button>
            )}
            {step === 3 && (
              <Button appearance="primary" disabled={submitting || !!nameErr || !poolName} onClick={submit}>
                {submitting ? 'Running…' : 'Run'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
