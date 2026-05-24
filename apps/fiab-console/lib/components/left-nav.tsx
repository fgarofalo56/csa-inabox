'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  Home24Regular,
  Building24Regular,
  Apps24Regular,
  ChartMultiple24Regular,
  Flash24Regular,
  Database24Regular,
  CloudArrowUp24Regular,
  PuzzlePiece24Regular,
  ShieldKeyhole24Regular,
  ShieldCheckmark24Regular,
  Settings24Regular,
  Bot24Regular,
  Notebook24Regular,
  Connector24Regular,
} from '@fluentui/react-icons';

// Fabric-parity left nav: top-level surfaces only, like the real
// Fabric portal. Item types are reached from inside a workspace via
// the "+ New" item dialog.
const navItems = [
  { href: '/', icon: Home24Regular, label: 'Home' },
  { href: '/workspaces', icon: Building24Regular, label: 'Workspaces' },
  { href: '/browse', icon: Apps24Regular, label: 'Browse' },
  { href: '/onelake', icon: Database24Regular, label: 'OneLake catalog' },
  { href: '/api-marketplace', icon: Connector24Regular, label: 'API marketplace' },
  { href: '/governance', icon: ShieldCheckmark24Regular, label: 'Governance' },
  { href: '/monitor', icon: ChartMultiple24Regular, label: 'Monitor' },
  { href: '/realtime-hub', icon: Flash24Regular, label: 'Real-Time hub' },
  { href: '/data-agent', icon: Bot24Regular, label: 'Data agent' },
  { href: '/copilot', icon: Notebook24Regular, label: 'Copilot' },
  { href: '/workload-hub', icon: PuzzlePiece24Regular, label: 'Workload hub' },
  { href: '/deployment-pipelines', icon: CloudArrowUp24Regular, label: 'Deployment' },
  { href: '/admin', icon: ShieldKeyhole24Regular, label: 'Admin portal' },
  { href: '/setup', icon: Settings24Regular, label: 'Setup wizard' },
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
});

export function LeftNav() {
  const styles = useStyles();
  const pathname = usePathname();
  return (
    <nav className={styles.root} aria-label="Primary">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.item} ${active ? styles.itemActive : styles.itemHover}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
