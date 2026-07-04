'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * QuotaPreflightPanel — Setup-Wizard review-step Azure vCPU quota pre-flight.
 *
 * POSTs the selected topology's deploy targets to /api/setup/quota-preflight
 * (read-only Compute usages) and renders, per subscription + region, whether the
 * Total Regional vCPUs aggregate and each VM-family tier the topology consumes
 * have headroom. Insufficient tiers surface a Fluent MessageBar naming the SKU +
 * region + current/limit + a "request quota increase" portal link.
 *
 * This is a GATE, not a blocker (per the Setup Wizard contract): the operator
 * can still proceed — quota may be requested out of band — but is warned loudly.
 * Read-only + honest: a failed check shows exactly what went wrong and lets the
 * deploy proceed with the default posture (no-vaporware.md).
 */
import { useEffect, useState, useCallback } from 'react';
import {
  makeStyles,
  tokens,
  Body1,
  Body1Strong,
  Caption1,
  Badge,
  Button,
  Spinner,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  CheckmarkCircle16Filled,
  Warning16Filled,
  QuestionCircle16Regular,
} from '@fluentui/react-icons';
import { quotaPortalLink, type QuotaEvaluation, type QuotaFamilyResult } from '@/lib/setup/quota-preflight';

/** One deploy target the panel checks (built from the wizard state by the caller). */
export interface QuotaTarget {
  subscriptionId: string;
  subscriptionName?: string;
  location: string;
  role?: 'full' | 'spoke';
}

interface PreflightResponse {
  ok: boolean;
  evaluations?: (QuotaEvaluation & { error?: string })[];
  error?: string;
  hint?: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalM },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  tierRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
  },
  tierIconOk: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0, marginTop: tokens.spacingVerticalXXS },
  tierIconWarn: { color: tokens.colorStatusWarningForeground1, flexShrink: 0, marginTop: tokens.spacingVerticalXXS },
  tierIconUnknown: { color: tokens.colorNeutralForeground3, flexShrink: 0, marginTop: tokens.spacingVerticalXXS },
  tierBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  advisoryBadge: { marginLeft: tokens.spacingHorizontalXS },
  meter: { color: tokens.colorNeutralForeground3 },
});

/** Icon + color for a single tier's sufficiency. */
function TierIcon({ result }: { result: QuotaFamilyResult }) {
  const styles = useStyles();
  if (result.sufficient === true) return <CheckmarkCircle16Filled className={styles.tierIconOk} aria-hidden />;
  if (result.sufficient === false) return <Warning16Filled className={styles.tierIconWarn} aria-hidden />;
  return <QuestionCircle16Regular className={styles.tierIconUnknown} aria-hidden />;
}

/** "12 / 350 used, need 36 more" style meter for a tier. */
function meterText(r: QuotaFamilyResult): string {
  if (r.current === undefined || r.limit === undefined) {
    return `need ${r.required} vCPU — current usage unavailable (tier not reported for this region)`;
  }
  const remaining = r.limit - r.current;
  return `${r.current} / ${r.limit} vCPU used · ${remaining} available · this deploy needs ${r.required}`;
}

function TierLine({ r }: { r: QuotaFamilyResult }) {
  const styles = useStyles();
  return (
    <div className={styles.tierRow}>
      <TierIcon result={r} />
      <div className={styles.tierBody}>
        <Body1>
          <Body1Strong>{r.familyLabel}</Body1Strong>
          {r.vmSize ? <Caption1> · {r.vmSize}</Caption1> : null}
          {r.scaleToZero ? (
            <Badge appearance="outline" color="informative" size="small" className={styles.advisoryBadge}>
              scale-to-0 (advisory)
            </Badge>
          ) : null}
        </Body1>
        {r.reason ? <Caption1>{r.reason}</Caption1> : null}
        <Caption1 className={styles.meter}>{meterText(r)}</Caption1>
      </div>
    </div>
  );
}

export function QuotaPreflightPanel({
  targets,
  boundary,
  isGov,
}: {
  targets: QuotaTarget[];
  boundary: string;
  isGov: boolean;
}) {
  const styles = useStyles();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<PreflightResponse | null>(null);

  // Serialize the targets so the effect only re-runs when they actually change.
  const targetsKey = targets.map((t) => `${t.subscriptionId}/${t.location}/${t.role ?? 'full'}`).join('|');

  const check = useCallback(async () => {
    if (targets.length === 0) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const res = await clientFetch('/api/setup/quota-preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ boundary, targets }),
      });
      const ct = res.headers.get('content-type') || '';
      const j: PreflightResponse = ct.includes('application/json')
        ? await res.json()
        : { ok: false, error: `Quota pre-flight returned non-JSON (HTTP ${res.status}).` };
      setData(j);
    } catch (e) {
      setData({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey, boundary]);

  useEffect(() => {
    void check();
  }, [check]);

  const portal = quotaPortalLink(isGov);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Azure capacity pre-flight (vCPU quota)</Body1Strong>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwise20Regular />}
          disabled={loading}
          onClick={() => void check()}
        >
          Recheck
        </Button>
      </div>

      {targets.length === 0 && (
        <Caption1>Wiring an existing Data Landing Zone provisions no new compute — no quota check needed.</Caption1>
      )}

      {loading && (
        <Spinner size="tiny" label="Checking Compute usages for each target subscription + region…" labelPosition="after" />
      )}

      {!loading && data && !data.ok && data.error && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Quota pre-flight unavailable</MessageBarTitle>
            {data.error}
            {data.hint ? ` — ${data.hint}` : ''} The deploy still proceeds; verify vCPU quota manually via the{' '}
            <Link href={portal} target="_blank">Azure quota portal</Link>.
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading &&
        data?.evaluations?.map((ev) => {
          const tiers = [ev.regional, ...ev.families];
          const anyWarn = tiers.some((t) => t.sufficient === false);
          return (
            <div key={`${ev.subscriptionId}/${ev.location}`} className={styles.card}>
              <div className={styles.cardTop}>
                <Body1Strong>{ev.subscriptionName || ev.subscriptionId}</Body1Strong>
                <Caption1>· {ev.location}</Caption1>
                {ev.error ? (
                  <Badge appearance="tint" color="warning">Could not read usages</Badge>
                ) : anyWarn ? (
                  <Badge appearance="tint" color="warning">Quota may block this deploy</Badge>
                ) : (
                  <Badge appearance="tint" color="success">Sufficient quota</Badge>
                )}
              </div>

              {ev.error ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    {ev.error} — grant the Console identity Reader on this subscription to enable the check, or verify
                    quota manually.
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <>
                  {tiers.map((t) => (
                    <TierLine key={t.family} r={t} />
                  ))}
                  {anyWarn && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Request a quota increase</MessageBarTitle>
                        One or more tiers above lack headroom in <b>{ev.location}</b>. You can still deploy now and
                        request the increase in parallel, or raise it first at the{' '}
                        <Link href={portal} target="_blank">Azure quota portal</Link> (select subscription{' '}
                        <code>{ev.subscriptionId}</code>, region <code>{ev.location}</code>).
                      </MessageBarBody>
                    </MessageBar>
                  )}
                </>
              )}
            </div>
          );
        })}
    </div>
  );
}
