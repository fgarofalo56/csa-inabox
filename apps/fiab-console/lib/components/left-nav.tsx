'use client';

import Link from 'next/link';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens, Tooltip } from '@fluentui/react-components';
import { PinnedSection } from './pinned-section';
import { NewItemDialog } from './new-item-dialog';
import {
  Home24Regular,
  Building24Regular,
  Apps24Regular,
  ChartMultiple24Regular,
  Flash24Regular,
  Library24Regular,
  GlobeSearch24Regular,
  CloudArrowUp24Regular,
  PuzzlePieceRegular,
  ShieldKeyhole24Regular,
  ShieldCheckmark24Regular,
  Settings24Regular,
  Bot24Regular,
  StoreMicrosoft24Regular,
  Branch24Regular,
  PlugConnected24Regular,
  DataUsage24Regular,
  BeakerEdit24Regular,
  Send24Regular,
  Flow24Regular,
  Alert24Regular,
  DataPie24Regular,
  Table24Regular,
  AddCircle24Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { CopilotIcon } from './icons/copilot-icon';
import { NAV_SECTIONS, type NavItem } from '@/lib/nav/nav-items';
import { useIsTenantAdmin } from './session-context';

// Fabric-parity left nav: top-level surfaces only, like the real Fabric portal.
// Item types are reached from inside a workspace via the "+ New" item dialog.
//
// The rail is grouped into labeled sections (rel-T45). Both the DESTINATIONS
// (href + label) and their grouping live in the shared source of truth
// (lib/nav/nav-items.ts → NAV_SECTIONS) so the Copilot navigate-tool allow-list
// and the command palette (which consume the flat NAV_ITEMS derived from the
// same file, including demoted pages) can't drift from this rail. The icon per
// destination is presentation-only and mapped here.
const ICON_BY_HREF: Record<string, FluentIcon | typeof CopilotIcon> = {
  '/new': AddCircle24Regular,
  '/': Home24Regular,
  '/workspaces': Building24Regular,
  '/browse': Apps24Regular,
  '/onelake': Library24Regular,
  '/catalog': GlobeSearch24Regular,
  '/org-reports': DataPie24Regular,
  '/semantic-model': Table24Regular,
  '/thread': Branch24Regular,
  '/marketplace': StoreMicrosoft24Regular,
  '/governance': ShieldCheckmark24Regular,
  '/monitor': ChartMultiple24Regular,
  '/realtime-hub': Flash24Regular,
  '/activator-hub': Alert24Regular,
  '/business-events': Send24Regular,
  '/rti-hub': DataUsage24Regular,
  '/data-agent': Bot24Regular,
  '/experience/data-science/home': BeakerEdit24Regular,
  '/experience/warp/home': Flow24Regular,
  '/copilot': CopilotIcon,
  '/workload-hub': PuzzlePieceRegular,
  '/connections': PlugConnected24Regular,
  '/deployment-pipelines': CloudArrowUp24Regular,
  '/admin': ShieldKeyhole24Regular,
  '/setup': Settings24Regular,
};

const iconFor = (href: string) => ICON_BY_HREF[href] ?? Apps24Regular;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', padding: '8px 0' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 16px',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    transition: 'background-color 0.15s',
    fontSize: '14px',
    textDecoration: 'none',
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
    borderLeft: `3px solid ${tokens.colorBrandForeground1}`,
    paddingLeft: '13px',
  },
  itemHover: {
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  // Icon-only rail when the shell nav is collapsed.
  itemCollapsed: { justifyContent: 'center', padding: '10px 0', gap: 0 },
  // Reset native <button> chrome so the "+ Create" action row matches the link
  // rows exactly (it opens a dialog rather than navigating).
  navBtn: {
    background: 'none',
    border: 'none',
    width: '100%',
    font: 'inherit',
    textAlign: 'left',
  },
  // Give the primary "+ Create" action a brand accent so it reads as the
  // prominent call-to-action Fabric puts at the top of its nav.
  createRow: { color: tokens.colorBrandForeground1, fontWeight: '600' },
  // Grouped-rail section header (rel-T45). Matches the sibling PinnedSection
  // header styling so the rail reads as one surface: small uppercase caption in
  // neutral-3, semibold. Tokens only (web3-ui) — no raw px/hex.
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 16px 4px',
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3,
  },
  // Adds a hairline above a group to separate sections; also the visual
  // separator used in the collapsed (icon-only) rail where headers are hidden.
  sectionDivider: {
    marginTop: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalXS,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

export function LeftNav({ collapsed = false }: { collapsed?: boolean }) {
  const styles = useStyles();
  const pathname = usePathname();
  // The "+ Create" rail entry opens the New Item dialog inline (rel-T50) rather
  // than navigating — hosted here so it's reachable from every page. The dialog
  // resolves the workspace to create in via its own picker.
  const [createOpen, setCreateOpen] = useState(false);
  // Single shell admin probe (rel-T54): hide admin-only destinations
  // (Admin portal, Setup & landing zones) for non-admins so they never
  // land in a per-page 403. Fail-closed — hidden until positively confirmed.
  const isTenantAdmin = useIsTenantAdmin();

  // Render a single destination row (Link) or the "+ Create" action (button).
  const renderItem = (item: NavItem) => {
    const Icon = iconFor(item.href);
    // "+ Create" is an action, not a destination: render a button that opens
    // the New Item dialog instead of a Link.
    if (item.href === '/new') {
      const createBtn = (
        <button
          key={item.href}
          type="button"
          className={`${styles.item} ${styles.navBtn} ${styles.createRow} ${collapsed ? styles.itemCollapsed : ''} ${styles.itemHover}`}
          onClick={() => setCreateOpen(true)}
          aria-haspopup="dialog"
          aria-label={collapsed ? item.label : undefined}
        >
          <Icon />
          {!collapsed && <span>{item.label}</span>}
        </button>
      );
      return collapsed
        ? <Tooltip key={item.href} content={item.label} relationship="label" positioning="after">{createBtn}</Tooltip>
        : createBtn;
    }
    const active = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
    const link = (
      <Link
        key={item.href}
        href={item.href}
        className={`${styles.item} ${collapsed ? styles.itemCollapsed : ''} ${active ? styles.itemActive : styles.itemHover}`}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? item.label : undefined}
      >
        <Icon />
        {!collapsed && <span>{item.label}</span>}
      </Link>
    );
    return collapsed
      ? <Tooltip key={item.href} content={item.label} relationship="label" positioning="after">{link}</Tooltip>
      : link;
  };

  return (
    <nav className={styles.root} aria-label="Primary">
      {NAV_SECTIONS.map((section, sectionIndex) => {
        // Drop admin-only rows for non-admins; skip the whole section (header
        // included) if nothing remains visible.
        const visible = section.items.filter((item) => !item.adminOnly || isTenantAdmin);
        if (visible.length === 0) return null;
        // The first section ("+ Create") is the ungrouped action row — no header
        // and no top divider. Every later section gets a hairline divider; when
        // expanded it also gets its uppercase caption header.
        const separated = sectionIndex > 0;
        return (
          <div key={section.label ?? 'primary'} className={separated ? styles.sectionDivider : undefined}>
            {separated && !collapsed && section.label && (
              <div className={styles.sectionHeader}>{section.label}</div>
            )}
            {visible.map(renderItem)}
          </div>
        );
      })}
      {!collapsed && <PinnedSection />}
      <NewItemDialog hideTrigger open={createOpen} onOpenChange={setCreateOpen} />
    </nav>
  );
}
