'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ReportSubscriptionsPanel — schedule + manage recurring report deliveries
 * (Azure-native parity with Fabric / Power BI "Subscribe to report").
 *
 * Every control calls the real BFF (no-vaporware.md):
 *   GET    /api/items/report/[id]/subscriptions
 *   POST   /api/items/report/[id]/subscriptions
 *   PATCH  /api/items/report/[id]/subscriptions/[subId]   (pause / resume)
 *   DELETE /api/items/report/[id]/subscriptions/[subId]   (cancel)
 *   GET    /api/items/report/[id]/subscriptions/[subId]/logs  (delivery history)
 *
 * Scheduled delivery is performed by the fiab-report-subscriptions timer
 * Function (real Power BI ExportTo job → ADLS archive → email via Logic App).
 * When that Function/Logic App is not deployed the BFF returns a `deliveryGate`
 * which is rendered as an honest warning MessageBar — subscriptions still save.
 *
 * Schedule is a dropdown of presets (no freeform cron required) with an
 * optional advanced NCRONTAB field for power users (loom-no-freeform-config:
 * the advanced field mirrors the Azure Functions timer expression 1:1).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Button, Caption1, Subtitle2, Field, Input, Textarea, Dropdown, Option, Switch, Spinner, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete16Regular, History16Regular, ArrowSync16Regular, MailClock20Regular,
} from '@fluentui/react-icons';
import { SCHEDULE_PRESETS, presetForCron, validateNcrontab } from '@/lib/util/ncrontab';

type Format = 'PDF' | 'PPTX' | 'PNG';

interface Subscription {
  id: string;
  reportId: string;
  workspaceId: string;
  format: Format;
  cron: string;
  recipients: string[];
  subject?: string;
  enabled: boolean;
  createdByName?: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: 'succeeded' | 'failed';
  lastError?: string;
}

interface DeliveryLog {
  id: string;
  deliveredAt: string;
  status: 'succeeded' | 'failed';
  format: Format;
  recipients: string[];
  fileSizeBytes?: number;
  blobPath?: string;
  error?: string;
}

interface DeliveryGate {
  ready: false;
  missing: string[];
  remediation: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  headRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  subCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  subTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  formGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '420px' },
});

const PRESET_CUSTOM = '__custom__';

export function ReportSubscriptionsPanel({
  reportId, workspaceId, reportName, itemId,
}: {
  reportId: string;
  workspaceId: string;
  reportName?: string;
  itemId?: string;
}) {
  const s = useStyles();
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [gate, setGate] = useState<DeliveryGate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Create dialog state.
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>('PDF');
  const [presetId, setPresetId] = useState<string>(SCHEDULE_PRESETS[0].id);
  const [customCron, setCustomCron] = useState<string>('0 0 8 * * 1-5');
  const [recipients, setRecipients] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Delivery-history expansion.
  const [openLogsFor, setOpenLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<DeliveryLog[] | null>(null);
  const [logsErr, setLogsErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!reportId) return;
    setLoading(true); setErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/subscriptions`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); setSubs([]); return; }
      setSubs(j.subscriptions || []);
      setGate(j.deliveryGate || null);
    } catch (e: any) { setErr(e?.message || String(e)); setSubs([]); }
    finally { setLoading(false); }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  const resetForm = useCallback(() => {
    setFormat('PDF'); setPresetId(SCHEDULE_PRESETS[0].id); setCustomCron('0 0 8 * * 1-5');
    setRecipients(''); setSubject(''); setSaveErr(null);
  }, []);

  const cronPreview = useMemo(
    () => (presetId === PRESET_CUSTOM ? customCron.trim() : SCHEDULE_PRESETS.find((p) => p.id === presetId)?.cron || ''),
    [presetId, customCron],
  );

  const createSub = useCallback(async () => {
    setSaving(true); setSaveErr(null);
    // Client-side guardrails mirror the BFF so errors surface inline.
    const recips = recipients.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (recips.length === 0) { setSaveErr('Enter at least one recipient email.'); setSaving(false); return; }
    if (presetId === PRESET_CUSTOM) {
      const cErr = validateNcrontab(customCron.trim());
      if (cErr) { setSaveErr(cErr); setSaving(false); return; }
    }
    try {
      const body: Record<string, unknown> = {
        workspaceId, format, recipients: recips,
        subject: subject.trim() || undefined,
        itemId,
      };
      if (presetId === PRESET_CUSTOM) body.cron = customCron.trim();
      else body.presetId = presetId;

      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/subscriptions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setSaveErr(j.error || `HTTP ${r.status}`); return; }
      setOpen(false); resetForm();
      await load();
    } catch (e: any) { setSaveErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [recipients, presetId, customCron, workspaceId, format, subject, itemId, reportId, resetForm, load]);

  const toggleEnabled = useCallback(async (sub: Subscription) => {
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/subscriptions/${encodeURIComponent(sub.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !sub.enabled }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [reportId, load]);

  const cancelSub = useCallback(async (sub: Subscription) => {
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/subscriptions/${encodeURIComponent(sub.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      if (openLogsFor === sub.id) { setOpenLogsFor(null); setLogs(null); }
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [reportId, openLogsFor, load]);

  const loadLogs = useCallback(async (sub: Subscription) => {
    if (openLogsFor === sub.id) { setOpenLogsFor(null); setLogs(null); return; }
    setOpenLogsFor(sub.id); setLogs(null); setLogsErr(null);
    try {
      const r = await clientFetch(`/api/items/report/${encodeURIComponent(reportId)}/subscriptions/${encodeURIComponent(sub.id)}/logs`);
      const j = await r.json();
      if (!j.ok) { setLogsErr(j.error || `HTTP ${r.status}`); setLogs([]); return; }
      setLogs(j.logs || []);
    } catch (e: any) { setLogsErr(e?.message || String(e)); setLogs([]); }
  }, [reportId, openLogsFor]);

  const scheduleLabel = useCallback((cron: string) => presetForCron(cron)?.label || cron, []);

  return (
    <div className={s.root}>
      <div className={s.headRow}>
        <Subtitle2><MailClock20Regular style={{ verticalAlign: 'middle', marginRight: tokens.spacingHorizontalXS }} />Subscriptions</Subtitle2>
        <div className={s.actions}>
          <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={load} disabled={loading}>Refresh</Button>
          <Button size="small" appearance="primary" icon={<Add20Regular />} onClick={() => { resetForm(); setOpen(true); }} disabled={!workspaceId}>
            New subscription
          </Button>
        </div>
      </div>

      <Caption1 className={s.meta}>
        Schedule a recurring export of this report (PDF / PPTX / PNG) delivered by email. Rendering uses the
        real Power BI export job; delivery uses an Azure Logic App. No Microsoft Fabric required.
      </Caption1>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Scheduled delivery not yet configured</MessageBarTitle>
            Subscriptions you save are stored and will start delivering once the report-subscriptions timer
            Function and delivery Logic App are deployed. Missing: <code>{gate.missing.join(', ')}</code>. {gate.remediation}
          </MessageBarBody>
        </MessageBar>
      )}

      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {loading && !subs && <Spinner size="tiny" label="Loading subscriptions…" />}
      {subs && subs.length === 0 && <Caption1 className={s.meta}>No subscriptions yet. Create one to schedule delivery.</Caption1>}

      {(subs || []).map((sub) => (
        <div key={sub.id} className={s.subCard}>
          <div className={s.subTop}>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
              <Badge appearance="filled" color={sub.enabled ? 'brand' : 'subtle'}>{sub.format}</Badge>
              <strong>{scheduleLabel(sub.cron)}</strong>
              {sub.lastStatus && (
                <Badge appearance="tint" color={sub.lastStatus === 'succeeded' ? 'success' : 'danger'}>
                  last: {sub.lastStatus}
                </Badge>
              )}
            </div>
            <div className={s.actions}>
              <Switch checked={sub.enabled} onChange={() => toggleEnabled(sub)} label={sub.enabled ? 'Active' : 'Paused'} />
              <Button size="small" appearance="subtle" icon={<History16Regular />} onClick={() => loadLogs(sub)}>
                {openLogsFor === sub.id ? 'Hide history' : 'History'}
              </Button>
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} onClick={() => cancelSub(sub)}>Cancel</Button>
            </div>
          </div>
          <Caption1 className={s.meta}>
            To: {sub.recipients.join(', ')}{sub.subject ? ` · Subject: ${sub.subject}` : ''} · cron: <code>{sub.cron}</code>
            {sub.lastRunAt ? ` · last run: ${new Date(sub.lastRunAt).toLocaleString()}` : ''}
          </Caption1>
          {sub.lastStatus === 'failed' && sub.lastError && (
            <MessageBar intent="error"><MessageBarBody>Last delivery failed: {sub.lastError}</MessageBarBody></MessageBar>
          )}

          {openLogsFor === sub.id && (
            <div style={{ marginTop: tokens.spacingVerticalS }}>
              {logsErr && <MessageBar intent="error"><MessageBarBody>{logsErr}</MessageBarBody></MessageBar>}
              {!logs && !logsErr && <Spinner size="tiny" label="Loading delivery history…" />}
              {logs && logs.length === 0 && <Caption1 className={s.meta}>No deliveries recorded yet.</Caption1>}
              {logs && logs.length > 0 && (
                <Table size="small" aria-label="Delivery history">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Delivered</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Format</TableHeaderCell>
                      <TableHeaderCell>Size</TableHeaderCell>
                      <TableHeaderCell>Recipients</TableHeaderCell>
                      <TableHeaderCell>Detail</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{new Date(l.deliveredAt).toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge appearance="tint" color={l.status === 'succeeded' ? 'success' : 'danger'}>{l.status}</Badge>
                        </TableCell>
                        <TableCell>{l.format}</TableCell>
                        <TableCell>{typeof l.fileSizeBytes === 'number' ? `${Math.round(l.fileSizeBytes / 1024)} KB` : '—'}</TableCell>
                        <TableCell>{l.recipients.length}</TableCell>
                        <TableCell>{l.status === 'failed' ? (l.error || 'failed') : (l.blobPath || 'delivered')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      ))}

      <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>New subscription{reportName ? ` — ${reportName}` : ''}</DialogTitle>
            <DialogContent>
              <div className={s.formGrid}>
                <Field label="Format">
                  <Dropdown
                    value={format}
                    selectedOptions={[format]}
                    onOptionSelect={(_, d) => setFormat((d.optionValue as Format) || 'PDF')}
                  >
                    <Option value="PDF">PDF</Option>
                    <Option value="PPTX">PowerPoint (PPTX)</Option>
                    <Option value="PNG">Image (PNG)</Option>
                  </Dropdown>
                </Field>

                <Field label="Schedule">
                  <Dropdown
                    value={presetId === PRESET_CUSTOM ? 'Custom (advanced)' : (SCHEDULE_PRESETS.find((p) => p.id === presetId)?.label || '')}
                    selectedOptions={[presetId]}
                    onOptionSelect={(_, d) => setPresetId(d.optionValue || SCHEDULE_PRESETS[0].id)}
                  >
                    {SCHEDULE_PRESETS.map((p) => (
                      <Option key={p.id} value={p.id}>{p.label}</Option>
                    ))}
                    <Option value={PRESET_CUSTOM}>Custom (advanced)…</Option>
                  </Dropdown>
                </Field>

                {presetId === PRESET_CUSTOM && (
                  <Field
                    label="NCRONTAB (6-field: sec min hour day month day-of-week)"
                    hint="Matches the Azure Functions timer expression. Example: 0 0 8 * * 1-5 (weekdays 08:00 UTC)."
                    validationState={validateNcrontab(customCron.trim()) ? 'error' : 'none'}
                    validationMessage={validateNcrontab(customCron.trim()) || undefined}
                  >
                    <Input value={customCron} onChange={(_, d) => setCustomCron(d.value)} placeholder="0 0 8 * * 1-5" />
                  </Field>
                )}

                <Caption1 className={s.meta}>Effective cron: <code>{cronPreview || '—'}</code></Caption1>

                <Field label="Recipients" hint="One or more email addresses, separated by commas, semicolons, or spaces.">
                  <Textarea value={recipients} onChange={(_, d) => setRecipients(d.value)} placeholder="alice@contoso.com, bob@contoso.com" />
                </Field>

                <Field label="Email subject (optional)">
                  <Input value={subject} onChange={(_, d) => setSubject(d.value)} placeholder={reportName ? `Scheduled report: ${reportName}` : 'Scheduled report'} />
                </Field>

                {saveErr && <MessageBar intent="error"><MessageBarBody>{saveErr}</MessageBarBody></MessageBar>}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
              <Button appearance="primary" onClick={createSub} disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined}>
                {saving ? 'Creating…' : 'Create subscription'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
