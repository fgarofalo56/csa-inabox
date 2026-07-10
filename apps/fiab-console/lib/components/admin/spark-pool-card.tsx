'use client';

/**
 * PSR-3 — warm Spark session-pool status + control card (on /admin/performance).
 *
 * Surfaces the DEFAULT-ON warm pool: live warm / shared / leased / warming counts,
 * the cross-replica lease-store mode (cosmos = shared across ACA replicas /
 * memory = per-replica, with an honest note on what to set for shared mode), and
 * two tenant-admin controls — the kill switch (enabled) and the FGC-10
 * high-concurrency shared-session toggle. Fluent v9 + Loom tokens only
 * (web3-ui.md); real backend via /api/spark/session-pool (no-vaporware.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1,
  Badge,
  Button,
  Switch,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Flash20Regular, Fire20Regular, People20Regular, CloudSync20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface StoreStatus {
  mode: 'cosmos' | 'memory';
  container: string;
  redisSubstrate: boolean;
  cosmosConfigured: boolean;
  replicaId: string;
}
interface PoolConfig {
  enabled: boolean;
  min: number;
  max: number;
  idleTtlMs: number;
  concurrent: boolean;
  maxLeasesPerSession: number;
}
interface PoolStatus {
  enabled: boolean;
  config: PoolConfig;
  backend: { backend: string; configured: boolean; missing?: string };
  totals: { warm: number; leased: number; shared: number; warming: number };
  store: StoreStatus;
  groups: unknown[];
}

const useStyles = makeStyles({
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  stat: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  statIcon: {
    flexShrink: 0,
    width: '40px',
    height: '40px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  statBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  statLabel: {
    fontSize: tokens.fontSizeBase100,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  statValue: {
    fontSize: tokens.fontSizeBase600,
    fontWeight: tokens.fontWeightBold,
    marginTop: tokens.spacingVerticalXXS,
    lineHeight: 1.1,
  },
  controls: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  meta: { color: tokens.colorNeutralForeground3, display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  bar: { marginBottom: tokens.spacingVerticalM },
});

export function SparkPoolCard() {
  const styles = useStyles();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    clientFetch('/api/spark/session-pool', { cache: 'no-store' }, 20_000)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok && j.status) setStatus(j.status as PoolStatus);
        else if (j?.error) setErr(j.error);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const postConfig = useCallback(
    (patch: Record<string, unknown>) => {
      setBusy(true);
      setErr(null);
      setNote(null);
      clientFetch(
        '/api/spark/session-pool',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'config', ...patch }) },
        20_000,
      )
        .then(async (r) => {
          const j = await r.json();
          if (r.status === 403) {
            setErr('Tenant admin required to change the warm-pool configuration.');
            return;
          }
          if (j?.ok && j.status) setStatus(j.status as PoolStatus);
          else if (j?.error) setErr(j.error);
        })
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [],
  );

  const warmNow = useCallback(() => {
    setBusy(true);
    setErr(null);
    setNote(null);
    clientFetch(
      '/api/spark/session-pool',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'warm' }) },
      30_000,
    )
      .then(async (r) => {
        const j = await r.json();
        if (j?.ok) {
          if (j.status) setStatus(j.status as PoolStatus);
          setNote('Warm-up requested — sessions are cold-starting toward the target on the real backend.');
        } else if (j?.data?.configured === false) {
          setErr(j.error || 'Spark backend not configured.');
        } else if (j?.error) {
          setErr(j.error);
        }
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  }, []);

  const learn = (
    <LearnPopover
      title="Warm Spark session pool (PSR-3)"
      content="Keeps N idle Livy/Databricks sessions on standby so notebook attach is instant on a warm hit instead of the 2-4 min Synapse cold start (Fabric starter-pool outcome, Azure-native). Default-ON; the kill switch disables it per tenant. Cross-replica mode shares warm sessions across ACA replicas via a Cosmos lease registry. Concurrent mode lets read-only runs share one warm session (FGC-10). Cost is bounded by the idle TTL + Synapse auto-pause."
      learnMoreHref="https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools"
    />
  );

  return (
    <Section title="Warm Spark session pool" actions={<div className={styles.row}>{learn}</div>}>
      {err && (
        <MessageBar intent="error" className={styles.bar}>
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {note && (
        <MessageBar intent="success" className={styles.bar}>
          <MessageBarBody>{note}</MessageBarBody>
        </MessageBar>
      )}

      {loading || !status ? (
        <Spinner label="Loading warm-pool status…" />
      ) : (
        <>
          {status.backend && !status.backend.configured && (
            <MessageBar intent="warning" className={styles.bar}>
              <MessageBarBody>
                <MessageBarTitle>Spark backend not configured</MessageBarTitle>
                Set <code>{status.backend.missing}</code> to warm real sessions. The pool stays a pure
                accelerator — notebook runs still cold-start until it is set.
              </MessageBarBody>
            </MessageBar>
          )}

          {status.store.mode === 'memory' && (
            <MessageBar intent="info" className={styles.bar}>
              <MessageBarBody>
                <MessageBarTitle>Per-replica pool (memory mode)</MessageBarTitle>
                Warm sessions are not shared across Console replicas. For a cross-replica shared pool set{' '}
                <code>LOOM_SPARK_POOL_REDIS</code> (or <code>LOOM_SPARK_POOL_LEASE_CONTAINER</code>) — the shared
                H-band substrate from <code>compute/hband-shared.bicep</code> — and cross-replica coordination
                turns on via the Cosmos <code>spark-warm-leases</code> registry.
              </MessageBarBody>
            </MessageBar>
          )}

          <div className={styles.stats}>
            <div className={styles.stat}>
              <span className={styles.statIcon} aria-hidden><Flash20Regular /></span>
              <div className={styles.statBody}>
                <div className={styles.statLabel}>Warm</div>
                <div className={styles.statValue}>{status.totals.warm}</div>
              </div>
            </div>
            <div className={styles.stat}>
              <span className={styles.statIcon} aria-hidden><Fire20Regular /></span>
              <div className={styles.statBody}>
                <div className={styles.statLabel}>Warming</div>
                <div className={styles.statValue}>{status.totals.warming}</div>
              </div>
            </div>
            <div className={styles.stat}>
              <span className={styles.statIcon} aria-hidden><People20Regular /></span>
              <div className={styles.statBody}>
                <div className={styles.statLabel}>Leased / shared</div>
                <div className={styles.statValue}>{status.totals.leased + status.totals.shared}</div>
              </div>
            </div>
            <div className={styles.stat}>
              <span className={styles.statIcon} aria-hidden><CloudSync20Regular /></span>
              <div className={styles.statBody}>
                <div className={styles.statLabel}>Lease store</div>
                <div className={styles.statValue} style={{ fontSize: tokens.fontSizeBase400 }}>
                  {status.store.mode === 'cosmos' ? 'Shared' : 'Per-replica'}
                </div>
              </div>
            </div>
          </div>

          <div className={styles.controls}>
            <div className={styles.row}>
              <Switch
                checked={status.enabled}
                disabled={busy}
                label={status.enabled ? 'Warm pool enabled (default-ON)' : 'Warm pool disabled'}
                onChange={(_, d) => postConfig({ enabled: !!d.checked })}
              />
              <Badge appearance="tint" color={status.enabled ? 'success' : 'danger'}>
                {status.enabled ? 'ON' : 'OFF (kill switch)'}
              </Badge>
            </div>
            <div className={styles.row}>
              <Switch
                checked={status.config.concurrent}
                disabled={busy || !status.enabled}
                label="High-concurrency shared sessions (read-only runs share a session · FGC-10)"
                onChange={(_, d) => postConfig({ concurrent: !!d.checked })}
              />
              <Badge appearance="tint" color="informative">
                up to {status.config.maxLeasesPerSession}/session
              </Badge>
            </div>
            <div className={styles.row}>
              <Button appearance="primary" icon={<Flash20Regular />} onClick={warmNow} disabled={busy || !status.enabled}>
                Warm now
              </Button>
              <Button appearance="secondary" onClick={load} disabled={busy}>
                Refresh
              </Button>
            </div>
          </div>

          <Caption1 className={styles.meta}>
            <span>backend: <strong>{status.backend?.backend}</strong></span>
            <span>·</span>
            <span>min {status.config.min} / max {status.config.max}</span>
            <span>·</span>
            <span>idle TTL {Math.round(status.config.idleTtlMs / 1000)}s</span>
            {status.store.mode === 'cosmos' && (
              <>
                <span>·</span>
                <span>store: <code>{status.store.container}</code></span>
              </>
            )}
            {status.store.redisSubstrate && (
              <>
                <span>·</span>
                <Badge appearance="outline" color="brand">H-band substrate</Badge>
              </>
            )}
          </Caption1>
        </>
      )}
    </Section>
  );
}

export default SparkPoolCard;
