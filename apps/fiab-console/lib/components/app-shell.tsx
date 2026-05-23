'use client';

import { ReactNode } from 'react';
import { makeStyles, tokens, Title3, Avatar, Button } from '@fluentui/react-components';
import { SignOut24Regular, Settings24Regular } from '@fluentui/react-icons';
import { LeftNav } from './left-nav';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: 'var(--loom-nav-width) 1fr',
    gridTemplateRows: 'var(--loom-topbar-height) 1fr',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  topbar: {
    gridColumn: '1 / -1',
    backgroundColor: 'var(--loom-navy)',
    color: tokens.colorNeutralForegroundInverted,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '16px',
    paddingRight: '16px',
    gap: '12px',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginRight: 'auto',
  },
  weave: {
    width: '24px',
    height: '24px',
    backgroundImage:
      'linear-gradient(135deg, var(--loom-amber) 25%, transparent 25%, transparent 50%, var(--loom-amber) 50%, var(--loom-amber) 75%, transparent 75%)',
    backgroundSize: '8px 8px',
    borderRadius: '4px',
  },
  brandText: {
    color: tokens.colorNeutralForegroundInverted,
    fontWeight: '600',
  },
  nav: {
    gridColumn: '1',
    gridRow: '2',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: 'auto',
  },
  main: {
    gridColumn: '2',
    gridRow: '2',
    overflow: 'auto',
    padding: '24px',
  },
});

export function AppShell({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <div className={styles.weave} aria-hidden />
          <Title3 className={styles.brandText}>CSA Loom</Title3>
        </div>
        <Button
          appearance="transparent"
          icon={<Settings24Regular />}
          style={{ color: 'white' }}
          aria-label="Settings"
        />
        <Avatar name="User" size={32} />
        <Button
          appearance="transparent"
          icon={<SignOut24Regular />}
          style={{ color: 'white' }}
          aria-label="Sign out"
        />
      </header>
      <nav className={styles.nav}>
        <LeftNav />
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
