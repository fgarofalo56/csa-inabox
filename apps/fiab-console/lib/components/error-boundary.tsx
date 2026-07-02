'use client';

/**
 * GlobalErrorBoundary — class component that catches React render
 * errors AND wires window.onerror + unhandledrejection so any browser-
 * side exception is auto-filed as an issue (after PII scrub). Avoids
 * loops by de-duping on a fingerprint of (name+message+route).
 */

import { Component, ErrorInfo, ReactNode, useEffect } from 'react';
import { Body1, Button, Subtitle1, makeStyles, tokens } from '@fluentui/react-components';
import { redact, redactStack, scrubEnv } from '@/lib/feedback/redaction';

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
    await fetch('/api/feedback', {
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
});

interface State { err: Error | null }

export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null };
  static getDerivedStateFromError(err: Error): State { return { err }; }
  componentDidCatch(err: Error, _info: ErrorInfo): void { void autoReport(err, 'render'); }
  render() {
    const FallbackShell = () => {
      const s = useStyles();
      const err = this.state.err;
      return (
        <div className={s.shell} role="alert">
          <Subtitle1>Something went wrong.</Subtitle1>
          <Body1 style={{ marginTop: 8 }}>
            CSA Loom hit an unexpected error rendering this page. A redacted report has been queued
            for the maintainers — no user names, workspace IDs, or data values were sent.
          </Body1>
          {err && (
            <pre style={{ marginTop: 12, fontSize: 12, color: tokens.colorNeutralForeground2, whiteSpace: 'pre-wrap' }}>
              {redact(err.message)}
            </pre>
          )}
          <Button appearance="primary" style={{ marginTop: 12 }} onClick={() => { this.setState({ err: null }); }}>
            Try again
          </Button>
          <div className={s.hint}>Loom version: {LOOM_VERSION}</div>
        </div>
      );
    };
    if (this.state.err) return <FallbackShell />;
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
