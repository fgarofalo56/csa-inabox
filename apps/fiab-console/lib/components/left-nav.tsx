'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  Home24Regular,
  Database24Regular,
  TableSimple24Regular,
  Notebook24Regular,
  ChartMultiple24Regular,
  Flash24Regular,
  Bot24Regular,
  Settings24Regular,
} from '@fluentui/react-icons';

const navItems = [
  { href: '/', icon: Home24Regular, label: 'Workspaces' },
  { href: '/lakehouse', icon: Database24Regular, label: 'Lakehouse' },
  { href: '/warehouse', icon: TableSimple24Regular, label: 'Warehouse' },
  { href: '/notebook', icon: Notebook24Regular, label: 'Notebook' },
  { href: '/semantic-model', icon: ChartMultiple24Regular, label: 'Semantic Model' },
  { href: '/activator', icon: Flash24Regular, label: 'Activator' },
  { href: '/data-agent', icon: Bot24Regular, label: 'Data Agent' },
  { href: '/setup', icon: Settings24Regular, label: 'Setup Wizard' },
];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    padding: '8px 0',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 16px',
    color: tokens.colorNeutralForeground1,
    cursor: 'pointer',
    transition: 'background-color 0.15s',
    fontSize: '14px',
  },
  itemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
    borderLeft: `3px solid ${tokens.colorBrandForeground1}`,
    paddingLeft: '13px',
  },
  itemHover: {
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2Hover,
    },
  },
});

export function LeftNav() {
  const styles = useStyles();
  const pathname = usePathname();
  return (
    <div className={styles.root}>
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;
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
    </div>
  );
}
