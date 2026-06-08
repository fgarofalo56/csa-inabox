'use client';

/**
 * GovernanceShell — shared layout for /governance/* pages. Sidebar
 * mirrors Microsoft Purview's left nav so users moving between Loom
 * and Purview feel at home. Loom passes through to Purview where the
 * native experience is richer (full Atlas-style lineage exploration),
 * and natively renders what makes sense in-portal (catalog browse,
 * sensitivity labels, scans, classification rules).
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { makeStyles, tokens, Subtitle2, Title3, Badge } from '@fluentui/react-components';

const SECTIONS = [
  { href: '/governance',                  label: 'Overview',           desc: 'Governance posture, coverage scores, recent activity.' },
  { href: '/governance/domains',          label: 'Domains',            desc: 'Business domains and subdomains, workspace assignment, delegated settings.' },
  { href: '/governance/catalog',          label: 'Data catalog',       desc: 'Unified inventory across OneLake, Synapse, Databricks, ADLS, on-prem.' },
  { href: '/governance/lineage',          label: 'Lineage',            desc: 'Column-level lineage across pipelines, notebooks, dataflows, semantic models.' },
  { href: '/governance/classifications',  label: 'Classifications',    desc: 'Sensitive-info types, custom regex classifiers, scan rule sets.' },
  { href: '/governance/sensitivity',      label: 'Sensitivity labels', desc: 'Define and auto-apply labels; enforce encryption and access policies.' },
  { href: '/governance/scans',            label: 'Scans & sources',    desc: 'Register data sources, schedule scans, monitor scan history.' },
  { href: '/governance/policies',         label: 'Access policies',    desc: 'DLP, masking, RLS/CLS, Purview access policies.' },
  { href: '/governance/insights',         label: 'Insights',           desc: 'Compliance reports, ownership coverage, endorsement trends.' },
  { href: '/governance/purview',          label: 'Purview portal',     desc: 'Embedded Microsoft Purview — full Atlas catalog and Unified Catalog.' },
];

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24, minHeight: '60vh' },
  sidebar: {
    display: 'flex', flexDirection: 'column', gap: 2,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`, paddingRight: 12,
  },
  item: {
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: '10px 12px', borderRadius: 6,
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
  },
  desc: { fontSize: 12, color: tokens.colorNeutralForeground3, fontWeight: 400 },
  body: { minWidth: 0 },
});

export function GovernanceShell({ sectionTitle, sectionBadge, children }: { sectionTitle?: string; sectionBadge?: string; children: ReactNode }) {
  const s = useStyles();
  const pathname = usePathname();
  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — backed by Microsoft Purview, woven into Loom."
    >
      <div className={s.layout}>
        <nav className={s.sidebar} aria-label="Governance sections">
          {SECTIONS.map((sec) => {
            const active = pathname === sec.href || (sec.href !== '/governance' && pathname?.startsWith(sec.href));
            return (
              <Link key={sec.href} href={sec.href} className={`${s.item} ${active ? s.itemActive : ''}`}>
                <Subtitle2>{sec.label}</Subtitle2>
                <span className={s.desc}>{sec.desc}</span>
              </Link>
            );
          })}
        </nav>
        <div className={s.body}>
          {sectionTitle && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
              <Title3 as="h2">{sectionTitle}</Title3>
              {sectionBadge && <Badge appearance="outline" color="brand">{sectionBadge}</Badge>}
            </div>
          )}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
