'use client';

import { ReactNode, useEffect, useState } from 'react';
import {
  makeStyles, tokens, Avatar, Button,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  Divider,
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
    minHeight: 'var(--loom-topbar-height)',
  },
  /* Brand block — uses fixed widths so it doesn't push out the search */
  brand: {
    display: 'flex', alignItems: 'center', gap: 12,
    color: 'white',
    flexShrink: 0,
    width: 'calc(var(--loom-nav-width) - 16px)',
    minWidth: 'calc(var(--loom-nav-width) - 16px)',
    overflow: 'hidden',
    textDecoration: 'none',
  },
  brandText: {
    display: 'flex', flexDirection: 'column', minWidth: 0,
    lineHeight: 1.15,
  },
  brandLine1: {
    fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em',
    whiteSpace: 'nowrap',
  },
  brandLine2: {
    fontSize: 10, letterSpacing: '0.12em', fontWeight: 600,
    textTransform: 'uppercase', opacity: 0.7,
    whiteSpace: 'nowrap',
  },
  divider: {
    width: 1, height: 32, marginLeft: 4, marginRight: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    flexShrink: 0,
  },
  taglineWrap: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12, lineHeight: 1.3,
    flex: '0 1 280px', minWidth: 0,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  iconBtn: { color: 'white !important', flexShrink: 0 },
  actions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
  nav: {
    gridColumn: '1', gridRow: '2',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
  },
  navMain: { flex: 1 },
  navFooter: {
    padding: '8px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  navFooterBtn: {
    justifyContent: 'flex-start', width: '100%',
  },
  main: {
    gridColumn: '2', gridRow: '2',
    overflow: 'auto',
    padding: '20px 24px',
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
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand} aria-label="CSA Loom home">
          <LoomLogo variant="icon" size={36} />
          <div className={styles.brandText}>
            <span className={styles.brandLine1}>CSA Loom</span>
            <span className={styles.brandLine2}>Cloud Scale Analytics</span>
          </div>
        </Link>
        <div className={styles.divider} />
        <div className={styles.taglineWrap}>Weaving every Azure data service into one experience</div>
        <TopbarSearch />
        <div className={styles.actions}>
          <Button appearance="transparent" className={styles.iconBtn} icon={<ChatHelp24Regular />}
            onClick={openFeedback} aria-label="Send feedback" title="Send feedback" />
          <Button appearance="transparent" className={styles.iconBtn} icon={<Sparkle24Regular />}
            onClick={openCopilot} aria-label="Open Copilot" title="Copilot (Ctrl+/)" />
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
