'use client';

/**
 * B-N19d — InsightDigestsPanel: schedule + manage Copilot-narrated insight
 * digests, and preview one against REAL Azure Monitor data before it ever mails.
 *
 * Every control calls the real BFF (no-vaporware.md):
 *   GET    /api/insights/digests                  list + options + delivery gate
 *   POST   /api/insights/digests                  create
 *   PATCH  /api/insights/digests/[id]             edit / pause / resume
 *   DELETE /api/insights/digests/[id]             delete
 *   POST   /api/insights/digests/[id]/preview     REAL Monitor run + narration
 *   POST   /api/insights/digests/[id]/run         queue delivery on the next C5 tick
 *
 * Delivery is performed by the EXISTING report-subscriptions timer Function —
 * the same scheduler + delivery Logic App report subscriptions use. When that
 * infra is absent the BFF returns `deliveryGate` and this pane renders an honest
 * warning MessageBar with an inline **Fix it** button into the Admin gate
 * registry (G2) — definitions still save and start delivering once it lands.
 *
 * No freeform config: schedule is a preset dropdown (advanced NCRONTAB behind
 * "Custom", validated identically to report subscriptions), resource types are a
 * multiselect over the live METRIC_CATALOG, and every numeric knob is a
 * bounded dropdown. Fluent v9 + Loom tokens only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Dropdown, Field, Input, MessageBar, MessageBarActions,
  MessageBarBody, MessageBarTitle, Option, Spinner, Switch, Textarea, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete16Regular, Play16Regular, Send16Regular,
  MailClock20Regular, Wrench16Regular,
} from '@fluentui/react-icons';
import { Section, Toolbar } from '@/lib/components/ui/section';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { EmptyState } from '@/lib/components/empty-state';
import { clientFetch } from '@/lib/client-fetch';
import { SCHEDULE_PRESETS, presetForCron, validateNcrontab } from '@/lib/util/ncrontab';

const PRESET_CUSTOM = '__custom__';

const LOOKBACK_OPTIONS = [
  { value: 1, label: 'Last 1 hour' },
  { value: 6, label: 'Last 6 hours' },
  { value: 24, label: 'Last 24 hours' },
  { value: 72, label: 'Last 3 days' },
  { value: 168, label: 'Last 7 days' },
];

const THRESHOLD_OPTIONS = [10, 15, 25, 50, 100];

interface DigestRow {
  id: string;
  name: string;
  description?: string;
  cron: string;
  enabled: boolean;
  lookbackHours: number;
  resourceTypes: string[];
  includeAlerts: boolean;
  anomalyThresholdPct: number;
  recipients: string[];
  narration: 'copilot' | 'deterministic';
  lastRunAt?: string;
  lastStatus?: 'succeeded' | 'failed' | 'skipped';
  lastError?: string;
  runNowRequestedAt?: string;
}

interface DeliveryGate {
  id: string;
  title: string;
  remediation: string;
  missing: string[];
  fixItHref: string;
}

interface PreviewDelta {
  resourceName: string;
  resourceType: string;
  label: string;
  previous: number | null;
  current: number | null;
  deltaPct: number | null;
  anomaly: boolean;
}

interface PreviewResult {
  narration: string;
  narratedByCopilot: boolean;
  narrationNote?: string;
  resourcesSampled: number;
  observation: {
    windowStart: string;
    windowEnd: string;
    deltas: PreviewDelta[];
    alerts: Array<{ id: string; alertRule: string; severity?: string; startDateTime: string; targetResourceName?: string }>;
  };
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  head: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  headIcon: { color: tokens.colorBrandForeground1, width: '20px', height: '20px' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '440px' },
  tagRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  actionRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  narration: {
    whiteSpace: 'pre-wrap',
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  previewBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0, maxWidth: '860px' },
  anomaly: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  cellName: { minWidth: 0, overflowWrap: 'anywhere' },
});

function shortType(t: string): string {
  const i = (t || '').lastIndexOf('/');
  return i >= 0 ? t.slice(i + 1) : t;
}

function fmt(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export function InsightDigestsPanel() {
  const s = useStyles();
  const [digests, setDigests] = useState<DigestRow[] | null>(null);
  const [typeOptions, setTypeOptions] = useState<string[]>([]);
  const [gate, setGate] = useState<DeliveryGate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Editor dialog state (create + edit share one form — no second surface).
  const [editing, setEditing] = useState<DigestRow | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [presetId, setPresetId] = useState(SCHEDULE_PRESETS[0].id);
  const [customCron, setCustomCron] = useState('0 0 8 * * 1-5');
  const [lookback, setLookback] = useState(24);
  const [threshold, setThreshold] = useState(25);
  const [types, setTypes] = useState<string[]>([]);
  const [includeAlerts, setIncludeAlerts] = useState(true);
  const [narrationMode, setNarrationMode] = useState<'copilot' | 'deterministic'>('copilot');
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Preview dialog state.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFor, setPreviewFor] = useState<DigestRow | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewGate, setPreviewGate] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await clientFetch('/api/insights/digests');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        setDigests([]);
        return;
      }
      setDigests(j.digests || []);
      setTypeOptions(j.resourceTypeOptions || []);
      setGate(j.deliveryGate || null);
    } catch (e) {
      setError((e as Error)?.message || String(e));
      setDigests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cron = useMemo(
    () => (presetId === PRESET_CUSTOM ? customCron.trim() : SCHEDULE_PRESETS.find((p) => p.id === presetId)?.cron || ''),
    [presetId, customCron],
  );
  const cronError = useMemo(() => (presetId === PRESET_CUSTOM ? validateNcrontab(customCron) : null), [presetId, customCron]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setName('');
    setDescription('');
    setPresetId(SCHEDULE_PRESETS[0].id);
    setCustomCron('0 0 8 * * 1-5');
    setLookback(24);
    setThreshold(25);
    setTypes([]);
    setIncludeAlerts(true);
    setNarrationMode('copilot');
    setRecipients('');
    setSaveErr(null);
    setOpen(true);
  }, []);

  const openEdit = useCallback((d: DigestRow) => {
    setEditing(d);
    setName(d.name);
    setDescription(d.description || '');
    const preset = presetForCron(d.cron);
    setPresetId(preset ? preset.id : PRESET_CUSTOM);
    setCustomCron(d.cron);
    setLookback(d.lookbackHours);
    setThreshold(d.anomalyThresholdPct);
    setTypes(d.resourceTypes);
    setIncludeAlerts(d.includeAlerts);
    setNarrationMode(d.narration);
    setRecipients(d.recipients.join(', '));
    setSaveErr(null);
    setOpen(true);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveErr(null);
    const body = {
      name,
      description,
      cron,
      lookbackHours: lookback,
      anomalyThresholdPct: threshold,
      resourceTypes: types,
      includeAlerts,
      narration: narrationMode,
      recipients: recipients.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean),
    };
    try {
      const url = editing ? `/api/insights/digests/${encodeURIComponent(editing.id)}` : '/api/insights/digests';
      const r = await clientFetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(Array.isArray(j.errors) && j.errors.length ? j.errors.join('; ') : j.error || `HTTP ${r.status}`);
        return;
      }
      setOpen(false);
      await load();
    } catch (e) {
      setSaveErr((e as Error)?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [name, description, cron, lookback, threshold, types, includeAlerts, narrationMode, recipients, editing, load]);

  const toggleEnabled = useCallback(async (d: DigestRow) => {
    setBusyId(d.id);
    setNotice(null);
    try {
      const r = await clientFetch(`/api/insights/digests/${encodeURIComponent(d.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      const j = await r.json();
      if (!j.ok) setError(j.error || `HTTP ${r.status}`);
      else await load();
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const remove = useCallback(async (d: DigestRow) => {
    setBusyId(d.id);
    try {
      const r = await clientFetch(`/api/insights/digests/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) setError(j.error || `HTTP ${r.status}`);
      else await load();
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const queueRun = useCallback(async (d: DigestRow) => {
    setBusyId(d.id);
    setNotice(null);
    try {
      const r = await clientFetch(`/api/insights/digests/${encodeURIComponent(d.id)}/run`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setError(j.error || `HTTP ${r.status}`);
      else {
        setNotice(j.message || 'Queued for the next scheduled tick.');
        await load();
      }
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const runPreview = useCallback(async (d: DigestRow) => {
    setPreviewFor(d);
    setPreview(null);
    setPreviewErr(null);
    setPreviewGate(null);
    setPreviewOpen(true);
    try {
      const r = await clientFetch(`/api/insights/digests/${encodeURIComponent(d.id)}/preview`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        if (j.gate?.message) setPreviewGate(j.gate.message);
        else setPreviewErr(j.error || `HTTP ${r.status}`);
        return;
      }
      if (j.disabled) {
        setPreviewGate(j.message);
        return;
      }
      setPreview(j as PreviewResult);
    } catch (e) {
      setPreviewErr((e as Error)?.message || String(e));
    }
  }, []);

  const columns: LoomColumn<DigestRow>[] = [
    {
      key: 'name', label: 'Digest', sortable: true, filterable: true, width: 260,
      getValue: (d) => d.name,
      render: (d) => (
        <div className={s.cellName}>
          <strong>{d.name}</strong>
          <Caption1 className={s.muted} style={{ display: 'block' }}>
            {presetForCron(d.cron)?.label || d.cron}
          </Caption1>
        </div>
      ),
    },
    {
      key: 'resourceTypes', label: 'Sampled', sortable: false, filterable: true, width: 240,
      getValue: (d) => d.resourceTypes.join(' '),
      render: (d) => (
        <div className={s.tagRow}>
          {d.resourceTypes.map((t) => (
            <Badge key={t} appearance="tint" size="small">{shortType(t)}</Badge>
          ))}
          {d.includeAlerts && <Badge appearance="tint" color="warning" size="small">alerts</Badge>}
        </div>
      ),
    },
    {
      key: 'window', label: 'Window', sortable: true, width: 130,
      getValue: (d) => d.lookbackHours,
      render: (d) => <span>{d.lookbackHours}h · ≥{d.anomalyThresholdPct}%</span>,
    },
    {
      key: 'recipients', label: 'Recipients', sortable: true, width: 120,
      getValue: (d) => d.recipients.length,
      render: (d) => <span>{d.recipients.length}</span>,
    },
    {
      key: 'lastStatus', label: 'Last run', sortable: true, width: 190,
      getValue: (d) => (d.lastRunAt ? new Date(d.lastRunAt).getTime() : 0),
      render: (d) => (
        <div className={s.tagRow}>
          {d.lastStatus
            ? <Badge appearance="tint" size="small" color={d.lastStatus === 'succeeded' ? 'success' : d.lastStatus === 'failed' ? 'danger' : 'informative'}>{d.lastStatus}</Badge>
            : <Badge appearance="tint" size="small" color="informative">never run</Badge>}
          {d.lastRunAt && <Caption1 className={s.muted}>{new Date(d.lastRunAt).toLocaleString()}</Caption1>}
          {d.runNowRequestedAt && <Badge appearance="tint" color="brand" size="small">queued</Badge>}
        </div>
      ),
    },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 330,
      render: (d) => (
        <div className={s.actionRow}>
          <Tooltip content="Run now against live Azure Monitor data (no email sent)" relationship="label">
            <Button size="small" icon={<Play16Regular />} disabled={busyId === d.id} onClick={() => void runPreview(d)}>Preview</Button>
          </Tooltip>
          <Tooltip content="Queue a real delivery on the next report-subscriptions tick" relationship="label">
            <Button size="small" icon={<Send16Regular />} disabled={busyId === d.id} onClick={() => void queueRun(d)}>Send</Button>
          </Tooltip>
          <Button size="small" appearance="subtle" disabled={busyId === d.id} onClick={() => openEdit(d)}>Edit</Button>
          <Switch
            checked={d.enabled}
            disabled={busyId === d.id}
            onChange={() => void toggleEnabled(d)}
            label={d.enabled ? 'On' : 'Off'}
          />
          <Button size="small" appearance="subtle" icon={<Delete16Regular />} disabled={busyId === d.id} onClick={() => void remove(d)} aria-label={`Delete ${d.name}`} />
        </div>
      ),
    },
  ];

  return (
    <div className={s.root}>
      <Section
        title={
          <span className={s.head}>
            <MailClock20Regular className={s.headIcon} aria-hidden />
            Scheduled digests
          </span>
        }
        actions={<Badge appearance="tint" color="informative">delivered by the report-subscriptions scheduler</Badge>}
      >
        <Body1 className={s.muted}>
          Turn Azure Monitor metric movement and fired alerts into a Copilot-narrated digest, delivered on a
          schedule to the people who need it. Digests ride the same timer Function and delivery Logic App that
          report subscriptions use &mdash; there is no second scheduler to operate.
        </Body1>

        {gate && (
          <MessageBar intent="warning" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>{gate.title} is not configured</MessageBarTitle>
              {gate.remediation}
              {gate.missing.length ? ` Missing: ${gate.missing.join(', ')}.` : ''}
              {' '}Digests you save here are stored now and begin delivering the moment the scheduler lands.
            </MessageBarBody>
            <MessageBarActions>
              <Button size="small" icon={<Wrench16Regular />} as="a" href={gate.fixItHref}>Fix it</Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {error && (
          <MessageBar intent="error" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Could not load scheduled digests</MessageBarTitle>
              {error}
            </MessageBarBody>
          </MessageBar>
        )}

        {notice && (
          <MessageBar intent="success" layout="multiline">
            <MessageBarBody>{notice}</MessageBarBody>
          </MessageBar>
        )}

        <Toolbar
          actions={
            <>
              <Button appearance="primary" icon={<Add20Regular />} onClick={openCreate}>New digest</Button>
              <Button icon={<ArrowSync20Regular />} onClick={() => void load()} disabled={loading}>Refresh</Button>
            </>
          }
        />

        {!loading && digests && digests.length === 0 ? (
          <EmptyState
            icon={<MailClock20Regular />}
            title="No scheduled digests yet"
            body="Create a digest to have Loom compare the last window of Azure Monitor metrics against the one before it, narrate what moved, and email the summary on your schedule."
            primaryAction={{ label: 'New digest', onClick: openCreate }}
          />
        ) : (
          <LoomDataTable
            ariaLabel="Scheduled insight digests"
            getRowId={(d) => d.id}
            rows={digests ?? []}
            loading={loading}
            skeleton={3}
            empty="No scheduled digests yet."
            columns={columns}
          />
        )}
      </Section>

      {/* Create / edit */}
      <Dialog open={open} onOpenChange={(_e, data) => setOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{editing ? 'Edit digest' : 'New scheduled digest'}</DialogTitle>
            <DialogContent>
              <div className={s.form}>
                {saveErr && (
                  <MessageBar intent="error" layout="multiline">
                    <MessageBarBody>{saveErr}</MessageBarBody>
                  </MessageBar>
                )}
                <Field label="Name" required>
                  <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="Platform health — daily" />
                </Field>
                <Field label="Description" hint="Shown in the digest list only.">
                  <Textarea value={description} onChange={(_e, d) => setDescription(d.value)} rows={2} />
                </Field>
                <Field label="Schedule" required hint="Evaluated in UTC by the report-subscriptions timer Function.">
                  <Dropdown
                    value={presetId === PRESET_CUSTOM ? 'Custom NCRONTAB' : SCHEDULE_PRESETS.find((p) => p.id === presetId)?.label || ''}
                    selectedOptions={[presetId]}
                    onOptionSelect={(_e, d) => setPresetId(String(d.optionValue))}
                  >
                    {SCHEDULE_PRESETS.map((p) => <Option key={p.id} value={p.id}>{p.label}</Option>)}
                    <Option value={PRESET_CUSTOM}>Custom NCRONTAB</Option>
                  </Dropdown>
                </Field>
                {presetId === PRESET_CUSTOM && (
                  <Field
                    label="NCRONTAB"
                    required
                    validationState={cronError ? 'error' : 'none'}
                    validationMessage={cronError || '6 fields: second minute hour day month day-of-week'}
                  >
                    <Input value={customCron} onChange={(_e, d) => setCustomCron(d.value)} />
                  </Field>
                )}
                <Field label="Comparison window" required hint="Compared against the immediately preceding window of the same length.">
                  <Dropdown
                    value={LOOKBACK_OPTIONS.find((o) => o.value === lookback)?.label || ''}
                    selectedOptions={[String(lookback)]}
                    onOptionSelect={(_e, d) => setLookback(Number(d.optionValue))}
                  >
                    {LOOKBACK_OPTIONS.map((o) => <Option key={o.value} value={String(o.value)}>{o.label}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Anomaly threshold" required hint="Percent change at or above which a movement is called out.">
                  <Dropdown
                    value={`${threshold}% change`}
                    selectedOptions={[String(threshold)]}
                    onOptionSelect={(_e, d) => setThreshold(Number(d.optionValue))}
                  >
                    {THRESHOLD_OPTIONS.map((t) => <Option key={t} value={String(t)}>{`${t}% change`}</Option>)}
                  </Dropdown>
                </Field>
                <Field label="Azure resource types to sample" required hint="Metrics come from the Loom platform resources of these types.">
                  <Dropdown
                    multiselect
                    placeholder="Select one or more resource types"
                    value={types.map(shortType).join(', ')}
                    selectedOptions={types}
                    onOptionSelect={(_e, d) => setTypes(d.selectedOptions)}
                  >
                    {typeOptions.map((t) => <Option key={t} value={t}>{shortType(t)}</Option>)}
                  </Dropdown>
                </Field>
                <Switch
                  checked={includeAlerts}
                  onChange={(_e, d) => setIncludeAlerts(d.checked)}
                  label="Include Azure Monitor alerts that fired in the window"
                />
                <Field label="Narration" hint="Copilot narrates the observed movement; deterministic writes a grounded summary with no model call.">
                  <Dropdown
                    value={narrationMode === 'copilot' ? 'Copilot narration' : 'Deterministic summary'}
                    selectedOptions={[narrationMode]}
                    onOptionSelect={(_e, d) => setNarrationMode(d.optionValue === 'deterministic' ? 'deterministic' : 'copilot')}
                  >
                    <Option value="copilot">Copilot narration</Option>
                    <Option value="deterministic">Deterministic summary</Option>
                  </Dropdown>
                </Field>
                <Field label="Recipients" required hint="Comma-separated email addresses.">
                  <Textarea value={recipients} onChange={(_e, d) => setRecipients(d.value)} rows={2} placeholder="ops@contoso.com, data-platform@contoso.com" />
                </Field>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={saving || !name.trim() || !types.length || !recipients.trim() || !!cronError}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create digest'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Preview */}
      <Dialog open={previewOpen} onOpenChange={(_e, data) => setPreviewOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{previewFor ? `Preview — ${previewFor.name}` : 'Preview'}</DialogTitle>
            <DialogContent>
              <div className={s.previewBody}>
                {!preview && !previewErr && !previewGate && <Spinner label="Sampling Azure Monitor and narrating…" />}
                {previewGate && (
                  <MessageBar intent="warning" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Preview unavailable</MessageBarTitle>
                      {previewGate}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {previewErr && (
                  <MessageBar intent="error" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Preview failed</MessageBarTitle>
                      {previewErr}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {preview && (
                  <>
                    <div className={s.tagRow}>
                      <Badge appearance="tint" color={preview.narratedByCopilot ? 'brand' : 'informative'}>
                        {preview.narratedByCopilot ? 'Copilot narration' : 'Deterministic summary'}
                      </Badge>
                      <Badge appearance="tint">{preview.resourcesSampled} resource(s) sampled</Badge>
                      <Caption1 className={s.muted}>
                        {new Date(preview.observation.windowStart).toLocaleString()} → {new Date(preview.observation.windowEnd).toLocaleString()}
                      </Caption1>
                    </div>
                    {preview.narrationNote && (
                      <MessageBar intent="warning" layout="multiline">
                        <MessageBarBody>{preview.narrationNote}</MessageBarBody>
                      </MessageBar>
                    )}
                    <div className={s.narration}>{preview.narration}</div>
                    <LoomDataTable
                      ariaLabel="Metric movement"
                      getRowId={(d) => `${d.resourceName}:${d.label}`}
                      rows={preview.observation.deltas}
                      empty="Azure Monitor returned no samples for the selected resource types in this window."
                      columns={[
                        {
                          key: 'resourceName', label: 'Resource', sortable: true, filterable: true, width: 220,
                          getValue: (d) => d.resourceName,
                          render: (d) => (
                            <div className={s.cellName}>
                              <strong>{d.resourceName}</strong>
                              <Caption1 className={s.muted} style={{ display: 'block' }}>{shortType(d.resourceType)}</Caption1>
                            </div>
                          ),
                        },
                        { key: 'label', label: 'Metric', sortable: true, filterable: true, width: 200, getValue: (d) => d.label, render: (d) => d.label },
                        { key: 'previous', label: 'Previous', sortable: true, width: 110, getValue: (d) => d.previous ?? 0, render: (d) => fmt(d.previous) },
                        { key: 'current', label: 'Current', sortable: true, width: 110, getValue: (d) => d.current ?? 0, render: (d) => fmt(d.current) },
                        {
                          key: 'deltaPct', label: 'Change', sortable: true, width: 120,
                          getValue: (d) => (d.deltaPct == null ? 0 : Math.abs(d.deltaPct)),
                          render: (d) => <span className={d.anomaly ? s.anomaly : undefined}>{fmtPct(d.deltaPct)}</span>,
                        },
                      ] as LoomColumn<PreviewDelta>[]}
                    />
                    {preview.observation.alerts.length > 0 && (
                      <LoomDataTable
                        ariaLabel="Alerts fired in the window"
                        getRowId={(a) => a.id}
                        rows={preview.observation.alerts}
                        empty="No alerts fired."
                        columns={[
                          { key: 'alertRule', label: 'Rule', sortable: true, filterable: true, width: 240, getValue: (a) => a.alertRule, render: (a) => a.alertRule },
                          { key: 'severity', label: 'Severity', sortable: true, width: 120, getValue: (a) => a.severity || '', render: (a) => a.severity || '—' },
                          { key: 'target', label: 'Target', sortable: true, width: 200, getValue: (a) => a.targetResourceName || '', render: (a) => a.targetResourceName || '—' },
                          { key: 'startDateTime', label: 'Fired', sortable: true, width: 190, getValue: (a) => new Date(a.startDateTime).getTime(), render: (a) => new Date(a.startDateTime).toLocaleString() },
                        ] as LoomColumn<{ id: string; alertRule: string; severity?: string; startDateTime: string; targetResourceName?: string }>[]}
                      />
                    )}
                  </>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPreviewOpen(false)}>Close</Button>
              {previewFor && (
                <Button appearance="primary" icon={<Send16Regular />} onClick={() => { setPreviewOpen(false); void queueRun(previewFor); }}>
                  Queue delivery
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
