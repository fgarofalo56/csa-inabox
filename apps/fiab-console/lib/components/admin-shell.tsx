'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ReactNode, useState, useEffect } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import { LearnPopover, type LearnPopoverProps } from '@/lib/components/ui/learn-popover';
import {
  makeStyles, mergeClasses, tokens, Title3, Tooltip, Button,
} from '@fluentui/react-components';
import {
  Settings24Regular, Server24Regular, GaugeRegular, Organization24Regular,
  CloudArrowUp24Regular, ShieldCheckmark24Regular, Key24Regular,
  ClipboardTask24Regular, ChartMultiple24Regular, People24Regular,
  Building24Regular, ArrowSync24Regular, PanelLeftContract24Regular,
  PanelLeftExpand24Regular, Globe24Regular, Heart24Regular,
  Tag24Regular, TagMultiple24Regular, Sparkle24Regular, Code24Regular, DataPie24Regular,
  Wrench24Regular, ShieldLock24Regular, PlugConnected24Regular,
  Money24Regular, Send24Regular, Apps24Regular,
  BotSparkle24Regular,
  ToggleLeft24Regular,
  DocumentBriefcase24Regular,
  DatabaseLink24Regular,
  Alert24Regular,
  ArrowSwap24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { ADMIN_SECTIONS, type AdminDestination } from '@/lib/nav/admin-sections';

/**
 * Presentation map: one Fluent icon per admin destination. The destinations
 * themselves (href / label / description / grouping) live in the pure-data
 * registry lib/nav/admin-sections.ts, which node-env tests and server modules
 * can import — the same split left-nav.tsx uses for NAV_SECTIONS. A missing
 * entry falls back to Apps24Regular rather than crashing the rail.
 */
const ICON_BY_HREF: Record<string, FluentIcon> = {
  '/admin/health': Heart24Regular,
  '/admin/performance': GaugeRegular,
  '/admin/rum': GaugeRegular,
  '/admin/readiness': GaugeRegular,
  '/admin/diagnostics': DocumentBriefcase24Regular,
  '/admin/incident-console': Alert24Regular,
  '/admin/capacity': Server24Regular,
  '/admin/scaling': GaugeRegular,
  '/admin/finops': Money24Regular,
  '/admin/tenant-settings': Settings24Regular,
  '/admin/env-config': Wrench24Regular,
  '/admin/gates': Wrench24Regular,
  '/admin/runtime-flags': ToggleLeft24Regular,
  '/admin/api-management': Settings24Regular,
  '/admin/catalog': DatabaseLink24Regular,
  '/admin/domains': Organization24Regular,
  '/admin/attribute-groups': TagMultiple24Regular,
  '/admin/security': ShieldCheckmark24Regular,
  '/admin/policy-code': ShieldCheckmark24Regular,
  '/admin/permissions': Key24Regular,
  '/admin/access-governance': ShieldLock24Regular,
  '/admin/batch-labeling': Tag24Regular,
  '/admin/embed-codes': Code24Regular,
  '/admin/org-visuals': DataPie24Regular,
  '/admin/security?tab=dspm': ShieldLock24Regular,
  '/admin/ai-operations': Sparkle24Regular,
  '/admin/autopilot': BotSparkle24Regular,
  '/admin/mcp-servers': PlugConnected24Regular,
  '/admin/audit-logs': ClipboardTask24Regular,
  '/admin/usage': ChartMultiple24Regular,
  '/admin/webhooks': Send24Regular,
  '/admin/developer/tokens': Key24Regular,
  '/admin/migrate': ArrowSwap24Regular,
  '/admin/deploy-planner': CloudArrowUp24Regular,
  '/admin/landing-zones': Server24Regular,
  '/admin/users': People24Regular,
  '/admin/workspaces': Building24Regular,
  '/admin/network': Globe24Regular,
  '/admin/updates': ArrowSync24Regular,
};

const iconFor = (href: string): FluentIcon => ICON_BY_HREF[href] ?? Apps24Regular;

const useStyles = makeStyles({
  // maxWidth:100% + minWidth:0 on the content track stop wide tables from
  // stretching the whole page past the viewport (the 1fr track defaults to
  // min-width:auto, which is what caused the horizontal-scroll-the-page bug).
  layout: {
    display: 'grid',
    gridTemplateColumns: '248px minmax(0, 1fr)',
    gap: '20px',
    minHeight: '480px',
    maxWidth: '100%',
  },
  layoutCollapsed: { gridTemplateColumns: '52px minmax(0, 1fr)' },
  sidebar: {
    display: 'flex', flexDirection: 'column', gap: '2px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: '12px',
    minWidth: 0,
  },
  sidebarHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', minHeight: '32px' },
  sidebarHeadCollapsed: { justifyContent: 'center' },
  item: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '8px 10px', borderRadius: '6px',
    color: tokens.colorNeutralForeground1,
    textDecoration: 'none',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemCollapsed: { justifyContent: 'center', padding: '8px' },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
  },
  itemIcon: { flexShrink: 0, display: 'flex', fontSize: '20px', color: tokens.colorNeutralForeground2 },
  itemIconActive: { color: tokens.colorBrandForeground1 },
  itemLabel: { fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // IA-01 grouped-sidebar header — mirrors the left-nav rail + governance-shell
  // group label (uppercase Caption in neutral-3, semibold). Tokens only
  // (web3-ui) — no raw px/hex. Hidden when the sidebar collapses to icon-only.
  groupLabel: {
    display: 'block',
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
  },
  // A hairline above each group in the collapsed (icon-only) rail, where the
  // text headers are hidden and would otherwise leave the groups undivided.
  groupDividerCollapsed: {
    marginTop: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  // The content region clips/scrolls its OWN overflow so a wide table gets a
  // local horizontal scrollbar instead of widening the page.
  body: { minWidth: 0, maxWidth: '100%', overflowX: 'auto' },
  // Section-title row: the H2 + an optional contextual-help LearnPopover.
  sectionHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalL,
  },
});

const STORAGE_KEY = 'loom-admin-nav-collapsed';

export function AdminShell({ sectionTitle, learn, children }: { sectionTitle?: string; learn?: LearnPopoverProps; children: ReactNode }) {
  const styles = useStyles();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Restore the user's collapsed preference.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(STORAGE_KEY) === '1'); } catch { /* ignore */ }
  }, []);
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  return (
    <PageShell
      title="Admin portal"
      subtitle="Tenant-wide settings, capacity, governance, audit, and usage for everyone in your organization."
    >
      <div className={mergeClasses(styles.layout, collapsed && styles.layoutCollapsed)}>
        <nav className={styles.sidebar} aria-label="Admin sections">
          <div className={mergeClasses(styles.sidebarHead, collapsed && styles.sidebarHeadCollapsed)}>
            <Tooltip content={collapsed ? 'Expand navigation' : 'Collapse navigation'} relationship="label">
              <Button
                appearance="subtle"
                size="small"
                icon={collapsed ? <PanelLeftExpand24Regular /> : <PanelLeftContract24Regular />}
                onClick={toggle}
                aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              />
            </Tooltip>
          </div>
          {ADMIN_SECTIONS.map((group, groupIndex) => {
            const renderItem = (s: AdminDestination) => {
              const active = pathname === s.href;
              const Icon = iconFor(s.href);
              const link = (
                <Link
                  key={s.href}
                  href={s.href}
                  className={mergeClasses(styles.item, collapsed && styles.itemCollapsed, active && styles.itemActive)}
                  aria-label={s.label}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className={mergeClasses(styles.itemIcon, active && styles.itemIconActive)}><Icon /></span>
                  {!collapsed && <span className={styles.itemLabel}>{s.label}</span>}
                </Link>
              );
              // Tooltip carries the label + description (always when collapsed;
              // as a helpful hover when expanded).
              return (
                <Tooltip
                  key={s.href}
                  content={collapsed ? `${s.label} — ${s.desc}` : s.desc}
                  relationship="label"
                  positioning="after"
                >
                  {link}
                </Tooltip>
              );
            };
            // Expanded rail: a text header per group. Collapsed (icon-only) rail:
            // headers are hidden (nothing to read), so a hairline separates the
            // later groups instead — matching the left-nav rail pattern.
            return (
              <div
                key={group.label}
                role="group"
                aria-label={group.label}
                className={collapsed && groupIndex > 0 ? styles.groupDividerCollapsed : undefined}
              >
                {!collapsed && <span className={styles.groupLabel}>{group.label}</span>}
                {group.items.map(renderItem)}
              </div>
            );
          })}
        </nav>
        <div className={styles.body}>
          {sectionTitle && (
            <div className={styles.sectionHead}>
              <Title3 as="h2">{sectionTitle}</Title3>
              {learn && <LearnPopover {...learn} />}
            </div>
          )}
          {children}
        </div>
      </div>
    </PageShell>
  );
}
