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
import { ReactNode, useEffect, useId } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { useIsTenantAdmin } from '@/lib/components/session-context';
import { SectionExplainer } from '@/lib/components/ui/learn-popover';
import { GOVERNANCE_SECTIONS } from '@/lib/nav/governance-sections';
import { useNavCollapse, CollapseChevron } from '@/lib/components/nav-collapse';
import { makeStyles, mergeClasses, tokens, Subtitle2, Title3, Badge, Button, Tooltip } from '@fluentui/react-components';
import { ArrowExpandAll20Regular, ArrowCollapseAll20Regular } from '@fluentui/react-icons';

/**
 * Per-group expand/collapse map for the governance sidebar (#5467). Its own
 * key, distinct from the main left nav's and the admin sidebar's, so a group
 * folded here never folds a same-named group anywhere else.
 */
export const GOVERNANCE_GROUP_COLLAPSE_LS_KEY = 'loom.governance.nav.groups.collapsed.v1';

const isActiveHref = (pathname: string | null, href: string) =>
  pathname === href || (href !== '/governance' && !!pathname?.startsWith(href));

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
  // #5467 — the group header is a real <button> (click / Enter / Space toggles
  // the group). Resets native chrome on top of the groupLabel caption; hover +
  // visible focus ring match the left-nav section headers.
  groupHeaderBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    width: '100%',
    textAlign: 'left',
    fontFamily: tokens.fontFamilyBase,
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
    ':focus-visible': {
      outline: `${tokens.strokeWidthThick} solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: `calc(-1 * ${tokens.strokeWidthThick})`,
    },
  },
  groupHeaderChevron: { display: 'inline-flex', flexShrink: 0, color: tokens.colorNeutralForeground3 },
  // Expand all / Collapse all row at the top of the sidebar.
  sidebarHead: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
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
  const groupLabels = groups.map((g) => g.label);
  const groupIdPrefix = useId();
  const {
    collapsed: isGroupCollapsed,
    toggle: toggleGroup,
    setCollapsed: setGroupsCollapsed,
    expand: expandGroup,
  } = useNavCollapse(GOVERNANCE_GROUP_COLLAPSE_LS_KEY);
  // The group holding the current page is forced open on load and on every
  // navigation (queued after the hook's hydration, so it wins over a
  // persisted "collapsed" for that group). Matched against the unfiltered
  // registry so the decision does not wait on the admin probe.
  const activeGroup = GOVERNANCE_SECTIONS.find((g) => g.items.some((sec) => isActiveHref(pathname, sec.href)))?.label;
  useEffect(() => {
    if (activeGroup) expandGroup(activeGroup);
  }, [activeGroup, pathname, expandGroup]);
  return (
    <PageShell
      title="Governance"
      subtitle="Catalog, classify, label, scan, and enforce policy across every Azure data source — backed by Microsoft Purview, woven into Loom."
    >
      <div className={s.layout}>
        <nav className={s.sidebar} aria-label="Governance sections">
          <div className={s.sidebarHead}>
            <Tooltip content="Expand all groups" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowExpandAll20Regular />}
                onClick={() => setGroupsCollapsed(groupLabels, false)}
                aria-label="Expand all groups"
              />
            </Tooltip>
            <Tooltip content="Collapse all groups" relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowCollapseAll20Regular />}
                onClick={() => setGroupsCollapsed(groupLabels, true)}
                aria-label="Collapse all groups"
              />
            </Tooltip>
          </div>
          {groups.map((g, groupIndex) => {
            const groupCollapsed = isGroupCollapsed(g.label);
            const regionId = `${groupIdPrefix}governance-group-${groupIndex}`;
            return (
              <div key={g.label} role="group" aria-label={g.label}>
                <button
                  type="button"
                  className={mergeClasses(s.groupLabel, s.groupHeaderBtn)}
                  aria-expanded={!groupCollapsed}
                  aria-controls={regionId}
                  onClick={() => toggleGroup(g.label)}
                >
                  <span className={s.groupHeaderChevron} aria-hidden>
                    <CollapseChevron open={!groupCollapsed} />
                  </span>
                  {g.label}
                </button>
                <div id={regionId} hidden={groupCollapsed}>
                  {g.items.map((sec) => {
                    const active = isActiveHref(pathname, sec.href);
                    return (
                      <Link key={sec.href} href={sec.href} className={mergeClasses(s.item, active && s.itemActive)}>
                        <Subtitle2>{sec.label}</Subtitle2>
                        <span className={s.desc}>{sec.desc}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
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
