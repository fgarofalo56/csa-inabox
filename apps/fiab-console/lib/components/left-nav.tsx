'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens, Tooltip } from '@fluentui/react-components';
import { PinnedSection } from './pinned-section';
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
  type FluentIcon,
} from '@fluentui/react-icons';
import { CopilotIcon } from './icons/copilot-icon';
import { NAV_ITEMS } from '@/lib/nav/nav-items';
import { useIsTenantAdmin } from './session-context';

// Fabric-parity left nav: top-level surfaces only, like the real Fabric portal.
// Item types are reached from inside a workspace via the "+ New" item dialog.
//
// The DESTINATIONS (href + label) live in the shared NAV_ITEMS source of truth
// (lib/nav/nav-items.ts) so the Copilot navigate-tool allow-list can't drift
// from this rail. The icon per destination is presentation-only and mapped here.
const ICON_BY_HREF: Record<string, FluentIcon | typeof CopilotIcon> = {
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

const navItems = NAV_ITEMS.map((it) => ({
  ...it,
  icon: ICON_BY_HREF[it.href] ?? Apps24Regular,
}));

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
});

export function LeftNav({ collapsed = false }: { collapsed?: boolean }) {
  const styles = useStyles();
  const pathname = usePathname();
  // Single shell admin probe (rel-T54): hide admin-only destinations
  // (Admin portal, Setup & landing zones) for non-admins so they never
  // land in a per-page 403. Fail-closed — hidden until positively confirmed.
  const isTenantAdmin = useIsTenantAdmin();
  const items = navItems.filter((item) => !item.adminOnly || isTenantAdmin);
  return (
    <nav className={styles.root} aria-label="Primary">
      {items.map((item) => {
        const Icon = item.icon;
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
      })}
      {!collapsed && <PinnedSection />}
    </nav>
  );
}
