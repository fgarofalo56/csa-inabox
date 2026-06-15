'use client';

/**
 * ServiceScanPanel — Setup-Wizard "scan-and-choose" surface for the networking
 * / API domain (APIM, Azure Maps, Key Vault, hub Azure Firewall).
 *
 * Calls GET /api/setup/discover-services (read-only ARM scan across every
 * visible subscription) and renders, per service: the recommendation (new /
 * existing / disable), why, and any existing instances the operator could
 * reuse. This is the in-console mirror of scripts/csa-loom/scan-and-deploy.sh
 * so the wizard offers the identical existing/new/disable + recommendation
 * choice the CLI does (ui-parity.md). Default posture = everything ON (opt-out).
 *
 * Read-only + honest: when discovery can't run (no ARM Reader, Gov endpoint),
 * a Fluent MessageBar explains exactly what's missing — no fake data
 * (no-vaporware.md).
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
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import { ArrowClockwise20Regular } from '@fluentui/react-icons';

interface ExistingResource {
  name: string;
  resourceGroup: string;
  subscriptionId: string;
  location?: string;
}
interface ServiceChoice {
  key: 'apim' | 'maps' | 'keyvault' | 'firewall';
  label: string;
  armType: string | null;
  enabledFlag: string | null;
  allowExisting: boolean;
  allowDisable: boolean;
  existing: ExistingResource[];
  recommendation: 'existing' | 'new' | 'disable';
  recommendationReason: string;
}
interface ScanResponse {
  ok: boolean;
  boundary?: string;
  subscriptionsScanned?: number;
  services?: ServiceChoice[];
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
  cardTop: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  existing: {
    marginTop: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
});

function recBadge(rec: ServiceChoice['recommendation']): { color: 'success' | 'brand' | 'warning'; text: string } {
  switch (rec) {
    case 'new': return { color: 'brand', text: 'Recommend: provision new' };
    case 'existing': return { color: 'success', text: 'Recommend: reuse existing' };
    case 'disable': return { color: 'warning', text: 'Recommend: leave disabled' };
  }
}

export function ServiceScanPanel({ boundary }: { boundary: string }) {
  const styles = useStyles();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScanResponse | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/setup/discover-services?boundary=${encodeURIComponent(boundary)}`);
      const j = (await res.json()) as ScanResponse;
      setData(j);
    } catch (e) {
      setData({ ok: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [boundary]);

  useEffect(() => {
    void scan();
  }, [scan]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Scan existing services (APIM · Azure Maps · Key Vault · Firewall)</Body1Strong>
        <Button
          size="small"
          appearance="subtle"
          icon={<ArrowClockwise20Regular />}
          disabled={loading}
          onClick={() => void scan()}
        >
          Re-scan
        </Button>
      </div>

      {loading && <Spinner size="tiny" label="Scanning every visible subscription…" labelPosition="after" />}

      {!loading && data && !data.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Discovery unavailable</MessageBarTitle>
            {data.error}
            {data.hint ? ` — ${data.hint}` : ''} The deploy still proceeds with the default posture
            (everything ON / new).
          </MessageBarBody>
        </MessageBar>
      )}

      {!loading && data?.ok && (
        <>
          <Caption1>
            Scanned {data.subscriptionsScanned ?? 0} subscription(s). Default posture is everything ON (opt-out) —
            reuse an existing instance below to skip provisioning, or disable what you don&apos;t want.
          </Caption1>
          {(data.services ?? []).map((svc) => {
            const badge = recBadge(svc.recommendation);
            return (
              <div key={svc.key} className={styles.card}>
                <div className={styles.cardTop}>
                  <Body1Strong>{svc.label}</Body1Strong>
                  <Badge appearance="tint" color={badge.color}>
                    {badge.text}
                  </Badge>
                  {!svc.allowDisable && (
                    <Badge appearance="outline" color="informative">
                      foundational
                    </Badge>
                  )}
                </div>
                <Caption1>{svc.recommendationReason}</Caption1>
                {svc.armType && (
                  <>
                    {svc.existing.length === 0 ? (
                      <Caption1>No existing {svc.label} found in any visible subscription.</Caption1>
                    ) : (
                      <div className={styles.existing}>
                        <Caption1>
                          {svc.existing.length} existing{' '}
                          {svc.allowExisting ? '(reusable)' : '(shown for context — reuse not offered)'}:
                        </Caption1>
                        {svc.existing.slice(0, 8).map((r, i) => (
                          <Body1 key={`${svc.key}-${i}`}>
                            • {r.name}{' '}
                            <Caption1>
                              (rg={r.resourceGroup || '?'}
                              {r.location ? `, ${r.location}` : ''})
                            </Caption1>
                          </Body1>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
