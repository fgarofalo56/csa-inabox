'use client';

/**
 * TriggerWizard — the Loom one-for-one of Azure Data Factory Studio's
 * "Add trigger → New" dialog (ui-parity.md). Instead of a cron string or raw
 * JSON, it offers the SAME four guided trigger types the ADF portal does, each
 * with typed controls, and emits the exact ADF trigger `properties` payload the
 * /api/items/data-pipeline/[id]/triggers route hands to the factory:
 *
 *   Schedule         — recurrence (minute/hour/day/week/month) + start/end + tz
 *   Tumbling window  — fixed windows + delay + concurrency + retry
 *   Storage events   — BlobCreated/Deleted on a storage account + path filters
 *   Custom events    — Event Grid subject/eventType filters
 *
 * Grounded in:
 *   learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers
 *   learn.microsoft.com/rest/api/datafactory/triggers/create-or-update
 */

import { useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Switch, Textarea, Text, Badge,
  makeStyles, tokens,
} from '@fluentui/react-components';

type TriggerKind = 'ScheduleTrigger' | 'TumblingWindowTrigger' | 'BlobEventsTrigger' | 'CustomEventsTrigger';

const useStyles = makeStyles({
  typeRow: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' },
  typeCard: {
    flex: '1 1 160px', minWidth: '150px', padding: '12px', borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`, cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: '4px',
  },
  typeCardActive: {
    border: `2px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2,
  },
  typeTitle: { fontWeight: 600, fontSize: '13px' },
  typeDesc: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
  fields: { display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '52vh', overflowY: 'auto', paddingRight: '4px' },
});

const TYPES: { kind: TriggerKind; title: string; desc: string }[] = [
  { kind: 'ScheduleTrigger', title: 'Schedule', desc: 'Run on a wall-clock recurrence (every N minutes/hours/days/weeks/months).' },
  { kind: 'TumblingWindowTrigger', title: 'Tumbling window', desc: 'Fixed, non-overlapping time windows with retry & concurrency.' },
  { kind: 'BlobEventsTrigger', title: 'Storage events', desc: 'React to blob created/deleted events on a storage account.' },
  { kind: 'CustomEventsTrigger', title: 'Custom events', desc: 'React to Event Grid custom events with subject filters.' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMEZONES = ['UTC', 'Eastern Standard Time', 'Central Standard Time', 'Mountain Standard Time', 'Pacific Standard Time', 'GMT Standard Time', 'Central European Standard Time'];

export interface TriggerWizardProps {
  open: boolean;
  onClose: () => void;
  /** Receives (name, properties) — the ADF trigger payload. Should POST + resolve. */
  onCreate: (name: string, properties: Record<string, unknown>) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}

export function TriggerWizard({ open, onClose, onCreate, busy, error }: TriggerWizardProps) {
  const styles = useStyles();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TriggerKind>('ScheduleTrigger');

  // Schedule / tumbling shared
  const [frequency, setFrequency] = useState('Day');
  const [interval, setInterval] = useState('1');
  const [startTime, setStartTime] = useState(() => isoLocalNow());
  const [endTime, setEndTime] = useState('');
  const [timeZone, setTimeZone] = useState('UTC');
  const [weekDays, setWeekDays] = useState<string[]>([]);
  const [atHours, setAtHours] = useState('');     // e.g. "0,12"
  const [atMinutes, setAtMinutes] = useState(''); // e.g. "0,30"

  // Tumbling
  const [delay, setDelay] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState('1');
  const [retryCount, setRetryCount] = useState('0');
  const [retryInterval, setRetryInterval] = useState('30');

  // Storage events
  const [scopeResourceId, setScopeResourceId] = useState('');
  const [pathBeginsWith, setPathBeginsWith] = useState('');
  const [pathEndsWith, setPathEndsWith] = useState('');
  const [ignoreEmpty, setIgnoreEmpty] = useState(true);
  const [evCreated, setEvCreated] = useState(true);
  const [evDeleted, setEvDeleted] = useState(false);

  // Custom events
  const [customEventTypes, setCustomEventTypes] = useState('');
  const [subjectBeginsWith, setSubjectBeginsWith] = useState('');
  const [subjectEndsWith, setSubjectEndsWith] = useState('');

  const toList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const toNums = (s: string) => toList(s).map(Number).filter((n) => Number.isFinite(n));

  const properties = useMemo<Record<string, unknown>>(() => {
    const base: any = { type: kind, runtimeState: 'Stopped' };
    if (kind === 'ScheduleTrigger') {
      const schedule: any = {};
      if (frequency === 'Week' && weekDays.length) schedule.weekDays = weekDays;
      if (atHours) schedule.hours = toNums(atHours);
      if (atMinutes) schedule.minutes = toNums(atMinutes);
      base.typeProperties = {
        recurrence: {
          frequency, interval: Number(interval) || 1,
          startTime: toIso(startTime), timeZone,
          ...(endTime ? { endTime: toIso(endTime) } : {}),
          ...(Object.keys(schedule).length ? { schedule } : {}),
        },
      };
    } else if (kind === 'TumblingWindowTrigger') {
      base.typeProperties = {
        frequency: frequency === 'Minute' ? 'Minute' : 'Hour',
        interval: Number(interval) || 1,
        startTime: toIso(startTime),
        ...(endTime ? { endTime: toIso(endTime) } : {}),
        ...(delay ? { delay } : {}),
        maxConcurrency: Number(maxConcurrency) || 1,
        retryPolicy: { count: Number(retryCount) || 0, intervalInSeconds: Number(retryInterval) || 30 },
      };
    } else if (kind === 'BlobEventsTrigger') {
      const events: string[] = [];
      if (evCreated) events.push('Microsoft.Storage.BlobCreated');
      if (evDeleted) events.push('Microsoft.Storage.BlobDeleted');
      base.typeProperties = {
        ...(pathBeginsWith ? { blobPathBeginsWith: pathBeginsWith } : {}),
        ...(pathEndsWith ? { blobPathEndsWith: pathEndsWith } : {}),
        ignoreEmptyBlobs: ignoreEmpty,
        scope: scopeResourceId,
        events,
      };
    } else {
      base.typeProperties = {
        scope: scopeResourceId,
        events: toList(customEventTypes),
        ...(subjectBeginsWith ? { subjectBeginsWith } : {}),
        ...(subjectEndsWith ? { subjectEndsWith } : {}),
      };
    }
    return base;
  }, [kind, frequency, interval, startTime, endTime, timeZone, weekDays, atHours, atMinutes,
      delay, maxConcurrency, retryCount, retryInterval, scopeResourceId, pathBeginsWith, pathEndsWith,
      ignoreEmpty, evCreated, evDeleted, customEventTypes, subjectBeginsWith, subjectEndsWith]);

  const valid = useMemo(() => {
    if (!name.trim()) return false;
    if (kind === 'BlobEventsTrigger' || kind === 'CustomEventsTrigger') return !!scopeResourceId.trim();
    return true;
  }, [name, kind, scopeResourceId]);

  const freqOptions = kind === 'TumblingWindowTrigger' ? ['Minute', 'Hour'] : ['Minute', 'Hour', 'Day', 'Week', 'Month'];

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>New trigger</DialogTitle>
          <DialogContent>
            <div className={styles.fields}>
              <Field label="Name" required>
                <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="daily-load" />
              </Field>

              <Field label="Type">
                <div className={styles.typeRow}>
                  {TYPES.map((t) => (
                    <div key={t.kind}
                      className={`${styles.typeCard} ${kind === t.kind ? styles.typeCardActive : ''}`}
                      onClick={() => setKind(t.kind)} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setKind(t.kind); }}>
                      <span className={styles.typeTitle}>{t.title}</span>
                      <span className={styles.typeDesc}>{t.desc}</span>
                    </div>
                  ))}
                </div>
              </Field>

              {(kind === 'ScheduleTrigger' || kind === 'TumblingWindowTrigger') && (
                <>
                  <div className={styles.grid2}>
                    <Field label="Recurrence">
                      <Dropdown value={frequency} selectedOptions={[frequency]}
                        onOptionSelect={(_, d) => d.optionValue && setFrequency(d.optionValue)}>
                        {freqOptions.map((f) => <Option key={f} value={f}>{`Every ${f.toLowerCase()}`}</Option>)}
                      </Dropdown>
                    </Field>
                    <Field label="Interval">
                      <Input type="number" value={interval} onChange={(_, d) => setInterval(d.value)} />
                    </Field>
                  </div>
                  <div className={styles.grid2}>
                    <Field label="Start (local)" required>
                      <Input type="datetime-local" value={startTime} onChange={(_, d) => setStartTime(d.value)} />
                    </Field>
                    <Field label="End (optional)">
                      <Input type="datetime-local" value={endTime} onChange={(_, d) => setEndTime(d.value)} />
                    </Field>
                  </div>
                  {kind === 'ScheduleTrigger' && (
                    <>
                      <Field label="Time zone">
                        <Dropdown value={timeZone} selectedOptions={[timeZone]}
                          onOptionSelect={(_, d) => d.optionValue && setTimeZone(d.optionValue)}>
                          {TIMEZONES.map((tz) => <Option key={tz} value={tz}>{tz}</Option>)}
                        </Dropdown>
                      </Field>
                      {frequency === 'Week' && (
                        <Field label="On days" hint="Which weekdays to run.">
                          <Dropdown multiselect placeholder="Select days"
                            value={weekDays.join(', ')} selectedOptions={weekDays}
                            onOptionSelect={(_, d) => setWeekDays(d.selectedOptions)}>
                            {WEEKDAYS.map((w) => <Option key={w} value={w}>{w}</Option>)}
                          </Dropdown>
                        </Field>
                      )}
                      {(frequency === 'Day' || frequency === 'Week') && (
                        <div className={styles.grid2}>
                          <Field label="At hours" hint="Comma list, 0–23 (e.g. 0,12).">
                            <Input value={atHours} onChange={(_, d) => setAtHours(d.value)} placeholder="0,12" />
                          </Field>
                          <Field label="At minutes" hint="Comma list, 0–59 (e.g. 0,30).">
                            <Input value={atMinutes} onChange={(_, d) => setAtMinutes(d.value)} placeholder="0" />
                          </Field>
                        </div>
                      )}
                    </>
                  )}
                  {kind === 'TumblingWindowTrigger' && (
                    <>
                      <div className={styles.grid2}>
                        <Field label="Delay" hint="How long after the window to start (e.g. 00:10:00).">
                          <Input value={delay} onChange={(_, d) => setDelay(d.value)} placeholder="00:00:00" />
                        </Field>
                        <Field label="Max concurrency" hint="Parallel windows (1–50).">
                          <Input type="number" value={maxConcurrency} onChange={(_, d) => setMaxConcurrency(d.value)} />
                        </Field>
                      </div>
                      <div className={styles.grid2}>
                        <Field label="Retry count">
                          <Input type="number" value={retryCount} onChange={(_, d) => setRetryCount(d.value)} />
                        </Field>
                        <Field label="Retry interval (s)">
                          <Input type="number" value={retryInterval} onChange={(_, d) => setRetryInterval(d.value)} />
                        </Field>
                      </div>
                    </>
                  )}
                </>
              )}

              {kind === 'BlobEventsTrigger' && (
                <>
                  <Field label="Storage account (resource ID)" required
                    hint="The /subscriptions/…/storageAccounts/<name> the events come from.">
                    <Textarea value={scopeResourceId} onChange={(_, d) => setScopeResourceId(d.value)} rows={2}
                      placeholder="/subscriptions/…/resourceGroups/…/providers/Microsoft.Storage/storageAccounts/myadls" />
                  </Field>
                  <div className={styles.grid2}>
                    <Field label="Blob path begins with" hint="e.g. /container/blobs/in/">
                      <Input value={pathBeginsWith} onChange={(_, d) => setPathBeginsWith(d.value)} />
                    </Field>
                    <Field label="Blob path ends with" hint="e.g. .csv">
                      <Input value={pathEndsWith} onChange={(_, d) => setPathEndsWith(d.value)} />
                    </Field>
                  </div>
                  <Field label="Events">
                    <div style={{ display: 'flex', gap: 16 }}>
                      <Switch label="Blob created" checked={evCreated} onChange={(_, d) => setEvCreated(d.checked)} />
                      <Switch label="Blob deleted" checked={evDeleted} onChange={(_, d) => setEvDeleted(d.checked)} />
                    </div>
                  </Field>
                  <Switch label="Ignore empty blobs" checked={ignoreEmpty} onChange={(_, d) => setIgnoreEmpty(d.checked)} />
                </>
              )}

              {kind === 'CustomEventsTrigger' && (
                <>
                  <Field label="Event Grid topic (resource ID)" required
                    hint="The custom Event Grid topic scope.">
                    <Textarea value={scopeResourceId} onChange={(_, d) => setScopeResourceId(d.value)} rows={2}
                      placeholder="/subscriptions/…/providers/Microsoft.EventGrid/topics/myTopic" />
                  </Field>
                  <Field label="Event types" required hint="Comma-separated custom event types to match.">
                    <Input value={customEventTypes} onChange={(_, d) => setCustomEventTypes(d.value)}
                      placeholder="copyCompleted, fileLanded" />
                  </Field>
                  <div className={styles.grid2}>
                    <Field label="Subject begins with">
                      <Input value={subjectBeginsWith} onChange={(_, d) => setSubjectBeginsWith(d.value)} />
                    </Field>
                    <Field label="Subject ends with">
                      <Input value={subjectEndsWith} onChange={(_, d) => setSubjectEndsWith(d.value)} />
                    </Field>
                  </div>
                </>
              )}

              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                <Badge appearance="tint" color="informative">Created stopped</Badge>{' '}
                The trigger is created in a stopped state — start it from the trigger list.
              </Text>
              {error && <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || busy}
              onClick={() => onCreate(name.trim(), properties)}>
              {busy ? 'Creating…' : 'Create trigger'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Now as a `yyyy-MM-ddThh:mm` local string for <input type=datetime-local>. */
function isoLocalNow(): string {
  // Avoid Date.now()/new Date() restrictions are runtime-only; this is client code.
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
