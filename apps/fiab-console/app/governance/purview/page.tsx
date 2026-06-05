'use client';

/**
 * /governance/purview — Microsoft Purview connection status + portal launch.
 *
 * Driven by the real /api/governance/purview/status probe (no fake iframe
 * placeholder). When Purview is wired in this deployment we confirm the
 * connection and surface every native Loom governance surface that now runs
 * against it, plus a deep-link to the full Purview portal (which sets
 * X-Frame-Options: deny, so a launch button is the honest, working embed).
 * When it isn't wired (or is cross-cloud), the honest gate explains the
 * one-time fix.
 *
 * Web-3.0 pass (task-010): Fluent v9 + Loom tokens throughout (no raw px),
 * per-surface icon cards in a responsive grid, modern connected-status hero.
 */

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import {
  Body1, Caption1, Subtitle2, Title3, Badge, Button, Card,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Open20Regular, ShieldCheckmark24Regular,
  BookDatabase24Regular, Building24Regular, DocumentSearch24Regular,
  BranchFork24Regular, Tag24Regular, ShieldLock24Regular, Key24Regular,
  ChartMultiple24Regular,
} from '@fluentui/react-icons';
import Link from 'next/link';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  intro: { color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalL, maxWidth: '820px' },
  hero: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, marginBottom: tokens.spacingVerticalL,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2} 0%, ${tokens.colorNeutralBackground1} 70%)`,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
  },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  conn: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  connIcon: { color: tokens.colorPaletteGreenForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2 },
  sectionHead: { marginTop: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalS },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  surface: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalM, textDecoration: 'none',
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
  surfaceCard: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  surfaceIcon: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '40px', height: '40px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1,
  },
  surfaceText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  actions: { marginTop: tokens.spacingVerticalM },
});

interface Surface { href: string; label: string; desc: string; icon: ReactNode }

const NATIVE_SURFACES: Surface[] = [
  { href: '/governance/catalog', label: 'Data catalog', desc: 'Browse & search governed assets', icon: <BookDatabase24Regular /> },
  { href: '/catalog/domains', label: 'Governance domains', desc: 'Business domains & data products', icon: <Building24Regular /> },
  { href: '/governance/scans', label: 'Scans & sources', desc: 'Registered sources & scan runs', icon: <DocumentSearch24Regular /> },
  { href: '/governance/lineage', label: 'Lineage', desc: 'Asset-to-asset data lineage', icon: <BranchFork24Regular /> },
  { href: '/governance/classifications', label: 'Classifications', desc: 'Classification taxonomy & coverage', icon: <Tag24Regular /> },
  { href: '/governance/sensitivity', label: 'Sensitivity labels', desc: 'MIP labels & protection', icon: <ShieldLock24Regular /> },
  { href: '/governance/policies', label: 'Access policies', desc: 'Data-access policy management', icon: <Key24Regular /> },
  { href: '/governance/insights', label: 'Insights & reports', desc: 'Governance health & coverage', icon: <ChartMultiple24Regular /> },
];

export default function PurviewPage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';
  const portal = purview.purviewPortal || 'https://purview.microsoft.com/';

  return (
    <GovernanceShell sectionTitle="Microsoft Purview" sectionBadge="Connection">
      <Body1 className={s.intro}>
        Loom&apos;s governance surfaces run natively against your Microsoft Purview account&apos;s data plane —
        Unified Catalog, Data Map, glossary, lineage, classifications, and policies. For the workflows Loom
        doesn&apos;t reproduce natively (bulk import, advanced Atlas editing), launch the Purview portal.
      </Body1>

      <PurviewGate status={purview} surface="Microsoft Purview" reload={reloadStatus} />

      {live && (
        <>
          <Card className={s.hero}>
            <div className={s.conn}>
              <ShieldCheckmark24Regular className={s.connIcon} />
              <Subtitle2>Connected</Subtitle2>
              <Badge appearance="tint" color="success" size="small">live</Badge>
            </div>
            <Caption1>
              Account <span className={s.mono}>{purview.account}</span> · Data Map data plane{' '}
              <span className={s.mono}>{purview.account}.purview.azure.com</span>
            </Caption1>
            <div className={s.actions}>
              <Button appearance="primary" as="a" href={portal} target="_blank" rel="noreferrer" icon={<Open20Regular />}>
                Open Microsoft Purview portal
              </Button>
            </div>
          </Card>

          <Title3 as="h3" className={s.sectionHead}>Native surfaces running on this account</Title3>
          <div className={s.grid}>
            {NATIVE_SURFACES.map((x) => (
              <Link key={x.href} href={x.href} className={mergeClasses(s.surface, s.surfaceCard)}>
                <span className={s.surfaceIcon}>{x.icon}</span>
                <span className={s.surfaceText}>
                  <Body1>{x.label}</Body1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{x.desc}</Caption1>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </GovernanceShell>
  );
}
