'use client';

/**
 * DbxScheduleDialog (R4-DBX-1) — "Schedule the notebook as a job".
 *
 * Creates a real Databricks Job (notebook_task on the attached cluster) with an
 * optional Quartz cron schedule, and lists the jobs already targeting this
 * notebook with run-now / pause / resume / delete — the first-party
 * "Schedule" panel. Every control calls the real Jobs API through
 * `/api/items/databricks-notebook/[id]/schedule` (no-vaporware.md); an honest
 * MessageBar surfaces the 503 when the workspace isn't configured.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Dialog, DialogSurface, DialogBody, DialogTitle,
  DialogContent, DialogActions, Button, Field, Input, Dropdown, Option,
  Switch, Badge, Caption1, Spinner, Divider, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
} from '@fluentui/react-components';
import {
  CalendarClock20Regular, Play16Regular, Pause16Regular, Delete16Regular,
  Add16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';

export interface ScheduleJobRow {
  job_id: number;
  name?: string;
  notebook_path?: string;
  cron?: string;
  timezone_id?: string;
  pause_status?: string;
  creator_user_name?: string;
  last_run?: { run_id: number; life_cycle_state?: string; result_state?: string; start_time?: number } | null;
}

/** Quartz cron presets (seconds-leading, Databricks flavour). */
const CRON_PRESETS: { id: string; label: string; cron: string }[] = [
  { id: 'hourly', label: 'Every hour', cron: '0 0 * * * ?' },
  { id: 'daily', label: 'Every day at 09:00', cron: '0 0 9 * * ?' },
  { id: 'weekdays', label: 'Weekdays at 08:00', cron: '0 0 8 ? * MON-FRI' },
  { id: 'weekly', label: 'Every Monday at 09:00', cron: '0 0 9 ? * MON' },
  { id: 'custom', label: 'Custom cron…', cron: '' },
];

const TIMEZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'];

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  grow: { flex: 1, minWidth: '200px' },
  sectionLabel: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2 },
  tableWrap: { overflowX: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  rowActions: { display: 'flex', gap: tokens.spacingHorizontalXS },
  cronText: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

export interface DbxScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: string;
  notebookPath: string | null;
  clusterId: string;
  /** Widget names → default values, offered as job base_parameters. */
  widgetValues?: Record<string, string>;
}

export function DbxScheduleDialog({
  open, onOpenChange, itemId, notebookPath, clusterId, widgetValues,
}: DbxScheduleDialogProps) {
  const s = useStyles();
  const [jobs, setJobs] = useState<ScheduleJobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('daily');
  const [customCron, setCustomCron] = useState('0 0 9 * * ?');
  const [timezoneId, setTimezoneId] = useState('UTC');
  const [scheduled, setScheduled] = useState(true);

  const base = `/api/items/databricks-notebook/${encodeURIComponent(itemId)}/schedule`;

  const load = useCallback(async () => {
    if (!notebookPath) return;
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch(`${base}?path=${encodeURIComponent(notebookPath)}`);
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 || j?.code === 'not_configured') { setGate(j?.error || 'Databricks workspace not configured.'); return; }
      if (!r.ok || !j?.ok) { setError(j?.error || `Failed to list jobs (${r.status})`); return; }
      setJobs(j.jobs || []);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [base, notebookPath]);

  useEffect(() => {
    if (open) { setNotice(null); void load(); if (notebookPath) setName(`loom-${notebookPath.split('/').pop()}`); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeCron = presetId === 'custom' ? customCron : (CRON_PRESETS.find((p) => p.id === presetId)?.cron || '');

  const create = useCallback(async () => {
    if (!notebookPath) { setError('Open or save a notebook first.'); return; }
    if (!clusterId) { setError('Attach a cluster before scheduling.'); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await clientFetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: notebookPath, clusterId, name: name.trim() || undefined,
          cron: scheduled ? activeCron : undefined, timezoneId,
          params: widgetValues && Object.keys(widgetValues).length ? widgetValues : undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 || j?.code === 'not_configured') { setGate(j?.error || 'Databricks workspace not configured.'); return; }
      if (!r.ok || !j?.ok) { setError(j?.error || `Create failed (${r.status})`); return; }
      setNotice(scheduled ? `Job ${j.job_id} created and scheduled.` : `Job ${j.job_id} created (run it on demand).`);
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, notebookPath, clusterId, name, scheduled, activeCron, timezoneId, widgetValues, load]);

  const act = useCallback(async (jobId: number, action: 'run' | 'pause' | 'unpause') => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await clientFetch(base, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, action, params: action === 'run' && widgetValues ? widgetValues : undefined }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setError(j?.error || `${action} failed (${r.status})`); return; }
      setNotice(action === 'run' ? `Triggered run ${j.run_id}.` : action === 'pause' ? 'Schedule paused.' : 'Schedule resumed.');
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, widgetValues, load]);

  const remove = useCallback(async (jobId: number) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await clientFetch(`${base}?jobId=${jobId}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) { setError(j?.error || `Delete failed (${r.status})`); return; }
      setNotice(`Job ${jobId} deleted.`);
      await load();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [base, load]);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '960px', width: '95vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <CalendarClock20Regular /> Schedule notebook as a job
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.form}>
              {gate && (
                <MessageBar intent="warning"><MessageBarBody>
                  <MessageBarTitle>Databricks not configured</MessageBarTitle>{gate}
                </MessageBarBody></MessageBar>
              )}
              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
              {notice && <MessageBar intent="success"><MessageBarBody>{notice}</MessageBarBody></MessageBar>}

              <Caption1>
                Notebook: <span className={s.cronText}>{notebookPath || '(unsaved — save the notebook first)'}</span>
                {clusterId ? '' : ' · attach a cluster to enable scheduling'}
              </Caption1>

              <div className={s.sectionLabel}>New job</div>
              <div className={s.row}>
                <Field label="Job name" className={s.grow}>
                  <Input value={name} onChange={(_, d) => setName(d.value)} placeholder="loom-notebook" />
                </Field>
                <Field label="Schedule" style={{ minWidth: '160px' }}>
                  <Switch checked={scheduled} onChange={(_, d) => setScheduled(d.checked)} label={scheduled ? 'On a cron schedule' : 'On demand only'} />
                </Field>
              </div>
              {scheduled && (
                <div className={s.row}>
                  <Field label="Frequency" className={s.grow}>
                    <Dropdown
                      value={CRON_PRESETS.find((p) => p.id === presetId)?.label || 'Custom'}
                      selectedOptions={[presetId]}
                      onOptionSelect={(_, d) => d.optionValue && setPresetId(d.optionValue)}
                    >
                      {CRON_PRESETS.map((p) => <Option key={p.id} value={p.id}>{p.label}</Option>)}
                    </Dropdown>
                  </Field>
                  {presetId === 'custom' && (
                    <Field label="Quartz cron" className={s.grow} hint="Seconds-leading, e.g. 0 0 9 * * ?">
                      <Input className={s.cronText} value={customCron} onChange={(_, d) => setCustomCron(d.value)} />
                    </Field>
                  )}
                  <Field label="Timezone" style={{ minWidth: '180px' }}>
                    <Dropdown value={timezoneId} selectedOptions={[timezoneId]} onOptionSelect={(_, d) => d.optionValue && setTimezoneId(d.optionValue)}>
                      {TIMEZONES.map((tz) => <Option key={tz} value={tz}>{tz}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              )}
              {widgetValues && Object.keys(widgetValues).length > 0 && (
                <Caption1>Widget values passed as job parameters: {Object.entries(widgetValues).map(([k, v]) => `${k}=${v}`).join(', ')}</Caption1>
              )}
              <div>
                <Button appearance="primary" icon={<Add16Regular />} onClick={create} disabled={busy || !notebookPath || !clusterId}>
                  {busy ? 'Working…' : scheduled ? 'Create scheduled job' : 'Create job'}
                </Button>
              </div>

              <Divider />
              <div className={s.sectionLabel}>Jobs targeting this notebook</div>
              {loading ? <Spinner size="tiny" label="Loading jobs…" /> : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Scheduled jobs">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Job</TableHeaderCell>
                      <TableHeaderCell>Schedule</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Last run</TableHeaderCell>
                      <TableHeaderCell>Actions</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {jobs.length === 0 && <TableRow><TableCell colSpan={5}><Caption1>No jobs yet for this notebook.</Caption1></TableCell></TableRow>}
                      {jobs.map((j) => (
                        <TableRow key={j.job_id}>
                          <TableCell>{j.name || j.job_id}</TableCell>
                          <TableCell>
                            {j.cron ? <span className={s.cronText}>{j.cron} · {j.timezone_id}</span> : <Caption1>On demand</Caption1>}
                          </TableCell>
                          <TableCell>
                            {j.cron
                              ? <Badge appearance="tint" color={j.pause_status === 'PAUSED' ? 'warning' : 'success'}>{j.pause_status === 'PAUSED' ? 'Paused' : 'Active'}</Badge>
                              : <Badge appearance="outline">—</Badge>}
                          </TableCell>
                          <TableCell>
                            {j.last_run
                              ? <Badge appearance="outline" color={j.last_run.result_state === 'SUCCESS' ? 'success' : j.last_run.result_state === 'FAILED' ? 'danger' : 'informative'}>
                                  {j.last_run.life_cycle_state || '—'}{j.last_run.result_state ? ` · ${j.last_run.result_state}` : ''}
                                </Badge>
                              : <Caption1>—</Caption1>}
                          </TableCell>
                          <TableCell>
                            <div className={s.rowActions}>
                              <Tooltip content="Run now" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} onClick={() => act(j.job_id, 'run')} disabled={busy} aria-label="Run now" /></Tooltip>
                              {j.cron && (
                                j.pause_status === 'PAUSED'
                                  ? <Tooltip content="Resume schedule" relationship="label"><Button size="small" appearance="subtle" icon={<Play16Regular />} onClick={() => act(j.job_id, 'unpause')} disabled={busy} aria-label="Resume schedule" /></Tooltip>
                                  : <Tooltip content="Pause schedule" relationship="label"><Button size="small" appearance="subtle" icon={<Pause16Regular />} onClick={() => act(j.job_id, 'pause')} disabled={busy} aria-label="Pause schedule" /></Tooltip>
                              )}
                              <Tooltip content="Delete job" relationship="label"><Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => remove(j.job_id)} disabled={busy} aria-label="Delete job" /></Tooltip>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            <Button appearance="primary" onClick={() => void load()} disabled={loading}>Refresh</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
