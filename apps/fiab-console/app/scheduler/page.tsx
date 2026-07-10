'use client';

/**
 * /scheduler — the UNIFIED job scheduler (rel-T81).
 *
 * A single cross-item surface to schedule + monitor recurring jobs across Loom:
 * ADF/Synapse pipeline runs, Synapse & Azure ML Spark jobs, and ADX commands.
 * Replaces the two bespoke per-item scheduling surfaces (semantic-model refresh,
 * notebook schedule) with one place to create schedules (visual CRON wizard),
 * run them now, watch run history + exit values, toggle enabled, and configure
 * failure notifications.
 *
 * Web 3.0: PageShell + Section + elevated cards (TileGrid) + EmptyState +
 * designed honest-gate MessageBar. Fluent v9 + Loom tokens throughout. Real
 * backend: every card + action calls the /api/scheduler routes (no mocks).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Card, Badge, Button, Spinner, Switch, Caption1, Text, Body1,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  CalendarClock24Regular, Add20Regular, Play20Regular, History20Regular,
  Edit20Regular, Delete20Regular, MoreHorizontal20Regular,
  CheckmarkCircle16Filled, ErrorCircle16Filled, Clock16Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { TeachingBanner } from '@/lib/components/shared/teaching-toast';
import { ScheduleDialog, type ScheduleDialogValue } from '@/lib/scheduler/schedule-dialog';
import { describeCron, nextFireTimes, SCHEDULER_TIMEZONES } from '@/lib/scheduler/cron';

interface ScheduleDoc {
  id: string;
  displayName: string;
  itemRef: { type: string; id: string; workspaceId?: string };
  jobKind: string;
  jobConfig: Record<string, unknown>;
  cron: string;
  timezone: string;
  enabled: boolean;
  notify: { onFailure: boolean; email?: string; webhook?: string };
  lastRunAt?: string;
  lastStatus?: 'running' | 'succeeded' | 'failed';
}
interface RunDoc {
  id: string; status: 'running' | 'succeeded' | 'failed'; trigger: 'manual' | 'scheduled';
  startedAt: string; finishedAt?: string; durationMs?: number; runId?: string; exitValue?: string; error?: string;
}

const KIND_LABEL: Record<string, string> = {
  'adf-pipeline': 'Data pipeline',
  'synapse-livy': 'Spark (Synapse)',
  'aml-spark': 'Spark (Azure ML)',
  'adx-command': 'ADX command',
};

const useStyles = makeStyles({
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    transition: 'box-shadow 0.15s ease, transform 0.15s ease',
    ':hover': { boxShadow: tokens.shadow16 },
    minWidth: 0,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  cardTitle: { fontWeight: tokens.fontWeightSemibold, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  cadence: { color: tokens.colorNeutralForeground2 },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  metaRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground3 },
  footer: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  loadingBox: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: tokens.spacingVerticalXXXL, minHeight: '200px' },
  runsHint: { color: tokens.colorNeutralForeground3, marginBottom: tokens.spacingVerticalS },
});

function fmt(iso?: string, tz = 'UTC'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: SCHEDULER_TIMEZONES.find((t) => t.id === tz)?.iana || 'UTC',
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(iso));
  } catch { return iso; }
}

function StatusBadge({ status }: { status?: string }) {
  if (status === 'succeeded') return <Badge appearance="tint" color="success" icon={<CheckmarkCircle16Filled />}>Succeeded</Badge>;
  if (status === 'failed') return <Badge appearance="tint" color="danger" icon={<ErrorCircle16Filled />}>Failed</Badge>;
  if (status === 'running') return <Badge appearance="tint" color="informative" icon={<Clock16Regular />}>Running</Badge>;
  return <Badge appearance="outline" color="subtle">Never run</Badge>;
}

export default function SchedulerPage() {
  const s = useStyles();
  const [schedules, setSchedules] = useState<ScheduleDoc[] | null>(null);
  const [gate, setGate] = useState<{ missing: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editInitial, setEditInitial] = useState<Partial<ScheduleDialogValue> | undefined>(undefined);
  const [runsFor, setRunsFor] = useState<ScheduleDoc | null>(null);
  const [runs, setRuns] = useState<RunDoc[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await clientFetch('/api/scheduler');
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); setSchedules([]); return; }
      setGate(j.configured === false ? (j.gate || { missing: 'LOOM_COSMOS_ENDPOINT' }) : null);
      setSchedules(j.schedules || []);
    } catch (e: any) { setError(e?.message || String(e)); setSchedules([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggleEnabled = useCallback(async (sch: ScheduleDoc, enabled: boolean) => {
    setBusyId(sch.id);
    try {
      await clientFetch(`/api/scheduler/${encodeURIComponent(sch.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      await load();
    } finally { setBusyId(null); }
  }, [load]);

  const runNow = useCallback(async (sch: ScheduleDoc) => {
    setBusyId(sch.id);
    setToast(null);
    try {
      const r = await clientFetch(`/api/scheduler/${encodeURIComponent(sch.id)}/run`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setToast(`Run failed: ${j?.error || `HTTP ${r.status}`}`); }
      else { setToast(`Run ${j.run?.status}: ${j.run?.exitValue || j.run?.error || j.run?.runId || 'done'}`); }
      await load();
    } catch (e: any) { setToast(`Run error: ${e?.message || e}`); }
    finally { setBusyId(null); }
  }, [load]);

  const remove = useCallback(async (sch: ScheduleDoc) => {
    if (!confirm(`Delete schedule "${sch.displayName}"? Its run history is also removed.`)) return;
    setBusyId(sch.id);
    try {
      await clientFetch(`/api/scheduler/${encodeURIComponent(sch.id)}`, { method: 'DELETE' });
      await load();
    } finally { setBusyId(null); }
  }, [load]);

  const openHistory = useCallback(async (sch: ScheduleDoc) => {
    setRunsFor(sch); setRuns(null);
    try {
      const r = await clientFetch(`/api/scheduler/${encodeURIComponent(sch.id)}/runs`);
      const j = await r.json();
      setRuns(j?.runs || []);
    } catch { setRuns([]); }
  }, []);

  const openEdit = useCallback((sch: ScheduleDoc) => {
    setEditInitial({
      id: sch.id, displayName: sch.displayName, itemRef: sch.itemRef, jobKind: sch.jobKind,
      jobConfig: sch.jobConfig as ScheduleDialogValue['jobConfig'], cron: sch.cron, timezone: sch.timezone,
      enabled: sch.enabled, notify: sch.notify,
    });
    setDialogOpen(true);
  }, []);

  const runColumns: LoomColumn<RunDoc>[] = useMemo(() => [
    { key: 'status', label: 'Status', sortable: true, getValue: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    { key: 'trigger', label: 'Trigger', sortable: true, getValue: (r) => r.trigger, render: (r) => <Badge appearance="outline" size="small">{r.trigger}</Badge> },
    { key: 'startedAt', label: 'Started', sortable: true, getValue: (r) => r.startedAt, render: (r) => <Caption1>{fmt(r.startedAt, runsFor?.timezone)}</Caption1> },
    { key: 'durationMs', label: 'Duration', sortable: true, getValue: (r) => r.durationMs ?? 0, render: (r) => <Caption1>{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</Caption1> },
    { key: 'exit', label: 'Exit value', sortable: false, getValue: (r) => r.exitValue || r.error || r.runId || '', render: (r) => <Caption1>{r.exitValue || r.error || r.runId || '—'}</Caption1> },
  ], [runsFor]);

  const hasRows = !!schedules && schedules.length > 0;

  return (
    <PageShell
      title="Scheduler"
      subtitle="Schedule and monitor recurring jobs across Loom — pipeline runs, Spark jobs, and ADX commands — from one place. Visual cron builder, run history, and failure alerts."
      actions={<Button appearance="primary" icon={<Add20Regular />} onClick={() => { setEditInitial(undefined); setDialogOpen(true); }}>New schedule</Button>}
    >
      <TeachingBanner
        surfaceKey="scheduler-hub"
        title="One place for every recurring job"
        message="Schedule pipeline runs, Spark jobs, and ADX commands here instead of item-by-item. Build the cadence with the visual cron wizard — no cron syntax to memorize — then watch run history and get alerted on failures. New schedule starts the wizard."
        learnMoreHref="https://learn.microsoft.com/azure/data-factory/concepts-pipeline-execution-triggers"
      />
      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Scheduler store not configured</MessageBarTitle>
            Set <code>{gate.missing}</code> on the console app so schedules can be stored in Cosmos. The scheduler UI is fully available; schedules save once the store is reachable. See <code>platform/fiab/bicep/modules/admin-plane/main.bicep</code>.
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody><MessageBarTitle>Could not load schedules</MessageBarTitle>{error}</MessageBarBody>
        </MessageBar>
      )}
      {toast && (
        <MessageBar intent="info">
          <MessageBarBody>{toast}</MessageBarBody>
        </MessageBar>
      )}

      <Section title="Schedules">
        {schedules == null ? (
          <div className={s.loadingBox}><Spinner label="Loading schedules…" /></div>
        ) : !hasRows ? (
          <EmptyState
            icon={<CalendarClock24Regular />}
            title="No schedules yet"
            body="Create a schedule to run a pipeline, Spark job, or ADX command on a recurring cadence. Build the cadence with the visual cron wizard, then watch run history and get alerted on failures."
            primaryAction={{ label: 'New schedule', onClick: () => { setEditInitial(undefined); setDialogOpen(true); } }}
          />
        ) : (
          <TileGrid minTileWidth={320}>
            {schedules.map((sch) => {
              const next = nextFireTimes(sch.cron, new Date(), 1, sch.timezone)[0];
              return (
                <Card key={sch.id} className={s.card}>
                  <div className={s.cardHead}>
                    <CalendarClock24Regular />
                    <Text className={s.cardTitle} title={sch.displayName}>{sch.displayName}</Text>
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <Button size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Actions for ${sch.displayName}`} />
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem icon={<Play20Regular />} disabled={busyId === sch.id} onClick={() => void runNow(sch)}>Run now</MenuItem>
                          <MenuItem icon={<History20Regular />} onClick={() => void openHistory(sch)}>Run history</MenuItem>
                          <MenuItem icon={<Edit20Regular />} onClick={() => openEdit(sch)}>Edit</MenuItem>
                          <MenuItem icon={<Delete20Regular />} disabled={busyId === sch.id} onClick={() => void remove(sch)}>Delete</MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  </div>

                  <div className={s.meta}>
                    <Badge appearance="tint" color="brand">{KIND_LABEL[sch.jobKind] || sch.jobKind}</Badge>
                    <Caption1>{sch.itemRef.type}/{sch.itemRef.id}</Caption1>
                  </div>

                  <Body1 className={s.cadence}>{describeCron(sch.cron, sch.timezone)}</Body1>
                  <div className={s.metaRow}><Clock16Regular /><Caption1>Next: {next ? fmt(next.toISOString(), sch.timezone) : '—'}</Caption1></div>
                  <div className={s.metaRow}><Caption1>Last: {fmt(sch.lastRunAt, sch.timezone)}</Caption1></div>

                  <div className={s.footer}>
                    <StatusBadge status={sch.lastStatus} />
                    {sch.notify?.onFailure && <Badge appearance="outline" size="small">Alerts on</Badge>}
                    <span className={s.spacer} />
                    <Switch
                      checked={sch.enabled}
                      disabled={busyId === sch.id}
                      onChange={(_, d) => void toggleEnabled(sch, !!d.checked)}
                      aria-label={`${sch.enabled ? 'Disable' : 'Enable'} ${sch.displayName}`}
                    />
                    <Button size="small" appearance="secondary" icon={<Play20Regular />} disabled={busyId === sch.id} onClick={() => void runNow(sch)}>Run now</Button>
                  </div>
                </Card>
              );
            })}
          </TileGrid>
        )}
      </Section>

      <ScheduleDialog open={dialogOpen} initial={editInitial} onClose={() => setDialogOpen(false)} onSaved={() => void load()} />

      <Dialog open={!!runsFor} onOpenChange={(_, d) => { if (!d.open) { setRunsFor(null); setRuns(null); } }}>
        <DialogSurface style={{ maxWidth: 820 }}>
          <DialogBody>
            <DialogTitle>Run history — {runsFor?.displayName}</DialogTitle>
            <DialogContent>
              <Caption1 className={s.runsHint}>The most recent runs, newest first — status, trigger, duration, and exit value. Retained 90 days.</Caption1>
              {runs == null ? (
                <div className={s.loadingBox}><Spinner label="Loading runs…" /></div>
              ) : runs.length === 0 ? (
                <EmptyState icon={<History20Regular />} title="No runs yet" body="This schedule hasn't run. Trigger it with “Run now” or wait for its next scheduled fire." />
              ) : (
                <LoomDataTable<RunDoc> columns={runColumns} rows={runs} getRowId={(r) => r.id} empty="No runs yet." />
              )}
            </DialogContent>
            <DialogActions>
              {runsFor && <Button appearance="secondary" icon={<Play20Regular />} disabled={busyId === runsFor.id} onClick={() => runsFor && void runNow(runsFor).then(() => openHistory(runsFor))}>Run now</Button>}
              <Button appearance="primary" onClick={() => { setRunsFor(null); setRuns(null); }}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </PageShell>
  );
}
