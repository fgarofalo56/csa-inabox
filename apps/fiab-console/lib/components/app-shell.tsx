'use client';

import { ReactNode, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Avatar, Button,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Divider,
} from '@fluentui/react-components';
import {
  SignOut24Regular, Settings24Regular, Person24Regular,
  Sparkle24Regular, Question24Regular,
} from '@fluentui/react-icons';
import { LeftNav } from './left-nav';
import { CommandPalette } from './command-palette';
import { CopilotPane, openCopilot } from './copilot-pane';
import { LoomLogo } from './loom-logo';
import { ThemeToggle } from './theme-toggle';
import { TopbarSearch } from './topbar-search';
import { FeedbackWidget } from './feedback-widget';
import { GlobalErrorBoundary, GlobalErrorListeners } from './error-boundary';

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
    backgroundColor: 'var(--loom-app-bg)',
  },
  topbar: {
    gridColumn: '1 / -1',
    background: 'var(--loom-topbar-bg)',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    paddingLeft: '16px',
    paddingRight: '12px',
    gap: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
    zIndex: 10,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12, color: 'white' },
  brandDivider: {
    width: 1, height: 24, marginLeft: 4, marginRight: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  tagline: {
    fontSize: 11, letterSpacing: '0.06em', opacity: 0.7, lineHeight: 1.2,
    display: 'flex', flexDirection: 'column',
  },
  iconBtn: { color: 'white !important' },
  nav: {
    gridColumn: '1', gridRow: '2',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: 'auto',
  },
  main: {
    gridColumn: '2', gridRow: '2',
    overflow: 'auto',
    padding: '20px 24px',
    backgroundColor: 'var(--loom-app-bg)',
  },
  userBtn: { color: 'white', display: 'flex', alignItems: 'center', gap: 8 },
});

export function AppShell({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me').then((r) => r.json()).then((d: MeResponse) => {
      if (!cancelled) setMe(d);
    }).catch(() => {/* unauthenticated */});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <LoomLogo variant="horizontal" size={26} />
          <div className={styles.brandDivider} />
          <div className={styles.tagline}>
            <span style={{ fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Cloud Scale Analytics</span>
            <span style={{ opacity: 0.85 }}>Weaving every Azure data service into one experience</span>
          </div>
        </div>
        <TopbarSearch />
        <Button appearance="transparent" className={styles.iconBtn} icon={<Sparkle24Regular />}
          onClick={openCopilot} aria-label="Open Copilot" title="Copilot" />
        <ThemeToggle color="white" />
        <Button appearance="transparent" className={styles.iconBtn} icon={<Question24Regular />}
          aria-label="Help" title="Help" />
        <Button appearance="transparent" className={styles.iconBtn} icon={<Settings24Regular />}
          as="a" href="/admin" aria-label="Admin & settings" title="Admin" />
        {me?.authenticated && me.user ? (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button appearance="transparent" className={styles.iconBtn} aria-label="Account">
                <Avatar name={me.user.name} size={28} color="colorful" />
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem icon={<Person24Regular />} disabled>{me.user.email ?? me.user.upn}</MenuItem>
                <Divider />
                <MenuItem icon={<SignOut24Regular />} onClick={() => { window.location.href = '/auth/sign-out'; }}>
                  Sign out
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        ) : (
          <Button appearance="primary" as="a" href="/auth/sign-in" aria-label="Sign in">Sign in</Button>
        )}
      </header>
      <nav className={styles.nav}>
        <LeftNav />
      </nav>
      <main className={`${styles.main} loom-app-grid-bg`}>
        <GlobalErrorBoundary>{children}</GlobalErrorBoundary>
      </main>
      <CommandPalette />
      <CopilotPane />
      <FeedbackWidget />
      <GlobalErrorListeners />
    </div>
  );
}
