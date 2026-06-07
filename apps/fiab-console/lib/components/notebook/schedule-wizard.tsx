'use client';

/**
 * ScheduleWizard — dropdown-driven recurrence scheduling for the Synapse
 * Notebook editor. The Loom one-for-one of the Azure ML Studio "Create
 * schedule" dialog (recurrence path): frequency + interval + start + time-zone
 * dropdowns, never a raw cron string. Emits a RecurrenceTrigger payload the
 * /api/notebook/[id]/schedule route turns into a real AML
 * `Microsoft.MachineLearningServices/workspaces/schedules` resource.
 *
 * Grounded in:
 *   learn.microsoft.com/azure/machine-learning/how-to-schedule-pipeline-job
 *   learn.microsoft.com/azure/templates/microsoft.machinelearningservices/workspaces/schedules
 */

import { useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Text, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';

export type AmlFrequency = 'Minute' | 'Hour' | 'Day' | 'Week' | 'Month';

export interface ScheduleCreateParams {
  displayName: string;
  frequency: AmlFrequency;
  interval: number;
  startTime: string;   // ISO-8601 UTC
  timeZone: string;
}

export interface ScheduleWizardProps {
  open: boolean;
  onClose: () => void;
  onCreate: (params: ScheduleCreateParams) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

const useStyles = makeStyles({
  fields: { display: 'flex', flexDirection: 'column', gap: '12px' },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  note: { color: tokens.colorNeutralForeground3 },
  err: { color: tokens.colorPaletteRedForeground1 },
});

// Human label → AML RecurrenceTrigger.frequency value. No cron is ever shown.
const FREQ_OPTIONS: { value: AmlFrequency; label: string; unit: string }[] = [
  { value: 'Minute', label: 'Every minute', unit: 'minute(s)' },
  { value: 'Hour', label: 'Every hour', unit: 'hour(s)' },
  { value: 'Day', label: 'Every day', unit: 'day(s)' },
  { value: 'Week', label: 'Every week', unit: 'week(s)' },
  { value: 'Month', label: 'Every month', unit: 'month(s)' },
];

const TIMEZONES = ['UTC', 'Eastern Standard Time', 'Central Standard Time', 'Mountain Standard Time', 'Pacific Standard Time', 'GMT Standard Time', 'Central European Standard Time'];

export function ScheduleWizard({ open, onClose, onCreate, busy, error }: ScheduleWizardProps) {
  const s = useStyles();
  const [displayName, setDisplayName] = useState('');
  const [frequency, setFrequency] = useState<AmlFrequency>('Day');
  const [interval, setIntervalValue] = useState('1');
  const [startTime, setStartTime] = useState(() => isoLocalNow());
  const [timeZone, setTimeZone] = useState('UTC');

  // Reset to defaults each time the dialog opens.
  useEffect(() => {
    if (open) {
      setDisplayName('');
      setFrequency('Day');
      setIntervalValue('1');
      setStartTime(isoLocalNow());
      setTimeZone('UTC');
    }
  }, [open]);

  const intervalNum = Number(interval);
  const valid = displayName.trim().length > 0 && Number.isFinite(intervalNum) && intervalNum >= 1;
  const unit = FREQ_OPTIONS.find((f) => f.value === frequency)?.unit || '';
  const freqLabel = FREQ_OPTIONS.find((f) => f.value === frequency)?.label || 'Every day';

  const submit = () => {
    if (!valid) return;
    void onCreate({
      displayName: displayName.trim(),
      frequency,
      interval: Math.floor(intervalNum),
      startTime: toIso(startTime),
      timeZone,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 540 }}>
        <DialogBody>
          <DialogTitle>New schedule</DialogTitle>
          <DialogContent>
            <div className={s.fields}>
              <Field label="Name" required>
                <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="daily-run" />
              </Field>

              <div className={s.grid2}>
                <Field label="Frequency">
                  <Dropdown
                    value={freqLabel}
                    selectedOptions={[frequency]}
                    onOptionSelect={(_, d) => { if (d.optionValue) setFrequency(d.optionValue as AmlFrequency); }}
                    aria-label="Recurrence frequency"
                  >
                    {FREQ_OPTIONS.map((f) => <Option key={f.value} value={f.value}>{f.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Interval" hint={`Run every N ${unit}.`}>
                  <Input type="number" min={1} value={interval} onChange={(_, d) => setIntervalValue(d.value)} />
                </Field>
              </div>

              <div className={s.grid2}>
                <Field label="Start (local)">
                  <Input type="datetime-local" value={startTime} onChange={(_, d) => setStartTime(d.value)} />
                </Field>
                <Field label="Time zone">
                  <Dropdown
                    value={timeZone}
                    selectedOptions={[timeZone]}
                    onOptionSelect={(_, d) => { if (d.optionValue) setTimeZone(d.optionValue); }}
                    aria-label="Time zone"
                  >
                    {TIMEZONES.map((tz) => <Option key={tz} value={tz}>{tz}</Option>)}
                  </Dropdown>
                </Field>
              </div>

              <Text size={200} className={s.note}>
                <Badge appearance="tint" color="informative">Created enabled</Badge>{' '}
                The schedule is created enabled — disable it any time from the list below.
              </Text>
              {error && <Text size={200} className={s.err}>{error}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || busy} onClick={submit}>
              {busy ? 'Creating…' : 'Create schedule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Now as a `yyyy-MM-ddThh:mm` local string for <input type=datetime-local>. */
function isoLocalNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Convert a datetime-local value to an ISO-8601 UTC string. */
function toIso(local: string): string {
  if (!local) return new Date().toISOString();
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
