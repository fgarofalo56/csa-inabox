'use client';

/**
 * /welcome — the PRE-AUTH landing surface.
 *
 * This is where an UNAUTHENTICATED, never-signed-in visitor lands (client-fetch
 * routes a session-expiry 401 here when the identity-free `loom_seen` hint cookie
 * is absent — see lib/auth/returning-user.ts). Its whole job is to give the
 * visitor a CHOICE that the old auto-bounce-to-Entra flow denied them:
 *
 *   - "Sign in"        → /auth/sign-in (302s to Entra) for people who HAVE access.
 *   - "Request access" → the RequestAccessButton dialog, which POSTs to the
 *                        rate-limited public endpoint /api/access-requests/public
 *                        and routes to the tenant admin's onboarding queue.
 *
 * A direct visit while already signed in bounces home. The page renders nothing
 * that leaks tenant data — it is deliberately static marketing + the two CTAs.
 * Web3.0 / Loom design tokens throughout (web3-ui.md), no raw px.
 */

import { useEffect } from 'react';
import {
  Title1, Body1, Subtitle2, Caption1, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ShieldCheckmark24Filled, Database24Filled, Sparkle24Filled,
  ArrowRight20Filled,
} from '@fluentui/react-icons';
import { LoomLogo } from '@/lib/components/loom-logo';
import { RequestAccessButton } from '@/lib/components/access/request-access-button';
import { SIGN_IN_PATH } from '@/lib/auth/returning-user';

const useStyles = makeStyles({
  wrap: {
    minHeight: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
  },
  card: {
    width: '100%',
    maxWidth: '860px',
    background: 'var(--loom-hero-bg)',
    color: 'white',
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow28,
    position: 'relative',
    overflow: 'hidden',
    paddingTop: tokens.spacingVerticalXXXL,
    paddingBottom: tokens.spacingVerticalXXXL,
    paddingLeft: tokens.spacingHorizontalXXXL,
    paddingRight: tokens.spacingHorizontalXXXL,
  },
  pattern: {
    position: 'absolute',
    inset: 0,
    background:
      'radial-gradient(circle at 88% 8%, rgba(255,255,255,0.18), transparent 45%), ' +
      'radial-gradient(circle at 8% 112%, rgba(216,159,61,0.30), transparent 50%)',
    pointerEvents: 'none',
  },
  inner: { position: 'relative', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  logoRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  wordmark: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em', fontSize: tokens.fontSizeBase500 },
  title: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em', marginTop: tokens.spacingVerticalS },
  sub: {
    color: 'rgba(255,255,255,0.92)', fontSize: tokens.fontSizeBase400,
    lineHeight: 1.6, maxWidth: '640px',
  },
  ctaRow: {
    display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    alignItems: 'center', marginTop: tokens.spacingVerticalM,
  },
  ctaHint: { color: 'rgba(255,255,255,0.78)' },
  points: {
    display: 'flex', gap: tokens.spacingHorizontalXL, flexWrap: 'wrap',
    marginTop: tokens.spacingVerticalXL,
    paddingTop: tokens.spacingVerticalL,
    borderTop: '1px solid rgba(255,255,255,0.20)',
  },
  point: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  pointIcon: { color: 'rgba(255,255,255,0.92)', display: 'flex', flexShrink: 0 },
  pointText: { color: 'rgba(255,255,255,0.90)' },
  // Force the primary/secondary CTAs to read as light-on-dark against the hero.
  signIn: {
    backgroundColor: 'white', color: tokens.colorBrandForeground1,
    ':hover': { backgroundColor: 'rgba(255,255,255,0.90)', color: tokens.colorBrandForeground1 },
  },
});

const POINTS = [
  { icon: <Database24Filled />, text: 'Lakehouses, warehouses & pipelines on Azure-native services' },
  { icon: <ShieldCheckmark24Filled />, text: 'Purview governance, lineage & sensitivity labels' },
  { icon: <Sparkle24Filled />, text: 'Copilot and data agents grounded in your data' },
];

export default function WelcomePage() {
  const s = useStyles();

  // If the visitor already has a live session, don't strand them on the pre-auth
  // page — send them into the app. A bare same-origin fetch (NOT clientFetch) so
  // an unauthenticated 401 here can never re-trigger the reauth navigation (and,
  // being on /welcome, that navigation is a no-op anyway).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { authenticated?: boolean } | null) => {
        if (!cancelled && d?.authenticated) window.location.replace('/');
      })
      .catch(() => { /* stay on /welcome */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={s.wrap}>
      <section className={s.card}>
        <div className={s.pattern} aria-hidden />
        <div className={s.inner}>
          <div className={s.logoRow}>
            <LoomLogo variant="icon" size={48} />
            <span className={s.wordmark}>CSA Loom</span>
          </div>

          <Title1 as="h1" className={s.title}>Welcome to CSA Loom</Title1>
          <Body1 className={s.sub}>
            The Microsoft Fabric experience, built on Azure-native services for tenants where
            Fabric isn&apos;t available. Sign in to open your workspaces — or request access and a
            Loom administrator will set you up.
          </Body1>

          <div className={s.ctaRow}>
            <Button
              appearance="primary" size="large" className={s.signIn}
              icon={<ArrowRight20Filled />} iconPosition="after"
              as="a" href={SIGN_IN_PATH}
            >
              Sign in
            </Button>
            <RequestAccessButton appearance="secondary" size="large" />
            <Caption1 className={s.ctaHint}>Don&apos;t have access yet? Request it above.</Caption1>
          </div>

          <div className={s.points}>
            {POINTS.map((p) => (
              <div key={p.text} className={s.point}>
                <span className={s.pointIcon} aria-hidden>{p.icon}</span>
                <Subtitle2 as="span" className={s.pointText}>{p.text}</Subtitle2>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
