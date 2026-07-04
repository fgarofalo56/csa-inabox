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
import { useIsTenantAdmin } from '@/lib/components/session-context';
import { makeStyles, mergeClasses, tokens, Subtitle2, Title3, Badge } from '@fluentui/react-components';

// adminOnly sections live in the Admin portal (/admin/*). They are hidden for
// non-admins (rel-T53) — reusing the single shell admin probe — leaving the
// read-only governance views (Overview, Govern, catalog, lineage, scans,
// policies, insights, …) so a non-admin is never dumped into a per-page 403.
const SECTIONS: { href: string; label: string; desc: string; adminOnly?: boolean }[] = [
  { href: '/governance',                  label: 'Overview',           desc: 'Governance posture, coverage scores, recent activity.' },
  { href: '/governance/govern',           label: 'Govern',             desc: 'My-items posture for data owners — label coverage, curation, recommended actions.' },
  { href: '/admin/domains',               label: 'Domains',            desc: 'Business domains and subdomains, workspace assignment, delegated settings (Admin portal).', adminOnly: true },
  { href: '/governance/catalog',          label: 'Governed inventory', desc: 'Governed data-asset inventory with endorsement, sensitivity, and access requests across OneLake, Synapse, Databricks, ADLS, on-prem.' },
  { href: '/governance/lineage',          label: 'Lineage',            desc: 'End-to-end lineage across items, pipelines, notebooks, dataflows, and models — Governed / Mesh / Federated scopes; Purview edges merge in when bound.' },
  { href: '/admin/classifications',       label: 'Classifications',    desc: 'Sensitive-info types, custom regex classifiers, scan rule sets (Admin portal).', adminOnly: true },
  { href: '/admin/sensitivity-labels',    label: 'Sensitivity labels', desc: 'Define and auto-apply labels; enforce encryption and access policies (Admin portal).', adminOnly: true },
  { href: '/governance/scans',            label: 'Scans & sources',    desc: 'Register data sources, schedule scans, monitor scan history.' },
  { href: '/governance/policies',         label: 'Access policies',    desc: 'DLP, masking, RLS/CLS, Purview access policies.' },
  { href: '/governance/data-quality',     label: 'Data quality',       desc: 'Author rules, run on Kusto/Databricks/Synapse, results + Delta/Lakehouse monitors.' },
  { href: '/governance/mdm',              label: 'Master data',        desc: 'Golden-record match/merge + reference-data management on Azure-native compute.' },
  { href: '/governance/insights',         label: 'Insights',           desc: 'Compliance reports, ownership coverage, endorsement trends.' },
  { href: '/governance/irm',              label: 'Insider risk',       desc: 'IRM indicators — unusual volume, off-hours access, privileged access over audit logs + Monitor.' },
  { href: '/governance/purview',          label: 'Purview portal',     desc: 'Embedded Microsoft Purview — full Atlas catalog and Unified Catalog.' },
];

const useStyles = makeStyles({
  layout: {
    display: 'grid',
    gridTemplateColumns: '280px minmax(0, 1fr)',
    gap: tokens.spacingHorizontalXXL,
    minHeight: '60vh',
  },
  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalM,
    position: 'sticky',
    top: tokens.spacingVerticalL,
    alignSelf: 'start',
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  desc: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightRegular,
  },
  body: { minWidth: 0 },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
});

export function GovernanceShell({ sectionTitle, sectionBadge, children }: { sectionTitle?: string; sectionBadge?: string; children: ReactNode }) {
  const s = useStyles();
  const pathname = usePathname();
  const isTenantAdmin = useIsTenantAdmin();
  const sections = SECTIONS.filter((sec) => !sec.adminOnly || isTenantAdmin);
  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — backed by Microsoft Purview, woven into Loom."
    >
      <div className={s.layout}>
        <nav className={s.sidebar} aria-label="Governance sections">
          {sections.map((sec) => {
            const active = pathname === sec.href || (sec.href !== '/governance' && pathname?.startsWith(sec.href));
            return (
              <Link key={sec.href} href={sec.href} className={mergeClasses(s.item, active && s.itemActive)}>
                <Subtitle2>{sec.label}</Subtitle2>
                <span className={s.desc}>{sec.desc}</span>
              </Link>
            );
          })}
        </nav>
        <div className={s.body}>
          {sectionTitle && (
            <div className={s.sectionHead}>
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
