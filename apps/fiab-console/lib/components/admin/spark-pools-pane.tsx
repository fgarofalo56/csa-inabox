'use client';

/**
 * Spark pools tab (A10) — live Spark reliability on the Health & Reliability
 * hub: per-pool ARM state with FAULTED detection (both the hard ARM fault and
 * the "Succeeded but can't launch" suspect flavor from the armed warm-pool
 * circuit breaker), warm-pool counts + cross-replica store mode, live Livy
 * session census with leaked-session candidates (the #1796 / 2026-07-14 leak
 * classes the reaper targets), quota (max vCores per pool), and recent warm
 * failures.
 *
 * REAL data only (no-vaporware.md): reads GET /api/admin/spark/health, which
 * aggregates getPoolStatus() + ARM listSparkPools() + Livy listLivySessions().
 * No Spark backend configured → the route's 503 gate envelope renders through
 * the shared HonestGate (G2 Fix-it), never a bare banner.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1Strong, Button, Caption1, Divider, MessageBar,
  MessageBarActions, MessageBarBody, MessageBarTitle, Spinner, Subtitle2, Switch, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular, ArrowSync24Regular, CheckmarkCircle24Filled, ErrorCircle24Filled,
  Flash24Regular, Open16Regular, Warning24Filled,
} from '@fluentui/react-icons';
import { HonestGate } from '@/lib/components/shared/honest-gate';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import type { PoolHealthSummary, SessionHealthRow, SparkHealthPayload } from '@/lib/admin/spark-health';

interface GateEnvelope {
  id: string; title?: string; remediation?: string; fixItHref?: string; missing?: string[];
  state?: 'blocked' | 'cloud-unavailable'; fallbackNote?: string;
}

const RUNBOOK_URL = 'https://github.com/fgarofalo56/csa-inabox/blob/main/docs/fiab/runbooks/spark-pools.md';

const useStyles = makeStyles({
  card: {
    padding: tokens.spacingVerticalXL,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    marginBottom: tokens.spacingVerticalXL,
    boxShadow: tokens.shadow4,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalMNudge,
    marginBottom: tokens.spacingVerticalL,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    minWidth: 0,
  },
  statValue: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700 },
  poolHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    marginBottom: tokens.spacingVerticalS,
  },
  poolMeta: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    marginBottom: tokens.spacingVerticalM,
  },
  poolBlock: { marginTop: tokens.spacingVerticalL, minWidth: 0 },
});

function healthBadge(p: PoolHealthSummary): React.ReactElement {
  if (p.healthState === 'faulted') return <Badge appearance="filled" color="danger">FAULTED — {p.provisioningState}</Badge>;
  if (p.healthState === 'suspect') return <Badge appearance="filled" color="warning">Suspect — breaker armed</Badge>;
  if (p.healthState === 'provisioning') return <Badge appearance="tint" color="brand">{p.provisioningState}</Badge>;
  if (p.healthState === 'deleting') return <Badge appearance="tint" color="warning">{p.provisioningState}</Badge>;
  if (p.healthState === 'ready') return <Badge appearance="tint" color="success">Ready</Badge>;
  return <Badge appearance="tint" color="informative">{p.provisioningState || 'Unknown'}</Badge>;
}

function healthIcon(p: PoolHealthSummary): React.ReactElement {
  if (p.healthState === 'faulted') return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />;
  if (p.healthState === 'suspect') return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />;
  return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />;
}

function sessionStateColor(state: string): 'success' | 'danger' | 'warning' | 'informative' | 'brand' {
  const s = state.toLowerCase();
  if (s === 'idle') return 'success';
  if (s === 'busy') return 'brand';
  if (s === 'error' || s === 'dead' || s === 'killed') return 'danger';
  if (s === 'not_started' || s === 'starting' || s === 'recovering') return 'warning';
  return 'informative';
}

function fmtAge(secs?: number): string {
  if (typeof secs !== 'number') return '—';
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

const SESSION_COLUMNS: LoomColumn<SessionHealthRow>[] = [
  { key: 'id', label: 'Livy id', getValue: (r) => r.id },
  { key: 'name', label: 'Name', render: (r) => <span>{r.name || '—'}</span>, getValue: (r) => r.name },
  {
    key: 'state', label: 'State',
    render: (r) => <Badge appearance="tint" color={sessionStateColor(r.state)}>{r.state}</Badge>,
    getValue: (r) => r.state,
  },
  {
    key: 'tracked', label: 'Tracked',
    render: (r) =>
      r.tracked
        ? <Badge appearance="tint" color="success">warm pool</Badge>
        : r.leakSuspect
          ? (
            <Tooltip relationship="description" content={r.busyZombieSuspect
              ? 'Pool-owned session stuck busy + untracked — the wedged-keepalive zombie class (2026-07-14: one held 80 cores for 2 days). The reaper reclaims it after the extended grace.'
              : 'Untracked session in a capacity-holding state — the leaked-session class the reaper reclaims after the grace window.'}>
              <Badge appearance="filled" color="warning">{r.busyZombieSuspect ? 'busy zombie?' : 'leak candidate'}</Badge>
            </Tooltip>
          )
          : <Badge appearance="tint" color="informative">untracked</Badge>,
    getValue: (r) => (r.tracked ? 'tracked' : r.leakSuspect ? 'leak' : 'untracked'),
  },
  { key: 'age', label: 'Age', render: (r) => <span>{fmtAge(r.ageSecs)}</span>, getValue: (r) => r.ageSecs ?? -1 },
  { key: 'idle', label: 'Idle', render: (r) => <span>{fmtAge(r.idleSecs)}</span>, getValue: (r) => r.idleSecs ?? -1 },
  {
    key: 'error', label: 'Error',
    render: (r) => r.error
      ? <Tooltip relationship="description" content={r.error}><span>{r.error.slice(0, 60)}{r.error.length > 60 ? '…' : ''}</span></Tooltip>
      : <span>—</span>,
    getValue: (r) => r.error || '',
  },
];

export function SparkPoolsPane({ autorecoverEnabled }: { autorecoverEnabled?: boolean } = {}) {
  const styles = useStyles();
  const [data, setData] = useState<SparkHealthPayload | null>(null);
  const [gate, setGate] = useState<GateEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A11 — auto-recovery toggle (a11-spark-autorecover flag) + manual recreate.
  const [autoOn, setAutoOn] = useState<boolean>(autorecoverEnabled ?? true);
  const [recreating, setRecreating] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'warning' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setGate(null);
    try {
      const r = await clientFetch('/api/admin/spark/health', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) { setGate(j.gate as GateEnvelope); return; }
      if (!r.ok || j?.ok === false) { setError(j?.error || `spark health failed (${r.status})`); return; }
      setData(j as SparkHealthPayload);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A11 — flip the auto-recovery kill-switch (audited runtime flag; seconds, no roll).
  const toggleAuto = useCallback(async (next: boolean) => {
    setAutoOn(next); // optimistic
    setActionMsg(null);
    try {
      const r = await clientFetch('/api/admin/runtime-flags/a11-spark-autorecover', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        setAutoOn(!next); // revert
        const j = await r.json().catch(() => ({}));
        setActionMsg({ intent: 'error', text: j?.error || `Could not ${next ? 'enable' : 'disable'} auto-recovery` });
      }
    } catch (e: unknown) {
      setAutoOn(!next);
      setActionMsg({ intent: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // A11 — operator-initiated delete + recreate of one pool (forces past thrash).
  const recreate = useCallback(async (poolName: string) => {
    setRecreating(poolName); setActionMsg(null);
    try {
      const r = await clientFetch('/api/admin/spark/recover', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poolName }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.ok === false) {
        setActionMsg({ intent: 'error', text: j?.error || `recreate failed (${r.status})` });
      } else {
        const res = j.result as { ok?: boolean; action?: string; reason?: string; provisioningState?: string };
        setActionMsg(
          res?.ok
            ? { intent: 'success', text: `Pool ${poolName} recreated — now ${res.provisioningState || 'provisioned'}.` }
            : { intent: 'warning', text: `Recreate ${res?.action || 'did not complete'}: ${res?.reason || 'see logs'}.` },
        );
        await load();
      }
    } catch (e: unknown) {
      setActionMsg({ intent: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRecreating(null);
    }
  }, [load]);

  const totals = data?.pool.totals;
  const faulted = (data?.pools || []).filter((p) => p.healthState === 'faulted' || p.healthState === 'suspect');
  const leakTotal = (data?.pools || []).reduce((n, p) => n + (p.leakSuspects || 0), 0);

  return (
    <section className={styles.card} aria-label="Spark pools">
      <div className={styles.head}>
        <Flash24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Spark pools</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          Live pool + session state from ARM and Livy — FAULTED detection, warm-pool health,
          leaked-session candidates, and quota per pool.
        </Caption1>
        <span style={{ flex: 1 }} />
        <Tooltip relationship="description"
          content="Auto-detect + delete/recreate a FAULTED or 'Succeeded-but-can't-launch' pool from the keep-warm heartbeat (thrash-guarded, operator-alerted). OFF keeps detection + alerting and the manual Recreate button, but stops the automatic recreate — the seconds-fast kill switch (a11-spark-autorecover).">
          <Switch
            checked={autoOn}
            onChange={(_, d) => toggleAuto(!!d.checked)}
            label={`Auto-recovery ${autoOn ? 'ON' : 'OFF'}`}
            aria-label="Spark pool auto-recovery"
          />
        </Tooltip>
        <Button appearance="subtle" icon={<Open16Regular />} as="a" href={RUNBOOK_URL}
          target="_blank" rel="noreferrer">
          Runbook
        </Button>
        <Button appearance="secondary" icon={loading ? <Spinner size="tiny" /> : <ArrowSync24Regular />}
          onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {gate && <HonestGate surface="Spark pools" gate={gate} onResolved={load} />}

      {actionMsg && (
        <MessageBar intent={actionMsg.intent} layout="multiline">
          <MessageBarBody>{actionMsg.text}</MessageBarBody>
        </MessageBar>
      )}

      {error && !gate && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Could not load Spark pool health</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {loading && !data && !gate && !error && <Spinner label="Loading Spark pool health…" />}

      {data && !gate && (
        <>
          {/* FAULTED / suspect pools front and center — the runbook moment. */}
          {faulted.map((p) => (
            <MessageBar key={`fault-${p.name}`} intent={p.healthState === 'faulted' ? 'error' : 'warning'} layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>
                  {p.healthState === 'faulted'
                    ? `Pool ${p.name} is FAULTED (${p.provisioningState})`
                    : `Pool ${p.name} may be faulted — warm-session launches are failing`}
                </MessageBarTitle>
                {p.lastFailure ? `Last failure: ${p.lastFailure}. ` : ''}
                {p.backoffUntil ? `Warm refill backing off until ${new Date(p.backoffUntil).toLocaleTimeString()}. ` : ''}
                A pool can report Succeeded and still be unable to launch any Spark application —
                the fix is delete + recreate (and if sessions still wedge, a NEW pool name).
                Follow the runbook: <a href={RUNBOOK_URL} target="_blank" rel="noreferrer">spark-pools.md</a>.
              </MessageBarBody>
              <MessageBarActions>
                <Button size="small" appearance="secondary"
                  icon={recreating === p.name ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
                  disabled={recreating !== null}
                  onClick={() => recreate(p.name)}>
                  {recreating === p.name ? 'Recreating…' : 'Recreate pool'}
                </Button>
              </MessageBarActions>
            </MessageBar>
          ))}

          {data.armError && (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>ARM pool census unavailable</MessageBarTitle>
                {data.armError} — the warm-pool snapshot below is still live.
              </MessageBarBody>
            </MessageBar>
          )}

          {/* Warm-pool snapshot */}
          <div className={styles.stats} role="group" aria-label="Warm pool totals">
            <div className={styles.stat}>
              <Caption1>Warm sessions</Caption1>
              <Body1Strong className={styles.statValue}>{totals?.warm ?? 0}</Body1Strong>
            </div>
            <div className={styles.stat}>
              <Caption1>Leased</Caption1>
              <Body1Strong className={styles.statValue}>{totals?.leased ?? 0}</Body1Strong>
            </div>
            <div className={styles.stat}>
              <Caption1>Warming</Caption1>
              <Body1Strong className={styles.statValue}>{totals?.warming ?? 0}</Body1Strong>
            </div>
            <div className={styles.stat}>
              <Caption1>Leak candidates</Caption1>
              <Body1Strong className={styles.statValue}>{leakTotal}</Body1Strong>
            </div>
            <div className={styles.stat}>
              <Caption1>Warm-adopt rate</Caption1>
              <Body1Strong className={styles.statValue}>
                {data.counters.total > 0 ? `${Math.round((1 - data.counters.missRate) * 100)}%` : '—'}
              </Body1Strong>
            </div>
          </div>

          <div className={styles.poolMeta}>
            <Badge appearance="tint" color={data.pool.enabled ? 'success' : 'danger'}>
              warm pool {data.pool.enabled ? 'ON' : 'OFF'}
            </Badge>
            <Badge appearance="tint" color={data.pool.store.mode === 'cosmos' ? 'success' : 'informative'}>
              lease store: {data.pool.store.mode}
            </Badge>
            <Badge appearance="tint" color={data.pool.config.reapEnabled ? 'success' : 'warning'}>
              reaper {data.pool.config.reapEnabled ? `ON (grace ${Math.round(data.pool.config.reapGraceMs / 60000)}m)` : 'OFF'}
            </Badge>
            <Badge appearance="tint" color="informative">backend: {data.backend.backend}</Badge>
          </div>

          {data.note && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{data.note}</Caption1>}

          {!data.note && data.pools.length === 0 && !data.armError && (
            <EmptyState
              title="No Spark pools in the workspace"
              body="The Synapse workspace has no Big Data pools yet. Create one from the notebook editor's pool picker or platform/fiab/bicep (landing-zone/synapse.bicep), and its live health appears here."
              primaryAction={{ label: 'Open the runbook', href: RUNBOOK_URL }}
            />
          )}

          {data.pools.map((p) => (
            <div key={p.name} className={styles.poolBlock}>
              <Divider />
              <div className={styles.poolHead} style={{ marginTop: tokens.spacingVerticalL }}>
                {healthIcon(p)}
                <Body1Strong>{p.name}</Body1Strong>
                {healthBadge(p)}
                {typeof p.leakSuspects === 'number' && p.leakSuspects > 0 && (
                  <Badge appearance="filled" color="warning">{p.leakSuspects} leak candidate{p.leakSuspects === 1 ? '' : 's'}</Badge>
                )}
                <span style={{ flex: 1 }} />
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  warm {p.warm} · leased {p.leased} · warming {p.warming}
                </Caption1>
                <Tooltip relationship="description" content="Delete + recreate this Spark pool (Synapse ARM). The fix for a FAULTED / can't-launch pool; forces past the auto-recovery thrash guard.">
                  <Button size="small" appearance="subtle"
                    icon={recreating === p.name ? <Spinner size="tiny" /> : <ArrowClockwise16Regular />}
                    disabled={recreating !== null}
                    onClick={() => recreate(p.name)}>
                    {recreating === p.name ? 'Recreating…' : 'Recreate'}
                  </Button>
                </Tooltip>
              </div>
              <div className={styles.poolMeta}>
                <Badge appearance="tint" color="informative">{p.nodeSize || 'size?'}</Badge>
                <Badge appearance="tint" color="informative">
                  {p.autoScale?.enabled ? `autoscale ${p.autoScale.min}–${p.autoScale.max} nodes` : `${p.maxNodes} nodes`}
                </Badge>
                <Badge appearance="tint" color="informative">≤ {p.maxVCores} vCores</Badge>
                {typeof p.autoPauseMinutes === 'number' && (
                  <Badge appearance="tint" color="informative">autopause {p.autoPauseMinutes}m</Badge>
                )}
                {p.sparkVersion && <Badge appearance="tint" color="informative">Spark {p.sparkVersion}</Badge>}
              </div>
              {p.sessionsError && (
                <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>
                  Livy session census unavailable: {p.sessionsError}
                </Caption1>
              )}
              {p.sessions && p.sessions.length > 0 && (
                <LoomDataTable<SessionHealthRow>
                  columns={SESSION_COLUMNS}
                  rows={p.sessions}
                  getRowId={(r) => String(r.id)}
                  density="compact"
                  ariaLabel={`Live Livy sessions on ${p.name}`}
                />
              )}
              {p.sessions && p.sessions.length === 0 && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  No live Livy sessions on this pool.
                </Caption1>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
