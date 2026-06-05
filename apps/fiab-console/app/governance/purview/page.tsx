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
 */

import { GovernanceShell } from '@/lib/components/governance-shell';
import { PurviewGate, usePurviewStatus } from '@/lib/components/purview-gate';
import {
  Body1, Caption1, Subtitle2, Title3, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Open24Regular, ShieldCheckmark24Regular } from '@fluentui/react-icons';
import Link from 'next/link';

const useStyles = makeStyles({
  card: {
    padding: 20, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginTop: 8 },
  link: {
    padding: '8px 12px', borderRadius: 6, border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorBrandForeground1, textDecoration: 'none', fontSize: 13,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
});

const NATIVE_SURFACES = [
  { href: '/governance/catalog', label: 'Data catalog' },
  { href: '/catalog/domains', label: 'Governance domains' },
  { href: '/governance/scans', label: 'Scans & sources' },
  { href: '/governance/lineage', label: 'Lineage' },
  { href: '/governance/classifications', label: 'Classifications' },
  { href: '/governance/sensitivity', label: 'Sensitivity labels' },
  { href: '/governance/policies', label: 'Access policies' },
  { href: '/governance/insights', label: 'Insights & reports' },
];

export default function PurviewPage() {
  const s = useStyles();
  const { status: purview, reload: reloadStatus } = usePurviewStatus();
  const live = purview.configured && purview.reason === 'live';
  const portal = purview.purviewPortal || 'https://purview.microsoft.com/';

  return (
    <GovernanceShell sectionTitle="Microsoft Purview" sectionBadge="Connection">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Loom&apos;s governance surfaces run natively against your Microsoft Purview account&apos;s data plane —
        Unified Catalog, Data Map, glossary, lineage, classifications, and policies. For the workflows Loom
        doesn&apos;t reproduce natively (bulk import, advanced Atlas editing), launch the Purview portal.
      </Body1>

      <PurviewGate status={purview} surface="Microsoft Purview" reload={reloadStatus} />

      {live && (
        <div className={s.card}>
          <div className={s.row}>
            <ShieldCheckmark24Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />
            <Subtitle2>Connected</Subtitle2>
            <Badge appearance="tint" color="success" size="small">live</Badge>
          </div>
          <Caption1>
            Account <code>{purview.account}</code> · Data Map data plane{' '}
            <code>{purview.account}.purview.azure.com</code>
          </Caption1>
          <div>
            <Title3 as="h3" style={{ fontSize: 14, marginBottom: 4 }}>Native surfaces running on this account</Title3>
            <div className={s.grid}>
              {NATIVE_SURFACES.map((x) => (
                <Link key={x.href} href={x.href} className={s.link}>{x.label}</Link>
              ))}
            </div>
          </div>
          <div className={s.row}>
            <Button appearance="primary" as="a" href={portal} target="_blank" rel="noreferrer" icon={<Open24Regular />}>
              Open Microsoft Purview portal
            </Button>
          </div>
        </div>
      )}
    </GovernanceShell>
  );
}
