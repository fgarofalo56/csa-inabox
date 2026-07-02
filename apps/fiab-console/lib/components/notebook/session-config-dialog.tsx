'use client';

/**
 * SessionConfigDialog — Synapse Studio "Configure session" parity + a Spark
 * config BUILDER for the Loom notebook. Two parts:
 *   1. A best-practice PRESET picker (different configs for different work
 *      types) — applies sizing + curated spark.* confs in one click.
 *   2. A structured key/value Spark-config builder (one row per spark.* prop) —
 *      NO freeform JSON textarea (per loom-no-freeform-config).
 *
 * The sizing maps 1:1 onto the Livy session-create body; the spark confs map
 * onto the Livy session `conf`. The run route also merges the Synapse→Loom Log
 * Analytics diagnostic confs so every session ships logs/metrics to Loom LA.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-azure-create-spark-configuration
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/data-collector-api-to-log-ingestion-api
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 */

import { useState, useEffect } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Slider, Input, Caption1, Badge, Divider, Tooltip,
  Select, MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Settings20Regular, Add16Regular, Delete16Regular, Sparkle16Regular } from '@fluentui/react-icons';
import {
  EXEC_MIN, EXEC_MAX, MEM_MIN, MEM_MAX, TIMEOUT_MIN, TIMEOUT_MAX,
  type SessionConfig,
} from './session-config';
import { SPARK_PRESETS, synapseConfFor, findPreset, COMMON_SPARK_CONF_KEYS } from '@/lib/spark/config-presets';

// Re-export the pure logic so existing importers (notebook-editor) keep a
// single import site. The implementation lives in session-config.ts (no React)
// so it can be unit-tested under a node environment.
export {
  DEFAULT_SESSION_CONFIG, EXEC_MIN, EXEC_MAX, MEM_MIN, MEM_MAX, TIMEOUT_MIN, TIMEOUT_MAX,
  normalizeSessionConfig, toConfigureOptions, sessionConfigEquals,
} from './session-config';
export type { SessionConfig, LivyConfigureOptions } from './session-config';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '480px', maxWidth: '560px', maxHeight: '70vh', overflowY: 'auto' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  slider: { flex: 1, minWidth: 0 },
  valueBadge: { minWidth: '64px', textAlign: 'right' },
  hint: { color: tokens.colorNeutralForeground3 },
  presetDesc: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  confHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, justifyContent: 'space-between' },
  confRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  confKey: { flex: '1 1 55%', minWidth: 0 },
  confVal: { flex: '1 1 45%', minWidth: 0 },
  confList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  empty: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontStyle: 'italic' },
});

interface Props {
  open: boolean;
  config: SessionConfig;
  onConfigChange: (next: SessionConfig) => void;
  onApply: () => void;
  onClose: () => void;
  poolMaxExecutors?: number;
}

interface ConfRow { id: number; key: string; value: string; }
let rowSeq = 1;
const recordToRows = (rec: Record<string, string> | undefined): ConfRow[] =>
  Object.entries(rec || {}).map(([key, value]) => ({ id: rowSeq++, key, value }));
const rowsToRecord = (rows: ConfRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) { const k = r.key.trim(); if (k) out[k] = r.value; }
  return out;
};

export function SessionConfigDialog({ open, config, onConfigChange, onApply, onClose, poolMaxExecutors }: Props) {
  const s = useStyles();
  const c = config;
  const set = (patch: Partial<SessionConfig>) => onConfigChange({ ...c, ...patch });

  // Local rows mirror config.sparkConf so the user can type partial keys without
  // collapsing the record mid-edit. Re-seed when the dialog (re)opens.
  const [rows, setRows] = useState<ConfRow[]>(() => recordToRows(config.sparkConf));
  useEffect(() => { if (open) setRows(recordToRows(config.sparkConf)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  const pushRows = (next: ConfRow[], clearPreset = true) => {
    setRows(next);
    onConfigChange({ ...c, sparkConf: rowsToRecord(next), ...(clearPreset ? { presetId: undefined } : {}) });
  };

  const applyPreset = (id: string) => {
    const p = findPreset(id);
    if (!p) return;
    const confRows = recordToRows(synapseConfFor(p));
    setRows(confRows);
    onConfigChange({
      ...c,
      numExecutors: p.synapse.numExecutors,
      executorMemoryGb: p.synapse.executorMemoryGb,
      timeoutMinutes: p.synapse.timeoutMinutes,
      sparkConf: rowsToRecord(confRows),
      presetId: p.id,
    });
  };

  const activePreset = findPreset(c.presetId);

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Configure Spark session</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {/* 1) Best-practice preset picker — different configs per work type */}
              <Field
                label="Configuration preset"
                hint={activePreset ? activePreset.whenToUse : 'Pick a best-practice profile for your work type, then fine-tune below.'}
              >
                <Select
                  value={c.presetId || ''}
                  onChange={(_, d) => { if (d.value) applyPreset(d.value); }}
                  aria-label="Spark configuration preset"
                >
                  <option value="">Custom (no preset)</option>
                  {SPARK_PRESETS.filter((p) => p.targets.includes('synapse')).map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </Select>
              </Field>
              {activePreset && (
                <Caption1 className={s.presetDesc}>{activePreset.summary}</Caption1>
              )}

              <Divider />

              <Field label={`Executors (${EXEC_MIN}–${EXEC_MAX})`} hint="Number of Spark executors allocated to this session.">
                <div className={s.sliderRow}>
                  <Slider className={s.slider} aria-label="Executors" min={EXEC_MIN} max={EXEC_MAX} step={1}
                    value={c.numExecutors} onChange={(_, d) => set({ numExecutors: d.value })} />
                  <Badge className={s.valueBadge} appearance="tint" color="brand">{c.numExecutors}</Badge>
                </div>
              </Field>

              <Field label={`Executor memory (${MEM_MIN}–${MEM_MAX} GB)`} hint="Memory per executor (and driver) — sent to Livy as e.g. 4g.">
                <div className={s.sliderRow}>
                  <Slider className={s.slider} aria-label="Executor memory" min={MEM_MIN} max={MEM_MAX} step={1}
                    value={c.executorMemoryGb} onChange={(_, d) => set({ executorMemoryGb: d.value })} />
                  <Badge className={s.valueBadge} appearance="tint" color="brand">{c.executorMemoryGb} GB</Badge>
                </div>
              </Field>

              <Field label={`Session timeout (minutes, ${TIMEOUT_MIN}–${TIMEOUT_MAX})`} hint="Idle timeout before the Spark session is released (Livy heartbeatTimeoutInSecond).">
                <Input type="number" aria-label="Session timeout in minutes" min={TIMEOUT_MIN} max={TIMEOUT_MAX}
                  value={String(c.timeoutMinutes)} onChange={(_, d) => { const n = parseInt(d.value, 10); set({ timeoutMinutes: Number.isFinite(n) ? n : c.timeoutMinutes }); }} />
              </Field>

              <Divider />

              {/* 2) Structured spark.* config builder (key/value rows — no JSON) */}
              <div className={s.confHeader}>
                <div style={{ minWidth: 0 }}>
                  <Caption1 style={{ fontWeight: tokens.fontWeightSemibold }}>Spark configuration</Caption1>
                  <Caption1 className={s.hint} style={{ display: 'block' }}>Structured spark.* properties applied to the session (Livy conf).</Caption1>
                </div>
                <Button size="small" appearance="outline" icon={<Add16Regular />}
                  onClick={() => setRows((r) => [...r, { id: rowSeq++, key: '', value: '' }])}>
                  Add property
                </Button>
              </div>

              {rows.length === 0 ? (
                <Caption1 className={s.empty}>No custom Spark properties. Pick a preset above or add a property.</Caption1>
              ) : (
                <div className={s.confList}>
                  {/* native datalist of common keys for autocomplete */}
                  <datalist id="loom-spark-conf-keys">
                    {COMMON_SPARK_CONF_KEYS.map((k) => <option key={k.key} value={k.key}>{k.hint}</option>)}
                  </datalist>
                  {rows.map((row, i) => {
                    const known = COMMON_SPARK_CONF_KEYS.find((k) => k.key === row.key.trim());
                    return (
                      <div key={row.id} className={s.confRow}>
                        <Tooltip content={known ? known.hint : 'spark.* property key'} relationship="label">
                          <Input className={s.confKey} aria-label={`Spark property key ${i + 1}`} placeholder="spark.sql.shuffle.partitions"
                            list="loom-spark-conf-keys" value={row.key}
                            onChange={(_, d) => pushRows(rows.map((r) => r.id === row.id ? { ...r, key: d.value } : r))} />
                        </Tooltip>
                        <Input className={s.confVal} aria-label={`Spark property value ${i + 1}`} placeholder="value"
                          value={row.value}
                          onChange={(_, d) => pushRows(rows.map((r) => r.id === row.id ? { ...r, value: d.value } : r))} />
                        <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Remove property"
                          onClick={() => pushRows(rows.filter((r) => r.id !== row.id))} />
                      </div>
                    );
                  })}
                </div>
              )}

              <MessageBar intent="info">
                <MessageBarBody style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <MessageBarTitle><Sparkle16Regular /> Diagnostics</MessageBarTitle>
                  Every Loom Spark session automatically ships its logs, metrics, and listener
                  events to the Loom Log Analytics workspace (when configured) — view them under
                  Monitor → Spark. Dynamic Executor Allocation may override the executor count
                  unless you add <code>spark.dynamicAllocation.enabled=false</code>.
                  {typeof poolMaxExecutors === 'number' && (
                    <> <Caption1 className={s.hint}>Pool auto-scale max is {poolMaxExecutors}; higher requests are clamped.</Caption1></>
                  )}
                </MessageBarBody>
              </MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={<Settings20Regular />} onClick={onApply}>Apply</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
