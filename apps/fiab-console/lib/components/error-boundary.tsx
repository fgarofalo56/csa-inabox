'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * GlobalErrorBoundary — class component that catches React render
 * errors AND wires window.onerror + unhandledrejection so any browser-
 * side exception is auto-filed as an issue (after PII scrub). Avoids
 * loops by de-duping on a fingerprint of (name+message+route).
 *
 * ChunkLoadError / failed-dynamic-import (deploy skew after an image roll)
 * gets special handling: ONE loop-guarded hard reload instead of the retry
 * card — see lib/components/shared/deploy-skew.ts (loom-apex A1).
 */

import { Component, ErrorInfo, ReactNode, useEffect } from 'react';
import { Body1, Button, Spinner, Subtitle1, makeStyles, tokens } from '@fluentui/react-components';
import { redact, redactStack, scrubEnv } from '@/lib/feedback/redaction';
import { attemptOneShotReload, isChunkLoadError } from '@/lib/components/shared/deploy-skew';

const LOOM_VERSION = process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev';
const SEEN = new Set<string>();
const MAX_AUTO_REPORTS_PER_SESSION = 5;
let reportCount = 0;

function fingerprintOf(name: string, message: string, route: string): string {
  return `${name}::${message.slice(0, 80)}::${route}`;
}

export async function autoReport(err: Error | { name?: string; message?: string; stack?: string }, source: 'render' | 'window' | 'unhandledrejection') {
  if (reportCount >= MAX_AUTO_REPORTS_PER_SESSION) return;
  const env = scrubEnv({
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    loomVersion: LOOM_VERSION,
  });
  const name = err.name || 'Error';
  const message = err.message || '(no message)';
  const fp = fingerprintOf(name, message, env.url ?? '');
  if (SEEN.has(fp)) return;
  SEEN.add(fp);
  reportCount += 1;
  try {
    await clientFetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'auto-error',
        errorName: redact(name),
        errorMessage: redact(message),
        stack: redactStack(err.stack),
        title: `[${source}] ${redact(message).slice(0, 80)}`,
        ...env,
      }),
      keepalive: true,
    });
  } catch { /* swallow — never throw from the error reporter */ }
}

const useStyles = makeStyles({
  shell: {
    padding: '32px', margin: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
    maxWidth: '720px', marginInline: 'auto', marginTop: '80px',
  },
  hint: { color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS, fontSize: tokens.fontSizeBase200 },
  reloadShell: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '40vh', padding: tokens.spacingVerticalXXL,
  },
});

interface State { err: Error | null; recovering: boolean }

export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null, recovering: false };
  static getDerivedStateFromError(err: Error): Partial<State> { return { err }; }
  componentDidCatch(err: Error, _info: ErrorInfo): void {
    if (isChunkLoadError(err)) {
      // Deploy skew (research/page-errors.md G-2): the image rolled while this
      // tab was open and the route's hashed chunk URL 404s on the new revision.
      // The documented recovery is ONE hard reload — it swaps in the whole new
      // chunk graph. attemptOneShotReload is sessionStorage-loop-guarded per
      // (pathname, client build), so a genuinely broken chunk falls through to
      // the honest error card below instead of reload-looping.
      if (attemptOneShotReload(window.location.pathname)) {
        this.setState({ recovering: true });
        return; // expected transient after a roll — don't auto-file an issue
      }
    }
    void autoReport(err, 'render');
  }
  render() {
    const FallbackShell = () => {
      const s = useStyles();
      const err = this.state.err;
      if (this.state.recovering) {
        // The one-shot hard reload has been initiated; this renders only for
        // the instant before the navigation replaces the page.
        return (
          <div className={s.reloadShell} role="status">
            <Spinner size="small" label="CSA Loom was updated — reloading this page to get the new version…" />
          </div>
        );
      }
      const chunkSkew = err != null && isChunkLoadError(err);
      return (
        <div className={s.shell} role="alert">
          <Subtitle1>{chunkSkew ? 'This page needs a newer version of CSA Loom.' : 'Something went wrong.'}</Subtitle1>
          <Body1 style={{ marginTop: tokens.spacingVerticalS }}>
            {chunkSkew
              ? 'CSA Loom was updated on the server while this tab was open, and an automatic ' +
                'reload could not fetch the new page code. Reload the page to get the current ' +
                'version; if this keeps happening, hard-refresh (Ctrl+Shift+R) to clear cached scripts.'
              : 'CSA Loom hit an unexpected error rendering this page. A redacted report has been queued ' +
                'for the maintainers — no user names, workspace IDs, or data values were sent.'}
          </Body1>
          {err && (
            <pre style={{ marginTop: tokens.spacingVerticalM, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground2, whiteSpace: 'pre-wrap' }}>
              {redact(err.message)}
            </pre>
          )}
          {chunkSkew ? (
            // A stale-chunk retry that re-renders would just re-request the
            // same dead chunk URL — the only real fix is a hard reload.
            <Button appearance="primary" style={{ marginTop: tokens.spacingVerticalM }} onClick={() => { window.location.reload(); }}>
              Reload page
            </Button>
          ) : (
            <Button appearance="primary" style={{ marginTop: tokens.spacingVerticalM }} onClick={() => { this.setState({ err: null }); }}>
              Try again
            </Button>
          )}
          <div className={s.hint}>Loom version: {LOOM_VERSION}</div>
        </div>
      );
    };
    if (this.state.err || this.state.recovering) return <FallbackShell />;
    return this.props.children;
  }
}

/** Component-level hook to install window listeners (must mount inside boundary). */
export function GlobalErrorListeners() {
  useEffect(() => {
    function onErr(e: ErrorEvent) { void autoReport(e.error ?? { name: 'Error', message: e.message }, 'window'); }
    function onRej(e: PromiseRejectionEvent) {
      const r = e.reason;
      const err = r instanceof Error ? r : { name: 'UnhandledRejection', message: typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200) };
      void autoReport(err, 'unhandledrejection');
    }
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);
  return null;
}
