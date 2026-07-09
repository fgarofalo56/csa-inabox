'use client';

/**
 * FGC-25 — Surge protection panel (Capacity & compute → Surge protection).
 *
 * Fabric-parity two-level admission control, themed Fluent v9 + Loom tokens:
 *   1. Master switch (ships ON — cost protection, not an enablement gate).
 *   2. Capacity-level rejection threshold % (a SpinButton) + optional per-engine
 *      override thresholds.
 *   3. Per-workspace LCU/hour cap (a SpinButton; 0 = unlimited).
 *
 * All controls are typed (Switch / SpinButton) — NO freeform JSON. Real backend:
 * GET/PUT /api/admin/capacity/guardrails (tenant-admin gated). Rejections are
 * enforced at the Spark / Databricks / ADX job-submission choke points.
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Switch, SpinButton, Field, Spinner, Button, Badge, Caption1, Body1,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Save20Regular, ShieldTask20Regular } from '@fluentui/react-icons';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface EngineMeta { id: string; label: string }
interface Policy {
  enabled: boolean;
  rejectionThresholdPct: number;
  perEngine: Record<string, number>;
  workspaceCuCapPerHour: number;
  updatedAt?: string;
  updatedBy?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  intro: { color: tokens.colorNeutralForeground2, lineHeight: 1.55 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  cardIcon: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', height: '32px', flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  cardTitle: { fontWeight: tokens.fontWeightSemibold },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  spin: { maxWidth: '160px' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  muted: { color: tokens.colorNeutralForeground3 },
  disabled: { opacity: 0.55 },
});

export function SurgeProtectionPanel() {
  const styles = useStyles();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [engines, setEngines] = useState<EngineMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    clientFetch('/api/admin/capacity/guardrails', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401 || r.status === 403) { setGate('Surge protection is a tenant-admin surface. Sign in as a tenant admin (LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID).'); return null; }
        return r.json();
      })
      .then((j: any) => {
        if (cancelled || !j) return;
        if (j.ok) { setPolicy(j.policy); setEngines(j.engines || []); }
        else setError(j.error || 'Failed to load policy');
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const patch = useCallback((p: Partial<Policy>) => {
    setPolicy((cur) => (cur ? { ...cur, ...p } : cur));
    setDirty(true); setSaved(false);
  }, []);

  const patchEngine = useCallback((id: string, value: number | undefined) => {
    setPolicy((cur) => {
      if (!cur) return cur;
      const perEngine = { ...cur.perEngine };
      if (value == null || Number.isNaN(value)) delete perEngine[id];
      else perEngine[id] = value;
      return { ...cur, perEngine };
    });
    setDirty(true); setSaved(false);
  }, []);

  const save = useCallback(() => {
    if (!policy) return;
    setSaving(true); setError(null); setSaved(false);
    clientFetch('/api/admin/capacity/guardrails', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(policy),
    })
      .then((r) => r.json())
      .then((j: any) => {
        if (j.ok) { setPolicy(j.policy); setEngines(j.engines || engines); setSaved(true); setDirty(false); }
        else setError(j.error || 'Save failed');
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  }, [policy, engines]);

  if (loading) return <Spinner label="Loading surge-protection policy…" />;
  if (gate) return (
    <MessageBar intent="warning">
      <MessageBarBody><MessageBarTitle>Tenant-admin access required</MessageBarTitle>{gate}</MessageBarBody>
    </MessageBar>
  );
  if (!policy) return (
    <MessageBar intent="error"><MessageBarBody>{error || 'Policy unavailable'}</MessageBarBody></MessageBar>
  );

  const off = !policy.enabled;

  return (
    <div className={styles.root}>
      <Body1 className={styles.intro}>
        Loom-enforced admission control — the Azure-native 1:1 of Microsoft Fabric&apos;s two-level surge
        protection. New Spark, Databricks and KQL jobs are rejected early (before Azure&apos;s own hard
        throttle) when a capacity is over its utilization threshold, and a per-workspace LCU/hour cap stops
        one workspace from starving the rest. It ships <strong>enabled</strong> with generous defaults — a
        cost-protection control, not an enablement gate — and you can tune or disable it here.
        {' '}
        <LearnPopover
          title="Capacity surge protection"
          content="Fabric rejects new background jobs at the capacity level before a hard throttle, and caps per-workspace CU. Loom enforces the same model itself (ADX/Synapse/Databricks have no native surge primitive): the rejection threshold is checked against real Azure Monitor utilization at job submission, and the per-workspace cap is checked against recorded per-execution cost attribution. A rejected job returns a 429 naming the rule that tripped and this override path."
          tips={['Ships ON with a 90% default threshold', 'Rejections return HTTP 429 with the rule + override path', 'Utilization is real Azure Monitor; the LCU cap is real recorded attribution']}
          learnMoreHref="https://learn.microsoft.com/fabric/enterprise/surge-protection"
        />
      </Body1>

      {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {saved && <MessageBar intent="success"><MessageBarBody>Surge-protection policy saved.</MessageBarBody></MessageBar>}

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon} aria-hidden><ShieldTask20Regular /></span>
          <span className={styles.cardTitle}>Admission control</span>
          <Badge appearance="tint" color={policy.enabled ? 'success' : 'warning'}>
            {policy.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <Switch
          checked={policy.enabled}
          onChange={(_, d) => patch({ enabled: d.checked })}
          label={policy.enabled ? 'Surge protection is enforcing job admission' : 'Surge protection is OFF — jobs are never rejected for load'}
        />
      </div>

      <div className={`${styles.card} ${off ? styles.disabled : ''}`}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>Capacity-level rejection threshold</span>
        </div>
        <Caption1 className={styles.muted}>
          Reject new jobs when the target engine&apos;s current Azure Monitor utilization is at or above this
          percentage. Real for engines Monitor exposes a clean % for (ADX cluster CPU); Spark and Databricks
          are governed by the per-workspace LCU cap below.
        </Caption1>
        <Field label="Default threshold (%)">
          <SpinButton
            className={styles.spin}
            min={0}
            max={100}
            step={5}
            value={policy.rejectionThresholdPct}
            disabled={off}
            onChange={(_, d) => {
              const v = d.value ?? Number(d.displayValue);
              if (v != null && !Number.isNaN(v)) patch({ rejectionThresholdPct: Math.max(0, Math.min(100, v)) });
            }}
          />
        </Field>
        <Caption1 className={styles.muted}>Per-engine overrides (leave blank to use the default)</Caption1>
        <div className={styles.grid}>
          {engines.map((e) => (
            <Field key={e.id} label={e.label}>
              <SpinButton
                className={styles.spin}
                min={0}
                max={100}
                step={5}
                disabled={off}
                value={policy.perEngine[e.id] ?? -1}
                displayValue={policy.perEngine[e.id] != null ? String(policy.perEngine[e.id]) : ''}
                onChange={(_, d) => {
                  const raw = d.value ?? Number(d.displayValue);
                  if (raw == null || Number.isNaN(raw) || raw < 0) patchEngine(e.id, undefined);
                  else patchEngine(e.id, Math.max(0, Math.min(100, raw)));
                }}
              />
            </Field>
          ))}
        </div>
      </div>

      <div className={`${styles.card} ${off ? styles.disabled : ''}`}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>Per-workspace consumption cap</span>
        </div>
        <Caption1 className={styles.muted}>
          Reject new jobs from a workspace once it has consumed this many Loom Capacity Units (LCU) in the
          current clock hour, summed from real per-execution cost attribution. Set to 0 for no cap.
        </Caption1>
        <Field label="Workspace cap (LCU / hour)">
          <SpinButton
            className={styles.spin}
            min={0}
            max={1_000_000}
            step={50}
            value={policy.workspaceCuCapPerHour}
            disabled={off}
            onChange={(_, d) => {
              const v = d.value ?? Number(d.displayValue);
              if (v != null && !Number.isNaN(v)) patch({ workspaceCuCapPerHour: Math.max(0, Math.round(v)) });
            }}
          />
        </Field>
      </div>

      <div className={styles.actions}>
        <Button appearance="primary" icon={<Save20Regular />} disabled={saving || !dirty} onClick={save}>
          {saving ? 'Saving…' : 'Save policy'}
        </Button>
        {policy.updatedAt && (
          <Caption1 className={styles.muted}>
            Last updated {new Date(policy.updatedAt).toLocaleString()}{policy.updatedBy ? ` by ${policy.updatedBy}` : ''}
          </Caption1>
        )}
      </div>
    </div>
  );
}
