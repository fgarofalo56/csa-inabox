'use client';

/**
 * AppShell — v3 topbar (Fabric parity). Order:
 *   Brand | AppLauncher | TabStrip | SavedStatus | TopbarSearch | actions
 * Action cluster: Copilot, Notifications, Feedback, ThemeToggle, Help,
 * Admin/Settings, Account/SignIn. Brand subtitle "Cloud Scale Analytics"
 * lives in the brand tooltip / aria-label so screen readers + clipboard
 * don't get "CSA LoomCloud Scale Analytics".
 */

import { ReactNode, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Avatar, Button,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Divider, Tooltip,
} from '@fluentui/react-components';
import {
  SignOut24Regular, Settings24Regular, Person24Regular,
  Sparkle24Regular, Question24Regular, ChatHelp24Regular,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { LeftNav } from './left-nav';
import { CommandPalette } from './command-palette';
import { CopilotPane, openCopilot } from './copilot-pane';
import { LoomLogo } from './loom-logo';
import { ThemeToggle } from './theme-toggle';
import { TopbarSearch } from './topbar-search';
import { FeedbackWidget, openFeedback } from './feedback-widget';
import { GlobalErrorBoundary, GlobalErrorListeners } from './error-boundary';
import { AppLauncher } from './app-launcher';
import { TabStrip } from './tab-strip';
import { SavedStatus } from './saved-status';
import { NotificationsButton } from './notifications-button';

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
    paddingLeft: 'var(--loom-space-4)',
    paddingRight: 'var(--loom-space-3)',
    gap: 'var(--loom-space-3)',
    boxShadow: 'var(--loom-elev-2)',
    zIndex: 10,
    minHeight: 'var(--loom-topbar-height)',
  },
  brand: {
    display: 'flex', alignItems: 'center',
    gap: 'var(--loom-space-2)',
    color: 'white',
    flexShrink: 0,
    width: 'calc(var(--loom-nav-width) - var(--loom-space-4))',
    textDecoration: 'none',
    padding: 'var(--loom-space-1) var(--loom-space-2)',
    borderRadius: 'var(--loom-radius-md)',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.08)' },
    ':focus-visible': { outline: '2px solid white', outlineOffset: '2px' },
  },
  wordmark: {
    fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
  },
  iconBtn: {
    color: 'white',
    transition: 'background-color var(--loom-motion-fast) var(--loom-motion-ease)',
    ':hover': { backgroundColor: 'rgba(255,255,255,0.10)' },
    flexShrink: 0,
  },
  actions: { display: 'flex', alignItems: 'center', gap: 'var(--loom-space-1)', flexShrink: 0 },
  nav: {
    gridColumn: '1', gridRow: '2',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
  },
  navMain: { flex: 1 },
  navFooter: {
    padding: 'var(--loom-space-2) var(--loom-space-3)',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', gap: 'var(--loom-space-1)',
  },
  navFooterBtn: { justifyContent: 'flex-start', width: '100%' },
  main: {
    gridColumn: '2', gridRow: '2',
    overflow: 'auto',
    padding: 'var(--loom-space-5) var(--loom-space-5) var(--loom-space-6)',
    backgroundColor: 'var(--loom-app-bg)',
  },
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
      <header className={styles.topbar} role="banner">
        <Tooltip content="CSA Loom — Cloud Scale Analytics · Weaving every Azure data service into one experience" relationship="label">
          <Link href="/" className={styles.brand} aria-label="CSA Loom (Cloud Scale Analytics) — home">
            <LoomLogo variant="icon" size={32} />
            <span className={styles.wordmark}>CSA Loom</span>
          </Link>
        </Tooltip>
        <AppLauncher />
        <TabStrip />
        <SavedStatus />
        <TopbarSearch />
        <div className={styles.actions} role="toolbar" aria-label="Global actions">
          <Tooltip content="Copilot (Ctrl+/)" relationship="label">
            <Button appearance="transparent" className={styles.iconBtn} icon={<Sparkle24Regular />}
              onClick={openCopilot} aria-label="Open Copilot" />
          </Tooltip>
          <NotificationsButton />
          <Tooltip content="Send feedback" relationship="label">
            <Button appearance="transparent" className={styles.iconBtn} icon={<ChatHelp24Regular />}
              onClick={openFeedback} aria-label="Send feedback" />
          </Tooltip>
          <ThemeToggle color="white" />
          <Tooltip content="Help" relationship="label">
            <Button appearance="transparent" className={styles.iconBtn} icon={<Question24Regular />}
              aria-label="Help" />
          </Tooltip>
          <Tooltip content="Admin & settings" relationship="label">
            <Button appearance="transparent" className={styles.iconBtn} icon={<Settings24Regular />}
              as="a" href="/admin" aria-label="Admin and settings" />
          </Tooltip>
          {me?.authenticated && me.user ? (
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button appearance="transparent" className={styles.iconBtn} aria-label={`Account · ${me.user.name}`}>
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
        </div>
      </header>
      <nav className={styles.nav}>
        <div className={styles.navMain}><LeftNav /></div>
        <div className={styles.navFooter}>
          <Button appearance="subtle" className={styles.navFooterBtn}
            icon={<ChatHelp24Regular />} onClick={openFeedback}>
            Send feedback
          </Button>
        </div>
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
