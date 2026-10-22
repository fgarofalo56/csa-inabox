'use client';

/**
 * Container Apps auto-pause policy, inside the Admin estate power panel
 * (operator decision 2026-10-22: ON by default, global + per-app opt-out, both
 * inspectable here).
 *
 *   - ONE global switch: "Include Container Apps in pause" (default on).
 *   - ONE switch per app that can be paused or exempted, labelled by its real
 *     name, with the replica range it will be restored to.
 *   - Apps that are held out (console, never-pause list), already scale to zero,
 *     lack the estate tag, or report no scale range are LISTED with the reason,
 *     not hidden: an app that vanishes from the list is an app nobody reviewed.
 *
 * Every switch PUTs the full setting to /api/admin/estate/autopause (real route,
 * real Cosmos write). The idle-hours form is a separate control that sends only
 * {enabled, idleHours}, which leaves these opt-outs untouched server-side.
 */
import { useState } from 'react';
import { Badge, Button, Caption1, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';

interface AppRow {
  name: string;
  state: string;
  reason: string;
  minReplicas?: number;
  maxReplicas?: number;
}

const STATE_BADGE: Record<string, { label: string; color: 'success' | 'informative' | 'warning' | 'subtle' | 'danger' }> = {
  'will-pause': { label: 'will pause when idle', color: 'success' },
  exempt: { label: 'exempt', color: 'informative' },
  'held-out': { label: 'never paused', color: 'warning' },
  'already-zero': { label: 'already scales to zero', color: 'subtle' },
  'not-owned': { label: 'not tagged for this estate', color: 'subtle' },
  'scale-unknown': { label: 'scale range unknown', color: 'warning' },
  'opted-out': { label: 'opted out (global)', color: 'informative' },
  'setting-unreadable': { label: 'setting unreadable', color: 'danger' },
};

const useStyles = makeStyles({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  appRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  name: { minWidth: 0, flexBasis: '14rem', flexGrow: 1, overflowWrap: 'anywhere' },
  reason: { flexBasis: '100%', color: tokens.colorNeutralForeground3 },
});

export function EstateContainerAppsSection({ power, containerApps, styles, onChanged }: {
  power: any;
  /** The `containerApps` status block from the estate state read (RUNNING only). */
  containerApps: any;
  styles: Record<string, string>;
  onChanged: () => Promise<unknown> | void;
}) {
  const s = useStyles();
  const ap = power?.autoPause;
  const policy = ap?.containerApps ?? { enabled: true, exempt: [] as string[] };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<{ enabled: boolean; exempt: string[] } | null>(null);

  if (!ap) return null;
  const unreadable = ap.source === 'unreadable';
  const apps: AppRow[] = Array.isArray(containerApps?.apps) ? containerApps.apps : [];

  async function save(next: { enabled: boolean; exempt: string[] }) {
    setSaving(true);
    setError(null);
    setLast(next);
    try {
      const r = await clientFetch('/api/admin/estate/autopause', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: ap.enabled, idleHours: ap.idleHours, containerApps: next }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `Save failed (${r.status})`);
      await onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const toggleApp = (name: string, include: boolean) => {
    const lower = name.toLowerCase();
    const exempt = include
      ? policy.exempt.filter((n: string) => n !== lower)
      : [...policy.exempt.filter((n: string) => n !== lower), lower];
    void save({ enabled: policy.enabled, exempt });
  };

  return (
    <div className={`${styles.powerSection} ${styles.powerDivider}`} data-testid="estate-container-apps">
      <Caption1 className={styles.fieldLabel}>Container Apps</Caption1>
      <div className={s.row}>
        <Switch
          checked={policy.enabled}
          disabled={saving || unreadable}
          label={policy.enabled ? 'Include Container Apps in pause' : 'Container Apps are opted out of pause'}
          onChange={(_, d) => { void save({ enabled: d.checked, exempt: policy.exempt }); }}
        />
        <Badge appearance="tint" color={policy.enabled ? 'success' : 'informative'}>
          {policy.enabled ? 'on (default)' : 'off'}
        </Badge>
        {policy.exempt.length > 0 && (
          <Badge appearance="tint" color="informative">{policy.exempt.length} exempt</Badge>
        )}
      </div>
      <Caption1 className={styles.powerSub}>
        When the estate pauses, each app below that is marked &quot;will pause&quot; is scaled to zero replicas
        and later restored to exactly the replica range shown. The console and the apps that would lose
        state or time out on wake are never paused.
      </Caption1>

      {unreadable && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Opt-outs cannot be read</MessageBarTitle>
            Until the saved setting can be read, no Container App is paused. Save the auto-pause setting above to rewrite it.
          </MessageBarBody>
        </MessageBar>
      )}
      {containerApps?.note && (
        <MessageBar intent="info"><MessageBarBody>{containerApps.note}</MessageBarBody></MessageBar>
      )}
      {containerApps?.listError && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Container Apps could not be listed</MessageBarTitle>
            {containerApps.listError}
          </MessageBarBody>
        </MessageBar>
      )}
      {error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>The Container Apps setting was not saved</MessageBarTitle>
            {error}
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" disabled={saving || !last} onClick={() => { if (last) void save(last); }}>Retry</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {apps.length === 0 && !containerApps?.note && !containerApps?.listError && (
        <Caption1 className={styles.powerSub}>
          The per-app list is read while the estate is running; it is not shown while it is paused.
        </Caption1>
      )}
      {apps.map((a) => {
        const badge = STATE_BADGE[a.state] ?? { label: a.state, color: 'subtle' as const };
        const toggleable = a.state === 'will-pause' || a.state === 'exempt';
        return (
          <div key={a.name} className={s.appRow}>
            <div className={s.name}>
              {toggleable ? (
                <Switch
                  checked={a.state === 'will-pause'}
                  disabled={saving || unreadable || !policy.enabled}
                  label={a.name}
                  aria-label={`Auto-pause ${a.name}`}
                  onChange={(_, d) => toggleApp(a.name, d.checked)}
                />
              ) : (
                <Caption1><strong>{a.name}</strong></Caption1>
              )}
            </div>
            <Badge appearance="tint" color={badge.color}>{badge.label}</Badge>
            {typeof a.minReplicas === 'number' && typeof a.maxReplicas === 'number' && (
              <Badge appearance="tint" color="subtle">{a.minReplicas}/{a.maxReplicas} replicas</Badge>
            )}
            <Caption1 className={s.reason}>{a.reason}</Caption1>
          </div>
        );
      })}
    </div>
  );
}
