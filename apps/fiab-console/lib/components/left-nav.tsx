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
} from '@fluentui/react-icons';
import { CopilotIcon } from './icons/copilot-icon';

// Fabric-parity left nav: top-level surfaces only, like the real
// Fabric portal. Item types are reached from inside a workspace via
// the "+ New" item dialog.
const navItems = [
  { href: '/', icon: Home24Regular, label: 'Home' },
  { href: '/workspaces', icon: Building24Regular, label: 'Workspaces' },
  { href: '/browse', icon: Apps24Regular, label: 'Browse' },
  { href: '/onelake', icon: Library24Regular, label: 'OneLake catalog' },
  { href: '/catalog', icon: GlobeSearch24Regular, label: 'Unified catalog' },
  { href: '/org-reports', icon: DataPie24Regular, label: 'Organization reports' },
  { href: '/semantic-model', icon: Table24Regular, label: 'Semantic models' },
  { href: '/thread', icon: Branch24Regular, label: 'Lineage' },
  { href: '/marketplace', icon: StoreMicrosoft24Regular, label: 'Marketplace' },
  { href: '/governance', icon: ShieldCheckmark24Regular, label: 'Governance' },
  { href: '/monitor', icon: ChartMultiple24Regular, label: 'Monitor' },
  { href: '/realtime-hub', icon: Flash24Regular, label: 'Real-Time hub' },
  { href: '/activator-hub', icon: Alert24Regular, label: 'Activator' },
  { href: '/business-events', icon: Send24Regular, label: 'Business events' },
  { href: '/rti-hub', icon: DataUsage24Regular, label: 'RTI catalog' },
  { href: '/data-agent', icon: Bot24Regular, label: 'Data agents' },
  { href: '/experience/data-science/home', icon: BeakerEdit24Regular, label: 'Data Science' },
  { href: '/experience/warp/home', icon: Flow24Regular, label: 'Warp' },
  { href: '/copilot', icon: CopilotIcon, label: 'Copilot' },
  { href: '/workload-hub', icon: PuzzlePieceRegular, label: 'Workload hub' },
  { href: '/connections', icon: PlugConnected24Regular, label: 'Connections' },
  { href: '/deployment-pipelines', icon: CloudArrowUp24Regular, label: 'Deployment' },
  { href: '/admin', icon: ShieldKeyhole24Regular, label: 'Admin portal' },
  { href: '/setup', icon: Settings24Regular, label: 'Setup & landing zones' },
];

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
  return (
    <nav className={styles.root} aria-label="Primary">
      {navItems.map((item) => {
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
