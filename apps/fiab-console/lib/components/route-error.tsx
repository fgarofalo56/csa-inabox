'use client';

/**
 * RouteError — the shared App Router `error.tsx` body (apex A2).
 *
 * Rendered by `app/error.tsx` and every first-level route-group
 * `app/<group>/error.tsx`, so a render/data crash in a page segment keeps the
 * shell chrome (nav, CommandPalette, CopilotPane — all mounted in the root
 * layout) and shows a Loom-styled recovery card instead of Next's raw
 * production error screen (research/page-errors.md finding #2).
 *
 * Behavior:
 * - Auto-files a redacted report via the existing `autoReport()` funnel
 *   (lib/components/error-boundary.tsx) — same dedupe + PII scrub.
 * - Deploy-skew chunk failures (`ChunkLoadError` / failed dynamic import —
 *   research finding #1): performs a ONE-SHOT, sessionStorage-guarded
 *   `window.location.reload()` so a tab left open across an image roll heals
 *   itself instead of retry-looping a dead chunk URL. If the guard is already
 *   set (the reload didn't heal it), renders an honest "new version deployed"
 *   card with a manual Reload action. A1 lands the same semantics in the
 *   global class boundary; integration unifies the constants.
 * - Otherwise: error card with the Next error digest, "Try again" wired to
 *   the boundary `reset()`, and a "Go to home" escape hatch.
 */

import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Link,
  Spinner,
  Subtitle1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwiseRegular,
  ArrowSyncCircleRegular,
  ErrorCircleRegular,
  HomeRegular,
} from '@fluentui/react-icons';
import { autoReport } from '@/lib/components/error-boundary';
import { redact } from '@/lib/feedback/redaction';
import {
  clientBuildId,
  isChunkLoadError,
  markReloadOnce,
  reloadGuardKey,
} from '@/lib/components/shared/deploy-skew';

// Re-exported so route-group wrappers/tests have ONE import site (A1's
// deploy-skew.ts is the canonical classifier/guard — unified at integration).
export { isChunkLoadError };

export interface RouteErrorProps {
  /** Next.js App Router error boundary contract. */
  error: Error & { digest?: string };
  /** Re-renders the segment (Next boundary `reset()`). */
  reset: () => void;
  /** Human label for the route group, e.g. "Admin", "Governance". */
  section?: string;
}

/**
 * The one-shot reload guard key for the CURRENT pathname + client build —
 * deploy-skew's (pathname, buildId) format, shared with the global boundary
 * so both boundaries draw from the same per-build reload budget.
 */
export function chunkReloadGuardKey(): string {
  return reloadGuardKey(
    typeof window !== 'undefined' ? window.location.pathname : '',
    clientBuildId(),
  );
}

/**
 * Indirection point for the hard reload. jsdom's `Location.reload` is
 * [LegacyUnforgeable] (non-configurable), so render tests observe the
 * one-shot reload by swapping this instead of spying on window.location.
 */
export const routeErrorInternals = {
  reload: () => {
    window.location.reload();
  },
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    padding: tokens.spacingVerticalXXL,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: tokens.spacingVerticalM,
    width: '100%',
    maxWidth: '560px',
    minWidth: 0,
    padding: tokens.spacingVerticalXXL,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge,
    boxShadow: tokens.shadow8,
  },
  glyph: {
    width: '72px',
    height: '72px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground2,
    fontSize: '36px',
  },
  glyphSkew: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  body: { color: tokens.colorNeutralForeground3, maxWidth: '480px' },
  digest: {
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyMonospace,
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalM,
    marginTop: tokens.spacingVerticalS,
  },
});

export function RouteError({ error, reset, section }: RouteErrorProps) {
  const s = useStyles();
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);
  // Read the guard synchronously so the first paint of a to-be-reloaded chunk
  // failure is a spinner, never a flash of the error card.
  const [guarded] = useState<boolean>(() => {
    if (!chunk || typeof window === 'undefined') return false;
    try {
      return window.sessionStorage.getItem(chunkReloadGuardKey()) !== null;
    } catch {
      return true; // storage unavailable -> never auto-reload (no loop risk)
    }
  });
  const willAutoReload = chunk && !guarded;

  useEffect(() => {
    if (willAutoReload) {
      try {
        // Mark via the shared deploy-skew guard (per pathname + build id) so
        // this boundary and the global one share ONE reload budget.
        markReloadOnce(window.sessionStorage, window.location.pathname, clientBuildId());
      } catch {
        /* storage unavailable — fall through to the manual card next render */
      }
      setReloading(true);
      routeErrorInternals.reload();
      return;
    }
    // Real error (or a chunk failure the reload didn't heal): auto-file the
    // redacted report through the existing dedupe/scrub funnel.
    void autoReport(error, 'render');
  }, [error, willAutoReload]);

  if (willAutoReload || reloading) {
    return (
      <div className={s.root}>
        <Spinner
          size="large"
          labelPosition="below"
          label="A new version of CSA Loom was deployed - reloading this page..."
        />
      </div>
    );
  }

  const label = section ? `${section} hit an unexpected error` : 'This page hit an unexpected error';

  if (chunk) {
    // Guarded chunk failure: the one-shot reload already ran (or storage is
    // unavailable) and the chunk still fails. Be honest about deploy skew and
    // hand the user a manual reload instead of looping.
    return (
      <div className={s.root}>
        <div className={s.card} role="alert">
          <div className={`${s.glyph} ${s.glyphSkew}`} aria-hidden>
            <ArrowSyncCircleRegular />
          </div>
          <Subtitle1>This page needs a refresh</Subtitle1>
          <Body1 className={s.body}>
            A new version of CSA Loom was deployed while this tab was open, and part of this page
            could not be loaded from the previous version. Reload to pick up the latest version.
          </Body1>
          {error?.digest && <Caption1 className={s.digest}>Error digest: {error.digest}</Caption1>}
          <div className={s.actions}>
            <Button
              appearance="primary"
              icon={<ArrowClockwiseRegular />}
              onClick={() => routeErrorInternals.reload()}
            >
              Reload page
            </Button>
            <Button appearance="secondary" icon={<HomeRegular />} as="a" href="/">
              Go to home
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.root}>
      <div className={s.card} role="alert">
        <div className={s.glyph} aria-hidden>
          <ErrorCircleRegular />
        </div>
        <Subtitle1>{label}</Subtitle1>
        <Body1 className={s.body}>
          CSA Loom could not render this page. A redacted report has been queued for the
          maintainers - no user names, workspace IDs, or data values were sent. Try again, or head
          back home; the rest of the console is unaffected.
        </Body1>
        {error?.digest ? (
          <Caption1 className={s.digest}>Error digest: {error.digest}</Caption1>
        ) : (
          error?.message && <Caption1 className={s.digest}>{redact(error.message)}</Caption1>
        )}
        <div className={s.actions}>
          <Button appearance="primary" icon={<ArrowClockwiseRegular />} onClick={() => reset()}>
            Try again
          </Button>
          <Button appearance="secondary" icon={<HomeRegular />} as="a" href="/">
            Go to home
          </Button>
          <Link href="/learn">Open the Learning Hub</Link>
        </div>
      </div>
    </div>
  );
}
