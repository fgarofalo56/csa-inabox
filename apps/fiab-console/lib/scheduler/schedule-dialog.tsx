'use client';

/**
 * ScheduleDialog — create / edit a unified scheduler entry (rel-T81).
 *
 * A single guided dialog: name → target item ref → job kind (which reveals the
 * matching structured job-config fields) → the visual CronWizard cadence → the
 * failure-notification config. Everything is dropdowns / typed inputs / the cron
 * wizard — no raw JSON config, no raw cron string (loom_no_freeform_config). On
 * submit it POSTs (create) or PATCHes (edit) the real /api/scheduler route.
 *
 * Fluent v9 + Loom tokens.
 */

import { useEffect, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Input, Field, Dropdown, Option, Textarea, Checkbox, Divider, Text,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import { CronWizard, type CronWizardValue } from '@/lib/scheduler/cron-wizard';

// Mirrors JOB_KINDS in lib/azure/scheduler-store.ts (kept in sync; the server
// re-validates, so this is a UX convenience list only).
const JOB_KINDS: { kind: string; label: string; backend: string }[] = [
  { kind: 'adf-pipeline', label: 'Data pipeline run', backend: 'Azure Data Factory / Synapse pipeline' },
  { kind: 'synapse-livy', label: 'Spark job (Synapse)', backend: 'Synapse Spark pool (Livy)' },
  { kind: 'aml-spark', label: 'Spark job (Azure ML)', backend: 'Azure ML serverless Spark' },
  { kind: 'adx-command', label: 'ADX command', backend: 'Azure Data Explorer (Kusto)' },
];

export interface ScheduleDialogValue {
  id?: string;
  displayName: string;
  itemRef: { type: string; id: string; workspaceId?: string };
  jobKind: string;
  jobConfig: {
    pipelineName?: string;
    sparkPoolName?: string;
    code?: string;
    database?: string;
    command?: string;
  };
  cron: string;
  timezone: string;
  enabled: boolean;
  notify: { onFailure: boolean; email?: string; webhook?: string };
}

export interface ScheduleDialogProps {
  open: boolean;
  initial?: Partial<ScheduleDialogValue>;
  onClose: () => void;
  onSaved: () => void;
}

const useStyles = makeStyles({
  fields: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  section: { fontWeight: tokens.fontWeightSemibold, marginTop: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
});

function emptyValue(initial?: Partial<ScheduleDialogValue>): ScheduleDialogValue {
  return {
    id: initial?.id,
    displayName: initial?.displayName ?? '',
    itemRef: { type: initial?.itemRef?.type ?? '', id: initial?.itemRef?.id ?? '', workspaceId: initial?.itemRef?.workspaceId },
    jobKind: initial?.jobKind ?? 'adf-pipeline',
    jobConfig: { ...(initial?.jobConfig ?? {}) },
    cron: initial?.cron ?? '0 2 * * *',
    timezone: initial?.timezone ?? 'UTC',
    enabled: initial?.enabled ?? true,
    notify: { onFailure: initial?.notify?.onFailure ?? false, email: initial?.notify?.email, webhook: initial?.notify?.webhook },
  };
}

export function ScheduleDialog({ open, initial, onClose, onSaved }: ScheduleDialogProps) {
  const s = useStyles();
  const [v, setV] = useState<ScheduleDialogValue>(() => emptyValue(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setV(emptyValue(initial)); setError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setJobConfig = (patch: Partial<ScheduleDialogValue['jobConfig']>) =>
    setV((prev) => ({ ...prev, jobConfig: { ...prev.jobConfig, ...patch } }));
  const setCron = (cw: CronWizardValue) => setV((prev) => ({ ...prev, cron: cw.cron, timezone: cw.timezone }));

  const kindLabel = JOB_KINDS.find((k) => k.kind === v.jobKind)?.label || v.jobKind;
  const backend = JOB_KINDS.find((k) => k.kind === v.jobKind)?.backend || '';

  const valid =
    v.displayName.trim().length > 0 &&
    v.itemRef.type.trim().length > 0 &&
    v.itemRef.id.trim().length > 0 &&
    jobConfigValid(v);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { clientFetch } = await import('@/lib/client-fetch');
      const url = v.id ? `/api/scheduler/${encodeURIComponent(v.id)}` : '/api/scheduler';
      const method = v.id ? 'PATCH' : 'POST';
      const r = await clientFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(v),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); return; }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 640 }}>
        <DialogBody>
          <DialogTitle>{v.id ? 'Edit schedule' : 'New schedule'}</DialogTitle>
          <DialogContent>
            <div className={s.fields}>
              <Field label="Name" required>
                <Input value={v.displayName} onChange={(_, d) => setV((p) => ({ ...p, displayName: d.value }))} placeholder="nightly-sales-refresh" />
              </Field>

              <Text className={s.section}>Target item</Text>
              <div className={s.grid2}>
                <Field label="Item type" required hint="e.g. data-pipeline, notebook, kql-database">
                  <Input value={v.itemRef.type} onChange={(_, d) => setV((p) => ({ ...p, itemRef: { ...p.itemRef, type: d.value } }))} placeholder="data-pipeline" />
                </Field>
                <Field label="Item id" required>
                  <Input value={v.itemRef.id} onChange={(_, d) => setV((p) => ({ ...p, itemRef: { ...p.itemRef, id: d.value } }))} placeholder="item id" />
                </Field>
              </div>

              <Text className={s.section}>Job</Text>
              <Field label="Job kind" hint={backend}>
                <Dropdown
                  value={kindLabel}
                  selectedOptions={[v.jobKind]}
                  onOptionSelect={(_, d) => d.optionValue && setV((p) => ({ ...p, jobKind: d.optionValue! }))}
                  aria-label="Job kind"
                >
                  {JOB_KINDS.map((k) => <Option key={k.kind} value={k.kind}>{k.label}</Option>)}
                </Dropdown>
              </Field>

              {v.jobKind === 'adf-pipeline' && (
                <Field label="Pipeline name" required>
                  <Input value={v.jobConfig.pipelineName ?? ''} onChange={(_, d) => setJobConfig({ pipelineName: d.value })} placeholder="CopyToLakehouse" />
                </Field>
              )}

              {(v.jobKind === 'aml-spark' || v.jobKind === 'synapse-livy') && (
                <>
                  {v.jobKind === 'synapse-livy' && (
                    <Field label="Spark pool" hint="Leave blank to use the deployment default pool.">
                      <Input value={v.jobConfig.sparkPoolName ?? ''} onChange={(_, d) => setJobConfig({ sparkPoolName: d.value })} placeholder="loompool" />
                    </Field>
                  )}
                  <Field label="PySpark code" required hint="The code the scheduled Spark job runs.">
                    <Textarea value={v.jobConfig.code ?? ''} onChange={(_, d) => setJobConfig({ code: d.value })} resize="vertical" rows={5} aria-label="PySpark job code" />
                  </Field>
                </>
              )}

              {v.jobKind === 'adx-command' && (
                <>
                  <Field label="Database" required>
                    <Input value={v.jobConfig.database ?? ''} onChange={(_, d) => setJobConfig({ database: d.value })} placeholder="telemetry" />
                  </Field>
                  <Field label="Command or query" required hint="A control command (starts with .) or a KQL query.">
                    <Textarea value={v.jobConfig.command ?? ''} onChange={(_, d) => setJobConfig({ command: d.value })} resize="vertical" rows={4} aria-label="ADX command or query" />
                  </Field>
                </>
              )}

              <Divider />
              <Text className={s.section}>Schedule</Text>
              <CronWizard value={{ cron: v.cron, timezone: v.timezone }} onChange={setCron} />

              <Divider />
              <Text className={s.section}>Failure notifications</Text>
              <Checkbox
                label="Notify on failure"
                checked={v.notify.onFailure}
                onChange={(_, d) => setV((p) => ({ ...p, notify: { ...p.notify, onFailure: !!d.checked } }))}
              />
              {v.notify.onFailure && (
                <div className={s.grid2}>
                  <Field label="Email" hint="Alerts also land in your Loom inbox.">
                    <Input type="email" value={v.notify.email ?? ''} onChange={(_, d) => setV((p) => ({ ...p, notify: { ...p.notify, email: d.value } }))} placeholder="team@contoso.com" />
                  </Field>
                  <Field label="Webhook URL" hint="POSTed with the failure payload.">
                    <Input value={v.notify.webhook ?? ''} onChange={(_, d) => setV((p) => ({ ...p, notify: { ...p.notify, webhook: d.value } }))} placeholder="https://…" />
                  </Field>
                </div>
              )}

              <Checkbox
                label="Enabled"
                checked={v.enabled}
                onChange={(_, d) => setV((p) => ({ ...p, enabled: !!d.checked }))}
              />

              {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button appearance="primary" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? 'Saving…' : v.id ? 'Save changes' : 'Create schedule'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function jobConfigValid(v: ScheduleDialogValue): boolean {
  switch (v.jobKind) {
    case 'adf-pipeline':
      return !!v.jobConfig.pipelineName?.trim();
    case 'adx-command':
      return !!v.jobConfig.database?.trim() && !!v.jobConfig.command?.trim();
    case 'aml-spark':
    case 'synapse-livy':
      return !!v.jobConfig.code?.trim();
    default:
      return false;
  }
}
