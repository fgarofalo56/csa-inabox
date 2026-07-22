'use client';

/**
 * GovernanceShell — shared layout for /governance/* pages. Sidebar
 * mirrors Microsoft Purview's left nav (grouped: Catalog management /
 * Data Map / Discovery & lineage / Policies & protection / Health &
 * quality / Purview portal) so users moving between Loom and Purview
 * feel at home. Loom passes through to Purview where the native
 * experience is richer (full Atlas-style lineage exploration), and
 * natively renders what makes sense in-portal (catalog browse,
 * sensitivity labels, scans, classification rules).
 *
 * The destinations come from the shared GOVERNANCE_SECTIONS registry
 * (lib/nav/governance-sections.ts) — the same list the /governance
 * overview grid renders — so the sidebar and the overview can never
 * disagree about which governance surfaces exist.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { useIsTenantAdmin } from '@/lib/components/session-context';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { GOVERNANCE_SECTIONS } from '@/lib/nav/governance-sections';
import { makeStyles, mergeClasses, tokens, Subtitle2, Title3, Badge } from '@fluentui/react-components';

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
  // Purview-style group header — matches the left-nav rail's uppercase
  // caption styling (left-nav.tsx sectionHeader) so the two nav surfaces
  // read as one product. Tokens only (web3-ui) — no raw px/hex.
  groupLabel: {
    display: 'block',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
  },
  body: { minWidth: 0 },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
  },
});

export function GovernanceShell({ sectionTitle, sectionBadge, explainer, children }: { sectionTitle?: string; sectionBadge?: string; explainer?: ReactNode; children: ReactNode }) {
  const s = useStyles();
  const pathname = usePathname();
  const isTenantAdmin = useIsTenantAdmin();
  // adminOnly destinations live in the Admin portal (/admin/*). They are
  // hidden for non-admins (rel-T53) — reusing the single shell admin probe —
  // so a non-admin is never dumped into a per-page 403. Groups left empty by
  // the filter are dropped entirely (header included).
  const groups = GOVERNANCE_SECTIONS
    .map((g) => ({ ...g, items: g.items.filter((sec) => !sec.adminOnly || isTenantAdmin) }))
    .filter((g) => g.items.length > 0);
  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — backed by Microsoft Purview, woven into Loom."
    >
      <div className={s.layout}>
        <nav className={s.sidebar} aria-label="Governance sections">
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <span className={s.groupLabel}>{g.label}</span>
              {g.items.map((sec) => {
                const active = pathname === sec.href || (sec.href !== '/governance' && pathname?.startsWith(sec.href));
                return (
                  <Link key={sec.href} href={sec.href} className={mergeClasses(s.item, active && s.itemActive)}>
                    <Subtitle2>{sec.label}</Subtitle2>
                    <span className={s.desc}>{sec.desc}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className={s.body}>
          {sectionTitle && (
            <div className={s.sectionHead}>
              <Title3 as="h2">{sectionTitle}</Title3>
              {sectionBadge && <Badge appearance="outline" color="brand">{sectionBadge}</Badge>}
            </div>
          )}
          {explainer && (
            <div style={{ marginBottom: tokens.spacingVerticalL }}>
              <SectionExplainer>{explainer}</SectionExplainer>
            </div>
          )}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
