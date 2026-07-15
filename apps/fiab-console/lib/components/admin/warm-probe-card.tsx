'use client';

/**
 * PERF-4.3 — "Prove warm session" probe card (on /admin/performance).
 *
 * One button that acquires a REAL session through the warm pool (same default
 * pool/kind/sizing as a notebook run), reports the wall-clock acquisition time
 * as a timestamped receipt card (warm hit = seconds vs the 2-4 min Synapse cold
 * start), and returns the lease so the session goes straight back to warm.
 * On a miss it shows the honest pool state instead of a fabricated timing.
 * Fluent v9 + Loom tokens (web3-ui.md); real backend via
 * /api/admin/performance/prove-warm (no-vaporware.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Flash20Regular, Timer20Regular, Beaker20Regular } from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';

interface ProbeResult {
  hit: boolean;
  acquireMs: number;
  acquiredAt: string;
  releasedAt?: string;
  backend: string;
  poolName: string;
  sessionId?: number | null;
  sessionState?: string | null;
  leaseId?: string;
  via?: string;
  sizingKey?: string;
  coldStartComparisonMs?: number;
  totals?: { warm: number; warming: number; leased: number; shared: number };
  lastFailure?: string | null;
  message: string;
}

const useStyles = makeStyles({
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalM },
  receipt: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
  },
  headline: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  bigNumber: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightBold, lineHeight: 1 },
  meta: { color: tokens.colorNeutralForeground3, display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
  bar: { marginBottom: tokens.spacingVerticalM },
});

export function WarmProbeCard() {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<string | null>(null);

  const run = useCallback(() => {
    setBusy(true);
    setErr(null);
    setGate(null);
    clientFetch('/api/admin/performance/prove-warm', { method: 'POST' }, 60_000)
      .then(async (r) => {
        const j = await r.json();
        if (r.status === 403) {
          setErr('Tenant admin required to run the warm-session probe.');
          return;
        }
        if (j?.ok && j.probe) setProbe(j.probe as ProbeResult);
        else if (j?.data?.configured === false || j?.configured === false) setGate(j.error || 'Spark backend not configured.');
        else setErr(j?.error || 'Probe failed');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  }, []);

  const learn = (
    <LearnPopover
      title="Warm-session proof (PERF-4.3)"
      content="The probe leases a real Livy session from the warm pool with the exact default pool/kind/sizing a notebook run uses, measures wall-clock acquisition, live-verifies the session state, and returns the lease (the session flips back to warm — non-destructive). A warm hit is seconds; a Synapse cold start is ~2-4 minutes. A miss shows the honest pool state and kicks a background warm-up."
      learnMoreHref="https://learn.microsoft.com/fabric/data-engineering/configure-starter-pools"
    />
  );

  return (
    <Section
      title="Prove warm session"
      actions={
        <div className={styles.row}>
          <Button appearance="primary" icon={<Beaker20Regular />} onClick={run} disabled={busy}>
            {busy ? 'Acquiring…' : 'Prove warm session'}
          </Button>
          {learn}
        </div>
      }
    >
      {err && (
        <MessageBar intent="error" className={styles.bar}>
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {gate && (
        <MessageBar intent="warning" className={styles.bar} layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Spark backend not configured</MessageBarTitle>
            {gate}
          </MessageBarBody>
        </MessageBar>
      )}

      {!probe && !err && !gate && (
        <Caption1 className={styles.meta}>
          Acquires a session via the warm pool and reports the real acquisition time as a receipt — the
          operator-facing proof that warm attach is seconds, not the 2-4 minute cold start.
        </Caption1>
      )}

      {probe && (
        <div className={styles.receipt}>
          <div className={styles.headline}>
            <span aria-hidden>{probe.hit ? <Flash20Regular /> : <Timer20Regular />}</span>
            <span className={styles.bigNumber}>{(probe.acquireMs / 1000).toFixed(1)}s</span>
            <Badge appearance="tint" color={probe.hit ? 'success' : 'warning'}>
              {probe.hit ? 'WARM HIT' : 'MISS — would cold-start'}
            </Badge>
            {probe.hit && typeof probe.coldStartComparisonMs === 'number' && (
              <Badge appearance="outline" color="brand">
                vs ~{Math.round(probe.coldStartComparisonMs / 60000)} min cold start
              </Badge>
            )}
          </div>
          <Body1>{probe.message}</Body1>
          <Caption1 className={styles.meta}>
            <span>acquired <span className={styles.mono}>{probe.acquiredAt}</span></span>
            {probe.releasedAt && (
              <>
                <span>·</span>
                <span>released <span className={styles.mono}>{probe.releasedAt}</span></span>
              </>
            )}
            <span>·</span>
            <span>backend <strong>{probe.backend}</strong></span>
            <span>·</span>
            <span>pool <span className={styles.mono}>{probe.poolName}</span></span>
            {typeof probe.sessionId === 'number' && (
              <>
                <span>·</span>
                <span>Livy session <span className={styles.mono}>#{probe.sessionId}</span></span>
              </>
            )}
            {probe.sessionState && (
              <>
                <span>·</span>
                <span>live state <span className={styles.mono}>{probe.sessionState}</span></span>
              </>
            )}
            {probe.via && (
              <>
                <span>·</span>
                <span>served via <Badge appearance="outline">{probe.via === 'cosmos' ? 'cross-replica store' : 'this replica'}</Badge></span>
              </>
            )}
          </Caption1>
          {!probe.hit && probe.totals && (
            <Caption1 className={styles.meta}>
              <Text>
                pool now: {probe.totals.warm} warm · {probe.totals.warming} warming · {probe.totals.leased + (probe.totals.shared ?? 0)} leased
              </Text>
              {probe.lastFailure && <span>· last warm failure: {probe.lastFailure}</span>}
            </Caption1>
          )}
        </div>
      )}
    </Section>
  );
}

export default WarmProbeCard;
