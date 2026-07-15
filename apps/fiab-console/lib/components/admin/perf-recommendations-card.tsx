'use client';

/**
 * PERF-4.1 — actionable recommendations card (on /admin/performance).
 *
 * Renders the recommendation cards derived from REAL measured signals (warm-
 * pool miss rate, Livy queue depth, cache hit-rate, Copilot SLO burn, benchmark
 * p95 vs bar, ARM state). Each card shows what's wrong, why, the exact change,
 * its evidence rows, and an Apply button behind an approval-style confirm
 * dialog. Apply POSTs the change; the server validates + clamps it into the
 * admin bounds and executes the REAL config write / ARM call, returning a
 * before/after receipt shown inline. Fluent v9 + Loom tokens only (web3-ui.md);
 * real backend via /api/admin/performance/recommendations (no-vaporware.md).
 */
import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Lightbulb20Regular,
  CheckmarkCircle20Regular,
  ArrowSync20Regular,
  Wrench20Regular,
} from '@fluentui/react-icons';
import { Section } from '@/lib/components/ui/section';
import { LearnPopover } from '@/lib/components/ui/learn-popover';
import { EmptyState } from '@/lib/components/empty-state';

interface Evidence {
  signal: string;
  value: string;
  threshold: string;
}
interface Recommendation {
  id: string;
  cls: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  whatsWrong: string;
  why: string;
  change: string;
  apply: { kind: string } & Record<string, unknown>;
  evidence: Evidence[];
}
interface ApplyReceipt {
  ok: boolean;
  summary: string;
  backend: string;
  appliedAt: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: string;
}

const SEVERITY_COLOR: Record<Recommendation['severity'], 'danger' | 'warning' | 'informative'> = {
  high: 'danger',
  medium: 'warning',
  low: 'informative',
};

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    ':hover': { boxShadow: tokens.shadow8 },
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  headIcon: {
    flexShrink: 0,
    width: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  title: { fontWeight: tokens.fontWeightSemibold, flexGrow: 1, minWidth: 0 },
  body: { color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  change: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
  evidence: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    borderLeft: `2px solid ${tokens.colorBrandStroke1}`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  evRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  receipt: { marginTop: tokens.spacingVerticalXS },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
});

export function PerfRecommendationsCard() {
  const styles = useStyles();
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [autoIds, setAutoIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Recommendation | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, ApplyReceipt>>({});

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    clientFetch('/api/admin/performance/recommendations', { cache: 'no-store' }, 45_000)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok) {
          setRecs((j.recommendations ?? []) as Recommendation[]);
          setAutoIds((j.autoApplicable ?? []) as string[]);
        } else setErr(j?.error || 'Failed to derive recommendations');
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const apply = useCallback(
    (rec: Recommendation) => {
      setConfirming(null);
      setApplyingId(rec.id);
      clientFetch(
        '/api/admin/performance/recommendations/apply',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: rec.id, change: rec.apply }),
        },
        60_000,
      )
        .then(async (r) => {
          const j = await r.json();
          if (r.status === 403) {
            setErr('Tenant admin required to apply performance changes.');
            return;
          }
          const receipt = (j?.receipt ?? { ok: false, error: j?.error || 'apply failed' }) as ApplyReceipt;
          setReceipts((prev) => ({ ...prev, [rec.id]: receipt }));
          if (receipt.ok) load(); // re-derive with the new config in effect
        })
        .catch((e) => setReceipts((prev) => ({ ...prev, [rec.id]: { ok: false, summary: 'Apply failed', backend: '', appliedAt: '', error: String(e) } })))
        .finally(() => setApplyingId(null));
    },
    [load],
  );

  const learn = (
    <LearnPopover
      title="Actionable recommendations (PERF-4.1)"
      content="Each card is derived from a real measured signal — warm-pool miss rate, live Livy queue depth, result-cache hit-rate, Copilot SLO burn, or a benchmark p95 breaching its Fabric bar — with the evidence shown on the card. Apply executes the exact change for real (cross-replica config write or ARM PATCH), clamped into the admin bounds from the Auto-adjust section, and returns a before/after receipt."
      learnMoreHref="https://learn.microsoft.com/azure/well-architected/performance-efficiency/"
    />
  );

  return (
    <Section
      title="Recommendations"
      actions={
        <div className={styles.actions}>
          <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={load} disabled={loading}>
            Re-derive
          </Button>
          {learn}
        </div>
      }
    >
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="Measuring live signals…" />
      ) : !recs || recs.length === 0 ? (
        <EmptyState
          icon={<CheckmarkCircle20Regular />}
          title="No recommendations — everything is inside its bars"
          body="Every measured signal (pool miss rate, cache hit-rate, queue depth, SLO burn, benchmark p95) is currently within target. Cards appear here the moment a real signal breaches its threshold."
        />
      ) : (
        <div className={styles.list}>
          {recs.map((rec) => {
            const receipt = receipts[rec.id];
            const actionable = rec.apply?.kind && rec.apply.kind !== 'none';
            return (
              <div key={rec.id} className={styles.card}>
                <div className={styles.head}>
                  <span className={styles.headIcon} aria-hidden>
                    <Lightbulb20Regular />
                  </span>
                  <Text className={styles.title}>{rec.title}</Text>
                  <Badge appearance="tint" color={SEVERITY_COLOR[rec.severity]}>
                    {rec.severity}
                  </Badge>
                  <Badge appearance="outline" color="brand">
                    {rec.cls}
                  </Badge>
                  {autoIds.includes(rec.id) && (
                    <Badge appearance="tint" color="success">
                      auto-adjust will apply
                    </Badge>
                  )}
                </div>
                <Body1 className={styles.body}>
                  <strong>What&apos;s wrong:</strong> {rec.whatsWrong}
                </Body1>
                <Body1 className={styles.body}>
                  <strong>Why:</strong> {rec.why}
                </Body1>
                <div className={styles.change}>{rec.change}</div>
                <div className={styles.evidence}>
                  {rec.evidence.map((ev, i) => (
                    <Caption1 key={i} className={styles.evRow}>
                      <span>
                        <strong>{ev.signal}</strong>
                      </span>
                      <span>measured {ev.value}</span>
                      <span>· threshold {ev.threshold}</span>
                    </Caption1>
                  ))}
                </div>
                <div className={styles.actions}>
                  {actionable ? (
                    <Button
                      appearance="primary"
                      icon={<Wrench20Regular />}
                      onClick={() => setConfirming(rec)}
                      disabled={applyingId === rec.id}
                    >
                      {applyingId === rec.id ? 'Applying…' : 'Apply'}
                    </Button>
                  ) : (
                    <Badge appearance="outline">informational — no automatic change</Badge>
                  )}
                </div>
                {receipt && (
                  <MessageBar intent={receipt.ok ? 'success' : 'error'} className={styles.receipt} layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>{receipt.ok ? 'Applied' : 'Apply failed'}</MessageBarTitle>
                      {receipt.summary}
                      {receipt.ok && (
                        <>
                          {' '}
                          <span className={styles.mono}>
                            via {receipt.backend} at {receipt.appliedAt}
                            {receipt.before ? ` · before ${JSON.stringify(receipt.before)}` : ''}
                            {receipt.after ? ` · after ${JSON.stringify(receipt.after)}` : ''}
                          </span>
                        </>
                      )}
                      {!receipt.ok && receipt.error ? ` — ${receipt.error}` : null}
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!confirming} onOpenChange={(_, d) => !d.open && setConfirming(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Apply this change?</DialogTitle>
            <DialogContent>
              {confirming && (
                <>
                  <Body1>{confirming.change}</Body1>
                  <Caption1>
                    The change is validated and clamped into the admin bounds server-side, executed against the
                    real backend, audited, and returns a before/after receipt.
                  </Caption1>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={() => confirming && apply(confirming)}>
                Apply for real
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Section>
  );
}

export default PerfRecommendationsCard;
