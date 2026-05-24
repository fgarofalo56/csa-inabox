'use client';

import { ReactNode, useEffect, useState } from 'react';
import { makeStyles, tokens, Title3, Avatar, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem } from '@fluentui/react-components';
import { SignOut24Regular, Settings24Regular, Person24Regular, Search24Regular } from '@fluentui/react-icons';
import { LeftNav } from './left-nav';
import { CommandPalette } from './command-palette';
import { CopilotPane } from './copilot-pane';

interface MeResponse {
  authenticated: boolean;
  user: null | { name: string; email?: string; upn: string; oid: string };
}

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
  brand: { display: 'flex', alignItems: 'center', gap: '8px', marginRight: 'auto' },
  weave: {
    width: '24px',
    height: '24px',
    backgroundImage:
      'linear-gradient(135deg, var(--loom-amber) 25%, transparent 25%, transparent 50%, var(--loom-amber) 50%, var(--loom-amber) 75%, transparent 75%)',
    backgroundSize: '8px 8px',
    borderRadius: '4px',
  },
  brandText: { color: tokens.colorNeutralForegroundInverted, fontWeight: '600' },
  nav: {
    gridColumn: '1',
    gridRow: '2',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: 'auto',
  },
  main: { gridColumn: '2', gridRow: '2', overflow: 'auto', padding: '24px' },
  userText: { color: 'white', fontSize: '13px', marginRight: '4px' },
});

export function AppShell({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me').then((r) => r.json()).then((d: MeResponse) => {
      if (!cancelled) setMe(d);
    }).catch(() => {/* unauthenticated render */});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <div className={styles.weave} aria-hidden />
          <Title3 className={styles.brandText}>CSA Loom</Title3>
        </div>
        <Button
          appearance="transparent"
          icon={<Search24Regular />}
          style={{ color: 'white' }}
          aria-label="Search (Ctrl+K)"
          title="Search (Ctrl+K)"
          onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
        />
        <Button
          appearance="transparent"
          icon={<Settings24Regular />}
          style={{ color: 'white' }}
          aria-label="Settings"
          as="a"
          href="/admin"
        />
        {me?.authenticated && me.user ? (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="transparent" style={{ color: 'white' }}>
                <Avatar name={me.user.name} size={28} />
                <span className={styles.userText} style={{ marginLeft: 8 }}>{me.user.name}</span>
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Person24Regular />} disabled>{me.user.email ?? me.user.upn}</MenuItem>
                <MenuItem icon={<SignOut24Regular />} onClick={() => { window.location.href = '/auth/sign-out'; }}>
                  Sign out
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        ) : (
          <Button
            appearance="primary"
            as="a"
            href="/auth/sign-in"
            aria-label="Sign in"
          >
            Sign in
          </Button>
        )}
      </header>
      <nav className={styles.nav}>
        <LeftNav />
      </nav>
      <main className={styles.main}>{children}</main>
      <CommandPalette />
      <CopilotPane />
    </div>
  );
}
