'use client';

/**
 * Secret & credential health (S1) — a section of the Health & Reliability hub
 * (/admin/health). Renders the LIVE credential-expiry inventory from
 * GET /api/admin/secret-health: the Console MSAL app registration's client
 * secrets (Graph) + tracked Key Vault secrets, each with days-to-expiry and a
 * 60/30/7-day band. Red row <7d / expired / drift; amber <30 and <60; the
 * scheduled alert sibling is azure-functions/secret-expiry-monitor.
 *
 * Real data only (no-vaporware.md); honest MessageBar gates name the exact
 * env var / Graph app-role when a source cannot be read. Dark + light safe —
 * every color comes from Fluent tokens.
 */

import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Body1, Button, Caption1, Link, MessageBar, MessageBarBody, MessageBarTitle,
  Spinner, Subtitle2, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync24Regular, CheckmarkCircle24Filled, ErrorCircle24Filled,
  KeyMultiple24Regular, Warning24Filled, Open16Regular,
} from '@fluentui/react-icons';

type SecretBand = 'expired' | 'critical' | 'warn30' | 'warn60' | 'ok' | 'no-expiry';

interface SecretHealthItem {
  id: string;
  source: 'entra-app' | 'key-vault';
  label: string;
  expiresAt: string | null;
  daysToExpiry: number | null;
  band: SecretBand;
  detail?: string;
  drift?: boolean;
}

interface SecretHealthReport {
  generatedAt: string;
  warnDays: number;
  items: SecretHealthItem[];
  gates: { graph?: string; keyVault?: string };
}

const RUNBOOK_URL = 'https://fgarofalo56.github.io/csa-inabox/fiab/runbooks/secret-rotation/';

const card: React.CSSProperties = {
  padding: tokens.spacingVerticalXL,
  border: `1px solid ${tokens.colorNeutralStroke2}`,
  borderRadius: tokens.borderRadiusXLarge,
  backgroundColor: tokens.colorNeutralBackground1,
  marginBottom: tokens.spacingVerticalXL,
  boxShadow: tokens.shadow4,
};

/** Red = act now; amber = plan the rotation; green = healthy; neutral = no clock. */
function bandVisual(item: SecretHealthItem): { icon: React.ReactNode; badge: React.ReactNode } {
  const b = item.band;
  if (b === 'expired' || b === 'critical') {
    return {
      icon: <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />,
      badge: (
        <Badge appearance="filled" color="danger">
          {item.drift ? 'drift' : b === 'expired' ? 'expired' : `${item.daysToExpiry}d left`}
        </Badge>
      ),
    };
  }
  if (b === 'warn30' || b === 'warn60') {
    return {
      icon: <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />,
      badge: <Badge appearance="filled" color="warning">{`${item.daysToExpiry}d left`}</Badge>,
    };
  }
  if (b === 'ok') {
    return {
      icon: <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />,
      badge: <Badge appearance="tint" color="success">{`${item.daysToExpiry}d left`}</Badge>,
    };
  }
  return {
    icon: <KeyMultiple24Regular style={{ color: tokens.colorNeutralForeground3 }} />,
    badge: <Badge appearance="tint" color="informative">no expiry</Badge>,
  };
}

export function SecretHealthPane() {
  const [report, setReport] = useState<SecretHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await clientFetch('/api/admin/secret-health', { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'secret-health read failed'); return; }
      setReport(j.data);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const worstIsBad = report?.items.some((i) => i.band === 'expired' || i.band === 'critical');

  return (
    <section style={card} aria-label="Secret and credential health">
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: tokens.spacingHorizontalMNudge, marginBottom: tokens.spacingVerticalL, minWidth: 0 }}>
        <KeyMultiple24Regular style={{ color: tokens.colorBrandForeground1 }} />
        <Subtitle2>Secret &amp; credential health</Subtitle2>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, minWidth: 0 }}>
          MSAL app secrets + tracked Key Vault credentials — alerts fire at {report?.warnDays ?? 60}/30/7 days via the shared action group.
        </Caption1>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' }}>
          <Link href={RUNBOOK_URL} target="_blank" rel="noreferrer">
            Runbook <Open16Regular style={{ verticalAlign: 'text-bottom' }} />
          </Link>
          <Button size="small" icon={<ArrowSync24Regular />} onClick={load} disabled={loading}>Refresh</Button>
        </div>
      </div>

      {loading && !report && (
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
          <Spinner size="tiny" /> <Body1>Reading live credential expiry (Graph + Key Vault)…</Body1>
        </div>
      )}

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Secret-health read failed</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {report?.gates.graph && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalS }}>
          <MessageBarBody>
            <MessageBarTitle>App-registration inventory unavailable</MessageBarTitle>
            {report.gates.graph}
          </MessageBarBody>
        </MessageBar>
      )}
      {report?.gates.keyVault && (
        <MessageBar intent="warning" layout="multiline" style={{ marginBottom: tokens.spacingVerticalS }}>
          <MessageBarBody>
            <MessageBarTitle>Key Vault inventory unavailable</MessageBarTitle>
            {report.gates.keyVault}
          </MessageBarBody>
        </MessageBar>
      )}

      {worstIsBad && (
        <MessageBar intent="error" layout="multiline" style={{ marginBottom: tokens.spacingVerticalS }}>
          <MessageBarBody>
            <MessageBarTitle>A standing credential needs rotation NOW</MessageBarTitle>
            An expired / near-expiry / drifted credential breaks ALL sign-in when it dies
            (the 2026-07-19 outage). Follow the <Link href={RUNBOOK_URL} target="_blank" rel="noreferrer">secret-rotation runbook</Link>.
          </MessageBarBody>
        </MessageBar>
      )}

      {report && (
        <div role="list" aria-label="Tracked credentials">
          {report.items.map((item) => {
            const { icon, badge } = bandVisual(item);
            return (
              <div
                key={item.id}
                role="listitem"
                style={{
                  display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
                  padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
                  borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
                  minWidth: 0, flexWrap: 'wrap',
                }}
              >
                {icon}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Body1 style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.label}
                  </Body1>
                  <Caption1 style={{ color: item.drift ? tokens.colorPaletteRedForeground1 : tokens.colorNeutralForeground3 }}>
                    {item.expiresAt ? `Expires ${item.expiresAt.slice(0, 10)}` : null}
                    {item.expiresAt && item.detail ? ' — ' : null}
                    {item.detail || (item.expiresAt ? null : 'No expiry metadata')}
                  </Caption1>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', minWidth: 0 }}>
                  <Badge appearance="outline" color={item.source === 'entra-app' ? 'brand' : 'informative'}>
                    {item.source === 'entra-app' ? 'Entra app' : 'Key Vault'}
                  </Badge>
                  {badge}
                </div>
              </div>
            );
          })}
          <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalS }}>
            Generated {report.generatedAt.slice(0, 19).replace('T', ' ')} UTC — live Graph + Key Vault reads
            (no secret values are ever read). Scheduled alerting: the secret-expiry-monitor timer Function.
          </Caption1>
        </div>
      )}
    </section>
  );
}
