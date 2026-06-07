'use client';

/**
 * SessionConfigDialog — Synapse Studio "Configure session" parity for the
 * Loom notebook editor. NO freeform JSON (per loom-no-freeform-config): the
 * session is shaped with two sliders + one numeric field, never a textarea.
 *
 * The values map 1:1 onto the real Livy session-create body that
 * createLivySessionAsync sends to the Synapse Spark pool:
 *   numExecutors        ← Executors slider (1–100)
 *   executorMemory/driverMemory ← Memory slider (1–8 GB) → "<n>g"
 *   heartbeatTimeoutInSecond    ← Timeout field (minutes × 60)
 *
 * Applied via a hidden `%%configure` magic prepended to the first executed
 * cell, so the next session is (re)created with these options before the first
 * statement runs — exactly how Synapse notebooks apply %%configure.
 *
 * Learn:
 *   https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks#magic-commands
 *   https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session/create-spark-session
 */

import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Field, Slider, Input, Caption1, Badge,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Settings20Regular } from '@fluentui/react-icons';
import {
  EXEC_MIN, EXEC_MAX, MEM_MIN, MEM_MAX, TIMEOUT_MIN, TIMEOUT_MAX,
  type SessionConfig,
} from './session-config';

// Re-export the pure logic so existing importers (notebook-editor) keep a
// single import site. The implementation lives in session-config.ts (no React)
// so it can be unit-tested under a node environment.
export {
  DEFAULT_SESSION_CONFIG, EXEC_MIN, EXEC_MAX, MEM_MIN, MEM_MAX, TIMEOUT_MIN, TIMEOUT_MAX,
  normalizeSessionConfig, toConfigureOptions, sessionConfigEquals,
} from './session-config';
export type { SessionConfig, LivyConfigureOptions } from './session-config';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: 18, minWidth: 420 },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 12 },
  slider: { flex: 1 },
  valueBadge: { minWidth: 64, textAlign: 'right' },
  hint: { color: tokens.colorNeutralForeground3 },
});

interface Props {
  open: boolean;
  /** Local, in-progress config the dialog edits. */
  config: SessionConfig;
  onConfigChange: (next: SessionConfig) => void;
  onApply: () => void;
  onClose: () => void;
  /**
   * Pool auto-scale ceiling (Dynamic Executor Allocation maxExecutors), when
   * known. Surfaces an honest "requests above this are clamped" note.
   */
  poolMaxExecutors?: number;
}

export function SessionConfigDialog({ open, config, onConfigChange, onApply, onClose, poolMaxExecutors }: Props) {
  const s = useStyles();
  const c = config;
  const set = (patch: Partial<SessionConfig>) => onConfigChange({ ...c, ...patch });

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Configure session</DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Field label={`Executors (${EXEC_MIN}–${EXEC_MAX})`}
                hint="Number of Spark executors allocated to this session.">
                <div className={s.sliderRow}>
                  <Slider className={s.slider} aria-label="Executors"
                    min={EXEC_MIN} max={EXEC_MAX} step={1}
                    value={c.numExecutors}
                    onChange={(_, d) => set({ numExecutors: d.value })} />
                  <Badge className={s.valueBadge} appearance="tint" color="brand">
                    {c.numExecutors}
                  </Badge>
                </div>
              </Field>

              <Field label={`Executor memory (${MEM_MIN}–${MEM_MAX} GB)`}
                hint="Memory per executor (and driver) — sent to Livy as e.g. 4g.">
                <div className={s.sliderRow}>
                  <Slider className={s.slider} aria-label="Executor memory"
                    min={MEM_MIN} max={MEM_MAX} step={1}
                    value={c.executorMemoryGb}
                    onChange={(_, d) => set({ executorMemoryGb: d.value })} />
                  <Badge className={s.valueBadge} appearance="tint" color="brand">
                    {c.executorMemoryGb} GB
                  </Badge>
                </div>
              </Field>

              <Field label={`Session timeout (minutes, ${TIMEOUT_MIN}–${TIMEOUT_MAX})`}
                hint="Idle timeout before the Spark session is released (Livy heartbeatTimeoutInSecond).">
                <Input type="number" aria-label="Session timeout in minutes"
                  min={TIMEOUT_MIN} max={TIMEOUT_MAX}
                  value={String(c.timeoutMinutes)}
                  onChange={(_, d) => {
                    const n = parseInt(d.value, 10);
                    set({ timeoutMinutes: Number.isFinite(n) ? n : c.timeoutMinutes });
                  }} />
              </Field>

              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>High-concurrency note</MessageBarTitle>
                  For high-concurrency workloads, set executors at or above the pool&apos;s
                  node count. Dynamic Executor Allocation (DEA) is enabled on the pool and
                  may override this count unless you also set
                  {' '}<code>spark.dynamicAllocation.enabled=false</code> in the pool&apos;s
                  Spark configuration.
                  {typeof poolMaxExecutors === 'number' && (
                    <>
                      {' '}
                      <Caption1 className={s.hint}>
                        Pool auto-scale max is {poolMaxExecutors}; requests above this are
                        clamped by the Spark pool.
                      </Caption1>
                    </>
                  )}
                </MessageBarBody>
              </MessageBar>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" icon={<Settings20Regular />} onClick={onApply}>
              Apply
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
