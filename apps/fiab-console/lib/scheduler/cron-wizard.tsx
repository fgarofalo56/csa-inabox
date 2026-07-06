'use client';

/**
 * CronWizard — the VISUAL recurrence builder for the unified scheduler (rel-T81).
 *
 * Per loom_no_freeform_config, a schedule's cadence is NEVER a raw cron string a
 * user types. This wizard assembles a standard 5-field cron from structured
 * controls — a frequency dropdown, then minute / hour / day-of-week / day-of-month
 * pickers as the frequency demands — and shows a live PREVIEW of the next N fire
 * times (computed in the chosen time zone) plus the resulting cron read-only. It
 * emits { cron, timezone } up to the parent; the raw cron field is display-only.
 *
 * Fluent v9 + Loom tokens. Mirrors the Azure ML "Create schedule" recurrence
 * dialog, themed for Loom.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Field, Dropdown, Option, Input, Checkbox, Text, Caption1, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  buildCron, nextFireTimes, describeCron,
  WEEKDAY_LABELS, SCHEDULER_TIMEZONES, type CronFrequency,
} from '@/lib/scheduler/cron';

export interface CronWizardValue {
  cron: string;
  timezone: string;
}

export interface CronWizardProps {
  value: CronWizardValue;
  onChange: (v: CronWizardValue) => void;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  dows: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  preview: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  previewRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cronCode: {
    fontFamily: 'monospace', fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  fireList: { margin: 0, paddingLeft: tokens.spacingHorizontalL, color: tokens.colorNeutralForeground2 },
});

const FREQ_OPTIONS: { value: CronFrequency; label: string }[] = [
  { value: 'minute', label: 'Every N minutes' },
  { value: 'hour', label: 'Hourly' },
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

function range(n: number, start = 0): number[] {
  return Array.from({ length: n }, (_, i) => i + start);
}

export function CronWizard({ value, onChange }: CronWizardProps) {
  const s = useStyles();
  const [frequency, setFrequency] = useState<CronFrequency>('day');
  const [interval, setIntervalVal] = useState(1);
  const [minute, setMinute] = useState(0);
  const [hour, setHour] = useState(2);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([1]); // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [timezone, setTimezone] = useState(value.timezone || 'UTC');

  // Recompute the cron whenever any control changes, and lift it to the parent.
  const cron = useMemo(
    () => buildCron({ frequency, interval, minute, hour, daysOfWeek, dayOfMonth }),
    [frequency, interval, minute, hour, daysOfWeek, dayOfMonth],
  );
  useEffect(() => {
    onChange({ cron, timezone });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cron, timezone]);

  const fires = useMemo(() => nextFireTimes(cron, new Date(), 5, timezone), [cron, timezone]);
  const summary = useMemo(() => describeCron(cron, timezone), [cron, timezone]);

  const tzLabel = SCHEDULER_TIMEZONES.find((t) => t.id === timezone)?.label || timezone;
  const freqLabel = FREQ_OPTIONS.find((f) => f.value === frequency)?.label || 'Daily';

  const toggleDow = (d: number) => {
    setDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  };

  return (
    <div className={s.root}>
      <div className={s.grid2}>
        <Field label="Frequency">
          <Dropdown
            value={freqLabel}
            selectedOptions={[frequency]}
            onOptionSelect={(_, d) => d.optionValue && setFrequency(d.optionValue as CronFrequency)}
            aria-label="Recurrence frequency"
          >
            {FREQ_OPTIONS.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
          </Dropdown>
        </Field>

        {(frequency === 'minute' || frequency === 'hour' || frequency === 'month') && (
          <Field label={frequency === 'minute' ? 'Every N minutes' : frequency === 'hour' ? 'Every N hours' : 'Every N months'}>
            <Input
              type="number" min={1} max={frequency === 'minute' ? 59 : 24}
              value={String(interval)}
              onChange={(_, d) => setIntervalVal(Math.max(1, Number(d.value) || 1))}
            />
          </Field>
        )}
      </div>

      {/* Minute-of-hour picker for hour/day/week/month */}
      {frequency !== 'minute' && (
        <div className={s.grid2}>
          {(frequency === 'day' || frequency === 'week' || frequency === 'month') && (
            <Field label="Hour">
              <Dropdown
                value={String(hour).padStart(2, '0')}
                selectedOptions={[String(hour)]}
                onOptionSelect={(_, d) => d.optionValue && setHour(Number(d.optionValue))}
                aria-label="Hour of day"
              >
                {range(24).map((h) => <Option key={h} value={String(h)}>{String(h).padStart(2, '0')}</Option>)}
              </Dropdown>
            </Field>
          )}
          <Field label="Minute">
            <Dropdown
              value={String(minute).padStart(2, '0')}
              selectedOptions={[String(minute)]}
              onOptionSelect={(_, d) => d.optionValue && setMinute(Number(d.optionValue))}
              aria-label="Minute of hour"
            >
              {range(60).map((m) => <Option key={m} value={String(m)}>{String(m).padStart(2, '0')}</Option>)}
            </Dropdown>
          </Field>
        </div>
      )}

      {frequency === 'week' && (
        <Field label="Days of week">
          <div className={s.dows}>
            {WEEKDAY_LABELS.map((lbl, i) => (
              <Checkbox key={i} label={lbl} checked={daysOfWeek.includes(i)} onChange={() => toggleDow(i)} />
            ))}
          </div>
        </Field>
      )}

      {frequency === 'month' && (
        <Field label="Day of month">
          <Dropdown
            value={String(dayOfMonth)}
            selectedOptions={[String(dayOfMonth)]}
            onOptionSelect={(_, d) => d.optionValue && setDayOfMonth(Number(d.optionValue))}
            aria-label="Day of month"
          >
            {range(31, 1).map((dnum) => <Option key={dnum} value={String(dnum)}>{dnum}</Option>)}
          </Dropdown>
        </Field>
      )}

      <Field label="Time zone">
        <Dropdown
          value={tzLabel}
          selectedOptions={[timezone]}
          onOptionSelect={(_, d) => d.optionValue && setTimezone(d.optionValue)}
          aria-label="Time zone"
        >
          {SCHEDULER_TIMEZONES.map((tz) => <Option key={tz.id} value={tz.id}>{tz.label}</Option>)}
        </Dropdown>
      </Field>

      <div className={s.preview}>
        <div className={s.previewRow}>
          <Badge appearance="tint" color="brand">Preview</Badge>
          <Text weight="semibold">{summary}</Text>
        </div>
        <Caption1 className={s.cronCode}>cron: {cron}</Caption1>
        {fires.length > 0 ? (
          <>
            <Caption1>Next {fires.length} runs ({tzLabel}):</Caption1>
            <ul className={s.fireList}>
              {fires.map((f, i) => (
                <li key={i}>
                  <Caption1>
                    {new Intl.DateTimeFormat('en-US', {
                      timeZone: SCHEDULER_TIMEZONES.find((t) => t.id === timezone)?.iana || 'UTC',
                      dateStyle: 'medium', timeStyle: 'short',
                    }).format(f)}
                  </Caption1>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Caption1>No upcoming runs in the preview window.</Caption1>
        )}
      </div>
    </div>
  );
}
