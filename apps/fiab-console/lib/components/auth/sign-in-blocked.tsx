'use client';

/**
 * SignInBlocked — the TERMINAL surface of the sign-in circuit breaker (#3334).
 *
 * This is where a browser stuck in a sign-in loop STOPS. It renders no
 * redirect, fires no fetch, and depends on nothing that could itself be broken
 * by whatever is breaking sign-in: every value it shows is resolved on the
 * server by app/auth/blocked/page.tsx and handed down as props, and the only
 * action is a plain <form> POST that needs no JavaScript.
 *
 * Design: a pre-auth surface, so it matches /welcome (Loom hero card + Fluent
 * v9 + Loom tokens) rather than the in-app PageShell, which assumes a session.
 * Per web3-ui.md every spacing/radius/shadow/colour comes from `tokens.*` or a
 * `--loom-*` custom property; the few rgba() literals are the on-hero contrast
 * values /welcome already established for light-on-dark text.
 *
 * Copy contract (deploy-integrity R7): the narrative is produced by
 * describeCause() in lib/auth/auth-breaker and states ONLY what a specific
 * branch of /auth/callback observed. Where the code could not tell two causes
 * apart, the copy says so. This component adds no interpretation of its own —
 * it renders strings, it does not compose them.
 */

import {
  Body1, Caption1, Subtitle2, Title2, Button,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowCounterclockwise20Filled, Home20Regular,
  Wrench20Regular, Info20Regular,
} from '@fluentui/react-icons';
import { LoomLogo } from '@/lib/components/loom-logo';
import type { AuthFailureCause, CauseNarrative } from '@/lib/auth/auth-breaker';

const useStyles = makeStyles({
  wrap: {
    minHeight: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: tokens.spacingVerticalXXL,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
  },
  card: {
    width: '100%',
    maxWidth: '860px',
    minWidth: 0,
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
  inner: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    minWidth: 0,
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  wordmark: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em', fontSize: tokens.fontSizeBase500 },
  title: { color: 'white', fontWeight: 700, letterSpacing: '-0.01em', marginTop: tokens.spacingVerticalS },
  lede: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: tokens.fontSizeBase400,
    lineHeight: 1.6,
    maxWidth: '640px',
  },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow8,
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: 0,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'flex', flexShrink: 0 },
  body: { color: tokens.colorNeutralForeground2, lineHeight: 1.6 },
  list: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    color: tokens.colorNeutralForeground2,
    lineHeight: 1.6,
  },
  ctaRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    alignItems: 'center',
    marginTop: tokens.spacingVerticalS,
  },
  resetForm: { margin: 0, display: 'contents' },
  diagnostics: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    minWidth: 0,
  },
  // flexWrap + minWidth:0 + truncation: a diagnostics chip row must never
  // overlap at any width (ux-baseline.md, badge-overlap rule).
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusCircular,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
  },
  chipValue: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground1 },
  primaryCta: {
    backgroundColor: 'white',
    color: tokens.colorBrandForeground1,
    ':hover': { backgroundColor: 'rgba(255,255,255,0.90)', color: tokens.colorBrandForeground1 },
  },
});

export interface SignInBlockedProps {
  /** The cause a branch of /auth/callback established. Never inferred here. */
  cause: AuthFailureCause;
  /** Copy for that cause, produced server-side by describeCause(). */
  narrative: CauseNarrative;
  /** Completed sign-in round trips that left this browser unauthenticated. */
  attempts: number;
  /** The configured ceiling that was reached. */
  maxAttempts: number;
  /** The counting window, in seconds. */
  windowSecs: number;
  /** Measured Set-Cookie byte length, when a successful callback recorded one. */
  cookieHeaderBytes?: number;
}

export function SignInBlocked({
  cause, narrative, attempts, maxAttempts, windowSecs, cookieHeaderBytes,
}: SignInBlockedProps) {
  const s = useStyles();
  const minutes = Math.round(windowSecs / 60);
  return (
    <div className={s.wrap}>
      <section className={s.card} aria-labelledby="signin-blocked-title">
        <div className={s.pattern} aria-hidden />
        <div className={s.inner}>
          <div className={s.logoRow}>
            <LoomLogo variant="icon" size={40} />
            <span className={s.wordmark}>CSA Loom</span>
          </div>

          <Title2 as="h1" id="signin-blocked-title" className={s.title}>
            Sign-in stopped after {attempts} attempt{attempts === 1 ? '' : 's'}
          </Title2>
          <Body1 className={s.lede}>
            Loom stopped the sign-in loop on purpose. {attempts} sign-in
            {attempts === 1 ? '' : 's'} completed the round trip to Microsoft Entra ID within{' '}
            {minutes} minute{minutes === 1 ? '' : 's'} and each one left this browser without a
            session, so instead of sending you back a {maxAttempts + 1}th time it is telling you
            what it found.
          </Body1>

          <div className={s.panel}>
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>{narrative.headline}</MessageBarTitle>
                {narrative.established}
              </MessageBarBody>
            </MessageBar>

            {narrative.whatToTry.length > 0 && (
              <>
                <div className={s.sectionHead}>
                  <span className={s.sectionIcon} aria-hidden><Wrench20Regular /></span>
                  <Subtitle2 as="h2">
                    {narrative.operatorAction ? 'What an operator needs to do' : 'What to try'}
                  </Subtitle2>
                </div>
                <ol className={s.list}>
                  {narrative.whatToTry.map((step) => (
                    <li key={step}><Body1 className={s.body}>{step}</Body1></li>
                  ))}
                </ol>
              </>
            )}

            <div className={s.diagnostics}>
              <span className={s.sectionIcon} aria-hidden><Info20Regular /></span>
              <span className={s.chip}>
                Cause&nbsp;<span className={s.chipValue}>{cause}</span>
              </span>
              <span className={s.chip}>
                Attempts&nbsp;<span className={s.chipValue}>{attempts}/{maxAttempts}</span>
              </span>
              <span className={s.chip}>
                Window&nbsp;<span className={s.chipValue}>{windowSecs}s</span>
              </span>
              {typeof cookieHeaderBytes === 'number' && cookieHeaderBytes > 0 && (
                <span className={s.chip}>
                  Set-Cookie&nbsp;<span className={s.chipValue}>{cookieHeaderBytes} bytes</span>
                </span>
              )}
            </div>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Quote these values to an operator — the matching server-side detail is in the
              Console log lines beginning <code>[auth/callback]</code> and <code>[auth/sign-in]</code>.
            </Caption1>
          </div>

          <div className={s.ctaRow}>
            {/*
              A real <form> POST, not an onClick — this page has to work even if
              the app's JavaScript is part of what is broken. POST (not a link)
              because clearing someone's session on a GET is a logout-CSRF.
            */}
            <form method="post" action="/auth/reset" className={s.resetForm}>
              <Button
                type="submit"
                appearance="primary"
                size="large"
                className={s.primaryCta}
                icon={<ArrowCounterclockwise20Filled />}
              >
                Clear sign-in cookies and try again
              </Button>
            </form>
            <Button appearance="outline" size="large" as="a" href="/welcome" icon={<Home20Regular />}>
              Back to the welcome page
            </Button>
          </div>
          <Caption1 style={{ color: 'rgba(255,255,255,0.78)' }}>
            Trying again starts one clean sign-in. If the cause above is still present the loop
            will stop here again after {maxAttempts} attempts rather than running forever.
          </Caption1>
        </div>
      </section>
    </div>
  );
}
