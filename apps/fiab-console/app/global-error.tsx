'use client';

/**
 * GlobalError — Next.js App Router last-resort boundary (apex A2).
 *
 * Catches errors thrown by the ROOT layout itself (Providers, TenantThemeBridge,
 * AppShell chrome — everything the segment-level error.tsx files cannot cover,
 * per research/page-errors.md G-1). Next replaces the entire <html> document
 * with this component, so NOTHING from the app is available here: no
 * FluentProvider, no design tokens, no globals.css. Styling is therefore
 * fully self-contained inline (the ONLY surface where raw hex/px is allowed;
 * the no-raw-px ratchet scopes lib plus app page.tsx files and does not apply).
 *
 * It still auto-files a redacted report via the provider-free autoReport()
 * funnel, and offers Try again (boundary reset), a hard reload, and a Go-home
 * escape hatch.
 */

import { useEffect } from 'react';
import { autoReport } from '@/lib/components/error-boundary';

const palette = {
  pageBg: '#1a1a24',
  cardBg: '#23232f',
  border: '#3d3d4d',
  text: '#f5f5f7',
  textSubtle: '#a0a0b0',
  accent: '#7f85f5',
  accentText: '#111118',
  danger: '#dc626d',
};

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0,
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.pageBg,
    color: palette.text,
    fontFamily:
      "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif",
  },
  card: {
    maxWidth: '560px',
    width: '100%',
    margin: '24px',
    padding: '40px 32px',
    backgroundColor: palette.cardBg,
    border: `1px solid ${palette.border}`,
    borderRadius: '16px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.45)',
    textAlign: 'center',
  },
  glyph: {
    width: '72px',
    height: '72px',
    margin: '0 auto 20px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '34px',
    lineHeight: 1,
    color: palette.danger,
    backgroundColor: 'rgba(220, 98, 109, 0.12)',
    border: `1px solid rgba(220, 98, 109, 0.35)`,
  },
  title: { fontSize: '20px', fontWeight: 600, margin: '0 0 12px' },
  bodyText: { fontSize: '14px', lineHeight: 1.6, color: palette.textSubtle, margin: '0 0 8px' },
  digest: {
    fontSize: '12px',
    fontFamily: "Consolas, 'Courier New', monospace",
    color: palette.textSubtle,
    overflowWrap: 'anywhere',
    margin: '8px 0 0',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: '12px',
    marginTop: '24px',
  },
  primaryBtn: {
    padding: '8px 20px',
    borderRadius: '6px',
    border: 'none',
    backgroundColor: palette.accent,
    color: palette.accentText,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  secondaryBtn: {
    padding: '8px 20px',
    borderRadius: '6px',
    border: `1px solid ${palette.border}`,
    backgroundColor: 'transparent',
    color: palette.text,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
  },
  version: { fontSize: '12px', color: palette.textSubtle, marginTop: '20px' },
};

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // autoReport is provider-free (plain fetch + PII scrub), safe here.
    void autoReport(error, 'render');
  }, [error]);

  return (
    <html lang="en">
      <body style={styles.body}>
        <div style={styles.card} role="alert">
          <div style={styles.glyph} aria-hidden>
            !
          </div>
          <h1 style={styles.title}>CSA Loom hit an unexpected error</h1>
          <p style={styles.bodyText}>
            The console shell could not render. A redacted report has been queued for the
            maintainers - no user names, workspace IDs, or data values were sent. Try again, or
            reload to pick up the latest deployed version.
          </p>
          {error?.digest && <p style={styles.digest}>Error digest: {error.digest}</p>}
          <div style={styles.actions}>
            <button type="button" style={styles.primaryBtn} onClick={() => reset()}>
              Try again
            </button>
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
            <a href="/" style={styles.secondaryBtn}>
              Go to home
            </a>
          </div>
          <div style={styles.version}>
            Loom version: {process.env.NEXT_PUBLIC_LOOM_VERSION || 'dev'}
          </div>
        </div>
      </body>
    </html>
  );
}
