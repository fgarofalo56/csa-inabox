'use client';

/**
 * Governance → Insider risk (IRM for Lakehouse, Fabric Build 2026 #35).
 *
 * Computes insider-risk indicators (unusual volume, off-hours access,
 * privileged access) live over the Cosmos audit log + Azure Monitor — no
 * Microsoft Fabric / Purview-IRM dependency. Mirrors the Purview IRM
 * Activity-explorer concepts under the Loom theme.
 *
 * All config is STRUCTURED (Switch toggles, SpinButtons, a timezone Dropdown)
 * — no freeform query box (loom-no-freeform-config).
 */

import { clientFetch } from '@/lib/client-fetch';
import { useEffect, useState } from 'react';
import {
  Spinner, Badge, Caption1, Body1, Subtitle2, Button, Switch, SpinButton,
  Dropdown, Option, Field, Divider,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Settings24Regular, ShieldError24Regular } from '@fluentui/react-icons';
import { GovernanceShell } from '@/lib/components/governance-shell';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { Section, Toolbar } from '@/lib/components/ui/section';

type Severity = 'low' | 'medium' | 'high';

interface Finding {
  actor: string; indicatorId: string; indicator: string; category: string;
  severity: Severity; count: number; baseline: number; lastSeen: string;
  detail: string; source: 'cosmos' | 'loganalytics' | 'arm';
}
interface TopActor {
  actor: string; riskScore: number; indicators: number; highestSeverity: Severity;
  exfilEvents: number; offHoursEvents: number; lastSeen: string;
}
interface IndicatorDef {
  id: string; label: string; category: string; description: string;
  source: string; enabledByDefault: boolean;
}
interface Thresholds {
  volumeZ: number; minVolumeEvents: number; minOffHoursEvents: number;
  privilegedMinEvents: number; pipelineMinRuns: number;
  businessStart: number; businessEnd: number; flagWeekends: boolean;
  timezone: string; enabled: Record<string, boolean>;
}
interface Report {
  kpis: {
    usersAtRisk: number; unusualVolumeAlerts: number; offHoursEvents: number;
    privilegedAccessEvents: number; indicatorsActive: number; auditEventsAnalyzed: number;
  };
  findings: Finding[];
  topActors: TopActor[];
  indicators: IndicatorDef[];
  thresholds: Thresholds;
  windowDays: number;
  gates: { la?: string };
}

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney',
];

const useStyles = makeStyles({
  statsRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalXL,
  },
  statCard: {
    position: 'relative', padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge, overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
    transition: 'box-shadow 120ms ease, transform 120ms ease',
    ':hover': { boxShadow: tokens.shadow8, transform: 'translateY(-1px)' },
  },
  statCardAlert: {
    borderTopColor: tokens.colorPaletteRedBorder2,
    borderRightColor: tokens.colorPaletteRedBorder2,
    borderBottomColor: tokens.colorPaletteRedBorder2,
    borderLeftColor: tokens.colorPaletteRedBackground3,
    borderLeftWidth: '3px',
  },
  statVal: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, color: tokens.colorBrandForeground1, lineHeight: '1.1' },
  statValAlert: { color: tokens.colorPaletteRedForeground1 },
  statLabel: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  settingsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL, marginTop: tokens.spacingVerticalM,
  },
  indicatorRow: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    padding: `${tokens.spacingVerticalS} 0`,
  },
});

const sevColor = (s: Severity): 'danger' | 'warning' | 'informative' =>
  s === 'high' ? 'danger' : s === 'medium' ? 'warning' : 'informative';

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleString() : '—');

export default function IrmPage() {
  const s = useStyles();
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState<Thresholds | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = async (d = days) => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch(`/api/governance/irm?days=${d}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error); return; }
      setData(j);
      setDraft(j.thresholds);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const saveSettings = async () => {
    if (!draft) return;
    setSaving(true); setSaveMsg(null);
    try {
      const r = await clientFetch('/api/governance/irm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const j = await r.json();
      if (!j.ok) { setSaveMsg(`Save failed: ${j.error}`); return; }
      setSaveMsg('Saved. Recomputing…');
      await load();
      setShowSettings(false);
    } catch (e: any) { setSaveMsg(`Save failed: ${e?.message || String(e)}`); }
    finally { setSaving(false); }
  };

  const patchDraft = (p: Partial<Thresholds>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const toggleIndicator = (id: string, v: boolean) =>
    setDraft((d) => (d ? { ...d, enabled: { ...d.enabled, [id]: v } } : d));

  return (
    <GovernanceShell sectionTitle="Insider risk" sectionBadge="IRM">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Insider-risk indicators computed live over your lakehouse audit log and Azure Monitor — unusual data
        volume (cumulative exfiltration), off-hours / weekend access, and privileged-access anomalies. No
        Microsoft Fabric or Purview-IRM dependency.
      </Body1>

      <Toolbar actions={
        <>
          <Dropdown
            aria-label="Analysis window"
            value={`Last ${days} days`}
            selectedOptions={[String(days)]}
            onOptionSelect={(_, dt) => { const d = Number(dt.optionValue); setDays(d); load(d); }}
            style={{ minWidth: 150 }}
          >
            {[7, 14, 30, 60, 90].map((d) => <Option key={d} value={String(d)}>{`Last ${d} days`}</Option>)}
          </Dropdown>
          <Button icon={<Settings24Regular />} onClick={() => setShowSettings((v) => !v)} appearance={showSettings ? 'primary' : 'secondary'}>
            Indicators &amp; thresholds
          </Button>
          <Button icon={<ArrowSync24Regular />} onClick={() => load()} disabled={loading}>Refresh</Button>
        </>
      } />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not compute IRM indicators</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {data?.gates?.la && (
        <MessageBar intent="warning" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Azure Monitor signals not configured</MessageBarTitle>
            {data.gates.la}
          </MessageBarBody>
        </MessageBar>
      )}

      {showSettings && draft && (
        <Section title="Indicators &amp; thresholds" actions={
          <>
            <Button appearance="primary" onClick={saveSettings} disabled={saving}>
              {saving ? 'Saving…' : 'Save & recompute'}
            </Button>
            <Button appearance="subtle" onClick={() => { setDraft(data?.thresholds || draft); setShowSettings(false); }}>Cancel</Button>
            {saveMsg && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
          </>
        }>
          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Indicators</Subtitle2>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalM }}>
            Like Purview IRM, indicators are off until you opt in. Toggle which signals contribute to risk.
          </Caption1>
          {(data?.indicators || []).map((ind) => (
            <div key={ind.id} className={s.indicatorRow}>
              <Switch
                checked={!!draft.enabled[ind.id]}
                label={`${ind.label}`}
                onChange={(_, dt) => toggleIndicator(ind.id, !!dt.checked)}
              />
              <Caption1 style={{ color: tokens.colorNeutralForeground3, marginLeft: 44 }}>
                {ind.description} <Badge appearance="outline" size="small">{ind.source}</Badge>
              </Caption1>
            </div>
          ))}

          <Divider style={{ margin: `${tokens.spacingVerticalM} 0` }} />
          <Subtitle2 style={{ display: 'block', marginBottom: tokens.spacingVerticalXS }}>Thresholds</Subtitle2>
          <div className={s.settingsGrid}>
            <Field label="Volume z-score cutoff">
              <SpinButton value={draft.volumeZ} step={0.5} min={0} max={6}
                onChange={(_, dt) => patchDraft({ volumeZ: dt.value ?? (Number(dt.displayValue) || draft.volumeZ) })} />
            </Field>
            <Field label="Min exfil events (floor)">
              <SpinButton value={draft.minVolumeEvents} step={1} min={1}
                onChange={(_, dt) => patchDraft({ minVolumeEvents: dt.value ?? (Number(dt.displayValue) || draft.minVolumeEvents) })} />
            </Field>
            <Field label="Min off-hours events">
              <SpinButton value={draft.minOffHoursEvents} step={1} min={1}
                onChange={(_, dt) => patchDraft({ minOffHoursEvents: dt.value ?? (Number(dt.displayValue) || draft.minOffHoursEvents) })} />
            </Field>
            <Field label="Min privileged ops">
              <SpinButton value={draft.privilegedMinEvents} step={1} min={1}
                onChange={(_, dt) => patchDraft({ privilegedMinEvents: dt.value ?? (Number(dt.displayValue) || draft.privilegedMinEvents) })} />
            </Field>
            <Field label="Min pipeline runs">
              <SpinButton value={draft.pipelineMinRuns} step={1} min={1}
                onChange={(_, dt) => patchDraft({ pipelineMinRuns: dt.value ?? (Number(dt.displayValue) || draft.pipelineMinRuns) })} />
            </Field>
            <Field label="Business hours start">
              <SpinButton value={draft.businessStart} step={1} min={0} max={24}
                onChange={(_, dt) => patchDraft({ businessStart: dt.value ?? (Number(dt.displayValue) || draft.businessStart) })} />
            </Field>
            <Field label="Business hours end">
              <SpinButton value={draft.businessEnd} step={1} min={0} max={24}
                onChange={(_, dt) => patchDraft({ businessEnd: dt.value ?? (Number(dt.displayValue) || draft.businessEnd) })} />
            </Field>
            <Field label="Timezone">
              <Dropdown value={draft.timezone} selectedOptions={[draft.timezone]}
                onOptionSelect={(_, dt) => patchDraft({ timezone: dt.optionValue || draft.timezone })}>
                {TIMEZONES.map((tz) => <Option key={tz} value={tz}>{tz}</Option>)}
              </Dropdown>
            </Field>
            <Field label="Flag weekend access">
              <Switch checked={draft.flagWeekends} onChange={(_, dt) => patchDraft({ flagWeekends: !!dt.checked })} />
            </Field>
          </div>
        </Section>
      )}

      {loading && !error && <Spinner label="Computing insider-risk indicators…" />}

      {data && !loading && (
        <>
          <div className={s.statsRow}>
            <div className={`${s.statCard} ${data.kpis.usersAtRisk > 0 ? s.statCardAlert : ''}`}>
              <div className={`${s.statVal} ${data.kpis.usersAtRisk > 0 ? s.statValAlert : ''}`}>{data.kpis.usersAtRisk}</div>
              <div className={s.statLabel}>users at risk</div>
            </div>
            <div className={`${s.statCard} ${data.kpis.unusualVolumeAlerts > 0 ? s.statCardAlert : ''}`}>
              <div className={`${s.statVal} ${data.kpis.unusualVolumeAlerts > 0 ? s.statValAlert : ''}`}>{data.kpis.unusualVolumeAlerts}</div>
              <div className={s.statLabel}>unusual-volume alerts</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.offHoursEvents}</div>
              <div className={s.statLabel}>off-hours events</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.privilegedAccessEvents}</div>
              <div className={s.statLabel}>privileged-access events</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.indicatorsActive}</div>
              <div className={s.statLabel}>indicators active</div>
            </div>
            <div className={s.statCard}>
              <div className={s.statVal}>{data.kpis.auditEventsAnalyzed}</div>
              <div className={s.statLabel}>events analyzed ({data.windowDays}d)</div>
            </div>
          </div>

          <div className={s.sectionHeader}>
            <Subtitle2>Risk indicators</Subtitle2>
            {data.findings.length > 0 && (
              <Badge appearance="tint" color={sevColor(data.findings[0].severity)} size="small">{data.findings.length}</Badge>
            )}
          </div>
          {data.findings.length === 0 ? (
            <MessageBar intent="success" style={{ marginBottom: 20 }}>
              <MessageBarBody>
                <MessageBarTitle>No insider-risk indicators triggered</MessageBarTitle>
                No actor exceeded the configured thresholds over the last {data.windowDays} days across
                the {data.kpis.indicatorsActive} active indicator(s).
              </MessageBarBody>
            </MessageBar>
          ) : (
            <div style={{ marginBottom: 20 }}>
              <LoomDataTable
                ariaLabel="Insider-risk indicators"
                getRowId={(f) => `${f.actor}:${f.indicatorId}`}
                rows={data.findings}
                columns={[
                  {
                    key: 'severity', label: 'Severity', sortable: true, width: 120,
                    getValue: (f) => ({ high: 3, medium: 2, low: 1 }[f.severity] ?? 0),
                    render: (f) => <Badge appearance="filled" color={sevColor(f.severity)} size="small">{f.severity}</Badge>,
                  },
                  { key: 'actor', label: 'Actor', sortable: true, filterable: true, width: 220, render: (f) => <strong>{f.actor}</strong> },
                  { key: 'indicator', label: 'Indicator', sortable: true, filterable: true, width: 260, getValue: (f) => f.indicator },
                  { key: 'category', label: 'Category', sortable: true, filterable: true, width: 150, getValue: (f) => f.category },
                  { key: 'count', label: 'Count', sortable: true, width: 90, getValue: (f) => f.count },
                  { key: 'baseline', label: 'Baseline', sortable: true, width: 100, getValue: (f) => f.baseline },
                  { key: 'detail', label: 'Detail', filterable: true, width: 360, getValue: (f) => f.detail },
                  {
                    key: 'source', label: 'Source', sortable: true, width: 120,
                    getValue: (f) => f.source,
                    render: (f) => <Badge appearance="outline" size="small">{f.source}</Badge>,
                  },
                  {
                    key: 'lastSeen', label: 'Last seen', sortable: true, width: 180,
                    getValue: (f) => (f.lastSeen ? new Date(f.lastSeen).getTime() : 0),
                    render: (f) => fmtDate(f.lastSeen),
                  },
                ] as LoomColumn<Finding>[]}
              />
            </div>
          )}

          <div className={s.sectionHeader}>
            <Subtitle2>Top actors by risk</Subtitle2>
            {data.topActors.length > 0 && (
              <Badge appearance="tint" color="brand" size="small">{data.topActors.length}</Badge>
            )}
          </div>
          {data.topActors.length === 0 ? (
            <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldError24Regular style={{ color: tokens.colorPaletteGreenForeground1 }} /> No flagged actors.
            </Caption1>
          ) : (
            <LoomDataTable
              ariaLabel="Top actors by risk"
              getRowId={(a) => a.actor}
              rows={data.topActors}
              columns={[
                { key: 'actor', label: 'Actor', sortable: true, filterable: true, width: 240, render: (a) => <strong>{a.actor}</strong> },
                { key: 'riskScore', label: 'Risk score', sortable: true, width: 120, getValue: (a) => a.riskScore },
                {
                  key: 'highestSeverity', label: 'Severity', sortable: true, width: 120,
                  getValue: (a) => ({ high: 3, medium: 2, low: 1 }[a.highestSeverity] ?? 0),
                  render: (a) => <Badge appearance="filled" color={sevColor(a.highestSeverity)} size="small">{a.highestSeverity}</Badge>,
                },
                { key: 'indicators', label: 'Indicators', sortable: true, width: 110, getValue: (a) => a.indicators },
                { key: 'exfilEvents', label: 'Exfil events', sortable: true, width: 130, getValue: (a) => a.exfilEvents },
                { key: 'offHoursEvents', label: 'Off-hours', sortable: true, width: 120, getValue: (a) => a.offHoursEvents },
                {
                  key: 'lastSeen', label: 'Last seen', sortable: true, width: 180,
                  getValue: (a) => (a.lastSeen ? new Date(a.lastSeen).getTime() : 0),
                  render: (a) => fmtDate(a.lastSeen),
                },
              ] as LoomColumn<TopActor>[]}
            />
          )}
        </>
      )}
    </GovernanceShell>
  );
}
