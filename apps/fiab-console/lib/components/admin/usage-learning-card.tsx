'use client';

/**
 * PERF-4.4 — usage-based learning card (on /admin/performance).
 *
 * Shows the REAL learned hour-of-week demand heatmap (EWMA histograms recorded
 * off every warm-pool acquire), the resulting warm/sleep schedule preview, and
 * the full set of admin controls: master enable (default ON), sensitivity
 * slider, per-workspace opt-out, and manual warm/sleep schedule overrides —
 * all persisted in the perf-tunables Cosmos doc and consumed live by the
 * pre-warm loop. Fluent v9 + Loom tokens only (web3-ui.md); real data via
 * /api/admin/performance/tunables (no-vaporware.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Slider,
  SpinButton,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { BrainCircuit20Regular, Add20Regular, Delete20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface ScheduleOverride {
  days?: number[];
  startHour: number;
  endHour: number;
  mode: 'warm' | 'sleep';
}
interface LearningConfig {
  enabled: boolean;
  sensitivity: number;
  halfLifeWeeks: number;
  minDataWeight: number;
  lookAheadHours: number;
  workspaces: Record<string, boolean>;
  overrides: ScheduleOverride[];
}
interface Heatmap {
  scope: string;
  poolKey: string;
  weights: number[];
  total: number;
  events: number;
  updatedAt: number;
}
interface Decision {
  target: number;
  rule: string;
  score: number;
}
interface Model {
  tunables: { learning: LearningConfig };
  heatmaps: Heatmap[];
  schedule: { poolKey: string; decisions: Decision[] } | null;
}

const useStyles = makeStyles({
  controls: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  sliderWrap: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, minWidth: '280px' },
  heatWrap: { overflowX: 'auto', paddingBottom: tokens.spacingVerticalS },
  heatGrid: {
    display: 'grid',
    gridTemplateColumns: `max-content repeat(24, minmax(14px, 1fr))`,
    gap: '2px',
    minWidth: '520px',
  },
  heatCell: {
    height: '18px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorBrandBackground,
  },
  heatEmpty: {
    height: '18px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  heatLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    display: 'flex',
    alignItems: 'center',
    paddingRight: tokens.spacingHorizontalS,
  },
  hourHead: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    textAlign: 'center',
  },
  legend: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  overrideRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  addForm: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  field: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  spin: { width: '90px' },
  muted: { color: tokens.colorNeutralForeground3 },
  bar: { marginBottom: tokens.spacingVerticalM },
  section: { marginTop: tokens.spacingVerticalL },
});

export function UsageLearningCard() {
  const styles = useStyles();
  const [model, setModel] = useState<Model | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Local slider state so dragging doesn't POST per pixel.
  const [sensitivity, setSensitivity] = useState<number | null>(null);
  // Add-override form.
  const [ovDay, setOvDay] = useState<string>('all');
  const [ovStart, setOvStart] = useState(8);
  const [ovEnd, setOvEnd] = useState(18);
  const [ovMode, setOvMode] = useState<'warm' | 'sleep'>('warm');

  const load = useCallback(() => {
    setLoading(true);
    clientFetch('/api/admin/performance/tunables', { cache: 'no-store' }, 30_000)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok) {
          setModel(j as Model);
          setSensitivity((j.tunables?.learning?.sensitivity as number) ?? 0.35);
        } else setErr(j?.error || 'Failed to load learning data');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const patchLearning = useCallback(
    (patch: Partial<LearningConfig>, okNote?: string) => {
      setBusy(true);
      setErr(null);
      setNote(null);
      clientFetch(
        '/api/admin/performance/tunables',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ learning: patch }) },
        30_000,
      )
        .then(async (r) => {
          const j = await r.json();
          if (r.status === 403) {
            setErr('Tenant admin required to change learning settings.');
            return;
          }
          if (j?.ok) {
            setModel(j as Model);
            setSensitivity((j.tunables?.learning?.sensitivity as number) ?? 0.35);
            if (okNote) setNote(okNote);
          } else setErr(j?.error || 'Save failed');
        })
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [],
  );

  const learning = model?.tunables?.learning;

  // The aggregate heatmap: sum every learning-enabled scope's weights.
  const aggregate = useMemo(() => {
    if (!model?.heatmaps?.length) return null;
    const weights = new Array<number>(168).fill(0);
    // Prefer per-workspace docs; use global only when no workspace data exists.
    const wsDocs = model.heatmaps.filter((h) => h.scope !== 'global' && learning?.workspaces?.[h.scope] !== false);
    const src = wsDocs.length > 0 ? wsDocs : model.heatmaps.filter((h) => h.scope === 'global');
    for (const h of src) for (let i = 0; i < 168; i++) weights[i] += h.weights[i] ?? 0;
    const max = Math.max(...weights);
    const total = weights.reduce((a, b) => a + b, 0);
    return { weights, max, total };
  }, [model, learning]);

  const workspaceScopes = useMemo(
    () => [...new Set((model?.heatmaps ?? []).map((h) => h.scope).filter((sc) => sc !== 'global'))],
    [model],
  );

  const removeOverride = useCallback(
    (idx: number) => {
      if (!learning) return;
      const overrides = learning.overrides.filter((_, i) => i !== idx);
      patchLearning({ overrides }, 'Override removed — the pre-warm loop follows the learned schedule again in that window.');
    },
    [learning, patchLearning],
  );

  const addOverride = useCallback(() => {
    if (!learning) return;
    const next: ScheduleOverride = {
      ...(ovDay === 'all' ? {} : { days: [Number(ovDay)] }),
      startHour: ovStart,
      endHour: ovEnd,
      mode: ovMode,
    };
    patchLearning(
      { overrides: [...learning.overrides, next] },
      `Override added — ${ovMode === 'warm' ? 'forced warm' : 'forced sleep'} ${ovDay === 'all' ? 'every day' : DAYS[Number(ovDay)]} ${ovStart}:00-${ovEnd}:00 UTC.`,
    );
  }, [learning, ovDay, ovStart, ovEnd, ovMode, patchLearning]);

  const learn = (
    <LearnPopover
      title="Usage-based learning (PERF-4.4)"
      content="Every warm-pool acquire (hit or miss) is recorded as demand into an EWMA hour-of-week histogram (half-life configurable, default 2 weeks). The learned schedule boosts the warm target ahead of predicted-busy windows and lets the pool sleep in confidently-dead hours; manual overrides beat both. Default ON with conservative sensitivity — with too little data the behaviour is exactly the admin-configured pool min. All times are UTC."
      learnMoreHref="https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools"
    />
  );

  return (
    <Section title="Usage-based warm scheduling" actions={learn}>
      {err && (
        <MessageBar intent="error" className={styles.bar}>
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {note && (
        <MessageBar intent="success" className={styles.bar}>
          <MessageBarBody>{note}</MessageBarBody>
        </MessageBar>
      )}

      {loading || !learning ? (
        <Spinner label="Loading learned schedule…" />
      ) : (
        <>
          <div className={styles.controls}>
            <div className={styles.row}>
              <Switch
                checked={learning.enabled}
                disabled={busy}
                label={learning.enabled ? 'Learning enabled (default-ON)' : 'Learning disabled'}
                onChange={(_, d) =>
                  patchLearning(
                    { enabled: !!d.checked },
                    d.checked
                      ? 'Learning re-enabled — the pre-warm loop follows the learned schedule.'
                      : 'Learning disabled — the pool holds the fixed admin min at all hours.',
                  )
                }
              />
              <Badge appearance="tint" color={learning.enabled ? 'success' : 'danger'}>
                {learning.enabled ? 'ON' : 'OFF'}
              </Badge>
              <span aria-hidden>
                <BrainCircuit20Regular />
              </span>
              <Caption1 className={styles.muted}>
                {aggregate ? `${Math.round(aggregate.total)} weighted events learned` : 'no usage recorded yet'}
              </Caption1>
            </div>

            <div className={styles.row}>
              <div className={styles.sliderWrap}>
                <Caption1>Sensitivity</Caption1>
                <Slider
                  min={0}
                  max={100}
                  value={Math.round((sensitivity ?? 0.35) * 100)}
                  disabled={busy || !learning.enabled}
                  onChange={(_, d) => setSensitivity(d.value / 100)}
                />
                <Badge appearance="outline">{Math.round((sensitivity ?? 0.35) * 100)}%</Badge>
              </div>
              <Button
                appearance="secondary"
                disabled={busy || !learning.enabled || sensitivity === null || sensitivity === learning.sensitivity}
                onClick={() =>
                  sensitivity !== null &&
                  patchLearning({ sensitivity }, `Sensitivity set to ${Math.round(sensitivity * 100)}% — busy threshold is now ${Math.round((1 - sensitivity) * 100)}% of peak demand.`)
                }
              >
                Save sensitivity
              </Button>
              <Caption1 className={styles.muted}>
                Higher = warms more hours (busy at ≥{Math.round((1 - (sensitivity ?? 0.35)) * 100)}% of peak). Conservative default 35%.
              </Caption1>
            </div>
          </div>

          <Text weight="semibold">Learned demand heatmap (hour-of-week, UTC)</Text>
          {aggregate && aggregate.max > 0 ? (
            <>
              <div className={styles.heatWrap}>
                <div className={styles.heatGrid}>
                  <span />
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className={styles.hourHead}>
                      {h % 6 === 0 ? h : ''}
                    </span>
                  ))}
                  {DAYS.map((day, d) => (
                    <Fragment key={day}>
                      <span className={styles.heatLabel}>
                        {day}
                      </span>
                      {Array.from({ length: 24 }, (_, h) => {
                        const w = aggregate.weights[d * 24 + h];
                        const intensity = aggregate.max > 0 ? w / aggregate.max : 0;
                        return w > 0 ? (
                          <span
                            key={`${d}-${h}`}
                            className={styles.heatCell}
                            style={{ opacity: 0.15 + 0.85 * intensity }}
                            title={`${day} ${h}:00 UTC — weight ${w.toFixed(1)} (${Math.round(intensity * 100)}% of peak)`}
                          />
                        ) : (
                          <span key={`${d}-${h}`} className={styles.heatEmpty} title={`${day} ${h}:00 UTC — no demand learned`} />
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
              <div className={styles.legend}>
                <Caption1 className={styles.muted}>cell intensity = EWMA demand relative to the peak hour</Caption1>
                {model?.schedule && (
                  <Badge appearance="outline" color="brand">
                    schedule preview: {model.schedule.decisions.filter((x) => x.rule === 'busy').length}h boosted ·{' '}
                    {model.schedule.decisions.filter((x) => x.rule === 'dead' || x.rule === 'override-sleep').length}h sleeping
                  </Badge>
                )}
              </div>
            </>
          ) : (
            <MessageBar intent="info" className={styles.bar} layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>No usage learned yet</MessageBarTitle>
                Demand is recorded from every warm-pool session acquire (notebook runs). Until the histogram
                reaches {learning.minDataWeight} weighted events the pool simply holds the admin-configured min —
                behaviour is unchanged while the schedule learns.
              </MessageBarBody>
            </MessageBar>
          )}

          {workspaceScopes.length > 0 && (
            <div className={styles.section}>
              <Text weight="semibold">Per-workspace learning</Text>
              <div className={styles.controls}>
                {workspaceScopes.map((ws) => (
                  <div key={ws} className={styles.row}>
                    <Switch
                      checked={learning.workspaces[ws] !== false}
                      disabled={busy || !learning.enabled}
                      label={ws}
                      onChange={(_, d) =>
                        patchLearning(
                          { workspaces: { ...learning.workspaces, [ws]: !!d.checked } },
                          `Workspace ${ws} ${d.checked ? 'included in' : 'excluded from'} the learned schedule.`,
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.section}>
            <Text weight="semibold">Manual schedule overrides (beat the learned prediction)</Text>
            <div className={styles.controls}>
              {learning.overrides.length === 0 && (
                <Caption1 className={styles.muted}>None — the learned schedule alone drives warm/sleep.</Caption1>
              )}
              {learning.overrides.map((o, i) => (
                <div key={i} className={styles.overrideRow}>
                  <Badge appearance="tint" color={o.mode === 'warm' ? 'success' : 'warning'}>
                    {o.mode === 'warm' ? 'force warm' : 'force sleep'}
                  </Badge>
                  <Caption1>
                    {o.days && o.days.length > 0 ? o.days.map((d) => DAYS[d]).join(', ') : 'Every day'} · {o.startHour}:00-
                    {o.endHour}:00 UTC
                  </Caption1>
                  <Button
                    appearance="subtle"
                    icon={<Delete20Regular />}
                    aria-label="Remove override"
                    disabled={busy}
                    onClick={() => removeOverride(i)}
                  />
                </div>
              ))}
              <div className={styles.addForm}>
                <div className={styles.field}>
                  <Caption1>Day</Caption1>
                  <Dropdown
                    value={ovDay === 'all' ? 'Every day' : DAYS[Number(ovDay)]}
                    selectedOptions={[ovDay]}
                    onOptionSelect={(_, d) => setOvDay(d.optionValue ?? 'all')}
                    disabled={busy}
                  >
                    <Option value="all">Every day</Option>
                    {DAYS.map((d, i) => (
                      <Option key={d} value={String(i)}>
                        {d}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Caption1>From (UTC)</Caption1>
                  <SpinButton
                    className={styles.spin}
                    value={ovStart}
                    min={0}
                    max={23}
                    disabled={busy}
                    onChange={(_, d) => {
                      const v = typeof d.value === 'number' ? d.value : Number(d.displayValue);
                      if (Number.isFinite(v)) setOvStart(Math.min(23, Math.max(0, Math.floor(v))));
                    }}
                  />
                </div>
                <div className={styles.field}>
                  <Caption1>To (UTC, exclusive)</Caption1>
                  <SpinButton
                    className={styles.spin}
                    value={ovEnd}
                    min={1}
                    max={24}
                    disabled={busy}
                    onChange={(_, d) => {
                      const v = typeof d.value === 'number' ? d.value : Number(d.displayValue);
                      if (Number.isFinite(v)) setOvEnd(Math.min(24, Math.max(1, Math.floor(v))));
                    }}
                  />
                </div>
                <div className={styles.field}>
                  <Caption1>Mode</Caption1>
                  <Dropdown
                    value={ovMode === 'warm' ? 'Force warm' : 'Force sleep'}
                    selectedOptions={[ovMode]}
                    onOptionSelect={(_, d) => setOvMode((d.optionValue as 'warm' | 'sleep') ?? 'warm')}
                    disabled={busy}
                  >
                    <Option value="warm">Force warm</Option>
                    <Option value="sleep">Force sleep</Option>
                  </Dropdown>
                </div>
                <Button appearance="primary" icon={<Add20Regular />} onClick={addOverride} disabled={busy || ovEnd <= ovStart}>
                  Add override
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

export default UsageLearningCard;
