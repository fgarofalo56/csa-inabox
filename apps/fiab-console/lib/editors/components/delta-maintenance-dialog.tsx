'use client';

/**
 * DeltaMaintenanceDialog — table-level Delta Lake maintenance: compaction
 * (OPTIMIZE), ZORDER BY column co-location, and VACUUM retention. Azure-native
 * parity with the Fabric Lakehouse "Maintenance" dialog — submits the same
 * three Spark SQL commands to a Synapse Spark Livy session via
 * /api/lakehouse/maintenance. The job is tracked in Monitor.
 *
 * No Fabric dependency: target storage is the DLZ ADLS Gen2 account; compute is
 * Synapse Spark. No free-form config — the Spark pool comes from the real
 * compute-targets list, retention is a fixed allowlist, and ZORDER columns are
 * picked from the table's own columns.
 */

import { useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Body1, Field, Select, Switch, Dropdown, Option, Spinner,
  MessageBar, MessageBarBody, MessageBarTitle, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Wrench20Regular, PlayCircle16Regular } from '@fluentui/react-icons';
import { useComputes } from '@/lib/components/compute-picker';
import { ALLOWED_RETENTION_HOURS } from '@/lib/azure/delta-maintenance';

const RETENTION_LABELS: Record<number, string> = {
  48: '48 hours (2 days) — use with caution',
  168: '168 hours (7 days, recommended default)',
  336: '336 hours (14 days)',
  720: '720 hours (30 days)',
  1440: '1440 hours (60 days)',
};

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '440px' },
  titleIcon: { verticalAlign: 'middle', marginRight: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
  // Elevated "Will run" preview card — reads like the polished load/mirror wizard summaries.
  preview: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    boxShadow: tokens.shadow4,
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
  },
  ops: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  monitorLink: { color: 'inherit', fontWeight: tokens.fontWeightSemibold },
  vacuumRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

interface DeltaMaintenanceDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** ADLS container (e.g. "bronze"). */
  container: string;
  /** Table name / relative path under Tables/ (e.g. "orders"). */
  tableName: string;
  /** Column names from the table DDL — used to populate the ZORDER picker. */
  columns?: string[];
}

interface RunResult {
  ok: boolean;
  jobId?: string;
  sessionId?: number;
  pool?: string;
  state?: string;
  sessionState?: string;
  ops?: string[];
  error?: string;
  hint?: string;
  code?: string;
}

export function DeltaMaintenanceDialog({ open, onOpenChange, container, tableName, columns }: DeltaMaintenanceDialogProps) {
  const s = useStyles();
  const { computes, loading: poolsLoading, error: poolsError } = useComputes(['synapse-spark']);

  const [pool, setPool] = useState('');
  const [compaction, setCompaction] = useState(true);
  const [vacuumEnabled, setVacuumEnabled] = useState(true);
  const [vacuumRetentionHours, setVacuumRetentionHours] = useState(168);
  const [zorderColumns, setZorderColumns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const cols = columns ?? [];
  const canRun = !!pool && !busy && (compaction || vacuumEnabled);

  // Operation preview chips.
  const ops: string[] = [];
  if (compaction) ops.push(zorderColumns.length ? `OPTIMIZE ZORDER BY (${zorderColumns.join(', ')})` : 'OPTIMIZE');
  if (vacuumEnabled) ops.push(`VACUUM RETAIN ${vacuumRetentionHours} HOURS`);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/lakehouse/maintenance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          container,
          tableName,
          pool,
          compaction,
          vacuumRetentionHours: vacuumEnabled ? vacuumRetentionHours : 0,
          zorderColumns: compaction ? zorderColumns : [],
        }),
      });
      let j: RunResult;
      try { j = await r.json(); }
      catch { j = { ok: false, error: `Unexpected non-JSON response (HTTP ${r.status})` }; }
      setResult(j);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>
            <Wrench20Regular className={s.titleIcon} />
            Maintain table — {tableName}
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Caption1 className={s.hint}>
                Runs Delta Lake maintenance against{' '}
                <code>{container}/Tables/{tableName}</code> on Synapse Spark. Compaction bin-packs small
                Parquet files; ZORDER BY co-locates related values for faster data-skipping; VACUUM removes
                tombstoned files past the retention window.
              </Caption1>

              <Field
                label="Spark pool"
                required
                hint={
                  poolsError
                    ? undefined
                    : computes.length === 0 && !poolsLoading
                      ? 'No Synapse Spark pools discovered. Provision a Spark pool in the workspace (LOOM_SYNAPSE_WORKSPACE).'
                      : 'OPTIMIZE / VACUUM run as Spark SQL on this pool. A paused pool warms up on first use.'
                }
                validationState={poolsError ? 'error' : undefined}
                validationMessage={poolsError || undefined}
              >
                {poolsLoading ? (
                  <Spinner size="tiny" label="Loading Spark pools…" labelPosition="after" />
                ) : (
                  <Select
                    value={pool}
                    disabled={computes.length === 0}
                    onChange={(_, d) => setPool(d.value)}
                  >
                    <option value="">{computes.length === 0 ? 'No Spark pools available' : 'Select a Spark pool'}</option>
                    {computes.map((c) => (
                      <option key={c.id} value={c.name}>{c.name}{c.state ? ` (${c.state})` : ''}</option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label="Compaction (OPTIMIZE)" hint="Bin-pack small files into ~1 GB Parquet files. Recommended after large appends.">
                <Switch
                  checked={compaction}
                  onChange={(_, d) => { setCompaction(d.checked); if (!d.checked) setZorderColumns([]); }}
                  label={compaction ? 'Run OPTIMIZE' : 'Skip OPTIMIZE'}
                />
              </Field>

              <Field
                label="ZORDER BY columns (optional)"
                hint="Co-locates related values to improve data-skipping on high-cardinality filter columns. Requires compaction."
              >
                {cols.length > 0 ? (
                  <Dropdown
                    multiselect
                    disabled={!compaction}
                    placeholder="None"
                    selectedOptions={zorderColumns}
                    value={zorderColumns.join(', ') || 'None'}
                    onOptionSelect={(_, d) => setZorderColumns(d.selectedOptions)}
                  >
                    {cols.map((col) => (
                      <Option key={col} value={col}>{col}</Option>
                    ))}
                  </Dropdown>
                ) : (
                  <Caption1 className={s.hint}>
                    Column list unavailable — schema not loaded. Maintenance will run without ZORDER BY.
                  </Caption1>
                )}
              </Field>

              <Field label="VACUUM (remove old files)" hint="Delete tombstoned data files past the retention window. Shortens time-travel history.">
                <div className={s.vacuumRow}>
                  <Switch
                    checked={vacuumEnabled}
                    onChange={(_, d) => setVacuumEnabled(d.checked)}
                    label={vacuumEnabled ? 'Run VACUUM' : 'Skip VACUUM'}
                  />
                  {vacuumEnabled && (
                    <Select
                      aria-label="Vacuum retention"
                      value={String(vacuumRetentionHours)}
                      onChange={(_, d) => setVacuumRetentionHours(Number(d.value))}
                    >
                      {ALLOWED_RETENTION_HOURS.map((h) => (
                        <option key={h} value={String(h)}>{RETENTION_LABELS[h] ?? `${h} hours`}</option>
                      ))}
                    </Select>
                  )}
                </div>
              </Field>

              {ops.length > 0 && (
                <div className={s.preview}>
                  <div className={s.previewHeader}>
                    <PlayCircle16Regular />
                    <Caption1>Will run on Synapse Spark</Caption1>
                  </div>
                  <div className={s.ops}>
                    {ops.map((op) => <Badge key={op} appearance="outline" color="brand">{op}</Badge>)}
                  </div>
                </div>
              )}

              {result?.ok && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Maintenance job submitted</MessageBarTitle>
                    Spark session {result.sessionId} on pool <strong>{result.pool}</strong>
                    {result.sessionState ? ` (${result.sessionState})` : ''}. Operations: {result.ops?.join(', ')}.{' '}
                    <a href="/monitor?tab=maintenance" className={s.monitorLink}>View in Monitor →</a>
                  </MessageBarBody>
                </MessageBar>
              )}
              {result && !result.ok && (
                <MessageBar intent={result.code && /unconfigured|access_denied|denied/.test(result.code) ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{result.code === 'adls_unconfigured' || result.code === 'livy_access_denied' ? 'Configuration required' : 'Submission failed'}</MessageBarTitle>
                    {result.error}
                    {result.hint && <><br /><Caption1>{result.hint}</Caption1></>}
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Wrench20Regular />} onClick={run} disabled={!canRun}>
              {busy ? 'Submitting…' : 'Run maintenance'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
